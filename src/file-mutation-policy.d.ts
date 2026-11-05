import { Context } from '@deepseek-ai/cordis';

export type FileMutationPolicyMode = 'off' | 'observe' | 'enforce';

export interface FileMutationPolicyOptions {
  mode?: FileMutationPolicyMode;
  minLargeWriteBytes?: number;
  reminderLimit?: number;
  allowFullReplacement?: (exec: any, targetPath: string) => boolean;
}

export interface FileMutationPolicySummary {
  largeWriteViolations: number;
  largeWritesBlocked: number;
  fullReplacementsAllowed: number;
  editsCount: number;
  observedFiles: number;
  createdFiles: number;
}

export declare function fileExists(filePath: string, cwd?: string): boolean;

export declare class FileMutationPolicyManager {
  config: Required<FileMutationPolicyOptions>;
  constructor(config?: FileMutationPolicyOptions);
  stateFor(session: any, turn?: number): any;
  onTurnStart(session: any, turn: number): void;
  onTurnEnd(session: any): void;
  onCwdChange(session: any, newCwd: string): void;
  evaluateToolExecution(session: any, exec: any, toolsService?: any): {
    allowed: boolean;
    reason?: string;
    code?: string;
    nextAction?: string;
    retryable?: boolean;
  };
  recordResult(session: any, exec: any, result: any): void;
  getSummary(session: any, turn?: number): FileMutationPolicySummary;
}

export declare function applyFileMutationPolicy(
  ctx: Context,
  rawConfig?: FileMutationPolicyOptions
): FileMutationPolicyManager | null;
