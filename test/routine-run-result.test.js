'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
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
