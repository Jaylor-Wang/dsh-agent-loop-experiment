import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse one installed dependency graph so Cordis service identities stay shared.
const root = fileURLToPath(new URL('../', import.meta.url));
const host = path.resolve(process.env.DSH_IMPLEMENTATION_ROOT ?? 'D:/nodejs/node_global/node_modules/@deepseek-ai/dsh');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const hostManifest = JSON.parse(fs.readFileSync(path.join(host, 'package.json'), 'utf8'));
assert.equal(hostManifest.name, '@deepseek-ai/dsh');
const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, '@deepseek-ai/dsh-tool-executor-native': manifest.version, '@deepseek-ai/dsh-llm-pi-ai': manifest.version };
const created = [];
for (const [name, expected] of Object.entries(dependencies)) {
  const target = path.join(root, 'node_modules', name);
  if (fs.existsSync(target)) {
    const present = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    assert.equal(present.version, expected.replace(/^[~^]/, ''), `Existing local version differs for ${name}`);
    continue;
  }
  const nested = path.join(host, 'node_modules/@deepseek-ai/dsh-agent-loop/node_modules', name);
  const source = fs.existsSync(nested) ? nested : path.join(host, 'node_modules', name);
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  assert.equal(sourcePackage.name, name);
  assert.equal(sourcePackage.version, expected.replace(/^[~^]/, ''), `Host version mismatch for ${name}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  created.push(name);
}
const require = createRequire(path.join(root, 'package.json'));
for (const name of Object.keys(dependencies)) require.resolve(name);
const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const copiedHash = hash(path.join(root, 'lib/index.js'));
assert.equal(copiedHash, hash(path.join(host, 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js')), 'Copied official core differs from installed baseline');
console.log(JSON.stringify({ hostVersion: hostManifest.version, linked: created, dependencies: Object.keys(dependencies).length, officialCoreSha256: copiedHash, networkRequests: 0 }, null, 2));
