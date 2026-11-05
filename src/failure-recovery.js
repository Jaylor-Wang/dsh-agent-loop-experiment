import { createHash } from 'node:crypto';
import { HarnessError, createUserMessage } from '@deepseek-ai/dsh-llm';
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import { normalizePath } from './runtime-policy.js';

export const RECOVERY_SOURCE = 'loop-write-recovery';
export const RETRY_TOOL = 'retry_failed_write';
export const PAIRING_ERROR = 'invalid escalation: justification is only valid together with sandbox_permissions';
const MIN_BYTES = 8 * 1024;
const MAX_BYTES = 1024 * 1024;
const READ_ONLY = new Set(['read', 'read_image', 'glob', 'grep', 'skill']);

/**
 * Structured finite recovery record abstraction.
 */
export class RecoveryRecord {
  constructor({
    owner,
    callId,
    rootCallId,
    toolName = 'write',
    args,
    definition,
    turn = 1,
    step = 0,
    category = 'pairing-error',
    maxAttempts = 1
  }) {
    this.owner = owner;
    this.callId = callId;
    this.rootCallId = rootCallId;
    this.toolName = toolName;
    // Allowlist safe arguments only
    this.args = { file_path: args.file_path, content: args.content };
    this.targetPath = normalizePath(args.file_path);
    this.argHash = createHash('sha256').update((args.file_path ?? '') + '|' + (args.content ?? '')).digest('hex').slice(0, 16);
    this.definition = definition;
    this.turn = turn;
    this.step = step;
    this.category = category;
    this.attempts = 0;
    this.maxAttempts = maxAttempts;
    this.notified = false;
    this.invalidatedReason = null;
    this.createdAt = Date.now();
  }

  isValid(agent, currentTurn, currentDefinition) {
    if (this.invalidatedReason) return false;
    if (this.owner !== agent) return false;
    if (this.turn !== currentTurn) return false;
    if (this.attempts >= this.maxAttempts) return false;
    if (currentDefinition && this.definition !== currentDefinition) return false;
    return true;
  }

  invalidate(reason) {
    if (!this.invalidatedReason) {
      this.invalidatedReason = reason;
    }
  }

  consume() {
    this.attempts++;
    if (this.attempts >= this.maxAttempts) {
      this.invalidate('attempt-exceeded');
    }
  }
}

const eligible = (exec, result) => {
  const args = exec.arguments;
  return exec.parent === undefined && exec.name === 'write' && !exec.signal.aborted
    && result.isError && result.error.message === PAIRING_ERROR
    && args && typeof args.file_path === 'string' && args.file_path.trim().length > 0
    && typeof args.content === 'string' && typeof args.justification === 'string'
    && args.justification.trim().length > 0 && args.sandbox_permissions === undefined
    && Object.keys(args).every(key => ['file_path', 'content', 'justification'].includes(key))
    && Buffer.byteLength(args.content, 'utf8') >= MIN_BYTES
    && Buffer.byteLength(args.content, 'utf8') <= MAX_BYTES;
};

