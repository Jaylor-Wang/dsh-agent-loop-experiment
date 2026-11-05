import z from '@deepseek-ai/schemastery';
import AgentLoop from '../lib/index.js';
import convergence, { Config as ConvergenceConfig } from './convergence.js';

export const name = 'agent-loop-experiment';
export const inject = AgentLoop.inject;
export const Config = z.object({
  // The official plugin owns loop validation, including volatile config fields.
  loop: z.any().default({}),
  convergence: ConvergenceConfig.default({})
});

/** Mount exactly one unchanged official loop, with optional scoped policy. */
export async function apply(ctx, config) {
  await ctx.plugin(convergence, config.convergence);
  await ctx.plugin(AgentLoop, config.loop);
}

export { AgentLoop };
export default { name, inject, Config, apply };
