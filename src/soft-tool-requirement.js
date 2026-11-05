import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const REQUIREMENT_SOURCE = 'loop-soft-tool-requirement';
const READ_ONLY = new Set(['read', 'read_image', 'glob', 'grep', 'skill']);

/**
 * Represents a soft requirement that steers the agent toward a specific tool before mutating state.
 */
export class SoftToolRequirement {
  constructor({
    id,
    requiredTool,
    satisfies,
    reminderMessage,
    maxReminders = 1,
    maxViolations = 2
  }) {
    this.id = id;
    this.requiredTool = requiredTool;
    this.satisfies = typeof satisfies === 'function' ? satisfies : (exec => exec.name === requiredTool);
    this.reminderMessage = reminderMessage;
    this.reminderCount = 0;
    this.violationCount = 0;
    this.maxReminders = maxReminders;
    this.maxViolations = maxViolations;
    this.satisfied = false;
    this.exhausted = false;
    this.notifiedInTurn = false;
  }

  check(exec) {
    if (this.satisfied || this.exhausted) return { status: 'inactive' };
    if (this.satisfies(exec)) {
      this.satisfied = true;
      return { status: 'satisfied' };
    }
    this.violationCount++;
    if (this.violationCount >= this.maxViolations) {
      this.exhausted = true;
      return { status: 'exhausted' };
    }
    return { status: 'violated' };
  }
}

export const SoftToolRequirementConfig = z.object({
  enabled: z.boolean().default(true),
  reminderLimit: z.number().step(1).min(1).default(1),
  maxViolations: z.number().step(1).min(1).default(2)
});

/**
 * Manager coordinating soft tool requirements across turns and tool execution seams.
 */
export class SoftToolRequirementManager {
  constructor(config = {}) {
    this.config = SoftToolRequirementConfig(config);
    this.sessionStates = new WeakMap();
  }

  stateFor(session, turn) {
    if (!session) return null;
    let state = this.sessionStates.get(session);
    if (!state) {
      state = {
        turn: turn ?? null,
        requirements: new Map(),
        pendingReminders: new Map(),
        pendingSatisfaction: new Map(),
        violationsBlocked: 0,
        requirementsSatisfied: 0
      };
      this.sessionStates.set(session, state);
    }
    return state;
  }

  onTurnStart(session, turn) {
    const state = this.stateFor(session, turn);
    if (!state) return;
    if (state.turn !== null && state.turn !== turn) state.requirements.clear();
    state.turn = turn;
    state.pendingSatisfaction.clear();
    state.pendingReminders.clear();
    for (const req of state.requirements.values()) req.notifiedInTurn = false;
  }

  onTurnEnd(session) {
    const state = this.sessionStates.get(session);
    if (!state) return;
    state.requirements.clear();
    state.pendingSatisfaction.clear();
    state.pendingReminders.clear();
    state.turn = null;
  }

  markReminder(session, id) {
    const req = this.sessionStates.get(session)?.requirements.get(id);
    if (!req || req.notifiedInTurn) return;
    req.notifiedInTurn = true;
    req.reminderCount++;
  }

  recordResult(session, exec, result) {
    if (!session || !exec) return;
    const state = this.sessionStates.get(session);
    const pending = state?.pendingSatisfaction.get(exec.callId);
    state?.pendingSatisfaction.delete(exec.callId);
    if (!pending || result?.isError) return;
    for (const id of pending) {
      const req = state.requirements.get(id);
      if (!req || req.satisfied) continue;
      req.satisfied = true;
      state.requirementsSatisfied++;
    }
  }

  addRequirement(session, options) {
    if (!this.config.enabled || !session || !options?.id) return null;
    const state = this.stateFor(session);
    if (!state) return null;
    const req = new SoftToolRequirement({
      maxReminders: this.config.reminderLimit,
      maxViolations: this.config.maxViolations,
      ...options
    });
    state.requirements.set(req.id, req);
    return req;
  }

  removeRequirement(session, id) {
    const state = this.stateFor(session);
    if (state) state.requirements.delete(id);
  }

