import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export interface SoftToolRequirementOptions {
  id: string;
  requiredTool: string;
  satisfies?: (exec: any) => boolean;
  reminderMessage: string;
  maxReminders?: number;
  maxViolations?: number;
}

export interface SoftToolRequirementSummary {
  activeCount: number;
  satisfiedCount: number;
  violationsBlocked: number;
  exhaustedCount: number;
}

export declare const REQUIREMENT_SOURCE: 'loop-soft-tool-requirement';

export declare class SoftToolRequirement {
  id: string;
  requiredTool: string;
  reminderMessage: string;
  reminderCount: number;
  violationCount: number;
  maxReminders: number;
  maxViolations: number;
  satisfied: boolean;
  exhausted: boolean;
  constructor(options: SoftToolRequirementOptions);
  check(exec: any): { status: 'inactive' | 'satisfied' | 'violated' | 'exhausted' };
}

export declare class SoftToolRequirementManager {
  constructor(config?: any);
  stateFor(session: any, turn?: number): any;
  addRequirement(session: any, options: SoftToolRequirementOptions): SoftToolRequirement | null;
  removeRequirement(session: any, id: string): void;
  onTurnStart(session: any, turn: number): void;
  onTurnEnd(session: any): void;
  markReminder(session: any, id: string): void;
  recordResult(session: any, exec: any, result: any): void;
  getSummary(session: any): SoftToolRequirementSummary;
}

export declare function applySoftToolRequirement(ctx: Context, rawConfig?: any): SoftToolRequirementManager | null;
