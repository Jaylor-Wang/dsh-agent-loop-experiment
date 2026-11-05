import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import {
  FileMutationPolicyManager,
  applyFileMutationPolicy,
  fileExists
} from '../src/file-mutation-policy.js';

test('fileExists checks path existence safely', () => {
  assert.equal(fileExists(null), false);
  assert.equal(fileExists(''), false);
  assert.equal(fileExists('non-existent-file-12345.xyz', process.cwd()), false);
  assert.equal(fileExists(process.cwd()), true);
});

test('FileMutationPolicyManager allows new files, sub-calls, small writes, and edit calls', () => {
  const manager = new FileMutationPolicyManager({ mode: 'enforce', minLargeWriteBytes: 1024 });
  const mockSession = {};

  manager.onTurnStart(mockSession, 1);

  // 1. New file write -> allowed
  const newFileExec = {
    name: 'write',
    callId: 'call-new',
    arguments: { file_path: 'brand-new-file.txt', content: 'x'.repeat(2000) },
    agent: {}
  };
  const d1 = manager.evaluateToolExecution(mockSession, newFileExec, { get: () => ({}) });
  assert.equal(d1.allowed, true);
  assert.equal(d1.reason, 'target-does-not-exist');

  // 2. Small write -> allowed
  const smallExec = {
    name: 'write',
    callId: 'call-small',
    arguments: { file_path: path.join(process.cwd(), 'package.json'), content: 'tiny' },
    agent: {}
  };
  const d2 = manager.evaluateToolExecution(mockSession, smallExec, { get: () => ({}) });
  assert.equal(d2.allowed, true);
  assert.equal(d2.reason, 'below-size-threshold');

  // 3. PTC sub-call -> allowed
  const subExec = {
    name: 'write',
    callId: 'call-ptc',
    parent: 'parent-token',
    arguments: { file_path: 'existing.txt', content: 'x'.repeat(2000) },
    agent: {}
  };
  const d3 = manager.evaluateToolExecution(mockSession, subExec, { get: () => ({}) });
  assert.equal(d3.allowed, true);
  assert.equal(d3.reason, 'nested-ptc-call');

  // 4. Recovery tool call -> allowed
  const recExec = {
    name: 'retry_failed_write',
    callId: 'call-rec',
    arguments: { call_id: 'prior-call' },
    agent: {}
  };
  const d4 = manager.evaluateToolExecution(mockSession, recExec, { get: () => ({}) });
  assert.equal(d4.allowed, true);
  assert.equal(d4.reason, 'recovery-tool');
});

