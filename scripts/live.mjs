import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai';
import { installProbe } from '../experiments/probe.js';
import { createRuntime } from '../test/support/runtime.js';

const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
assert.ok(args.includes('--config'), 'Pass --config experiments/live.example.json');
const configFile = path.resolve(value('--config'));
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const variant = args.includes('--variant') ? value('--variant') : 'baseline';
assert.ok(['baseline', 'convergence'].includes(variant), 'Variant must be baseline or convergence');
assert.ok(config.provider && config.model && config.route);
assert.equal(typeof config.route.apiKeyEnv, 'string', 'Provide a credential environment variable name');
assert.equal(config.route.apiKey, undefined, 'Do not place credentials in the configuration');
assert.equal(config.route.headers, undefined, 'Use environment credentials instead of configured headers');
const endpoint = new URL(config.route.baseURL);
assert.ok(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)));
assert.equal(endpoint.username + endpoint.password, '', 'Do not embed credentials in endpoint URLs');
const task = JSON.parse(fs.readFileSync(path.resolve(path.dirname(configFile), config.task), 'utf8'));
const outputFile = args.includes('--output') ? path.resolve(value('--output')) : undefined;
if (outputFile) assert.equal(fs.existsSync(outputFile), false, 'Choose a new output filename');
const run = args.includes('--run');
let probe;
const host = await createRuntime({
  enabled: variant === 'convergence', softStepBudget: config.softStepBudget ?? 8,
  agentOptions: { provider: config.provider, model: config.model, ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) },
  async configureModel(ctx) {
    // Read credentials only on an explicitly requested live run; never persist them.
    ctx.provide('credentials', {
      async resolve(ref) {
        if (!run) return { value: 'offline-dry-run-placeholder' };
        const key = process.env[String(ref)];
        assert.ok(key, 'Set the configured credential environment variable before --run');
        return { value: key };
      },
      async readRecord() { return undefined; }
    });
    await ctx.plugin(piAi, { providers: { [config.provider]: config.route } });
  },
  configureTools(ctx) { probe = installProbe(ctx, task); }
});
try {
  await host.ctx.llm.prepareCall({ provider: config.provider, model: config.model, ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) });
  if (!run) {
    console.log(JSON.stringify({ mode: 'dry-run', variant, provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort ?? 'adapter default', task: task.id, softStepBudget: config.softStepBudget ?? 8, networkRequests: 0, ready: true, next: 'Add --run to send real model requests using this isolated in-memory task.' }, null, 2));
  } else {
    assert.ok(process.env[config.route.apiKeyEnv], 'Set the configured credential environment variable before --run');
    let timedOut = false;
    assert.ok(Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0, 'timeoutMs must be a positive integer');
    const timer = setTimeout(() => { timedOut = true; host.agent.cancel({ kind: 'hook', reason: 'Experiment timeout.' }); }, config.timeoutMs);
    const start = performance.now();
    try { await host.run(task.prompt); } finally { clearTimeout(timer); }
    const result = { variant, provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort ?? null, ...probe.summarize(host.events, performance.now() - start, timedOut), errors: host.errors.length };
    if (outputFile) fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify(result, null, 2));
    if (result.errors || !result.quality.passed || timedOut) process.exitCode = 1;
  }
} finally { await host.dispose(); }
