import assert from 'node:assert/strict';
import { createRuntime, call } from '../test/support/runtime.js';
import { SOURCE } from '../src/convergence.js';

// The fixture intentionally follows the same script in A/B. It tests integration,
// not whether a real model becomes more efficient after receiving the guidance.
const results = [];
for (const enabled of [false, true]) {
  const host = await createRuntime({ enabled, softStepBudget: 2, script: [
    [call('a'), call('b')], [call('c')], [call('d')], [{ type: 'text', text: 'Complete.' }]
  ] });
  try {
    await host.run();
    assert.equal(host.errors.length, 0);
    results.push({
      variant: enabled ? 'convergence' : 'baseline', modelRequests: host.requests.length,
      toolCalls: host.calls.length, reminders: host.events.filter(event => event.type === 'user/message' && event.data.source?.kind === SOURCE).length,
      completed: host.events.filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind === 'completed',
      historyPrefixesStable: host.requests.slice(1).every((request, index) => JSON.stringify(request.messages.slice(0, host.requests[index].messages.length)) === JSON.stringify(host.requests[index].messages))
    });
  } finally { await host.dispose(); }
}
console.log(JSON.stringify({ mode: 'offline-contract-check', networkRequests: 0, performanceClaim: 'None: real-model request-count and quality comparisons remain required.', results }, null, 2));
