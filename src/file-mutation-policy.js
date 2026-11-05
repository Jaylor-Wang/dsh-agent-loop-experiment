import fs from 'node:fs';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { normalizePath } from './runtime-policy.js';

export const MUTATION_SOURCE = 'loop-file-mutation-policy';

export const FileMutationPolicyConfig = z.object({
  mode: z.union(['off', 'observe', 'enforce']).default('observe'),
  minLargeWriteBytes: z.number().step(1).min(1).default(8192),
  reminderLimit: z.number().step(1).min(1).default(1),
  allowFullReplacement: z.any()
});

/**
 * Check safely whether a file path exists on the local filesystem.
 */
export function fileExists(filePath, cwd = '') {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || process.cwd(), filePath);
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}

/**
 * Manager tracking file reads, writes, and enforcing edit vs write constraints.
 */
export class FileMutationPolicyManager {
  constructor(config = {}) {
    this.config = FileMutationPolicyConfig(config);
    this.sessionStates = new WeakMap();
  }

  stateFor(session, turn) {
    if (!session) return null;
    let state = this.sessionStates.get(session);
    const targetTurn = turn ?? state?.turn ?? 1;
    if (!state || state.turn !== targetTurn) {
      state = {
        turn: targetTurn,
        cwd: state?.cwd ?? '',
        observedFiles: new Set(),
        knownExistingFiles: new Set(),
        createdFiles: new Set(),
        pendingCreates: new Map(),
        largeWriteViolations: 0,
        largeWritesBlocked: 0,
        fullReplacementsAllowed: 0,
        editsCount: 0,
        records: []
      };
      this.sessionStates.set(session, state);
    }
    return state;
  }

  onTurnStart(session, turn) {
    const existing = this.sessionStates.get(session);
    this.sessionStates.set(session, {
      turn,
      cwd: existing?.cwd ?? '',
      observedFiles: new Set(),
      knownExistingFiles: new Set(),
      createdFiles: new Set(),
      pendingCreates: new Map(),
      largeWriteViolations: 0,
      largeWritesBlocked: 0,
      fullReplacementsAllowed: 0,
      editsCount: 0,
      records: []
    });
  }

  onTurnEnd(session) {
    const state = this.sessionStates.get(session);
    state?.pendingCreates.clear();
  }

  onCwdChange(session, newCwd) {
    const state = this.sessionStates.get(session);
    if (!state) return;
    state.cwd = newCwd;
    state.observedFiles.clear();
    state.knownExistingFiles.clear();
    state.createdFiles.clear();
    state.pendingCreates.clear();
  }

  evaluateToolExecution(session, exec, toolsService) {
    if (this.config.mode === 'off' || !session || !exec) {
      return { allowed: true, reason: 'policy-off' };
    }
    const state = this.stateFor(session);
    if (!state) return { allowed: true, reason: 'no-state' };

    // PTC nested sub-calls (such as retry_failed_write dispatches) are exempt
    if (exec.parent !== undefined) {
      return { allowed: true, reason: 'nested-ptc-call' };
    }

    if (exec.name === 'retry_failed_write') {
      return { allowed: true, reason: 'recovery-tool' };
    }

    if (exec.name !== 'write') {
      return { allowed: true, reason: 'not-write' };
    }

    const args = exec.arguments ?? {};
    const targetPath = typeof args.file_path === 'string' ? args.file_path : '';
    const normPath = normalizePath(targetPath, state.cwd);
    const content = typeof args.content === 'string' ? args.content : '';
    const byteLength = Buffer.byteLength(content, 'utf8');

    // Files created earlier in this turn may be rewritten safely.
    if (state.createdFiles.has(normPath)) {
      return { allowed: true, reason: 'created-in-this-turn' };
    }

    // A missing target is a new-file write regardless of payload size.
    const createPending = [...state.pendingCreates.values()].includes(normPath);
    const knownExisting = state.knownExistingFiles.has(normPath) || fileExists(targetPath, state.cwd);
    if (!knownExisting && !createPending) {
      state.pendingCreates.set(exec.callId, normPath);
      return { allowed: true, reason: 'target-does-not-exist' };
    }

    // Small writes do not need edit guidance for known existing files.
    if (byteLength < this.config.minLargeWriteBytes) {
      return { allowed: true, reason: 'below-size-threshold' };
    }

    // If edit is unavailable, do not trap the agent.
    if (toolsService && toolsService.get && toolsService.get('edit', exec.agent) === undefined) {
      return { allowed: true, reason: 'no-edit-available' };
    }

    // Explicit host approval permits a full replacement.
    let hostApprovedReplacement = false;
    try {
      hostApprovedReplacement = typeof this.config.allowFullReplacement === 'function'
        && this.config.allowFullReplacement(exec, normPath) === true;
    } catch {
      // A broken host callback must not turn a policy check into an agent-loop failure.
    }
    if (hostApprovedReplacement) {
      state.fullReplacementsAllowed++;
      return { allowed: true, reason: 'host-approved-replacement' };
    }

    // Target exists, write is large, edit is available, and no full replacement is approved.
    state.largeWriteViolations++;
    const violation = {
      callId: exec.callId,
      targetPath: normPath,
      byteLength,
      code: 'LARGE_WRITE_EXISTING_FILE',
      reason: 'target is known existing and the call appears to replace the whole file',
      nextAction: 'use edit with an exact unique match, or use the host-approved full-replacement path',
      retryable: false
    };
    state.records.push(violation);

    if (this.config.mode === 'enforce') {
      state.largeWritesBlocked++;
      return {
        allowed: false,
        ...violation
      };
    }

    return {
      allowed: true,
      ...violation
    };
  }