test('FileMutationPolicyManager allows large write if edit tool is not available', () => {
  const tmpFile = path.join(os.tmpdir(), `dsh-policy-test-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'initial');
  try {
    const manager = new FileMutationPolicyManager({ mode: 'enforce', minLargeWriteBytes: 100 });
    const mockSession = {};
    manager.onTurnStart(mockSession, 1);

    const exec = {
      name: 'write',
      callId: 'call-no-edit',
      arguments: { file_path: tmpFile, content: 'a'.repeat(200) },
      agent: {}
    };

    // Tools service returns undefined for 'edit'
    const toolsServiceWithoutEdit = { get: name => name === 'write' ? {} : undefined };
    const decision = manager.evaluateToolExecution(mockSession, exec, toolsServiceWithoutEdit);
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'no-edit-available');
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('FileMutationPolicyManager in observe mode records violations without blocking', () => {
  const tmpFile = path.join(os.tmpdir(), `dsh-policy-observe-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'initial content');
  try {
    const manager = new FileMutationPolicyManager({ mode: 'observe', minLargeWriteBytes: 100 });
    const mockSession = {};
    manager.onTurnStart(mockSession, 1);

    const exec = {
      name: 'write',
      callId: 'call-obs',
      arguments: { file_path: tmpFile, content: 'b'.repeat(300) },
      agent: {}
    };

    const toolsServiceWithEdit = { get: () => ({}) };
    const decision = manager.evaluateToolExecution(mockSession, exec, toolsServiceWithEdit);
    assert.equal(decision.allowed, true);
    assert.equal(decision.code, 'LARGE_WRITE_EXISTING_FILE');

    const summary = manager.getSummary(mockSession, 1);
    assert.equal(summary.largeWriteViolations, 1);
    assert.equal(summary.largeWritesBlocked, 0);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('FileMutationPolicyManager in enforce mode blocks large write on existing file unless allowed by host callback', () => {
  const tmpFile = path.join(os.tmpdir(), `dsh-policy-enforce-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'initial content');
  try {
    let hostAllowed = false;
    const manager = new FileMutationPolicyManager({
      mode: 'enforce',
      minLargeWriteBytes: 100,
      allowFullReplacement: (_exec, _target) => hostAllowed
    });
    const mockSession = {};
    manager.onTurnStart(mockSession, 1);

    const exec = {
      name: 'write',
      callId: 'call-enf',
      arguments: { file_path: tmpFile, content: 'b'.repeat(300) },
      agent: {}
    };

    const toolsServiceWithEdit = { get: () => ({}) };

    // Initially hostAllowed is false -> should block
    const d1 = manager.evaluateToolExecution(mockSession, exec, toolsServiceWithEdit);
    assert.equal(d1.allowed, false);
    assert.equal(d1.code, 'LARGE_WRITE_EXISTING_FILE');
    assert.ok(d1.nextAction.includes('use edit'));

    // When hostAllowed is true -> should allow
    hostAllowed = true;
    const d2 = manager.evaluateToolExecution(mockSession, exec, toolsServiceWithEdit);
    assert.equal(d2.allowed, true);
    assert.equal(d2.reason, 'host-approved-replacement');

    const summary = manager.getSummary(mockSession, 1);
    assert.equal(summary.largeWriteViolations, 1);
    assert.equal(summary.largeWritesBlocked, 1);
    assert.equal(summary.fullReplacementsAllowed, 1);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('successful overwrite of an existing file does not grant the new-file exemption', () => {
  const tmpFile = path.join(os.tmpdir(), `dsh-policy-existing-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'initial');
  try {
    const manager = new FileMutationPolicyManager({ mode: 'enforce', minLargeWriteBytes: 10 });
    const session = {};
    manager.onTurnStart(session, 1);
    const tools = { get: () => ({}) };
    const first = { name: 'write', callId: 'first', arguments: { file_path: tmpFile, content: 'small' } };
    assert.equal(manager.evaluateToolExecution(session, first, tools).allowed, true);
    manager.recordResult(session, first, { isError: false });
    const second = { ...first, callId: 'second', arguments: { ...first.arguments, content: 'a'.repeat(20) } };
    assert.equal(manager.evaluateToolExecution(session, second, tools).allowed, false);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('FileMutationPolicyManager records edit and read/grep operations in observedFiles', () => {
  const manager = new FileMutationPolicyManager({ mode: 'observe' });
  const mockSession = {};
  manager.onTurnStart(mockSession, 1);

  manager.recordResult(mockSession, { name: 'read', arguments: { file_path: 'foo/bar.js' } }, { isError: false });
  manager.recordResult(mockSession, { name: 'grep', arguments: { path: 'src/' } }, { isError: false });
  manager.recordResult(mockSession, { name: 'edit', arguments: { file_path: 'foo/bar.js' } }, { isError: false });

  const summary = manager.getSummary(mockSession, 1);
  assert.equal(summary.editsCount, 1);
  assert.equal(summary.observedFiles, 2);
});

test('applyFileMutationPolicy integrates with Cordis context tools/pre-execute', async () => {
  const tmpFile = path.join(os.tmpdir(), `dsh-cordis-enforce-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'initial');
  try {
    const ctx = new Context();
    ctx.tools = { get: () => ({}) };
    const manager = applyFileMutationPolicy(ctx, { mode: 'enforce', minLargeWriteBytes: 50 });
    assert.ok(manager);

    const mockSession = {};
    ctx.emit('session/event', mockSession, { type: 'turn/start', data: { turn: 1 } });

    const exec = {
      name: 'write',
      callId: 'call-1',
      arguments: { file_path: tmpFile, content: 'long text '.repeat(20) },
      agent: { session: mockSession }
    };

    let nextCalled = false;
    const result = await ctx.serial('tools/pre-execute', exec, async () => {
      nextCalled = true;
      return { kind: 'allow' };
    });

    assert.equal(nextCalled, false);
    assert.equal(result.kind, 'deny');
    const parsed = JSON.parse(result.reason);
    assert.equal(parsed.code, 'LARGE_WRITE_EXISTING_FILE');
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});