  getSummary(session) {
    const state = this.stateFor(session);
    if (!state) {
      return { activeCount: 0, satisfiedCount: 0, violationsBlocked: 0, exhaustedCount: 0 };
    }
    let activeCount = 0;
    let exhaustedCount = 0;
    for (const req of state.requirements.values()) {
      if (!req.satisfied && !req.exhausted) activeCount++;
      if (req.exhausted) exhaustedCount++;
    }
    return {
      activeCount,
      satisfiedCount: state.requirementsSatisfied,
      violationsBlocked: state.violationsBlocked,
      exhaustedCount
    };
  }
}

/**
 * Apply soft tool requirement hooks to Cordis context.
 */
export function applySoftToolRequirement(ctx, rawConfig = {}) {
  const config = SoftToolRequirementConfig(rawConfig);
  if (!config.enabled) return null;

  const manager = new SoftToolRequirementManager(config);

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') manager.onTurnStart(session, event.data.turn);
    else if (event.type === 'turn/end') manager.onTurnEnd(session);
    else if (event.type === 'user/message' && event.data.source?.kind === REQUIREMENT_SOURCE) {
      const state = manager.sessionStates.get(session);
      const pending = state?.pendingReminders.get(event.data.source.id) ?? 0;
      if (pending > 0) {
        state.pendingReminders.set(event.data.source.id, pending - 1);
        manager.markReminder(session, event.data.source.id);
      }
    }
  });

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || signal.aborted) return decision;
    // A notice must never turn an empty probe into a model request.
    if (decision.messages.length === 0) return decision;

    const state = manager.stateFor(agent.session);
    if (!state) return decision;

    const newMessages = [];
    const reminderIds = [];
    for (const req of state.requirements.values()) {
      if (!req.satisfied && !req.exhausted && !req.notifiedInTurn && req.reminderCount < req.maxReminders) {
        reminderIds.push(req.id);
        newMessages.push(createUserMessage({
          content: [{ type: 'text', text: req.reminderMessage }],
          source: {
            kind: REQUIREMENT_SOURCE,
            form: 'notice',
            summary: `Requirement for tool ${req.requiredTool}`,
            id: req.id
          }
        }));
      }
    }

    if (newMessages.length === 0) return decision;
    for (const id of reminderIds) {
      state.pendingReminders.set(id, (state.pendingReminders.get(id) ?? 0) + 1);
    }
    return { ...decision, messages: [...decision.messages, ...newMessages] };
  }, { prepend: true });

  ctx.on('tools/result', (exec, result) => {
    if (exec.agent) manager.recordResult(exec.agent.session, exec, result);
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec.agent) return next();
    const state = manager.stateFor(exec.agent.session, exec.log?.turn);
    if (!state) return next();

    const satisfiedByCall = [];
    for (const req of state.requirements.values()) {
      if (req.satisfied || req.exhausted) continue;

      if (req.satisfies(exec)) {
        satisfiedByCall.push(req.id);
        continue;
      }

      // Allow evidence-gathering read-only tools to proceed
      if (READ_ONLY.has(exec.name)) {
        continue;
      }

      // Block side-effecting detours, including all calls after exhaustion.
      const checkResult = req.check(exec);
      state.violationsBlocked++;
      return {
        kind: 'deny',
        reason: JSON.stringify({
          code: req.exhausted || checkResult.status === 'exhausted' ? 'SOFT_TOOL_REQUIREMENT_EXHAUSTED' : 'SOFT_TOOL_REQUIREMENT_VIOLATION',
          reason: `Tool '${exec.name}' is not allowed while requirement '${req.id}' is active.`,
          requiredTool: req.requiredTool,
          nextAction: `Use '${req.requiredTool}' or gather read-only evidence before continuing.`,
          retryable: !req.exhausted && checkResult.status !== 'exhausted'
        })
      };
    }

    if (satisfiedByCall.length > 0) state.pendingSatisfaction.set(exec.callId, satisfiedByCall);
    return next();
  });

  return manager;
}
