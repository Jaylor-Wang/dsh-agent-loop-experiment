import type { Context } from '@deepseek-ai/cordis';
import type { Config as LoopConfig } from '../lib/types/index.js';
import type z from '@deepseek-ai/schemastery';
import type { RuntimePolicyOptions } from './runtime-policy.d.ts';
import type { FileMutationPolicyOptions } from './file-mutation-policy.d.ts';
import type { SoftToolRequirementOptions } from './soft-tool-requirement.d.ts';

export interface ConvergenceConfig {
  enabled?: boolean;
  softStepBudget?: number;
  recoverFailedWrites?: boolean;
  runtimePolicy?: RuntimePolicyOptions;
  policy?: RuntimePolicyOptions;
  fileMutationPolicy?: FileMutationPolicyOptions;
  mutationPolicy?: FileMutationPolicyOptions;
  softToolRequirement?: { enabled?: boolean; reminderLimit?: number; maxViolations?: number };
}
export interface ExperimentConfig {
  loop?: { agents?: LoopConfig['agents']; maxParallelToolCalls?: number };
  convergence?: ConvergenceConfig;
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'loop-convergence': { kind: 'loop-convergence'; form: 'notice'; summary: string };
    'loop-write-recovery': { kind: 'loop-write-recovery'; form: 'notice'; summary: string; callId: string };
    'loop-soft-tool-requirement': { kind: 'loop-soft-tool-requirement'; form: 'notice'; summary: string; id: string };
  }
}
export declare const name: string;
export declare const inject: string[];
export declare const Config: z<ExperimentConfig>;
export function apply(ctx: Context, config: ExperimentConfig): Promise<void>;
export { AgentLoop } from '../lib/types/index.js';
declare const plugin: { name: typeof name; inject: typeof inject; Config: typeof Config; apply: typeof apply };
export default plugin;