/** Keep only a reference to the latest unexecuted native write in this turn. */
export function applyFailureRecovery(ctx, { maxAttempts = 1 } = {}) {
  const attemptsLimit = Math.min(1, Math.max(1, Math.floor(Number.isFinite(maxAttempts) ? maxAttempts : 1)));
  const states = new WeakMap();
  const candidates = new Map();
  const pipeline = new ToolExecutionPipeline(ctx);

  const getStats = session => {
    const s = session && states.get(session);
    return s ? { ...s.stats } : { attempted: 0, succeeded: 0, failed: 0, invalidated: 0 };
  };

  const getRecord = session => {
    return session ? states.get(session)?.record : undefined;
  };

  ctx.provide('failureRecovery', { getRecord, getStats });

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      states.set(session, {
        turn: event.data.turn,
        step: 0,
        rootResults: 0,
        concluded: false,
        record: undefined,
        stats: { attempted: 0, succeeded: 0, failed: 0, invalidated: 0 }
      });
    }
    const state = states.get(session);
    if (!state) return;
    if (event.type === 'turn/end') {
      if (state.record) {
        state.record.invalidate('turn-end');
        state.stats.invalidated++;
        state.record = undefined;
      }
    }
    if (event.type === 'working-directory/change') {
      if (state.record) {
        state.record.invalidate('cwd-change');
        state.stats.invalidated++;
        state.record = undefined;
      }
    }
    if (event.type === 'step/start') {
      state.step = event.data.step ?? state.step;
      state.rootResults = 0;
      state.concluded = false;
    }
    if (event.type === 'user/message' && event.data.source?.kind === RECOVERY_SOURCE
      && event.data.source.callId === state.record?.callId) {
      state.record.notified = true;
    }
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    // Be conservative about stale contents after any operation that may mutate files.
    if (exec.parent === undefined && exec.agent && exec.name !== RETRY_TOOL && !READ_ONLY.has(exec.name)) {
      const state = states.get(exec.agent.session);
      if (state?.record) {
        state.record.invalidate('mutating-tool');
        state.stats.invalidated++;
        state.record = undefined;
      }
    }
    return next();
  });

  ctx.on('tools/execute', async (exec, next) => {
    const result = await next();
    // A pre-dispatch policy denial never reaches this seam and cannot mint a reference.
    if (exec.agent && eligible(exec, result)) {
      candidates.set(exec.token, ctx.tools.executable('write', exec.agent, exec.toolSet));
    }
    return result;
  });

  ctx.on('tools/result', (exec, result) => {
    const definition = candidates.get(exec.token);
    candidates.delete(exec.token);
    if (!exec.agent || exec.parent !== undefined) return;
    const state = states.get(exec.agent.session);
    if (!state) return;
    state.rootResults++;
    state.concluded ||= result.concludesTurn === true;
    if (!definition || !eligible(exec, result)) return;
    state.record = new RecoveryRecord({
      owner: exec.agent,
      callId: exec.callId,
      rootCallId: exec.rootCallId,
      toolName: 'write',
      args: exec.arguments,
      definition,
      turn: state.turn,
      step: state.step,
      category: 'pairing-error',
      maxAttempts: attemptsLimit
    });
  });

  ctx.on('agent/pre-step', async ({ agent, step, signal, messages }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || signal.aborted) return decision;
    if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision;
    const state = states.get(agent.session);
    const record = state?.record;
    if (!record || record.owner !== agent || record.notified) return decision;
    if (decision.messages.length === 0 && (state.rootResults === 0 || state.concluded)) return decision;
    const notice = createUserMessage({
      content: [{ type: 'text', text: [
        `The large write in call ${JSON.stringify(record.callId)} failed because justification was supplied without sandbox_permissions.`,
        `To retry the same file path and exact content under current permissions, call ${RETRY_TOOL} with {"call_id":${JSON.stringify(record.callId)}}. Only the invalid justification is removed; do not generate the content again.`,
        'This reference is valid only in this turn until a subsequent potentially mutating tool call, and can be attempted once. Retry only if the write is still required. All current tool policies and cancellation checks still apply.'
      ].join('\n') }],
      source: { kind: RECOVERY_SOURCE, form: 'notice', summary: 'Reuse a rejected large write without generating its contents again.', callId: record.callId }
    });
    return { ...decision, messages: [...decision.messages, notice] };
  }, { prepend: true });

  ctx.tools.register({
    name: RETRY_TOOL,
    description: 'Retry the latest large write rejected for an unpaired justification, using its original call ID and exact contents. Removes only that invalid justification. Current permissions apply; consumes the reference once.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['call_id'],
      properties: { call_id: { type: 'string', description: 'Original failed write call ID supplied by the recovery notice.' } }
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const state = exec.agent && states.get(exec.agent.session);
      const record = state?.record;
      if (!args || typeof args.call_id !== 'string' || Object.keys(args).length !== 1
        || !record || record.owner !== exec.agent || record.callId !== args.call_id) {
        throw new Error('No matching recoverable write in this turn. Use the normal write tool if still needed.');
      }
      if (!record.isValid(exec.agent, state.turn)) {
        throw new Error('No matching recoverable write in this turn. Use the normal write tool if still needed.');
      }
      state.record = undefined;
      if (ctx.tools.executable('write', exec.agent, exec.toolSet) !== record.definition) {
        record.invalidate('tool-definition-change');
        if (state) state.stats.invalidated++;
        throw new Error('The original write tool is no longer admitted. The recovery reference has expired.');
      }
      record.consume();
      if (state) state.stats.attempted++;
      const subCallId = `${exec.callId}:write-recovery`;
      const log = { rootCallId: exec.rootCallId, parentCallId: exec.callId, subCallId, name: 'write', arguments: record.args };
      exec.agent.session.append('tool/ptc-dispatch-start', log);
      const prepared = await pipeline.prepare({
        callId: subCallId, rootCallId: exec.rootCallId, parent: exec.token,
        name: 'write', arguments: record.args, agent: exec.agent,
        toolSet: exec.toolSet, signal: exec.signal
      });
      const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared;
      const result = await pipeline.complete(prepared.exec, outcome);
      exec.agent.session.append('tool/ptc-dispatch', {
        ...log, isError: result.isError, content: result.content,
        ...(result.error?.info ? { error: result.error.info } : {}),
        ...(result.meta === undefined ? {} : { meta: result.meta })
      });
      for (const context of result.additionalContexts ?? []) exec.deferContext(context);
      if (result.isError) {
        if (state) state.stats.failed++;
        throw new HarnessError(result.error.message, result.error.info?.code ?? 'WRITE_RECOVERY_FAILED');
      }
      if (state) state.stats.succeeded++;
      if (result.concludesTurn) exec.concludeTurn();
      return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    }
  }, { when: ({ agent }) => ctx.tools.get('write', agent) !== undefined });
}
