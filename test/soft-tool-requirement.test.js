import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import {
  SoftToolRequirement,
  SoftToolRequirementManager,
  applySoftToolRequirement,
  REQUIREMENT_SOURCE
} from '../src/soft-tool-requirement.js';

test('SoftToolRequirement transitions across satisfied, violated, and exhausted states', () => {
  const req = new SoftToolRequirement({
    id: 'req-edit',
    requiredTool: 'edit',
    reminderMessage: 'Please use edit instead of rewriting.',
    maxReminders: 1,
    maxViolations: 2
  });

  assert.equal(req.satisfied, false);
  assert.equal(req.exhausted, false);

  // First violation
  const res1 = req.check({ name: 'write' });
  assert.equal(res1.status, 'violated');
  assert.equal(req.violationCount, 1);
  assert.equal(req.exhausted, false);

  // Second violation -> exhausted
  const res2 = req.check({ name: 'write' });
  assert.equal(res2.status, 'exhausted');
  assert.equal(req.violationCount, 2);
  assert.equal(req.exhausted, true);

  // Once exhausted, further checks return inactive
  const res3 = req.check({ name: 'edit' });
  assert.equal(res3.status, 'inactive');
});

test('SoftToolRequirement satisfies on matching tool', () => {
  const req = new SoftToolRequirement({
    id: 'req-edit',
    requiredTool: 'edit',
    reminderMessage: 'Use edit.'
  });

  const res = req.check({ name: 'edit' });
  assert.equal(res.status, 'satisfied');
  assert.equal(req.satisfied, true);
});

test('SoftToolRequirementManager injects reminder message in pre-step once', async () => {
  const ctx = new Context();
  const manager = applySoftToolRequirement(ctx, { enabled: true, reminderLimit: 1 });
  assert.ok(manager);

  const mockSession = {};
  const agent = { session: mockSession };

  // Add requirement
  manager.addRequirement(mockSession, {
    id: 'req-inspect',
    requiredTool: 'inspect',
    reminderMessage: 'You must inspect the system before proceeding.'
  });

  ctx.emit('session/event', mockSession, { type: 'turn/start', data: { turn: 1 } });

  // First pre-step with existing user message
  const preStepEvent1 = {
    agent,
    turn: 1,
    step: 1,
    signal: { aborted: false },
    messages: [{ type: 'user', content: [{ type: 'text', text: 'Do work' }] }]
  };

  const decision1 = await ctx.waterfall('agent/pre-step', preStepEvent1, () => ({
    kind: 'enter',
    messages: preStepEvent1.messages
  }));

  assert.equal(decision1.kind, 'enter');
  assert.equal(decision1.messages.length, 2);
  const notice = decision1.messages.find(m => m.source?.kind === REQUIREMENT_SOURCE);
  assert.ok(notice);
  assert.ok(notice.content[0].text.includes('must inspect the system'));
  ctx.emit('session/event', mockSession, { type: 'user/message', data: { source: notice.source } });

  // Second pre-step in the same turn -> should not duplicate reminder
  const preStepEvent2 = {
    agent,
    turn: 1,
    step: 2,
    signal: { aborted: false },
    messages: decision1.messages
  };

  const decision2 = await ctx.waterfall('agent/pre-step', preStepEvent2, () => ({
    kind: 'enter',
    messages: preStepEvent2.messages
  }));

  const notices = decision2.messages.filter(m => m.source?.kind === REQUIREMENT_SOURCE);
  assert.equal(notices.length, 1);
  ctx.emit('session/event', mockSession, { type: 'user/message', data: { source: notice.source } });
});

test('SoftToolRequirement never turns an empty pre-step probe into a request', async () => {
  const ctx = new Context();
  const manager = applySoftToolRequirement(ctx, { enabled: true });
  const session = {};
  manager.addRequirement(session, { id: 'req-empty', requiredTool: 'inspect', reminderMessage: 'Inspect first.' });
  const event = { agent: { session }, turn: 1, step: 2, signal: { aborted: false }, messages: [] };
  const decision = await ctx.waterfall('agent/pre-step', event, () => ({ kind: 'enter', messages: [] }));
  assert.deepEqual(decision.messages, []);
});

test('SoftToolRequirement blocks side-effecting detours but allows read-only evidence gathering', async () => {
  const ctx = new Context();
  const manager = applySoftToolRequirement(ctx, { enabled: true });
  const mockSession = {};
  const agent = { session: mockSession };

  manager.addRequirement(mockSession, {
    id: 'req-verify',
    requiredTool: 'verify_result',
    reminderMessage: 'Please call verify_result.'
  });

  // 1. Read-only tool ('read') should be allowed
  const readExec = { name: 'read', agent, callId: 'c-read', arguments: {} };
  let readExecuted = false;
  const readRes = await ctx.serial('tools/pre-execute', readExec, async () => {
    readExecuted = true;
    return { kind: 'allow' };
  });
  assert.equal(readExecuted, true);
  assert.equal(readRes.kind, 'allow');

  // 2. Side-effecting detour tool ('bash') should be blocked
  const bashExec = { name: 'bash', agent, callId: 'c-bash', arguments: {} };
  let bashExecuted = false;
  const bashRes = await ctx.serial('tools/pre-execute', bashExec, async () => {
    bashExecuted = true;
    return { kind: 'allow' };
  });
  assert.equal(bashExecuted, false);
  assert.equal(bashRes.kind, 'deny');
  assert.equal(JSON.parse(bashRes.reason).code, 'SOFT_TOOL_REQUIREMENT_VIOLATION');

  // 3. Matching tool ('verify_result') satisfies requirement and is allowed
  const verifyExec = { name: 'verify_result', agent, callId: 'c-verify', arguments: {} };
  let verifyExecuted = false;
  const verifyRes = await ctx.serial('tools/pre-execute', verifyExec, async () => {
    verifyExecuted = true;
    return { kind: 'allow' };
  });
  assert.equal(verifyExecuted, true);
  assert.equal(verifyRes.kind, 'allow');
  assert.equal(manager.getSummary(mockSession).satisfiedCount, 0, 'pre-execution admission alone does not satisfy the requirement');
  ctx.emit('tools/result', verifyExec, { isError: false });

  const summary = manager.getSummary(mockSession);
  assert.equal(summary.satisfiedCount, 1);
  assert.equal(summary.violationsBlocked, 1);
});

test('soft requirements clear at turn end and a failed matching call does not satisfy them', () => {
  const manager = new SoftToolRequirementManager({ enabled: true });
  const session = {};
  manager.onTurnStart(session, 1);
  manager.addRequirement(session, { id: 'req-check', requiredTool: 'verify', reminderMessage: 'Verify.' });
  const exec = { name: 'verify', callId: 'verify-failed' };
  manager.stateFor(session).pendingSatisfaction.set(exec.callId, ['req-check']);
  manager.recordResult(session, exec, { isError: true });
  assert.equal(manager.getSummary(session).activeCount, 1);
  manager.onTurnEnd(session);
  assert.equal(manager.getSummary(session).activeCount, 0);
  manager.onTurnStart(session, 2);
  assert.equal(manager.getSummary(session).activeCount, 0);
});

test('SoftToolRequirement state isolates across different sessions', () => {
  const manager = new SoftToolRequirementManager({ enabled: true });
  const s1 = {};
  const s2 = {};

  manager.addRequirement(s1, {
    id: 'req-1',
    requiredTool: 'toolA',
    reminderMessage: 'Do toolA'
  });

  assert.equal(manager.getSummary(s1).activeCount, 1);
  assert.equal(manager.getSummary(s2).activeCount, 0);
});
