'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const view = require('../frontend/app/windows/routines.js');

const saved = patch => Object.assign({ lastRunId: 'entry-1', lastStatus: 'ok', lastReason: 'done', lastOutput: 'Actual output' }, patch);
const event = (name, runId, rest) => ({ name, payload: Object.assign({ runId }, rest) });
const completed = () => ({ runId: 'entry-1', reason: 'done', error: '', reply: 'Entry output' });

test('exact silent or empty successful output is neutral no-work, not product completion', () => {
  for (const lastOutput of ['[SILENT]', '  [SILENT]\n', '', '   ']) {
    const result = view.fromSaved(saved({ lastOutput }));
    assert.equal(result.kind, 'no-work');
    assert.equal(result.label, 'No work produced');
    assert.equal(result.output, '');
  }
  assert.equal(view.fromSaved(saved({ lastOutput: 'The document explains [SILENT].' })).kind, 'ok');
  assert.notEqual(view.fromSaved(saved({ lastOutput: null })).kind, 'no-work');
  assert.notEqual(view.fromSaved(saved({ lastOutput: undefined })).kind, 'no-work');
});

test('manual Run uses the whole-line saved verdict and final output, not entry success', () => {
  const blocked = view.fromManual(completed(), saved({ runsLine: true, lastStatus: 'error', lastError: 'Writer requires terminal access', lastLineOutcome: { status: 'blocked', reason: 'Writer requires terminal access', hops: 1 } }));
  assert.equal(blocked.kind, 'blocked');
  assert.equal(blocked.label, 'Line blocked');
  assert.match(blocked.detail, /terminal access/);
  assert.equal(blocked.output, '');
  const done = view.fromManual(completed(), saved({ runsLine: true, lastOutput: 'Reviewer final output', lastLineOutcome: { status: 'completed', hops: 2 } }));
  assert.equal(done.kind, 'ok');
  assert.equal(done.label, 'Line finished');
  assert.equal(done.output, 'Reviewer final output');
});

test('unknown line verdict and exhausted review loop cannot be green', () => {
  assert.equal(view.fromSaved(saved({ runsLine: true })).kind, 'pending');
  assert.equal(view.fromSaved(saved({ runsLine: true, lastLineOutcome: { status: 'completed', loopExhausted: true, reason: 'Review limit reached' } })).kind, 'blocked');
  assert.equal(view.fromSaved(saved({ runsLine: true, lastLineOutcome: { status: 'no-work' } })).kind, 'no-work');
  assert.equal(view.fromSaved(saved({ runsLine: true, lastLineOutcome: { status: 'error', reason: 'Next stage failed' } })).kind, 'error');
});

test('manual completion requires matching durable run identity', () => {
  for (const record of [null, saved({ lastRunId: 'previous-run' })]) {
    assert.equal(view.fromManual(completed(), record).kind, 'pending');
  }
  assert.equal(view.fromManual(completed(), saved({ lastOutput: '[SILENT]' })).kind, 'no-work');
});

test('cancellation, budget, iteration limits and missing terminal fail without a run.error event', () => {
  for (const reason of ['cancelled', 'budget', 'max_turns', null]) {
    const result = view.fromManual(Object.assign(completed(), { reason }), saved());
    assert.equal(result.kind, 'error');
    assert.match(result.detail, /without completion/);
  }
});

test('child success cannot complete or replace the entry stream, and child errors stay scoped', () => {
  const t = view.tracker();
  t.accept(event('agent.run.start', 'entry-1'));
  t.accept(event('agent.token', 'entry-1', { delta: 'Narration' }));
  t.accept(event('agent.tool_call', 'entry-1'));
  t.accept(event('agent.token', 'entry-1', { delta: '[SILENT]' }));
  t.accept(event('agent.run.start', 'worker-1'));
  t.accept(event('agent.token', 'worker-1', { delta: 'Child output' }));
  t.accept(event('agent.run.error', 'worker-1', { message: 'Child failure' }));
  t.accept(event('agent.run.end', 'worker-1', { reason: 'done' }));
  assert.equal(t.state.reply, '[SILENT]');
  assert.equal(t.state.error, '');
  assert.equal(t.state.reason, null);
  assert.equal(view.fromManual(t.state, saved()).kind, 'error');
  t.accept(event('agent.run.end', 'entry-1', { reason: 'done' }));
  assert.equal(view.fromManual(t.state, saved({ lastOutput: '[SILENT]' })).kind, 'no-work');
});

test('an error terminal is not erased by a duplicate done event', () => {
  const t = view.tracker();
  t.accept(event('agent.run.start', 'entry-1'));
  t.accept(event('agent.run.end', 'entry-1', { reason: 'budget' }));
  t.accept(event('agent.run.end', 'entry-1', { reason: 'done' }));
  assert.equal(t.state.reason, 'budget');
  assert.equal(view.fromManual(t.state, saved()).kind, 'error');
});

