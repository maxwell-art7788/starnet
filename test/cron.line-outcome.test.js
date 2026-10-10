'use strict';
// Offline regression: the routine outcome belongs to the whole line, not its entry.
const assert = require('node:assert/strict');
const { makeCronDriver, applyLineOutcome, lineHopResult } = require('../sidecar/cron-driver.js');
const store = require('../sidecar/cron-store.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const events = require('../shared/events.js');
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
let assertions = 0;
const eq = (a, b) => { assert.deepEqual(a, b); assertions++; };

async function run(line, options = {}) {
  let jobs = [store.makeJob({ id: 'line-test', agentId: 'scout', runsLine: options.runsLine !== false,
    dockId: 'entry', prompt: 'Build one item', schedule: { kind: 'once', at: '2026-10-10T00:00:00Z' } }, { now: 1000 })];
  const emitted = []; let advances = 0, persist = true;
  const driver = makeCronDriver({ getJobs: () => jobs,
    setJobs: next => { if (!persist) return false; jobs = next; return true; },
    now: () => 2000, newId: () => 'run-1', newAbort: () => new AbortController(),
    getKey: () => 'test-only', defaultModel: 'offline', warn: () => {},
    emit: (name, payload) => emitted.push({ name, payload }),
    runOnce: async o => {
      o.emit('agent.token', { delta: options.entry == null ? 'Saved research' : options.entry });
      o.emit('agent.run.end', { reason: 'done', usd: 0.1 });
      if (options.failPersist) persist = false;
    },
    advanceChain: options.noRunner ? undefined : async o => { advances++; eq(o.unattendedGrants, []); if (line instanceof Error) throw line; return typeof line === 'function' ? line(o) : line; }
  });
  driver._internals.fireJob(jobs[0], 1000, 1000);
  await flush();
  return { driver, emitted, get job() { return jobs[0]; }, get advances() { return advances; }, restore: () => { persist = true; } };
}

(async () => {
  const full = { text: 'Owner review package', agentId: 'packager', dockId: 'package', usd: 0.3,
    hops: [{ agentId: 'hodor' }, { agentId: 'designer' }, { agentId: 'checker' }, { agentId: 'packager' }], stopped: null };
  const success = await run(full);
  eq(success.job.lastStatus, 'ok'); eq(success.job.lastOutput, full.text);
  eq(success.job.lastLineOutcome, { status: 'completed', reason: null, finalAgentId: 'packager', finalDockId: 'package', hops: 4, loopExhausted: false });
  eq(success.job.lastUsd, 0.4); eq(success.job.finalization.lineOutcome, success.job.lastLineOutcome);
  eq(success.emitted.find(e => e.name === 'cron.result').payload.outcome, 'ok');
  // A real downstream failure preserves upstream work and stops before the package dock.
  const chain = makeChainRunner({ nextAgent: a => ({ scout: 'designer', designer: 'checker', checker: 'packager' })[a],
    runAgent: async ({ agentId }) => agentId === 'designer' ? { text: 'Saved candidate', usd: 0.2 } : { error: 'required image tool unavailable' } });
  const blocked = await run(o => chain.advance({ agentId: o.agentId, text: o.text, originalText: o.originalText }));
  eq(blocked.job.lastStatus, 'error'); eq(blocked.job.lastLineOutcome.status, 'blocked');
  eq(blocked.job.lastOutput, 'Saved candidate'); eq(blocked.job.finalization.result, 'Saved candidate');
  eq(blocked.job.lastLineOutcome.hops, 1); eq(blocked.emitted.find(e => e.name === 'cron.result').payload.outcome, 'failed');
  assert.match(blocked.job.lastError, /required image tool unavailable/); assertions++;
  const exhausted = await run({ ...full, loopExhausted: true });
  eq(exhausted.job.lastStatus, 'error'); eq(exhausted.job.lastLineOutcome.loopExhausted, true);
  const thrown = await run(new Error('chain fault'));
  eq(thrown.job.lastLineOutcome.status, 'error'); eq(thrown.job.lastOutput, 'Saved research');
  eq(thrown.job.retryCount, 0); eq(thrown.driver.leases.size, 0);
  for (const entry of ['[SILENT]', '']) {
    const idle = await run(full, { entry });
    eq(idle.advances, 0); eq(idle.job.lastLineOutcome.status, 'no-work'); eq(idle.job.lastStatus, 'ok');
    eq(idle.job.finalization.outcome, 'silent'); eq(idle.emitted.find(e => e.name === 'cron.result').payload.outcome, 'silent');
  }
  const missing = await run(null, { noRunner: true });
  eq(missing.job.lastStatus, 'error'); eq(missing.job.lastLineOutcome.status, 'error');
  const noResult = await run(undefined); eq(noResult.job.lastStatus, 'error');
  const ordinary = await run({ ...full, stopped: 'unused foreign line' }, { runsLine: false });
  eq(ordinary.job.lastStatus, 'ok'); eq(ordinary.job.lastLineOutcome, null);
  // Failure settlement survives a failed disk write, and a late success cannot overwrite it.
  const held = await run({ ...full, stopped: 'review missing' }, { failPersist: true });
  eq(held.emitted.filter(e => e.name === 'cron.result').length, 0); eq(held.driver.leases.size, 1);
  held.restore(); held.driver.settleRun('line-test', 'run-1', { reason: 'done', buf: 'late success' }, null);
  await flush(); eq(held.job.lastStatus, 'error'); eq(held.job.lastLineOutcome.reason, 'review missing');
  eq(held.emitted.filter(e => e.name === 'cron.result').length, 1);
  // Run Now calls the SAME normalizer; terminal limit/refusal without an error event also fails.
  for (const reason of ['max_turns', 'budget', 'cancelled', '']) {
    const hop = lineHopResult({ reason, buf: 'partial', usd: 0.1 });
    assert.ok(hop.error); assertions++;
    const state = { reason: 'done', buf: 'entry', usd: 0.1 };
    applyLineOutcome(state, { text: state.buf, stopped: hop.error, hops: [], usd: hop.usd }, { agentId: 'scout' });
    eq(state.reason, 'line-blocked'); eq(state.lineOutcome.status, 'blocked');
  }
  eq(lineHopResult({ reason: 'done', buf: 'finished', usd: 0 }).error, null);
  // Terminal control is parsed before routing (including before a revision loop).
  for (const text of ['[SILENT]', 'Nothing eligible\nWORKFLOW_STATUS: no-work', 'Image tool unavailable\nWORKFLOW_STATUS: blocked']) {
    let routed = 0, ran = 0;
    const guarded = makeChainRunner({ nextAgent: () => { routed++; return 'builder'; }, runAgent: async () => { ran++; return { text: 'must not run' }; } });
    const result = await guarded.advance({ agentId: 'scout', text });
    eq(routed, 0); eq(ran, 0); eq(result.workflowStatus, text.endsWith('blocked') ? 'blocked' : 'no-work');
    const state = { reason: 'done', buf: text, usd: 0 };
    applyLineOutcome(state, result, { agentId: 'scout' });
    eq(state.lineOutcome.status, text.endsWith('blocked') ? 'blocked' : 'no-work');
  }
  for (const text of ['Saved files', 'Use WORKFLOW_STATUS: blocked when unavailable', '> WORKFLOW_STATUS: blocked', 'WORKFLOW_STATUS: blocked\nThat was an example.', 'Partial [SILENT] note']) {
    let ran = 0;
    const normal = makeChainRunner({ nextAgent: a => a === 'scout' ? 'builder' : null, runAgent: async () => { ran++; return { text: 'Finished' }; } });
    await normal.advance({ agentId: 'scout', text }); eq(ran, 1);
  }
  // The real loop permits exactly two correction passes, then takes the escape.
  const visited = [];
  const loop = makeChainRunner({ nextAgent: () => null,
    stepAgent: a => a === 'scout' ? { agentId: 'designer' } : a === 'designer' ? { agentId: 'checker' }
      : a === 'checker' ? { loop: 'review', max: 2, when: 'approved', backTo: 'designer', next: 'packager', esc: 'blocker' } : null,
    runAgent: async ({ agentId }) => { visited.push(agentId); return { text: agentId === 'checker' ? 'Defect remains\nVERDICT: revise' : 'Saved evidence' }; } });
  const loopResult = await loop.advance({ agentId: 'scout', text: 'Research complete' });
  eq(visited, ['designer', 'checker', 'designer', 'checker', 'designer', 'checker', 'blocker']);
  eq(loopResult.loopExhausted, true);
  const loopState = { reason: 'done', buf: '', usd: 0 }; applyLineOutcome(loopState, loopResult, {});
  eq(loopState.lineOutcome.status, 'blocked');
  for (const item of [...success.emitted, ...blocked.emitted, ...exhausted.emitted].filter(e => e.name === 'cron.result')) {
    assert.ok(events.validate(item.name, item.payload).ok); assertions++;
  }
  console.log('cron.line-outcome: ' + assertions + ' assertions passed (offline, no providers or live jobs)');
})().catch(e => { console.error(e); process.exitCode = 1; });
