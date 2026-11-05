import assert from 'node:assert/strict';
import { SOURCE } from '../src/convergence.js';

/** Read-only task fixture and aggregate metrics, shared by real and offline runs. */
export function installProbe(ctx, task) {
  assert.equal(typeof task.prompt, 'string');
  assert.ok(task.records && Object.keys(task.records).length > 0);
  const reads = new Map();
  let currentSession = null;
  ctx.on('session/event', session => { currentSession = session; });
  ctx.tools.register({
    name: 'list_records', description: 'List the available incident record names.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute() { return JSON.stringify(Object.keys(task.records)); }
  });
  ctx.tools.register({
    name: 'read_record', description: 'Read one incident record by name. Independent records can be read together.',
    parameters: { type: 'object', properties: { name: { type: 'string', enum: Object.keys(task.records) } }, required: ['name'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      assert.ok(Object.hasOwn(task.records, args.name), 'Unknown fixture record');
      reads.set(args.name, (reads.get(args.name) ?? 0) + 1);
      return task.records[args.name];
    }
  });
  const attempts = [];
  let previous;
  let prefixChanges = 0;
  ctx.on('llm/stream', (options, next) => {
    const history = options.messages.map(message => JSON.stringify(message));
    if (previous?.some((message, index) => history[index] !== message)) prefixChanges++;
    previous = history;
    const item = { started: performance.now(), elapsedMs: null, firstTokenMs: null, usage: null };
    attempts.push(item);
    const stream = next();
    return (async function* () {
      try {
        for await (const chunk of stream) {
          const token = (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') ? chunk.text !== '' : chunk.type === 'tool-call-delta' && (chunk.name !== undefined || chunk.argumentsDelta !== '');
          if (token && item.firstTokenMs === null) item.firstTokenMs = performance.now() - item.started;
          if (chunk.type === 'usage') item.usage = chunk.usage;
          yield chunk;
        }
      } finally { item.elapsedMs = performance.now() - item.started; }
    })();
  });
  return {
    summarize(events, elapsedMs, timedOut) {
      const last = events.filter(event => event.type === 'assistant/message').at(-1);
      const finalText = last?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? '';
      let parsed;
      try { parsed = JSON.parse(finalText.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* Quality check reports failure. */ }
      const checks = Object.entries(task.expected).map(([key, value]) => ({ key, correct: parsed?.[key] === value, read: reads.has(key) }));
      const exactKeys = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        && JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify(Object.keys(task.expected).sort());
      const total = key => attempts.reduce((n, attempt) => n + (attempt.usage?.[key] ?? 0), 0);
      const firstTokens = attempts.map(attempt => attempt.firstTokenMs).filter(Number.isFinite).sort((a, b) => a - b);
      const quantile = p => firstTokens.length ? firstTokens[Math.ceil(firstTokens.length * p) - 1] : null;
      const policySummary = currentSession ? ctx.get('runtimePolicy')?.getSummary(currentSession) : null;
      const mutationSummary = currentSession ? ctx.get('fileMutationPolicy')?.getSummary(currentSession) : null;
      const recoveryStats = currentSession ? ctx.get('failureRecovery')?.getStats(currentSession) : null;
      const requirementSummary = currentSession ? ctx.get('softToolRequirement')?.getSummary(currentSession) : null;
      return {
        task: task.id, elapsedMs, timedOut, modelRequests: attempts.length,
        modelStreamMs: attempts.reduce((n, attempt) => n + (attempt.elapsedMs ?? 0), 0),
        requestStreamMs: attempts.map(attempt => Math.round((attempt.elapsedMs ?? 0) * 100) / 100),
        firstTokenMs: { n: firstTokens.length, p50: quantile(0.5), p95: quantile(0.95) },
        toolCalls: events.filter(event => event.type === 'tool/call').length,
        failedToolCalls: events.filter(event => event.type === 'tool/result' && event.data.message?.isError).length,
        largeWrites: events.filter(event => event.type === 'tool/call' && event.data.name === 'write' && (event.data.arguments?.length ?? 0) >= 8192).length,
        edits: events.filter(event => event.type === 'tool/call' && event.data.name === 'edit').length,
        writeBytes: events.filter(event => event.type === 'tool/call' && (event.data.name === 'write' || event.data.name === 'retry_failed_write')).reduce((sum, e) => sum + (e.data.arguments?.length ?? 0), 0),
        editBytes: events.filter(event => event.type === 'tool/call' && event.data.name === 'edit').reduce((sum, e) => sum + (e.data.arguments?.length ?? 0), 0),
        repeatedRecordReads: [...reads.values()].reduce((n, count) => n + Math.max(0, count - 1), 0),
        reminders: events.filter(event => event.type === 'user/message' && event.data.source?.kind === SOURCE).length,
        recoveryNotices: events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'loop-write-recovery').length,
        requirementNotices: events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'loop-soft-tool-requirement').length,
        earlyStops: events.filter(event => event.type === 'turn/end' && event.data.reason?.kind === 'blocked').length,
        prefixChanges,
        usageReportedRequests: attempts.filter(attempt => attempt.usage !== null).length,
        usage: { inputTokens: total('inputTokens'), outputTokens: total('outputTokens'), cacheReadTokens: total('cacheReadTokens'), cacheWriteTokens: total('cacheWriteTokens') },
        turnOutcome: events.filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind ?? null,
        runtimePolicy: policySummary ?? null,
        fileMutationPolicy: mutationSummary ?? null,
        failureRecovery: recoveryStats ?? null,
        softToolRequirement: requirementSummary ?? null,
        quality: { passed: exactKeys && checks.length > 0 && checks.every(check => check.correct && check.read), exactKeys, checks }
      };
    }
  };
}