  recordResult(session, exec, result) {
    if (!session || !exec) return;
    const state = this.stateFor(session);
    if (!state) return;

    const args = exec.arguments ?? {};
    if (exec.name === 'write') {
      const pendingPath = state.pendingCreates.get(exec.callId);
      state.pendingCreates.delete(exec.callId);
      if (result && !result.isError && pendingPath) state.createdFiles.add(pendingPath);
    } else if (result?.isError) {
      return;
    } else if (exec.name === 'edit') {
      state.editsCount++;
      if (typeof args.file_path === 'string') {
        const filePath = normalizePath(args.file_path, state.cwd);
        state.observedFiles.add(filePath);
        state.knownExistingFiles.add(filePath);
      }
    } else if (['read', 'read_image'].includes(exec.name)) {
      if (typeof args.file_path === 'string') {
        const filePath = normalizePath(args.file_path, state.cwd);
        state.observedFiles.add(filePath);
        state.knownExistingFiles.add(filePath);
      }
    } else if (['grep', 'glob'].includes(exec.name)) {
      if (typeof args.path === 'string') {
        state.observedFiles.add(normalizePath(args.path, state.cwd));
      }
    }
  }

  getSummary(session, turn) {
    const state = this.stateFor(session, turn);
    if (!state) {
      return {
        largeWriteViolations: 0,
        largeWritesBlocked: 0,
        fullReplacementsAllowed: 0,
        editsCount: 0,
        observedFiles: 0,
        createdFiles: 0
      };
    }
    return {
      largeWriteViolations: state.largeWriteViolations,
      largeWritesBlocked: state.largeWritesBlocked,
      fullReplacementsAllowed: state.fullReplacementsAllowed,
      editsCount: state.editsCount,
      observedFiles: state.observedFiles.size,
      createdFiles: state.createdFiles.size
    };
  }
}

/**
 * Apply file mutation policy to Cordis context.
 */
export function applyFileMutationPolicy(ctx, rawConfig = {}) {
  const config = FileMutationPolicyConfig(rawConfig);
  if (config.mode === 'off') return null;

  const manager = new FileMutationPolicyManager(config);

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      manager.onTurnStart(session, event.data.turn);
    } else if (event.type === 'turn/end') {
      manager.onTurnEnd(session);
    } else if (event.type === 'working-directory/change') {
      manager.onCwdChange(session, event.data.cwd);
    }
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec.agent) return next();
    const decision = manager.evaluateToolExecution(exec.agent.session, exec, ctx.tools);
    if (!decision.allowed) {
      return {
        kind: 'deny',
        reason: JSON.stringify({
          code: decision.code,
          reason: decision.reason,
          nextAction: decision.nextAction,
          retryable: decision.retryable
        })
      };
    }
    return next();
  });

  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent) return;
    manager.recordResult(exec.agent.session, exec, result);
  });

  return manager;
}
