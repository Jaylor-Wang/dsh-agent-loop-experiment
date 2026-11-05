import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Compose a prospective bundle in memory. Never load services or write a profile.
const root = fileURLToPath(new URL('../', import.meta.url));
const host = process.env.DSH_IMPLEMENTATION_ROOT ?? 'D:/nodejs/node_global/node_modules/@deepseek-ai/dsh';
const require = createRequire(path.join(host, 'package.json'));
const { bundlePatchPaths, composeEntries, loadOverlayPatches, resolveBundleDir, evaluatePluginCompatibility } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
const args = process.argv.slice(2);
const profileIndex = args.indexOf('--profile-dir');
const profile = path.resolve(profileIndex === -1 ? process.env.DSH_PROFILE_DIR ?? 'C:/Users/29507/.dsh/profiles/web' : args[profileIndex + 1]);
const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
const own = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(evaluatePluginCompatibility(own), undefined, 'Plugin version does not match this DSH runtime');
const layers = [];
let alreadySelected = false;
for (const bundle of manifest.dsh?.profile?.bundles ?? []) {
  const directory = bundle === own.name ? root : resolveBundleDir('dsh', bundle, path.join(host, 'package.json'), profile);
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  layers.push(bundlePatchPaths(directory, pkg.dsh.bundle).flatMap(filename => loadOverlayPatches('dsh', filename)));
  alreadySelected ||= bundle === own.name;
}
if (!alreadySelected) layers.push(loadOverlayPatches('dsh', path.join(root, 'cordis.patch.yml')));
for (const patch of [path.join(profile, 'cordis.patch.yml'), path.join(process.env.DSH_HOME ?? 'C:/Users/29507/.dsh', 'cordis.patch.yml')]) {
  if (fs.existsSync(patch)) layers.push(loadOverlayPatches('dsh', patch));
}
const warnings = [];
const entries = composeEntries(layers, (...values) => warnings.push(values));
const flatten = list => list.flatMap(entry => [entry, ...(entry.group && Array.isArray(entry.config) && !entry.disabled ? flatten(entry.config) : [])]);
const flat = flatten(entries);
const active = flat.filter(entry => !entry.disabled && ['@deepseek-ai/dsh-agent-loop', own.name, `${own.name}/replacement`].includes(entry.name));
const official = flat.find(entry => entry.id === 'agent-loop');
const replacement = flat.find(entry => entry.id === `${own.name}:loop`);
// Only compare loop-owned settings; never print declarative agent routes or user config.
const existingAgents = official?.config?.agents ?? [];
const replacementAgents = replacement?.config?.agents ?? [];
const loopSettingsPreserved = JSON.stringify(existingAgents) === JSON.stringify(replacementAgents)
  && (official?.config?.maxParallelToolCalls ?? 10) === (replacement?.config?.maxParallelToolCalls ?? 10);
const ready = warnings.length === 0 && active.length === 1 && active[0] === replacement && official?.disabled === true && loopSettingsPreserved;
console.log(JSON.stringify({
  mode: 'read-only-prospective-composition', profile: path.basename(profile), bundleAlreadySelected: alreadySelected,
  activeLoopCount: active.length, activeLoop: active[0]?.name ?? null, officialDisabled: official?.disabled === true,
  convergenceEnabled: replacement?.config?.convergence?.enabled === true,
  softStepBudget: replacement?.config?.convergence?.softStepBudget ?? null,
  originalAgentCount: existingAgents.length, replacementAgentCount: replacementAgents.length,
  loopSettingsPreserved, compositionWarnings: warnings.length, ready,
  note: loopSettingsPreserved ? 'Prospective configuration only; restart and runtime checks are still required after installation.' : 'Copy custom agents and concurrency settings to the replacement entry before switching.'
}, null, 2));
if (!ready) process.exitCode = 1;
