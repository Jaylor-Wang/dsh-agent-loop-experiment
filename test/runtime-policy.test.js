import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizePath,
  sizeBucket,
  computeFingerprint,
  classifyToolCall,
  RuntimePolicyManager,
  applyRuntimePolicy
} from '../src/runtime-policy.js';
import { Context } from '@deepseek-ai/cordis';

test('normalizePath canonicalizes slashes, drive letters, and trailing slashes', () => {
  assert.equal(normalizePath('C:\\Users\\Test\\file.txt'), 'c:/Users/Test/file.txt');
  assert.equal(normalizePath('c:/Users/Test/file.txt/'), 'c:/Users/Test/file.txt');
  assert.equal(normalizePath('   relative\\path\\foo.js  '), 'relative/path/foo.js');
  assert.equal(normalizePath(''), '');
  assert.equal(normalizePath(null), '');
});

test('sizeBucket buckets bytes deterministically without retaining payload', () => {
  assert.equal(sizeBucket(0), '0');
  assert.equal(sizeBucket(500), '<1K');
  assert.equal(sizeBucket(4096), '1K-8K');
  assert.equal(sizeBucket(20000), '8K-64K');
  assert.equal(sizeBucket(100000), '64K-512K');
  assert.equal(sizeBucket(1000000), '>512K');
});

test('computeFingerprint yields identical 16-hex hashes for equivalent normalized inputs', () => {
  const fp1 = computeFingerprint({
    name: 'write',
    targetPath: 'C:\\project\\app.js',
    opClass: 'write',
    errorCode: 'OK',
    isError: false,
    byteLength: 5000
  });

  const fp2 = computeFingerprint({
    name: 'write',
    targetPath: 'c:/project/app.js',
    opClass: 'write',
    errorCode: 'OK',
    isError: false,
    byteLength: 6000 // same bucket 1K-8K
  });

  assert.equal(fp1, fp2);
  assert.equal(typeof fp1, 'string');
  assert.equal(fp1.length, 16);

  const fpDifferentErr = computeFingerprint({
    name: 'write',
    targetPath: 'c:/project/app.js',
    opClass: 'write',
    errorCode: 'PERMISSION_DENIED',
    isError: true,
    byteLength: 6000
  });

  assert.notEqual(fp1, fpDifferentErr);
});

test('classifyToolCall extracts metadata without leaking payload content', () => {
  const payload = 'secret content'.repeat(100);
  const writeCall = classifyToolCall('write', { file_path: 'E:\\src\\main.js', content: payload });
  assert.equal(writeCall.opClass, 'write');
  assert.equal(writeCall.targetPath, 'E:\\src\\main.js');
  assert.equal(writeCall.byteLength, Buffer.byteLength(payload, 'utf8'));

  const editCall = classifyToolCall('edit', { file_path: 'foo.txt', old_string: 'a', new_string: 'b' });
  assert.equal(editCall.opClass, 'edit');
  assert.equal(editCall.byteLength, 2);

  const bashCall = classifyToolCall('bash', { command: 'npm test' }, 'E:/work');
  assert.equal(bashCall.opClass, 'shell');
  assert.equal(bashCall.targetPath, 'E:/work');
});

test('RuntimePolicyManager tracks repeated fingerprints and aggregates summary without blocking', () => {
  const manager = new RuntimePolicyManager({ mode: 'observe', minLargeWriteBytes: 1024 });
  const mockSession = {};

  manager.onTurnStart(mockSession, 1);
  manager.onStepStart(mockSession, 1, 1);

  const exec1 = {
    name: 'write',
    callId: 'call-1',
    log: { turn: 1, step: 1 },
    arguments: { file_path: 'test.html', content: 'hello world'.repeat(200) }
  };
  const res1 = { isError: false };

  const { decision: d1 } = manager.recordExecution(mockSession, exec1, res1);
  assert.equal(d1.kind, 'observe');
  assert.equal(d1.repeated, false);
  assert.equal(d1.consecutive, 1);

  // Repeat identical execution
  const exec2 = {
    name: 'write',
    callId: 'call-2',
    log: { turn: 1, step: 2 },
    arguments: { file_path: 'test.html', content: 'hello world'.repeat(200) }
  };
  manager.onStepStart(mockSession, 1, 2);
  const { decision: d2 } = manager.recordExecution(mockSession, exec2, res1);
  assert.equal(d2.kind, 'observe');
  assert.equal(d2.repeated, true);
  assert.equal(d2.consecutive, 2);

  const summary = manager.getSummary(mockSession, 1);
  assert.equal(summary.toolExecutions, 2);
  assert.equal(summary.failedToolExecutions, 0);
  assert.equal(summary.largeWrites, 2);
  assert.equal(summary.repeatedFingerprintHits, 1);
  assert.equal(summary.uniqueFingerprints, 1);
  assert.equal(summary.maxConsecutiveRepeats, 2);
});