test('Run labels expose explicit whole-line opt-in only', () => {
  assert.equal(view.buttonLabel({ runsLine: true }), '▶ RUN LINE');
  for (const job of [{}, { runsLine: false }, { runsLine: 'true' }]) assert.equal(view.buttonLabel(job), '▶ RUN AGENT');
});

test('history cannot apply stale whole-line success to an entry run', () => {
  const r = { runId: 'old', reason: 'done', runsLine: true, resultRunId: 'new',
    lastStatus: 'ok', lastLineOutcome: { status: 'completed' }, lastOutput: 'new product' };
  for (const record of [r, { ...r, resultRunId: undefined }, { ...r, resultRunId: 'old', lastLineOutcome: null }]) {
    const result = view.fromHistory(record);
    assert.equal(result.kind, 'pending'); assert.equal(result.label, 'Entry finished; line result unconfirmed'); assert.equal(result.output, '');
  }
  const current = { ...r, resultRunId: 'old' };
  assert.equal(view.fromHistory(current).kind, 'ok'); assert.equal(view.fromHistory(current).output, 'new product');
  const blocked = view.fromHistory({ ...current, lastStatus: 'error', lastLineOutcome: { status: 'blocked', reason: 'Reviewer could not open pixels' }, lastOutput: 'Partial build' });
  assert.equal(blocked.kind, 'blocked'); assert.match(blocked.detail, /open pixels/); assert.equal(blocked.output, 'Partial build');
  const idle = view.fromHistory({ ...current, lastLineOutcome: { status: 'no-work' }, lastOutput: '[SILENT]' });
  assert.equal(idle.kind, 'no-work'); assert.equal(idle.output, '');
  assert.equal(view.fromHistory({ ...r, reason: 'budget' }).kind, 'error');
});

test('actual history endpoint enriches only matching settlement and hides sticky failed output', () => {
  const source = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
  const handler = source.slice(source.indexOf('function handleCronHistory('), source.indexOf('// POST /api/cron — create a routine.'));
  const job = saved({ id: 'routine', runsLine: true, lastRunId: 'latest', lastLineOutcome: { status: 'blocked', reason: 'Review failed' }, lastStatus: 'error', lastOutput: 'Partial files' });
  const rows = [{ runId: 'older', cronJobId: 'routine', reason: 'done' }, { runId: 'latest', cronJobId: 'routine', reason: 'done' }];
  const box = { URL, cronStore: { getJob: () => job }, cronJobs: [job], runStore: { all: () => rows } };
  vm.createContext(box); vm.runInContext(handler, box);
  let response;
  const get = () => { box.handleCronHistory({ url: '/api/cron/history?id=routine' }, { writeHead() {}, end(body) { response = JSON.parse(body); } }); return response.runs; };
  const current = get();
  assert.equal(current[0].resultRunId, 'latest'); assert.equal(current[0].lastOutput, 'Partial files');
  assert.equal(view.fromHistory(current[0]).kind, 'blocked');
  assert.equal(current[1].resultRunId, undefined); assert.equal(current[1].lastOutput, undefined); assert.equal(view.fromHistory(current[1]).kind, 'pending');
  job.lastRunId = 'unrelated'; assert.ok(get().every(r => !r.lastLineOutcome && !r.lastOutput));
  job.lastRunId = 'latest'; job.lastLineOutcome = null; job.runsLine = false;
  assert.equal(get()[0].lastOutput, null);
});

test('history renders final output and errors as escaped text with honest entry metrics', () => {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/app/windows/routines.js'), 'utf8');
  const render = source.slice(source.indexOf('    function historyLine('), source.indexOf('    async function toggleHistory('));
  const box = { RoutineRunResult: view, esc: x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
  vm.createContext(box); vm.runInContext(render, box);
  const row = { runId: 'latest', resultRunId: 'latest', runsLine: true, reason: 'done', lastStatus: 'ok', lastLineOutcome: { status: 'completed' }, lastOutput: '<img src=x onerror=alert(1)>\nproduct.pdf' };
  const html = box.historyLine(row);
  assert.match(html, /Line finished/); assert.match(html, /Saved line output/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img/); assert.match(html, /entry:/); assert.match(html, /product\.pdf/);
  const blocked = box.historyLine({ ...row, lastStatus: 'error', lastLineOutcome: { status: 'blocked', reason: '<script>bad</script>' } });
  assert.match(blocked, /Line blocked/); assert.match(blocked, /&lt;script&gt;/); assert.doesNotMatch(blocked, /class="pos"/);
});
