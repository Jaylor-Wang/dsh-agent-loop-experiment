import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import { GUIDANCE, REMINDER, SOURCE } from '../src/convergence.js';
import { call, createRuntime, response, userMessage } from './support/runtime.js';

const text = request => request.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n');
const reminders = host => host.events.filter(event => event.type === 'user/message' && event.data.source?.kind === SOURCE);
const end = host => host.events.filter(event => event.type === 'turn/end').at(-1)?.data.reason;
const script = n => [...Array.from({ length: n }, (_, i) => [call(`call-${i}`)]), [{ type: 'text', text: 'Complete.' }]];
const use = async (t, options) => { const host = await createRuntime(options); t.after(() => host.dispose()); return host; };
const prefixEqual = (before, after) => assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);

test('copied official core remains byte-identical to the captured baseline', () => {
  const hash = createHash('sha256').update(fs.readFileSync(new URL('../lib/index.js', import.meta.url))).digest('hex');
  assert.equal(hash, 'a6fa8e0c7c90191caf5f4a3bb5c624a86e9845cf3c79d020b71420d0e20ae4c1');
});

test('disabled strategy matches official model/tool sequence and request content', async t => {
  const baseline = await use(t, { baseline: true, script: script(3) });
  const candidate = await use(t, { script: script(3) });
  await baseline.run(); await candidate.run();
  const normalize = host => host.requests.map(request => ({
    ...request, sessionId: undefined, signal: undefined,
    messages: request.messages.map(({ id: _id, ...message }) => message)
  }));
  assert.deepEqual(normalize(candidate), normalize(baseline));
  assert.deepEqual(candidate.calls, baseline.calls);
  assert.equal(reminders(candidate).length, 0);
  assert.equal(candidate.errors.length, 0);
});

test('strategy adds static guidance and one appended reminder, preserving all request prefixes', async t => {
  const host = await use(t, { enabled: true, script: script(5) });
  await host.run();
  assert.equal(host.requests.length, 6);
  assert.equal(host.calls.length, 5);
  assert.equal(reminders(host).length, 1);
  assert.equal(text(host.requests[0]).includes(GUIDANCE), true);
  assert.equal(text(host.requests[1]).includes(REMINDER), false);
  assert.equal(text(host.requests[2]).includes(REMINDER), true);
  for (let i = 1; i < host.requests.length; i++) prefixEqual(host.requests[i - 1], host.requests[i]);
  assert.equal(end(host).kind, 'completed');
  assert.equal(host.errors.length, 0);
});

test('soft budget does not create another request after a natural final answer', async t => {
  const host = await use(t, { enabled: true, softStepBudget: 1 });
  await host.run();
  assert.equal(host.requests.length, 1);
  assert.equal(reminders(host).length, 0);
  assert.equal(end(host).kind, 'completed');
});

test('a concluding tool does not create another request at the soft budget', async t => {
  const host = await use(t, { enabled: true, softStepBudget: 1, script: [[call()]], inspect: async (_args, exec) => {
    exec.concludeTurn();
    return 'Evidence verified.';
  } });
  await host.run();
  assert.equal(host.requests.length, 1);
  assert.equal(reminders(host).length, 0);
  assert.equal(host.errors.length, 0);
});

test('concluding tools with fresh steering retain the required continuation', async t => {
  const host = await use(t, { enabled: true, softStepBudget: 1, script: script(1), inspect: async (_args, exec) => {
    exec.deferContext(userMessage('Also explain the verified result.'));
    exec.concludeTurn();
    return 'Evidence verified.';
  } });
  await host.run();
  assert.equal(host.requests.length, 2);
  assert.equal(reminders(host).length, 1);
  assert.equal(host.errors.length, 0);
});

test('retry keeps admitted reminder exactly once and preserves model selection', async t => {
  const host = await use(t, { enabled: true, softStepBudget: 1, script: [
    [call()],
    () => response([], { kind: 'error', failure: { code: 'OFFLINE_TRANSIENT', message: 'Scripted retry.' } }),
    [{ type: 'text', text: 'Recovered.' }]
  ], setup(ctx) {
    let retried = false;
    ctx.on('agent/request-error', (_event, next) => {
      if (!retried) { retried = true; return { kind: 'retry' }; }
      return next();
    });
  } });
  await host.run();
  assert.equal(host.requests.length, 3);
  assert.equal(reminders(host).length, 1);
  assert.deepEqual(host.requests[2].messages, host.requests[1].messages);
  assert.ok(host.requests.every(request => request.reasoningEffort === 'xhigh'));
  assert.equal(host.calls.length, 1);
  assert.equal(host.errors.length, 0);
});

test('rejected preStep remains rejected without committing a reminder', async t => {
  const host = await use(t, { enabled: true, softStepBudget: 1, script: [[call()]], setup(ctx) {
    ctx.on('agent/pre-step', (event, next) => event.step === 2 ? { kind: 'reject' } : next());
  } });
  await host.run();
  assert.equal(host.requests.length, 1);
  assert.equal(reminders(host).length, 0);
  assert.equal(end(host).kind, 'blocked');
});

