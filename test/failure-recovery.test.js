import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Service } from '@deepseek-ai/cordis';
import convergence from '../src/convergence.js';
import { PAIRING_ERROR, RECOVERY_SOURCE, RETRY_TOOL, RecoveryRecord } from '../src/failure-recovery.js';
import { call, createRuntime } from './support/runtime.js';

const payload = ('鹈鹕\r\n\uFEFF literal ` ${value} $() \\ 🐦\n').repeat(350);
const original = { file_path: 'pelican.html', content: payload, justification: 'Create the requested HTML.' };
const notices = host => host.events.filter(e => e.type === 'user/message' && e.data.source?.kind === RECOVERY_SOURCE);
const results = host => host.events.filter(e => e.type === 'tool/result');
const finish = [{ type: 'text', text: 'Complete.' }];
const readText = request => request.messages.flatMap(m => m.content).filter(b => b.type === 'text').map(b => b.text).join('\n');
async function fixture(t, { script = [[call('failed', 'write', original)], [call('retry', RETRY_TOOL, { call_id: 'failed' })], finish], beforeWrite, ...options } = {}) {
  const writes = [];
  const host = await createRuntime({
    enabled: true, softStepBudget: 100, script,
    configureTools(ctx, owner) {
      ctx.tools.register({
        name: 'write', description: 'Write fixture text.',
        parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' }, justification: { type: 'string' }, sandbox_permissions: { type: 'string' } }, required: ['file_path', 'content'] },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
          owner.calls.push(exec.callId);
          if (beforeWrite) await beforeWrite(args, exec);
          if (args.justification && args.sandbox_permissions === undefined) throw new Error(PAIRING_ERROR);
          writes.push({ args, exec });
          return 'Created file';
        }
      });
      for (const name of ['read', 'bash']) ctx.tools.register({
        name, description: 'Fixture operation.', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() { return 'Done.'; }
      });
    }, ...options
  });
  t.after(() => host.dispose());
  host.writes = writes;
  return host;
}

test('short reference retries the exact payload once through the official pipeline and preserves prefixes', async t => {
  const policies = [];
  const host = await fixture(t, { setup(ctx) { ctx.on('tools/pre-execute', (exec, next) => { if (exec.name === 'write') policies.push(exec); return next(); }); } });
  await host.run();
  assert.equal(host.requests.length, 3);
  assert.equal(host.errors.length, 0);
  assert.equal(host.writes.length, 1);
  assert.deepEqual(host.writes[0].args, { file_path: original.file_path, content: payload });
  assert.equal(host.writes[0].exec.rootCallId, 'retry');
  assert.notEqual(host.writes[0].exec.parent, undefined);
  assert.equal(policies.length, 2);
  assert.equal(notices(host).length, 1);
  assert.ok(readText(host.requests[1]).includes('"call_id":"failed"'));
  assert.equal(results(host)[0].data.message.isError, true);
  assert.equal(results(host)[1].data.message.isError, false);
  const nested = host.events.find(e => e.type === 'tool/ptc-dispatch');
  assert.equal(nested.data.parentCallId, 'retry');
  assert.deepEqual(nested.data.arguments, { file_path: original.file_path, content: payload });
  assert.equal(nested.data.isError, false);
  const retryCall = host.events.find(e => e.type === 'tool/call' && e.data.name === RETRY_TOOL);
  assert.ok(retryCall.data.arguments.length < 100);
  for (let i = 1; i < host.requests.length; i++) assert.deepEqual(host.requests[i].messages.slice(0, host.requests[i - 1].messages.length), host.requests[i - 1].messages);
});

test('a short write, unknown error, or explicit escalation never offers recovery', async t => {
  for (const [label, args, beforeWrite] of [
    ['short', { ...original, content: 'small' }, undefined],
    ['unknown', original, async () => { throw new Error('Disk unavailable.'); }],
    ['escalated', { ...original, sandbox_permissions: 'danger-full-access' }, async () => { throw new Error(PAIRING_ERROR); }]
  ]) {
    const host = await fixture(t, { script: [[call(label, 'write', args)], finish], beforeWrite });
    await host.run();
    assert.equal(notices(host).length, 0, label);
    assert.equal(host.writes.length, 0, label);
  }
});

test('pre-dispatch policy denials cannot create a recovery reference even with matching error text', async t => {
  const host = await fixture(t, { script: [[call('failed', 'write', original)], finish], setup(ctx) {
    ctx.on('tools/pre-execute', (exec, next) => exec.name === 'write' ? { kind: 'deny', reason: PAIRING_ERROR } : next());
  } });
  await host.run();
  assert.equal(notices(host).length, 0);
  assert.equal(host.calls.length, 0);
  assert.equal(results(host)[0].data.message.isError, true);
});

