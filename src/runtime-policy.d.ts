import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export type RuntimePolicyMode = 'off' | 'observe' | 'enforce';

export interface RuntimePolicyOptions {
  mode?: RuntimePolicyMode;
  noProgressLimit?: number;
  recoveryAttemptLimit?: number;
  minLargeWriteBytes?: number;
}

export interface ToolFingerprintInput {
  name: string;
  targetPath?: string;
  opClass?: string;
  errorCode?: string;
  isError?: boolean;
  byteLength?: number;
}

export interface ClassifiedToolCall {
  name: string;
  opClass: string;
  targetPath: string;
  byteLength: number;
}

export interface RuntimePolicySummary {
  toolExecutions: number;
  failedToolExecutions: number;
  largeWrites: number;
  edits: number;
  writeBytes: number;
  editBytes: number;
  repeatedFingerprintHits: number;
  uniqueFingerprints: number;
  maxConsecutiveRepeats: number;
  noProgressHits: number;
  uniqueNoProgressFingerprints: number;
}

export declare const POLICY_SOURCE: 'loop-runtime-policy';
export declare const RuntimePolicyConfig: z<RuntimePolicyOptions>;
export declare function normalizePath(filePath?: string | null, cwd?: string): string;
export declare function sizeBucket(bytes?: number): string;
export declare function computeFingerprint(input: ToolFingerprintInput): string;
export declare function classifyToolCall(name: string, args?: Record<string, unknown>, cwd?: string): ClassifiedToolCall;

export declare class RuntimePolicyManager {
  readonly config: RuntimePolicyOptions;
  constructor(config?: RuntimePolicyOptions);
  onTurnStart(session: unknown, turn: number): void;
  onTurnEnd(session: unknown): void;
  onStepStart(session: unknown, turn: number, step: number): void;
  onCwdChange(session: unknown, cwd: string): void;
  recordExecution(session: unknown, exec: any, result: any): any;
  evaluatePreExecute(session: unknown, exec: any): any;
  getSummary(session: unknown, turn?: number): RuntimePolicySummary;
}

export declare function applyRuntimePolicy(ctx: Context, rawConfig?: RuntimePolicyOptions): RuntimePolicyManager | null;