test('canceled admission commits no reminder and later turns can still receive one', async t => {
  const host = await use(t, { enabled: true, softStepBudget: 1, script: [...script(1).slice(0,1), ...script(1)], setup(ctx, agent) {
    let cancel = true;
    ctx.on('agent/pre-step', async (event, next) => {
      const decision = await next();
      if (event.step === 2 && cancel) { cancel = false; agent.cancel({ kind: 'user' }); }
      return decision;
    });
  } });
  await host.run();
  assert.equal(reminders(host).length, 0);
  assert.equal(end(host).kind, 'aborted');
  await host.run('Continue the task.');
  assert.equal(host.requests.length, 3);
  assert.equal(reminders(host).length, 1);
  assert.equal(host.errors.length, 0);
});

test('batch tools still overlap and settle once each in model order', async t => {
  const gate = Promise.withResolvers();
  const started = [];
  const host = await use(t, { enabled: true, softStepBudget: 1, script: [[call('a'), call('b')], [{ type: 'text', text: 'Complete.' }]], inspect: async (_args, exec) => {
    started.push(exec.callId);
    if (started.length === 2) gate.resolve();
    await gate.promise;
    return 'Evidence verified.';
  } });
  await host.run();
  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual(host.events.filter(event => event.type === 'tool/result').map(event => event.data.message.toolCallId), ['a', 'b']);
  assert.equal(host.requests.length, 2);
  assert.equal(reminders(host).length, 1);
});

test('each new turn gets at most one reminder', async t => {
  const host = await use(t, { enabled: true, scopedPolicy: true, softStepBudget: 1, script: [...script(1), ...script(1)] });
  await host.run(); await host.run('Run a second independent task.');
  assert.equal(host.requests.length, 4);
  assert.equal(reminders(host).length, 2);
  assert.equal(host.errors.length, 0);
});

test('scoped policy does not affect a neighboring agent or consume its budget', async t => {
  const host = await use(t, { script: [...script(1), ...script(1), ...script(1)] });
  const { default: convergence } = await import('../src/convergence.js');
  const selected = await host.create({ setup: async ctx => { await ctx.plugin(convergence, { enabled: true, softStepBudget: 1 }); } });
  await host.run();
  assert.equal(text(host.requests[0]).includes(GUIDANCE), false);
  selected.followup(userMessage('Complete another task.'));
  await selected.whenIdle();
  assert.equal(text(host.requests[2]).includes(GUIDANCE), true);
  assert.equal(reminders(host).length, 1);
  await host.run('Complete one more task.');
  assert.equal(text(host.requests[4]).includes(GUIDANCE), false);
  assert.equal(reminders(host).length, 1);
  assert.equal(host.errors.length, 0);
});

test('unloading policy removes its providers and stops future reminders', async t => {
  const host = await use(t, { script: script(2) });
  const { default: convergence } = await import('../src/convergence.js');
  const fiber = host.ctx.plugin(convergence, { enabled: true, softStepBudget: 1 });
  await fiber;
  const assembly = await host.ctx.systemPrompt.assemble({ agent: host.agent, scope: host.agent });
  assert.ok(assembly.sections.some(section => section.text === GUIDANCE));
  await fiber.dispose();
  await host.run();
  assert.equal(text(host.requests[0]).includes(GUIDANCE), false);
  assert.equal(reminders(host).length, 0);
  assert.equal(host.requests.length, 3);
});

test('budget counts admitted steps in this turn, not cumulative session steps', async t => {
  const host = await use(t, { enabled: true, softStepBudget: 2, script: [...script(2), ...script(2)] });
  await host.run(); await host.run('Another task with the same budget.');
  assert.equal(text(host.requests[3]).includes(REMINDER), true); // First turn's retained reminder.
  assert.equal(reminders(host).length, 2);
  const turnSteps = reminders(host).map(notice => host.events.filter(event => event.type === 'step/start' && event.seq < notice.seq).at(-1).data.step);
  assert.deepEqual(turnSteps, [3, 3]);
});

test('max-token terminal response does not become another model request', async t => {
  const host = await use(t, { enabled: true, softStepBudget: 1, script: [() => response([{ type: 'text', text: 'Partial answer.' }], { kind: 'max-tokens' })] });
  await host.run();
  assert.equal(host.requests.length, 1);
  assert.equal(reminders(host).length, 0);
  assert.equal(end(host).kind, 'max-tokens');
});

test('tool errors remain visible to the model and are never treated as completion', async t => {
  const host = await use(t, { enabled: true, softStepBudget: 1, script: script(1), inspect: async () => { throw new Error('Fixture evidence unavailable.'); } });
  await host.run();
  assert.equal(host.requests.length, 2);
  assert.equal(host.requests[1].messages.find(message => message.role === 'tool').isError, true);
  assert.equal(reminders(host).length, 1);
  assert.equal(host.errors.length, 0);
});

test('runtime policy observe mode records tool metrics and fingerprints without changing baseline', async t => {
  const host = await use(t, { enabled: true, softStepBudget: 10, script: script(2) });
  await host.run();
  assert.equal(host.requests.length, 3);
  assert.equal(host.calls.length, 2);
  const manager = host.ctx.get('runtimePolicy');
  assert.ok(manager);
  const summary = manager.getSummary(host.agent.session, 1);
  assert.equal(summary.toolExecutions, 2);
  assert.equal(summary.failedToolExecutions, 0);
  assert.equal(summary.uniqueFingerprints, 1);
  assert.equal(summary.repeatedFingerprintHits, 1);
});

