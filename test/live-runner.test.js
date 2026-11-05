import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const taskPath = fileURLToPath(new URL('../experiments/task.json', import.meta.url));
const fixture = JSON.parse(fs.readFileSync(taskPath, 'utf8'));

test('real adapter runner executes both variants against a loopback SSE fixture and grades evidence', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const hasResults = body.messages.some(message => message.role === 'tool');
    const delta = hasResults ? { content: JSON.stringify(fixture.expected) } : {
      tool_calls: Object.keys(fixture.records).map((name, index) => ({ index, id: `fixture-${index}`, type: 'function', function: { name: 'read_record', arguments: JSON.stringify({ name }) } }))
    };
    const frame = (part, finishReason) => ({ id: 'fixture-response', object: 'chat.completion.chunk', created: 0, model: 'fixture-model', choices: [{ index: 0, delta: part, finish_reason: finishReason }] });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(frame(delta, null))}\n\n`);
    res.write(`data: ${JSON.stringify(frame({}, hasResults ? 'stop' : 'tool_calls'))}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-loop-experiment-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('dsh-loop-experiment-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const configFile = path.join(directory, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    provider: 'fixture', model: 'fixture-model', softStepBudget: 1, timeoutMs: 5000, task: taskPath,
    route: { api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'DSH_LOOP_TEST_KEY', models: [{ id: 'fixture-model', contextWindow: 100000, input: ['text'] }] }
  }), 'utf8');
  for (const variant of ['baseline', 'convergence']) {
    const { stdout } = await execute(process.execPath, ['scripts/live.mjs', '--config', configFile, '--variant', variant, '--run'], {
      cwd: root, env: { ...process.env, DSH_LOOP_TEST_KEY: 'local-fixture-placeholder' }, timeout: 10000
    });
    const result = JSON.parse(stdout);
    assert.equal(result.modelRequests, 2);
    assert.equal(result.toolCalls, 4);
    assert.equal(result.failedToolCalls, 0);
    assert.equal(result.largeWrites, 0);
    assert.equal(result.edits, 0);
    assert.ok(Array.isArray(result.requestStreamMs));
    assert.equal(result.requestStreamMs.length, 2);
    assert.equal(result.quality.passed, true);
    assert.equal(result.repeatedRecordReads, 0);
    assert.equal(result.prefixChanges, 0);
    assert.equal(result.errors, 0);
    assert.equal(result.reminders, variant === 'convergence' ? 1 : 0);
  }
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages);
  assert.deepEqual(requests[3].messages.slice(0, requests[2].messages.length), requests[2].messages);
});
