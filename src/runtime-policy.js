import { createHash } from 'node:crypto';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

export const POLICY_SOURCE = 'loop-runtime-policy';

export const RuntimePolicyConfig = z.object({
  mode: z.union(['off', 'observe', 'enforce']).default('enforce'),
  noProgressLimit: z.number().step(1).min(1).default(2),
  recoveryAttemptLimit: z.number().step(1).min(1).max(1).default(1),
  minLargeWriteBytes: z.number().step(1).min(1).default(8192),
  maxShellCommandBytes: z.number().step(1).min(256).default(4096),
  maxInlineScriptBytes: z.number().step(1).min(128).default(512)
});

/**
 * Normalize file path representation (forward slashes, lowercase drive letters on Windows, trim).
 */
export function normalizePath(filePath, cwd = '') {
  if (typeof filePath !== 'string' || !filePath.trim()) return '';
  let normalized = filePath.trim().replace(/\\/g, '/');
  const normalizedCwd = typeof cwd === 'string' ? cwd.trim().replace(/\\/g, '/') : '';
  if (normalizedCwd && !path.posix.isAbsolute(normalized) && !/^[a-zA-Z]:\//.test(normalized)) {
    normalized = path.posix.join(normalizedCwd, normalized);
  }
  // Lowercase Windows drive letter if present
  if (/^[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  // Remove redundant trailing slashes and dot segments without resolving paths on the host OS.
  normalized = path.posix.normalize(normalized);
  if (normalized.length > 1 && normalized.endsWith('/') && !/^[a-z]:\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, '');
  if (normalized === '.') return '';
  return normalized;
}

/**
 * Size bucket to ensure fingerprint captures payload scale without storing payload bytes.
 */
export function sizeBucket(bytes) {
  if (!bytes || bytes <= 0) return '0';
  if (bytes < 1024) return '<1K';
  if (bytes < 8192) return '1K-8K';
  if (bytes < 65536) return '8K-64K';
  if (bytes < 524288) return '64K-512K';
  return '>512K';
}

/**
 * Generate a short, deterministic fingerprint string for a tool call.
 */
export function computeFingerprint({ name, targetPath, opClass, errorCode, isError, byteLength }) {
  const parts = [
    name ?? '',
    opClass ?? 'generic',
    normalizePath(targetPath),
    isError ? (errorCode ?? 'ERROR') : 'OK',
    sizeBucket(byteLength)
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/**
 * Classify a tool call and extract structured metadata without retaining bulk contents.
 */
function stableValue(value) {
  if (typeof value === 'string') {
    return { bytes: Buffer.byteLength(value, 'utf8'), hash: createHash('sha256').update(value).digest('hex').slice(0, 16) };
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function invocationKey(name, args, classified, cwd) {
  const identity = {
    name,
    opClass: classified.opClass,
    targetPath: normalizePath(classified.targetPath, cwd),
    byteLength: classified.byteLength,
    args: stableValue(args)
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
}

export function classifyToolCall(name, args = {}, cwd = '') {
  let targetPath = '';
  let opClass = 'generic';
  let byteLength = 0;

  if (name === 'write' || name === 'retry_failed_write') {
    opClass = 'write';
    targetPath = typeof args.file_path === 'string' ? args.file_path : '';
    if (typeof args.content === 'string') {
      byteLength = Buffer.byteLength(args.content, 'utf8');
    }
  } else if (name === 'edit') {
    opClass = 'edit';
    targetPath = typeof args.file_path === 'string' ? args.file_path : '';
    const newLen = typeof args.new_string === 'string' ? Buffer.byteLength(args.new_string, 'utf8') : 0;
    const oldLen = typeof args.old_string === 'string' ? Buffer.byteLength(args.old_string, 'utf8') : 0;
    byteLength = newLen + oldLen;
  } else if (name === 'read' || name === 'read_image') {
    opClass = 'read';
    targetPath = typeof args.file_path === 'string' ? args.file_path : '';
  } else if (name === 'glob' || name === 'grep') {
    opClass = 'search';
    targetPath = typeof args.path === 'string' ? args.path : '';
  } else if (name === 'bash') {
    opClass = 'shell';
    targetPath = typeof args.workdir === 'string' ? args.workdir : (cwd || '');
    if (typeof args.command === 'string') {
      byteLength = Buffer.byteLength(args.command, 'utf8');
    }
  }

  return { name, opClass, targetPath, byteLength };
}

/**
 * Core runtime policy manager managing state, fingerprinting, and observation.
 */
export class RuntimePolicyManager {
  constructor(config = {}) {
    this.config = RuntimePolicyConfig(config);
    this.sessionStates = new WeakMap();
  }

  stateFor(session, turn) {
    if (!session) return null;
    let state = this.sessionStates.get(session);
    const targetTurn = turn ?? state?.turn ?? 1;
    if (!state || state.turn !== targetTurn) {
      state = {
        turn: targetTurn,
        step: 0,
        cwd: state?.cwd ?? '',
        fingerprintCounts: new Map(), // fingerprint -> count in this turn
        consecutiveFingerprints: new Map(), // fingerprint -> count consecutive
        lastFingerprint: null,
        lastInvocationKey: null,
        consecutiveInvocationCount: 0,
        maxConsecutiveRepeats: 0,
        lastRecord: null,
        toolExecutions: 0,
        failedToolExecutions: 0,
        largeWrites: 0,
        edits: 0,
        writeBytes: 0,
        editBytes: 0,
        repeatedFingerprintHits: 0,
        noProgressHits: 0,
        noProgressFingerprints: new Set()
      };
      this.sessionStates.set(session, state);
    }
    return state;
  }

  onTurnStart(session, turn) {
    const existing = this.sessionStates.get(session);
    this.sessionStates.set(session, {
      turn,
      step: 0,
      cwd: existing?.cwd ?? '',
      fingerprintCounts: new Map(),
      consecutiveFingerprints: new Map(),
      lastFingerprint: null,
      lastInvocationKey: null,
      consecutiveInvocationCount: 0,
      maxConsecutiveRepeats: 0,
      lastRecord: null,
      toolExecutions: 0,
      failedToolExecutions: 0,
      largeWrites: 0,
      edits: 0,
      writeBytes: 0,
      editBytes: 0,
      repeatedFingerprintHits: 0,
      noProgressHits: 0,
      noProgressFingerprints: new Set()
    });
  }

  onTurnEnd(session) {
    // Keep state available for post-turn summary, but clean up references if needed
  }

  onStepStart(session, turn, step) {
    const state = this.stateFor(session, turn);
    if (state) state.step = step;
  }

  onCwdChange(session, newCwd) {
    const state = this.sessionStates.get(session);
    if (!state) return;
    state.cwd = newCwd;
    state.lastFingerprint = null;
    state.lastInvocationKey = null;
    state.consecutiveInvocationCount = 0;
    state.lastRecord = null;
  }

  recordExecution(session, exec, result) {
    if (!session || !exec) return null;
    const existing = this.sessionStates.get(session);
    const state = existing ?? this.stateFor(session, 1);
    if (!state) return null;

    const classified = classifyToolCall(exec.name, exec.arguments, state.cwd);
    const { name, opClass, targetPath, byteLength } = classified;
    const key = invocationKey(name, exec.arguments ?? {}, classified, state.cwd);
    const isError = Boolean(result?.isError);
    const errorMessage = result?.error?.message;
    const errorCode = result?.error?.info?.code ?? (isError
      ? `ERROR:${createHash('sha256').update(typeof errorMessage === 'string' ? errorMessage : '').digest('hex').slice(0, 16)}`
      : 'OK');

    const fp = computeFingerprint({
      name,
      targetPath: normalizePath(targetPath, state.cwd),
      opClass,
      errorCode,
      isError,
      byteLength
    });

    state.toolExecutions++;
    if (isError) state.failedToolExecutions++;

    if (opClass === 'write') {
      if (byteLength >= this.config.minLargeWriteBytes) state.largeWrites++;
      state.writeBytes += byteLength;
    } else if (opClass === 'edit') {
      state.edits++;
      state.editBytes += byteLength;
    }

    const previousCount = state.fingerprintCounts.get(fp) ?? 0;
    state.fingerprintCounts.set(fp, previousCount + 1);

    const isConsecutive = state.lastFingerprint === fp;
    const consecutiveCount = (isConsecutive ? (state.consecutiveFingerprints.get(fp) ?? 0) : 0) + 1;
    state.consecutiveFingerprints.set(fp, consecutiveCount);
    state.maxConsecutiveRepeats = Math.max(state.maxConsecutiveRepeats, consecutiveCount);
    state.lastFingerprint = fp;
    const failureKey = isError ? `${key}:${fp}` : null;
    state.consecutiveInvocationCount = failureKey
      ? (state.lastInvocationKey === failureKey ? state.consecutiveInvocationCount + 1 : 1)
      : 0;
    state.lastInvocationKey = failureKey;

    if (previousCount > 0) {
      state.repeatedFingerprintHits++;
    }

    if (isError && state.consecutiveInvocationCount >= this.config.noProgressLimit) {
      state.noProgressHits++;
      state.noProgressFingerprints.add(fp);
    }

    const record = {
      step: state.step,
      callId: exec.callId,
      name,
      opClass,
      targetPath: normalizePath(targetPath, state.cwd),
      byteLength,
      isError,
      errorCode,
      fingerprint: fp,
      invocationKey: key,
      failureKey,
      repeated: previousCount > 0,
      consecutive: consecutiveCount
    };
    state.lastRecord = record;
    if (!isError || key !== state.blockedInvocationKey) state.blockedInvocationKey = null;

    return {
      record,
      decision: {
        kind: this.config.mode === 'off' ? 'allow' : 'observe',
        fingerprint: fp,
        repeated: previousCount > 0,
        consecutive: consecutiveCount
      }
    };
  }

  evaluatePreExecute(session, exec) {
    if (this.config.mode !== 'enforce' || !session || !exec) return { kind: 'allow' };
    const state = this.sessionStates.get(session);
    if (!state) return { kind: 'allow' };
    const classified = classifyToolCall(exec.name, exec.arguments, state.cwd);
    const { name, opClass, targetPath } = classified;
    const key = invocationKey(name, exec.arguments ?? {}, classified, state.cwd);
    if (state.blockedInvocationKey === key) {
      return { kind: 'deny', reason: `[runtime-policy] Execution blocked: the same tool invocation was already denied after repeated identical failures.` };
    }

    // Guard against oversized shell commands or large embedded scripts (anti-spawn ENAMETOOLONG on Windows)
    if (name === 'bash' && exec.arguments && typeof exec.arguments.command === 'string') {
      const cmd = exec.arguments.command;
      const cmdBytes = Buffer.byteLength(cmd, 'utf8');
      const isHeredoc = /(?:cat|type)\s*<<\s*['"]?EOF/i.test(cmd);
      const isInlineScript = /(?:python|python3|node|pwsh)\s+(?:-c|-e|-Command)\s+['"][\s\S]+/i.test(cmd);

      const maxBytes = this.config.maxShellCommandBytes ?? 4096;
      const maxScriptBytes = this.config.maxInlineScriptBytes ?? 512;

      if (cmdBytes > maxBytes) {
        return {
          kind: 'deny',
          reason: JSON.stringify({
            code: 'EMBEDDED_SHELL_PAYLOAD_TOO_LARGE',
            reason: `Shell command size (${cmdBytes} bytes) exceeds safe limit of ${maxBytes} bytes (causes spawn ENAMETOOLONG on Windows).`,
            nextAction: "Write the script or deliverable to a file using native 'write' first, then execute it by file path.",
            retryable: false
          })
        };
      }

      if ((isHeredoc && cmdBytes > 256) || (isInlineScript && cmdBytes > maxScriptBytes)) {
        return {
          kind: 'deny',
          reason: JSON.stringify({
            code: 'EMBEDDED_SHELL_PAYLOAD_TOO_LARGE',
            reason: `Large script or deliverable embedded in shell argument (${cmdBytes} bytes). Never embed complete scripts or files in shell commands.`,
            nextAction: "Write a reusable script or deliverable using native 'write' first, then execute it by file path.",
            retryable: false
          })
        };
      }
    }

    const lastRecord = state.lastRecord;
    const candidateFingerprint = computeFingerprint({
      name, targetPath: normalizePath(targetPath, state.cwd), opClass,
      errorCode: lastRecord?.errorCode, isError: true, byteLength: classified.byteLength
    });
    if (lastRecord?.isError && lastRecord.failureKey === `${key}:${candidateFingerprint}`) {
      const normTarget = normalizePath(targetPath, state.cwd);
      if (lastRecord.name === name && lastRecord.opClass === opClass && lastRecord.targetPath === normTarget) {
        const consecutive = state.consecutiveInvocationCount;
        if (consecutive >= this.config.noProgressLimit) {
          state.blockedInvocationKey = key;
          state.noProgressHits++;
          state.noProgressFingerprints.add(lastRecord.fingerprint);
          return {
            kind: 'deny',
            reason: JSON.stringify({
              code: 'NO_PROGRESS',
              reason: `Tool '${name}' on '${normTarget || 'target'}' failed ${consecutive} times consecutively without progress (limit: ${this.config.noProgressLimit}).`,
              nextAction: 'Inspect the prior error and change the command, arguments, or target before retrying.',
              retryable: false
            })
          };
        }
      }
    }
    return { kind: 'allow' };
  }

  getSummary(session, turn) {
    const state = this.stateFor(session, turn);
    if (!state) {
      return {
        toolExecutions: 0,
        failedToolExecutions: 0,
        largeWrites: 0,
        edits: 0,
        writeBytes: 0,
        editBytes: 0,
        repeatedFingerprintHits: 0,
        uniqueFingerprints: 0,
        maxConsecutiveRepeats: 0,
        noProgressHits: 0,
        uniqueNoProgressFingerprints: 0
      };
    }

    return {
      toolExecutions: state.toolExecutions,
      failedToolExecutions: state.failedToolExecutions,
      largeWrites: state.largeWrites,
      edits: state.edits,
      writeBytes: state.writeBytes,
      editBytes: state.editBytes,
      repeatedFingerprintHits: state.repeatedFingerprintHits,
      uniqueFingerprints: state.fingerprintCounts.size,
      maxConsecutiveRepeats: state.maxConsecutiveRepeats,
      noProgressHits: state.noProgressHits ?? 0,
      uniqueNoProgressFingerprints: state.noProgressFingerprints?.size ?? 0
    };
  }
}

/**
 * Apply the runtime policy plugin to the Cordis context.
 */
export function applyRuntimePolicy(ctx, rawConfig = {}) {
  const config = RuntimePolicyConfig(rawConfig);
  if (config.mode === 'off') return null;

  const manager = new RuntimePolicyManager(config);

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      manager.onTurnStart(session, event.data.turn);
    } else if (event.type === 'turn/end') {
      manager.onTurnEnd(session);
    } else if (event.type === 'step/start') {
      manager.onStepStart(session, event.data.turn, event.data.step);
    } else if (event.type === 'working-directory/change') {
      manager.onCwdChange(session, event.data.cwd);
    }
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec.agent) return next();
    const decision = manager.evaluatePreExecute(exec.agent.session, exec);
    if (decision.kind === 'deny') {
      return decision;
    }
    return next();
  });

  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent) return;
    manager.recordExecution(exec.agent.session, exec, result);
  });

  return manager;
}
