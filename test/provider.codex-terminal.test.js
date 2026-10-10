/* Explicit Responses completion must settle a turn even when the transport stays open.
   These are local injected streams: no network, credentials or native runtime required. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCodexProvider } = require('../sidecar/providers/codex.js');

const sse = events => events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('');
const textEvent = delta => ({ type: 'response.output_text.delta', delta });

async function readOpenStream(events, options) {
  options = options || {};
  let cancelCount = 0, keepalive, captured, deadline;
  const abort = new AbortController();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse(events)));
      // The upstream can keep its SSE connection alive after response.completed. Byte-idle
      // timeout cannot solve this shape because these comments continue arriving.
      keepalive = setInterval(() => controller.enqueue(new TextEncoder().encode(': keepalive\n\n')), 10);
    },
    cancel() {
      cancelCount++; clearInterval(keepalive);
      // Closing a remote body must not add a new unbounded wait after completion.
      return options.pendingCancel ? new Promise(() => {}) : Promise.resolve();
    }
  });
  const provider = makeCodexProvider({ token: 'local-fixture', fetch: async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const collected = [];
  try {
    await Promise.race([
      (async () => { for await (const event of provider.stream({ model: 'gpt-5.5', messages: options.messages || [], signal: abort.signal })) collected.push(event); })(),
      new Promise((_resolve, reject) => { deadline = setTimeout(() => { reject(new Error('Explicit completion did not settle the stream promptly')); abort.abort(); }, 1000); })
    ]);
    return { events: collected, cancelCount, captured };
  } finally { clearTimeout(deadline); clearInterval(keepalive); abort.abort(); }
}

test('response.completed returns without EOF/sentinel, cancels transport and preserves usage/text', async () => {
  const r = await readOpenStream([
    textEvent('Files are ready.'),
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } } },
    textEvent('must not appear after terminal'),
    { type: 'response.completed', response: { status: 'completed' } }
  ]);
  assert.equal(r.events.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Files are ready.');
  assert.deepEqual(r.events.filter(e => e.type === 'done'), [{ type: 'done', finishReason: 'stop', truncated: false }]);
  assert.equal(r.events.find(e => e.type === 'usage').usage.prompt_tokens, 12);
  assert.equal(r.events.find(e => e.type === 'usage').usage.completion_tokens, 7);
  assert.equal(r.cancelCount, 1);
});

test('completion keeps preceding tool events and previously completed tool results', async () => {
  const r = await readOpenStream([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'next-call', name: 'fs_read', arguments: '' } },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"path":"result.txt"}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'next-call', arguments: '{"path":"result.txt"}' } },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 9 } } }
  ], { messages: [
    { role: 'assistant', content: '', tool_calls: [{ id: 'previous-call', function: { name: 'fs_write', arguments: '{"path":"result.txt","content":"saved"}' } }] },
    { role: 'tool', tool_call_id: 'previous-call', content: 'saved successfully' }
  ] });
  assert.deepEqual(r.events.map(e => e.type), ['tool_start', 'tool_args', 'tool_done', 'usage', 'done']);
  assert.equal(r.events.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"path":"result.txt"}');
  assert.equal(r.events.find(e => e.type === 'done').finishReason, 'tool_calls');
  assert.equal(r.events.find(e => e.type === 'usage').usage.completion_tokens, 9);
  assert.ok(r.captured.input.some(i => i.type === 'function_call_output' && i.call_id === 'previous-call' && i.output === 'saved successfully'));
  assert.equal(r.cancelCount, 1);
});

test('explicit incomplete settles promptly with length semantics, not transport truncation', async () => {
  const r = await readOpenStream([
    textEvent('Partial answer'),
    { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 2, output_tokens: 3 } } }
  ], { pendingCancel: true });
  assert.deepEqual(r.events.filter(e => e.type === 'done'), [{ type: 'done', finishReason: 'length', truncated: false }]);
  assert.equal(r.events.find(e => e.type === 'usage').usage.completion_tokens, 3);
  assert.equal(r.cancelCount, 1);
});

test('EOF without terminal evidence remains truncated; a sentinel remains a clean end', async () => {
  for (const [suffix, truncated] of [['', true], ['data: [DONE]\n\n', false]]) {
    const provider = makeCodexProvider({ token: 'local-fixture', fetch: async () => new Response(sse([textEvent('fragment')]) + suffix) });
    const events = [];
    for await (const event of provider.stream({ model: 'gpt-5.5', messages: [] })) events.push(event);
    assert.deepEqual(events.filter(e => e.type === 'done'), [{ type: 'done', finishReason: null, truncated }]);
  }
});