test('RuntimePolicyManager state does not leak across sessions or turns', () => {
  const manager = new RuntimePolicyManager({ mode: 'observe' });
  const s1 = {};
  const s2 = {};

  manager.onTurnStart(s1, 1);
  manager.onTurnStart(s2, 1);

  const exec = { name: 'read', callId: 'c1', log: { turn: 1 }, arguments: { file_path: 'a.txt' } };
  manager.recordExecution(s1, exec, { isError: false });

  assert.equal(manager.getSummary(s1, 1).toolExecutions, 1);
  assert.equal(manager.getSummary(s2, 1).toolExecutions, 0);

  // Next turn for s1 resets turn counters
  manager.onTurnStart(s1, 2);
  assert.equal(manager.getSummary(s1, 2).toolExecutions, 0);
});

test('applyRuntimePolicy integrates with Cordis events cleanly', () => {
  const ctx = new Context();
  const manager = applyRuntimePolicy(ctx, { mode: 'observe' });
  assert.ok(manager instanceof RuntimePolicyManager);

  const session = {};
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'step/start', data: { turn: 1, step: 1 } });

  const agent = { session };
  const exec = {
    agent,
    name: 'read',
    callId: 'read-1',
    log: { turn: 1, step: 1 },
    arguments: { file_path: 'readme.md' }
  };

  ctx.emit('tools/result', exec, { isError: false });

  const summary = manager.getSummary(session, 1);
  assert.equal(summary.toolExecutions, 1);
  assert.equal(summary.uniqueFingerprints, 1);
});

test('RuntimePolicyManager does not treat different command arguments as the same failure streak', () => {
  const manager = new RuntimePolicyManager({ mode: 'enforce', noProgressLimit: 2 });
  const session = {};
  manager.onTurnStart(session, 1);
  const failure = { isError: true, error: { message: 'command not found' } };
  const first = { name: 'bash', callId: 'cmd-1', arguments: { command: 'missing-a' } };
  const second = { name: 'bash', callId: 'cmd-2', arguments: { command: 'missing-b' } };
  manager.recordExecution(session, first, failure);
  assert.equal(manager.evaluatePreExecute(session, second).kind, 'allow');
  manager.recordExecution(session, second, failure);
  assert.equal(manager.evaluatePreExecute(session, first).kind, 'allow');
});

test('RuntimePolicyManager in enforce mode denies repeated tool failure without progress', () => {
  const manager = new RuntimePolicyManager({ mode: 'enforce', noProgressLimit: 2 });
  const mockSession = {};
  manager.onTurnStart(mockSession, 1);
  manager.onStepStart(mockSession, 1, 1);

  const exec1 = { name: 'bash', callId: 'cmd-1', arguments: { command: 'failing-command' } };
  const errResult = { isError: true, error: { message: 'command not found' } };

  // First failure
  manager.recordExecution(mockSession, exec1, errResult);
  const pre1 = manager.evaluatePreExecute(mockSession, exec1);
  assert.equal(pre1.kind, 'allow');

  // Second failure (reaches noProgressLimit = 2)
  manager.recordExecution(mockSession, exec1, errResult);
  const pre2 = manager.evaluatePreExecute(mockSession, exec1);
  assert.equal(pre2.kind, 'deny');
  assert.match(pre2.reason, /failed 2 times consecutively without progress/);
  assert.equal(JSON.parse(pre2.reason).code, 'NO_PROGRESS');
  assert.equal(manager.evaluatePreExecute(mockSession, exec1).kind, 'deny', 'repeatedly denied invocation stays blocked');

  const summary = manager.getSummary(mockSession, 1);
  assert.equal(summary.failedToolExecutions, 2);
  assert.ok(summary.noProgressHits >= 1);
  assert.equal(summary.uniqueNoProgressFingerprints, 1);
});
