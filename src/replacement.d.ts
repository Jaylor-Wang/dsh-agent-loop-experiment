import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';
import { AgentLoop, type Config as OfficialConfig } from '../lib/types/index.js';
import type { ConvergenceConfig } from './index.js';

export interface ReplacementConfig {
  agents?: OfficialConfig['agents'];
  maxParallelToolCalls?: number;
  convergence?: ConvergenceConfig;
}
export declare class ReplacementAgentLoop extends AgentLoop {
  static Config: z<ReplacementConfig, OfficialConfig & { convergence: Required<ConvergenceConfig> }>;
  constructor(ctx: Context, config: OfficialConfig & { convergence: Required<ConvergenceConfig> });
}
export default ReplacementAgentLoop;
