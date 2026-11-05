import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolsService from '@deepseek-ai/dsh-tools';
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import OfficialLoop from '../../lib/index.js';
import experiment from '../../src/index.js';
import convergence from '../../src/convergence.js';

export const userMessage = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
export const call = (id = 'call-1', name = 'inspect', args = {}) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) });

export async function* response(blocks = [{ type: 'text', text: 'Complete.' }], finish) {
  for (const [index, block] of blocks.entries()) {
    yield { type: 'block-start', index, blockType: block.type };
    if (block.type === 'text') yield { type: 'text-delta', index, text: block.text };
    if (block.type === 'tool-call') yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
    yield { type: 'block-end', index, block };
  }
  yield { type: 'finish', reason: finish ?? { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } };
}

class ScriptedAdapter extends LlmAdapter {
  constructor(owner, script) { super(); this.owner = owner; this.script = script; }
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100000 }, reasoning: { efforts: [{ id: 'xhigh', name: 'xhigh' }] } });
  }
  async *stream(options) {
    const request = { ...options, messages: structuredClone(options.messages), tools: structuredClone(options.tools ?? []) };
    this.owner.requests.push(request);
    const index = this.owner.requests.length - 1;
    assert.ok(index < 100, 'Offline fixture exceeded its request guard');
    const step = typeof this.script === 'function' ? this.script(request, index, this.owner) : this.script[index];
    assert.ok(step, `Missing scripted response ${index}`);
    yield* typeof step === 'function' ? step(options, this.owner) : response(step);
  }
}

/** Run the copied official loop with real registries, LLM runtime and native executor. */
export async function createRuntime({ enabled = false, softStepBudget = 2, script = [[{ type: 'text', text: 'Complete.' }]], baseline = false, setup, scopedPolicy = false, seed, inspect, configureModel, configureTools, agentOptions, loopPlugin, loopConfig } = {}) {
  const ctx = new Context();
  const fibers = [];
  const handles = [];
  const owner = { ctx, requests: [], errors: [], calls: [], events: [], handles };
  const mount = async (plugin, config = {}) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
    return fiber;
  };
  try {
    await mount(SessionProjectionRegistry);
    await mount(SessionStore);
    await mount(AgentRegistry);
    await mount(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'Complete the task accurately.' });
    await mount(LlmRuntime);
    await mount(ToolsService);
    await mount(nativeExecutor);
    ctx.on('agent/error', ({ error }) => owner.errors.push(error));
    ctx.on('session/event', (_session, event) => owner.events.push(event));
    if (configureModel) await configureModel(ctx, owner);
    else ctx.llm.registerAdapter(['offline'], new ScriptedAdapter(owner, script));
    if (configureTools) await configureTools(ctx, owner);
    else ctx.tools.register({
      name: 'inspect', description: 'Read one independent piece of evidence.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) { owner.calls.push(exec.callId); return inspect ? inspect(args, exec) : 'Evidence verified.'; }
    });
    if (loopPlugin) await mount(loopPlugin, loopConfig);
    else if (baseline || scopedPolicy) await mount(OfficialLoop);
    else await mount(experiment, { convergence: { enabled, softStepBudget } });
    owner.create = async (options = {}) => {
      const handle = await ctx.agents.create({
        sessionId: `experiment-${randomUUID()}`,
        agentOptions: agentOptions ?? { provider: 'offline', model: 'scripted', reasoningEffort: 'xhigh' },
        ...options,
        setup: async (agentCtx, agent) => {
          if (scopedPolicy) await agentCtx.plugin(convergence, { enabled, softStepBudget });
          if (setup) await setup(agentCtx, agent, owner);
          if (options.setup) await options.setup(agentCtx, agent);
        }
      });
      handles.push(handle);
      return handle.agent;
    };
    owner.agent = await owner.create(seed ? { seed } : {});
    owner.run = async (text = 'Inspect the evidence and finish the task.') => {
      owner.agent.followup(userMessage(text));
      await owner.agent.whenIdle();
      return owner;
    };
    owner.dispose = async () => {
      for (const handle of [...handles].reverse()) await handle.dispose();
      for (const fiber of [...fibers].reverse()) await fiber.dispose();
    };
    return owner;
  } catch (error) {
    for (const handle of [...handles].reverse()) await handle.dispose();
    for (const fiber of [...fibers].reverse()) await fiber.dispose();
    throw error;
  }
}
