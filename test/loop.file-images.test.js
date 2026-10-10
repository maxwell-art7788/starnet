/* Local scripted provider only: document preview retention is independent of live-screen aging. */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { runAgentLoop, _internals: images } = require('../sidecar/loop.js');
const { _internals: codex } = require('../sidecar/providers/codex.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeCostEngine } = require('../sidecar/cost.js');

const urls = messages => messages.flatMap(m => Array.isArray(m.content)
  ? m.content.filter(p => p.type === 'image_url').map(p => p.image_url.url) : []);
const fileImage = (path, data = path) => ({ role: 'user', fileImageSource: path, content: [
  { type: 'text', text: '[BEGIN EXTERNAL FILE IMAGE — ' + JSON.stringify(path) + ']' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,' + Buffer.from(data).toString('base64') } }
] });
const screenshot = data => ({ role: 'user', content: [
  { type: 'text', text: '[BEGIN EXTERNAL SCREEN CAPTURE — tool output]' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,' + Buffer.from(data).toString('base64') } }
] });

async function fixture(batches, limits = {}) {
  const requests = [];
  let turn = 0;
  const priceOf = () => ({ in: 0, out: 0 });
  const provider = { priceOf, contextLimit: () => 1000000, async *stream(req) {
    requests.push(req.messages.slice());
    const batch = batches[turn++];
    if (!batch) { yield { type: 'text', delta: 'Review evidence collected.' }; yield { type: 'done', finishReason: 'stop' }; return; }
    for (const [index, item] of batch.entries()) {
      yield { type: 'tool_start', index, id: 'call_' + turn + '_' + index, name: item.tool || 'fs_read' };
      yield { type: 'tool_args', index, chunk: JSON.stringify({ path: item.path }) };
    }
    yield { type: 'done', finishReason: 'tool_calls' };
  } };
  const registry = makeRegistry();
  for (const name of ['fs_read', 'browser_screenshot']) registry.register({
    name, schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async args => ({ content: 'Image metadata', images: [{ mime: 'image/png', data: Buffer.from(args.path).toString('base64') }] })
  });
  const messages = [{ role: 'user', content: 'Inspect each document page, then compare the full set.' }];
  const result = await runAgentLoop({ messages, provider, emit: () => {}, model: 'test', agentId: 'reviewer', runId: 'test-run',
    tools: [], toolImages: true, limits: Object.assign({ maxIters: 30, verifyOnStop: false }, limits),
    cost: makeCostEngine({ priceOf }), dispatch: (call, ctx) => registry.dispatch(call, ctx),
    capCtx: { canRun: () => true, canUse: () => ({ ok: true }) }
  });
  return { requests, messages, result };
}

test('nine pages read two per turn remain available to the final comparison and Codex input', async () => {
  const pages = Array.from({ length: 9 }, (_, i) => ({ path: 'previews/page-' + (i + 1) + '.png' }));
  const batches = [];
  for (let i = 0; i < pages.length; i += 2) batches.push(pages.slice(i, i + 2));
  const { requests, messages, result } = await fixture(batches);
  assert.equal(result.reason, 'done');
  assert.deepEqual(requests.map(r => urls(r).length), [0, 2, 4, 6, 8, 9]);
  const final = requests.at(-1);
  assert.equal(final.some(m => Object.hasOwn(m, 'fileImageSource')), false, 'private recovery keys stay off the wire');
  assert.equal(messages.filter(images.isFileImage).length, 9, 'durable messages retain source identity');
  assert.equal(messages.filter(images.isFileImage).every(m => /record page-specific observations/.test(m.content[0].text)), true);
  const expected = pages.map(p => 'data:image/png;base64,' + Buffer.from(p.path).toString('base64'));
  assert.deepEqual(urls(final), expected);
  assert.deepEqual(codex.messagesToInput(final).flatMap(m => (m.content || []).filter(p => p.type === 'input_image').map(p => p.image_url)), expected);
});

test('browser captures still age out independently after two capture turns', async () => {
  const { requests } = await fixture([
    [{ path: 'previews/page-1.png' }],
    [{ path: 'screen-one', tool: 'browser_screenshot' }],
    [{ path: 'screen-two', tool: 'browser_screenshot' }],
    [{ path: 'screen-three', tool: 'browser_screenshot' }]
  ]);
  const final = requests.at(-1);
  assert.equal(urls(final).length, 3);
  assert.equal(final.some(m => typeof m.content === 'string' && /earlier screen capture removed/.test(m.content)), true);
  assert.equal(urls(final).includes(fileImage('previews/page-1.png').content[1].image_url.url), true);
});

test('file window is bounded by twelve images and encoded bytes without mutating recovery messages', () => {
  const originals = Array.from({ length: 15 }, (_, i) => fileImage('page-' + i));
  const before = JSON.stringify(originals);
  const projected = images.evictToolImages(originals, 2);
  assert.equal(urls(projected).length, 12);
  assert.deepEqual(urls(projected), urls(originals.slice(3)));
  assert.equal(JSON.stringify(originals), before);
  const large = [fileImage('old', 'a'.repeat(5 * 1024 * 1024)), fileImage('new', 'b'.repeat(5 * 1024 * 1024))];
  const budgeted = images.evictToolImages(large, 2);
  assert.equal(urls(budgeted).length, 1);
  assert.deepEqual(urls(budgeted), urls(large.slice(1)));
  assert.ok(urls(budgeted).join('').length <= 12 * 1024 * 1024);
});

test('newer reads replace old bytes of the same file, including after journal JSON recovery', () => {
  const original = [fileImage('page.png', 'old bytes'), fileImage('other.png'), fileImage('page.png', 'new bytes')];
  const recovered = JSON.parse(JSON.stringify(original));
  const projected = images.evictToolImages(recovered, 2);
  assert.equal(urls(projected).length, 2);
  assert.deepEqual(urls(projected), urls(original.slice(1)));
  assert.match(projected[0].content, /newer read/);
  assert.deepEqual(urls(recovered), urls(original), 'the provider view never edits journal recovery data');
});

test('explicit image disable and ordinary text behavior remain unchanged', () => {
  const text = [{ role: 'user', content: 'hello' }];
  assert.equal(images.evictToolImages(text, 2), text);
  assert.equal(urls(images.evictToolImages([fileImage('one'), screenshot('screen')], 0)).length, 0);
  assert.equal(urls(images.evictToolImages(Array.from({ length: 13 }, (_, i) => fileImage(String(i))), -1)).length, 12,
    'disabling browser eviction does not remove the independent static-file bound');
});