test('retry respects current write policy and preserves the denial as a failure', async t => {
  const host = await fixture(t, { setup(ctx) {
    ctx.on('tools/pre-execute', (exec, next) => exec.name === 'write' && exec.parent !== undefined
      ? { kind: 'deny', reason: '[sandbox: file access denied under read-only mode]' } : next());
  } });
  await host.run();
  assert.equal(host.writes.length, 0);
  const result = results(host).at(-1).data.message;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /file access denied/);
  assert.equal(host.events.find(e => e.type === 'tool/ptc-dispatch').data.isError, true);
  assert.equal(host.errors.length, 0);
});

test('retry is single use and cannot change the target path or payload', async t => {
  const host = await fixture(t, { script: [
    [call('failed', 'write', original)],
    [call('invalid', RETRY_TOOL, { call_id: 'failed', file_path: 'other.html' })],
    [call('retry', RETRY_TOOL, { call_id: 'failed' })],
    [call('again', RETRY_TOOL, { call_id: 'failed' })], finish
  ] });
  await host.run();
  assert.equal(host.writes.length, 1);
  assert.equal(notices(host).length, 1);
  assert.deepEqual(results(host).map(e => e.data.message.isError), [true, true, false, true]);
});

test('read-only operations retain references but shell operations invalidate them', async t => {
  for (const name of ['read', 'bash']) {
    const host = await fixture(t, { script: [[call('failed', 'write', original)], [call('inspect', name)], [call('retry', RETRY_TOOL, { call_id: 'failed' })], finish] });
    await host.run();
    assert.equal(host.writes.length, name === 'read' ? 1 : 0);
    assert.equal(results(host).at(-1).data.message.isError, name !== 'read');
    assert.equal(notices(host).length, 1);
  }
});

test('new turns and neighboring agents cannot reuse a prior reference', async t => {
  const host = await fixture(t, { script: [[call('failed', 'write', original)], finish, [call('other', RETRY_TOOL, { call_id: 'failed' })], finish, [call('later', RETRY_TOOL, { call_id: 'failed' })], finish] });
  await host.run();
  const other = await host.create();
  const { userMessage } = await import('./support/runtime.js');
  other.followup(userMessage('Try a foreign reference.'));
  await other.whenIdle();
  await host.run('Try the old reference.');
  assert.equal(host.writes.length, 0);
  assert.equal(notices(host).length, 1);
  assert.equal(host.errors.length, 0);
});

test('canceled retry drains the nested pipeline and never performs the write', async t => {
  const host = await fixture(t, { setup(ctx, agent) {
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'write' && exec.parent !== undefined) agent.cancel({ kind: 'user' });
      return next();
    });
  } });
  await host.run();
  assert.equal(host.writes.length, 0);
  assert.equal(host.events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'aborted');
  assert.equal(host.events.filter(e => e.type === 'tool/ptc-dispatch').at(-1).data.isError, true);
  assert.equal(host.errors.length, 0);
});

test('failed admission adds no recovery notice or extra request', async t => {
  const host = await fixture(t, { script: [[call('failed', 'write', original)]], setup(ctx) {
    ctx.on('agent/pre-step', (event, next) => event.step === 2 ? { kind: 'reject' } : next());
  } });
  await host.run();
  assert.equal(notices(host).length, 0);
  assert.equal(host.requests.length, 1);
  assert.equal(host.writes.length, 0);
});

test('working directory changes invalidate relative-path recovery references', async t => {
  const host = await fixture(t, { setup(ctx) {
    ctx.on('agent/pre-step', async (event, next) => {
      const decision = await next();
      if (event.step === 2) event.agent.session.append('working-directory/change', { cwd: 'E:/other' });
      return decision;
    });
  } });
  await host.run();
  assert.equal(host.writes.length, 0);
  assert.equal(notices(host).length, 0);
  assert.equal(results(host).at(-1).data.message.isError, true);
});

test('a write excluded by step admission cannot be reached through recovery', async t => {
  let visible = true;
  const host = await fixture(t, { setup(ctx) {
    const definition = ctx.tools.get('write');
    ctx.tools.register({ ...definition }, { when: () => visible });
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result' && event.data.message.toolCallId === 'failed') visible = false;
    });
  } });
  await host.run();
  assert.equal(host.writes.length, 0);
  assert.equal(results(host).at(-1).data.message.isError, true);
  assert.equal(host.events.some(e => e.type === 'tool/ptc-dispatch'), false);
});

