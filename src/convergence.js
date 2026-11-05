import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { applyFailureRecovery } from './failure-recovery.js';
import { applyRuntimePolicy, RuntimePolicyConfig } from './runtime-policy.js';
import { applyFileMutationPolicy, FileMutationPolicyConfig } from './file-mutation-policy.js';
import { applySoftToolRequirement, SoftToolRequirementConfig } from './soft-tool-requirement.js';

export const name = 'agent-loop-convergence';
export const inject = ['systemPrompt', 'tools'];
export const SOURCE = 'loop-convergence';
export const GUIDANCE = [
  'Work toward the user\'s completion criteria with as few model round trips as practical.',
  'Before emitting the first large payload, choose its file destination: write new deliverables with native write; when computation is needed, prefer existing project tools or a reusable script written with native write and executed by file path. Never embed complete files or large scripts in shell arguments, including node -e, python -c, or pwsh -Command. After spawn ENAMETOOLONG, use file input for subsequent large payloads in this turn.',
  'For related calculations with known inputs, combine bounded parameter comparisons, generation, and validation in one run; keep tunable inputs together and reuse the script and established results. Return concise conclusions, failed checks, and output paths; keep bulk generated content in files. Keep exploration staged when the next choice requires new evidence or batching would add substantial cost or side effects. Small one-off calculations need no script scaffolding.',
  'For localized revisions, reuse current relevant file content already available and read only missing or stale context; prefer native edit with an unambiguous match over re-emitting the whole file. For generated artifacts, update the source or generator and use the established build process. Preserve unrelated changes, encoding, and line endings. A full write is appropriate for new files, an explicitly requested full replacement, a necessary broad rewrite, or when a targeted edit cannot be applied reliably. Check existing content before replacing it and verify the affected behavior afterward.',
  'Batch independent reads, searches, and checks in one response when their inputs are known; preserve dependencies and exclusive tool barriers. Probe environment capabilities only when missing information blocks the next action.',
  'After receiving results, make the next complete useful decision. Do not repeat equivalent searches or verification unless new evidence justifies them.',
  'Track task-created resource IDs and artifact paths as they are created. After verification, batch compatible session/server shutdowns and temporary-artifact cleanup while preserving required ordering. Use known paths and prior results; avoid repeated directory listings or unsolicited backup copies. Confirm asynchronous shutdown through its completion result before delivering.',
  'Once the requested outcome and relevant verification are complete, deliver the result. If work remains, continue the necessary work and identify the specific missing evidence.',
  'This efficiency guidance never overrides the user, correctness, permission checks, required verification, or cancellation.'
].join('\n');
export const REMINDER = [
  'The soft step budget for this turn has been reached. Reassess the remaining completion criteria using the evidence already available.',
  'If the task and required verification are complete, provide the final result now. Otherwise, perform the specific remaining work: reuse established results, combine bounded calculations with known inputs, prefer native edit for localized revisions, and batch compatible cleanup. Keep large payloads in files; update the source or generator for generated artifacts. Preserve dependencies, evidence-driven exploration, and required checks.',
  'This is a one-time efficiency reminder, not a step limit or permission to omit required work.'
].join('\n');
export const Config = z.object({
  enabled: z.boolean().default(false),
  softStepBudget: z.number().step(1).min(1).max(10000).default(8),
  recoverFailedWrites: z.boolean().default(true),
  runtimePolicy: RuntimePolicyConfig.default({}),
  policy: RuntimePolicyConfig.default({}),
  fileMutationPolicy: FileMutationPolicyConfig.default({}),
  mutationPolicy: FileMutationPolicyConfig.default({}),
  softToolRequirement: SoftToolRequirementConfig.default({})
});

/** Add guidance through public channels without taking over the loop's decisions. */
export function apply(ctx, raw = {}) {
  const config = Config(raw);
  if (!config.enabled) return;
  const policyConfig = raw.runtimePolicy ?? raw.policy ?? config.runtimePolicy ?? {};
  if (config.recoverFailedWrites) {
    applyFailureRecovery(ctx, { maxAttempts: policyConfig.recoveryAttemptLimit ?? config.runtimePolicy.recoveryAttemptLimit });
  }
  const runtimePolicyManager = applyRuntimePolicy(ctx, policyConfig);
  if (runtimePolicyManager) ctx.provide('runtimePolicy', runtimePolicyManager);
  const mutationConfig = raw.fileMutationPolicy ?? raw.mutationPolicy ?? config.fileMutationPolicy ?? {};
  const fileMutationPolicyManager = applyFileMutationPolicy(ctx, mutationConfig);
  if (fileMutationPolicyManager) ctx.provide('fileMutationPolicy', fileMutationPolicyManager);
  const reqConfig = raw.softToolRequirement ?? config.softToolRequirement ?? {};
  const softToolReqManager = applySoftToolRequirement(ctx, reqConfig);
  if (softToolReqManager) ctx.provide('softToolRequirement', softToolReqManager);
  const states = new WeakMap();
  const stateFor = (session, turn) => {
    let state = states.get(session);
    if (!state || state.turn !== turn) {
      state = { turn, steps: 0, reminded: false, toolResults: 0, concluded: false };
      // Restore only the current turn when mounting onto a running/resumed agent.
      for (const event of session.snapshotEvents()) {
        if (event.type === 'step/start' && event.data.turn === turn) state.steps++;
        if (event.type === 'turn/start' && event.data.turn === turn) state.startSeq = event.seq;
        if (event.type === 'user/message' && event.data.source?.kind === SOURCE && event.seq > (state.startSeq ?? Infinity)) state.reminded = true;
      }
      states.set(session, state);
    }
    return state;
  };
  ctx.systemPrompt.section({ name: 'experiment:convergence', order: 650, text: GUIDANCE, interpolate: false });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      states.set(session, { turn: event.data.turn, steps: 0, reminded: false, startSeq: event.seq, toolResults: 0, concluded: false });
      return;
    }
    const state = states.get(session);
    if (!state) return;
    if (event.type === 'step/start' && event.data.turn === state.turn) {
      state.steps++;
      state.toolResults = 0;
      state.concluded = false;
    }
    if (event.type === 'user/message' && event.data.source?.kind === SOURCE) state.reminded = true;
  });
  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent) return;
    const state = states.get(exec.agent.session);
    if (!state) return;
    state.toolResults++;
    state.concluded ||= result.concludesTurn === true;
  });
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal, messages }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || signal.aborted) return decision;
    // Preserve downstream empty-input decisions, including the loop's empty first step.
    if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision;
    const state = stateFor(agent.session, turn);
    if (state.reminded || state.steps < config.softStepBudget) return decision;
    // A terminal response also runs preStep once. Never turn its empty probe into work.
    if (decision.messages.length === 0 && (state.toolResults === 0 || state.concluded)) return decision;
    const reminder = createUserMessage({
      content: [{ type: 'text', text: REMINDER }],
      source: { kind: SOURCE, form: 'notice', summary: 'Reassess remaining work after the soft step budget.' }
    });
    // Admission owns the commit. Failed/canceled admission must not consume the reminder.
    return { ...decision, messages: [...decision.messages, reminder] };
  }, { prepend: true });
}

export default { name, inject, Config, apply };
