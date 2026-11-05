import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ReplacementAgentLoop from '../src/replacement.js';
import { GUIDANCE, SOURCE } from '../src/convergence.js';
import { call, createRuntime } from './support/runtime.js';

const hostAnchor = process.env.DSH_IMPLEMENTATION_ROOT ?? 'D:/nodejs/node_global/node_modules/@deepseek-ai/dsh';
const require = createRequire(`${hostAnchor}/package.json`);
const { composeEntries, loadOverlayPatches, evaluatePluginCompatibility } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);

test('bundle disables exactly the official loop and mounts one enabled replacement', () => {
  const warnings = [];
  const patches = loadOverlayPatches('dsh', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)));
  const entries = composeEntries([
    [{ insert: [{ id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } }, { id: 'unrelated', name: 'unrelated' }] }],
    patches
  ], (...args) => warnings.push(args));
  assert.equal(warnings.length, 0);
  assert.equal(entries.find(entry => entry.id === 'agent-loop').disabled, true);
  const active = entries.filter(entry => !entry.disabled && /agent-loop/.test(entry.name));
  assert.equal(active.length, 1);
  assert.equal(active[0].name, 'dsh-agent-loop-experiment/replacement');
  assert.equal(active[0].config.convergence.enabled, true);
  assert.equal(entries.find(entry => entry.id === 'unrelated').disabled, undefined);
});

test('removing bundle restores official loop through ordinary composition', () => {
  const entries = composeEntries([[{ insert: [{ id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } }] }]]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].disabled, undefined);
});

test('replacement preserves flat loop settings and registers guidance before startup agents', async t => {
  const host = await createRuntime({
    loopPlugin: ReplacementAgentLoop,
    loopConfig: { maxParallelToolCalls: 3, agents: [{ id: 'configured', provider: 'offline', model: 'scripted' }], convergence: { enabled: true, softStepBudget: 1 } },
    script: [[call()], [{ type: 'text', text: 'Complete.' }]]
  });
  t.after(() => host.dispose());
  assert.equal(host.ctx.agentLoop.config.maxParallelToolCalls.get(), 3);
  assert.equal(host.ctx.agentLoop.config.agents[0].id, 'configured');
  await host.run();
  assert.equal(host.requests.length, 2);
  assert.ok(host.requests[0].messages.some(message => message.content.some(block => block.text?.includes(GUIDANCE))));
  assert.equal(host.events.filter(event => event.type === 'user/message' && event.data.source?.kind === SOURCE).length, 1);
  assert.equal(host.errors.length, 0);
});

test('replacement policy remains opt-in when loaded without bundle defaults', async t => {
  const host = await createRuntime({ loopPlugin: ReplacementAgentLoop, loopConfig: {}, script: [[{ type: 'text', text: 'Complete.' }]] });
  t.after(() => host.dispose());
  await host.run();
  assert.equal(host.requests.length, 1);
  assert.ok(host.requests[0].messages.every(message => message.content.every(block => !block.text?.includes(GUIDANCE))));
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.2-rc.1'), undefined);
  assert.ok(evaluatePluginCompatibility(manifest, {}, '0.2.3'));
});