test('the installed official write validates the original failure and preserves filesystem intent on retry', async t => {
  const hostRequire = createRequire(`${process.env.DSH_IMPLEMENTATION_ROOT ?? 'D:/nodejs/node_global/node_modules/@deepseek-ai/dsh'}/package.json`);
  const load = name => import(pathToFileURL(hostRequire.resolve(name)).href);
  const [{ FileSystem }, fsTools] = await Promise.all([load('@deepseek-ai/dsh-fs'), load('@deepseek-ai/dsh-tool-fs')]);
  const stored = [];
  let resolved = 0;
  const guard = { kind: 'create' };
  class MemoryFs extends FileSystem {
    get sandboxMode() { return 'danger-full-access'; }
    async resolve(filePath, options) { resolved++; assert.equal(options.cwd, 'E:/fixture'); return { targetKey: filePath, displayPath: `E:/fixture/${filePath}` }; }
    processPath(target) { return target.displayPath; }
    async writeText(target, content, intent, signal, policy) {
      signal.throwIfAborted();
      assert.equal(intent, guard);
      assert.equal(policy.mode, 'danger-full-access');
      stored.push({ target, content });
      return { operation: 'create', before: null, after: content, version: 'v1' };
    }
  }
  class WorkingDirectory extends Service {
    constructor(ctx) { super(ctx, 'workingDirectory'); }
    async ensure() { return 'E:/fixture'; }
  }
  class SandboxPolicy extends Service {
    constructor(ctx) { super(ctx, 'sandboxPolicy'); }
    resolve() { return { mode: 'danger-full-access', workspaceRoot: 'E:/fixture' }; }
  }
  const host = await fixture(t, { configureTools: async ctx => {
    await ctx.plugin(MemoryFs);
    await ctx.plugin(WorkingDirectory);
    await ctx.plugin(SandboxPolicy);
    ctx.on('fs/write-intent', () => guard);
    await ctx.plugin(fsTools, { read: false, readImage: false, edit: false });
  } });
  await host.run();
  assert.equal(resolved, 1, 'the invalid original call never reached filesystem resolution');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].content, payload);
  assert.equal(stored[0].target.displayPath, 'E:/fixture/pelican.html');
  assert.equal(notices(host).length, 1);
  assert.deepEqual(results(host).map(e => e.data.message.isError), [true, false]);
  assert.equal(host.errors.length, 0);
});

test('recovery can be disabled independently and unload removes its tool', async t => {
  const host = await fixture(t, { baseline: true, script: [[call('failed', 'write', original)], finish] });
  const fiber = host.ctx.plugin(convergence, { enabled: true, softStepBudget: 100, recoverFailedWrites: false });
  await fiber;
  assert.equal(host.ctx.tools.get(RETRY_TOOL, host.agent), undefined);
  await host.run();
  assert.equal(notices(host).length, 0);
  await fiber.dispose();
  const enabled = host.ctx.plugin(convergence, { enabled: true });
  await enabled;
  assert.ok(host.ctx.tools.get(RETRY_TOOL, host.agent));
  await enabled.dispose();
  assert.equal(host.ctx.tools.get(RETRY_TOOL, host.agent), undefined);
});

test('RecoveryRecord enforces safe argument allowlisting, hashing, attempt limits, and invalidation', () => {
  const mockAgent = { id: 'agent-1' };
  const mockDef = { name: 'write' };
  const record = new RecoveryRecord({
    owner: mockAgent,
    callId: 'call-100',
    rootCallId: 'root-100',
    args: { file_path: 'C:\\docs\\report.txt', content: 'secure payload', justification: 'invalid field', extra: 123 },
    definition: mockDef,
    turn: 1,
    step: 2,
    maxAttempts: 1
  });

  // Safe allowlist
  assert.deepEqual(record.args, { file_path: 'C:\\docs\\report.txt', content: 'secure payload' });
  assert.equal(record.targetPath, 'c:/docs/report.txt');
  assert.equal(record.argHash.length, 16);
  assert.equal(record.attempts, 0);

  // Validity checks
  assert.equal(record.isValid(mockAgent, 1, mockDef), true);
  assert.equal(record.isValid({ id: 'agent-2' }, 1, mockDef), false);
  assert.equal(record.isValid(mockAgent, 2, mockDef), false);
  assert.equal(record.isValid(mockAgent, 1, { name: 'write-different' }), false);

  // Single-use attempt consumption
  record.consume();
  assert.equal(record.attempts, 1);
  assert.equal(record.invalidatedReason, 'attempt-exceeded');
  assert.equal(record.isValid(mockAgent, 1, mockDef), false);

  // Invalidation reason
  const record2 = new RecoveryRecord({
    owner: mockAgent,
    callId: 'call-200',
    rootCallId: 'root-200',
    args: { file_path: 'test.txt', content: 'hello' },
    definition: mockDef,
    turn: 1
  });
  record2.invalidate('mutating-tool');
  assert.equal(record2.invalidatedReason, 'mutating-tool');
  assert.equal(record2.isValid(mockAgent, 1, mockDef), false);
});

test('failureRecovery tracks attempt and success statistics across sessions', async t => {
  const host = await fixture(t);
  await host.run();
  const recoveryService = host.ctx.get('failureRecovery');
  assert.ok(recoveryService);
  const stats = recoveryService.getStats(host.agent.session);
  assert.equal(stats.attempted, 1);
  assert.equal(stats.succeeded, 1);
  assert.equal(stats.failed, 0);
});
