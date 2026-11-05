import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import AgentLoop from '../lib/index.js';
import convergence, { Config as ConvergenceConfig } from './convergence.js';

/** Preserve the official flat loop config and service owner for loader replacement. */
export class ReplacementAgentLoop extends AgentLoop {
  static Config = z.object({
    ...AgentLoop.Config.dict,
    convergence: ConvergenceConfig.default({})
  });

  constructor(ctx, config) {
    super(ctx, config);
    this.experimentRuntime = { ctx, convergence: config.convergence };
  }

  async [Service.init]() {
    const { ctx, convergence: config } = this.experimentRuntime;
    // Register policy before the official initialization can create startup agents.
    await ctx.plugin(convergence, config);
    await super[Service.init]();
  }
}

export default ReplacementAgentLoop;
