'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Jobs = require('../sidecar/routing/linejobs.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');

async function sample(stages, lineOverride) {
  const runs = [], calls = [], sent = []; let outcome;
  const hub = makeChannelHub({ channel: 'sample', ownerSurface: true, bindChats: false, textBatchWaitMs: 0,
    store: { loadHistory: () => [], appendTurn: () => [], getChatRecord: () => null, loadOutbox: () => [] },
    send: async (_, text) => { sent.push(text); return { ok: true }; }, secrets: () => ({ key: 'offline', model: 'offline' }),
    resolveAgent: () => ({ agentId: 'scout', dockId: 'entry', isTask: true, lineId: 'line' }),
    resolveRunConfig: () => ({ key: 'offline', model: 'offline' }), lineOriginFor: () => 'line',
    runOnce: async o => {
      calls.push(o.agentId); const next = stages[calls.length - 1] || { text: 'unexpected', reason: 'error' };
      o.emit('agent.token', { delta: next.text });
      if (next.reason) o.emit('agent.run.end', { reason: next.reason, usd: 0 });
      runs.push({ runId: 'run-' + calls.length, agentId: o.agentId, reason: next.reason });
    },
    chain: lineOverride ? { advance: async () => lineOverride, stopNote: () => '' }
      : makeChainRunner({ nextAgent: a => ({ scout: 'builder', builder: 'reviewer' })[a] || null }),
    onLineOutcome: o => { outcome = o; }
  });
  await hub.onInbound({ chatId: 's', userId: 'commander', text: 'Build one item', chatType: 'dm' });
  return { calls, runs, outcome, sent, verdict: Jobs.sampleOutcome({ runs, lineOutcome: outcome, onLine: true, shipsToOutbox: true }) };
}

test('entry and downstream no-work stay neutral and stop before another stage', async () => {
  for (const text of ['', '[SILENT]', 'Nothing eligible\nWORKFLOW_STATUS: no-work']) {
    const r = await sample([{ text, reason: 'done' }]);
    assert.deepEqual(r.calls, ['scout']); assert.equal(r.outcome.workflowStatus, 'no-work');
    assert.equal(r.verdict.status, 'no-work'); assert.equal(r.verdict.completed, false);
  }
  const r = await sample([{ text: 'Brief', reason: 'done' }, { text: '[SILENT]', reason: 'done' }]);
  assert.deepEqual(r.calls, ['scout', 'builder']); assert.equal(r.verdict.status, 'no-work');
});

test('exact blocked reason and exhausted loop survive the real hub callback', async () => {
  const blocked = await sample([{ text: 'Missing image evidence\nWORKFLOW_STATUS: blocked', reason: 'done' }]);
  assert.equal(blocked.verdict.status, 'problem'); assert.match(blocked.verdict.error, /scout.*blocked/);
  const exhausted = await sample([{ text: 'Brief', reason: 'done' }], {
    agentId: 'reviewer', text: 'Still needs correction', stopped: null, hops: [], usd: 0, loopExhausted: true
  });
  assert.equal(exhausted.outcome.loopExhausted, true); assert.equal(exhausted.verdict.completed, false);
  assert.equal(exhausted.verdict.error, 'review loop exhausted without approval');
});

test('incomplete entry or hop cannot buy the next stage or become delivered', async () => {
  for (const reason of ['budget', 'max_iters', 'cancelled', undefined]) {
    const entry = await sample([{ text: 'partial', reason }]);
    assert.deepEqual(entry.calls, ['scout']); assert.equal(entry.verdict.completed, false);
    const hop = await sample([{ text: 'Brief', reason: 'done' }, { text: 'partial', reason }]);
    assert.deepEqual(hop.calls, ['scout', 'builder']); assert.equal(hop.verdict.completed, false);
  }
});

test('ordinary content and a clean full line still deliver', async () => {
  const r = await sample([{ text: 'Use WORKFLOW_STATUS: no-work only when idle', reason: 'done' },
    { text: 'PDF built', reason: 'done' }, { text: 'Pixel review saved', reason: 'done' }]);
  assert.deepEqual(r.calls, ['scout', 'builder', 'reviewer']); assert.equal(r.verdict.status, 'delivered');
  assert.equal(r.verdict.completed, true);
});

test('failure precedes no-work; wrong line or missing OUTBOX cannot pass', () => {
  const good = { runs: [{ reason: 'done' }], lineOutcome: { workflowStatus: 'no-work' }, onLine: true, shipsToOutbox: true };
  for (const change of [{ stopped: true }, { onLine: false }, { runs: [] },
    { runs: [{ reason: 'budget' }] }, { lineOutcome: { workflowStatus: 'blocked' } }, { lineOutcome: { workflowStatus: 'no-work', loopExhausted: true } }]) {
    const r = Jobs.sampleOutcome({ ...good, ...change }); assert.equal(r.noWork, false); assert.equal(r.completed, false);
  }
  assert.equal(Jobs.sampleOutcome({ ...good, lineOutcome: {}, shipsToOutbox: false }).status, 'problem');
});

test('no-work persists across reload and never leaks into a later success', () => {
  let state = Jobs.start({ jobs: [] }, { id: 'job-12345678', line: 'line', at: 1 }).state;
  state = Jobs.finish(state, 'job-12345678', { status: 'no-work', at: 2, output: '[SILENT]', error: 'No work produced', runs: [] }).state;
  state = Jobs.normalizeAll(JSON.parse(JSON.stringify(state)));
  assert.equal(Jobs.get(state, 'job-12345678').status, 'no-work');
  assert.equal(Jobs.list(state)[0].status, 'no-work'); assert.equal(Jobs.boot(state, 3).changed, false);
  state = Jobs.finish(state, 'job-12345678', { status: 'delivered', at: 4, output: 'Review package', runs: [] }).state;
  assert.equal(Jobs.get(state, 'job-12345678').status, 'delivered'); assert.equal(Jobs.get(state, 'job-12345678').error, '');
});

test('Send Job view renders no-work neutrally without an OUTBOX claim', () => {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/app/build.js'), 'utf8');
  const view = source.slice(source.indexOf('  function sampleResultView('), source.indexOf('  /* REFIT-JUNCTION-PURE-END */'));
  const html = source.slice(source.indexOf('  function finSampleHTML('), source.indexOf('  /* POST THE LINE BEFORE RUNNING IT'));
  const box = { esc: v => String(v).replaceAll('<', '&lt;') }; vm.createContext(box);
  vm.runInContext(view + html, box);
  const rendered = box.sampleResultView({ ok: true, delivered: { reason: 'done' }, noWork: true,
    error: 'No work produced', runs: [{ agentId: 'scout' }], replies: ['[SILENT]'], totalUsd: 0.2 }, 200);
  assert.equal(rendered.ok, false); assert.equal(rendered.noWork, true); assert.equal(rendered.reply, '');
  const out = box.finSampleHTML(rendered);
  assert.match(out, /NO WORK PRODUCED/); assert.doesNotMatch(out, /REFUSED|class="fl-result bad"|DELIVERED/);
});
