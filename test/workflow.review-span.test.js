'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const W = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const E = require('../frontend/app/lineedit.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeChainRunner, loopDecision } = require('../sidecar/routing/chain.js');
const { makeStepTest } = require('../sidecar/routing/steptest.js');

function fixture() {
  const d = W.defaultDoc(); d.rooms[d.order[0]].rects = [{ x1: 0, y1: 0, x2: 70, y2: 35 }];
  d.props = []; d.belts = {}; d.links = []; d.edges = [];
  const station = W.deserialize(d);
  const added = E.run(station, null, 'newLine', {}, { near: { x: 10, y: 12 } }); assert.equal(added.ok, true);
  const graph = station.lineGraph(added.focus).graph;
  const builder = graph.nodes.find(n => n.t === 'bay').id, outbox = graph.nodes.find(n => n.t === 'outbox').id;
  station.assignPropAgent(builder, 'builder');
  const appended = E.run(station, builder, 'appendStep', { after: builder, role: 'REVIEWER' }); assert.equal(appended.ok, true);
  const designer = appended.focus; station.assignPropAgent(designer, 'designer');
  const review = E.run(station, designer, 'addLoop', { around: designer, max: 2, when: 'approved' }); assert.equal(review.ok, true);
  const loop = review.focus, reviewer = station.lineGraph(loop).graph.nodes.find(n => n.t === 'bay' && !n.agentId).id;
  station.assignPropAgent(reviewer, 'checker');
  return { station, builder, designer, reviewer, loop, outbox, intake: added.focus };
}
function routerFor(station) {
  const router = makeRouter(); const plan = P.compileRoutingPlan(station.projectGeometry());
  assert.equal(router.setPlan(plan).ok, true); return { router, plan };
}
function requireApproval(f) {
  const p = f.station.propById(f.loop);
  f.station.configureJunction(f.loop, { maxIter: 2, when: p.when, done: p.done, esc: p.esc, requireApproval: true });
}
function appendMerch(f) {
  const r = E.run(f.station, f.outbox, 'insertStep', { from: f.loop, to: f.outbox, role: 'WRITER' });
  assert.equal(r.ok, true); f.station.assignPropAgent(r.focus, 'merch'); return r.focus;
}

test('loop selector reads the saved return lane before and after target changes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/app/workflowpanel.js'), 'utf8');
  const helper = source.slice(source.indexOf('  function currentLoopBackTarget('), source.indexOf('  function paintGate('));
  const box = {}; vm.createContext(box); vm.runInContext(helper, box);
  const f = fixture();
  const selected = station => box.currentLoopBackTarget(station.lineGraph(f.loop).graph, f.loop);
  assert.equal(selected(f.station), f.designer);
  assert.equal(E.run(f.station, f.loop, 'setLoopBack', { id: f.loop, target: f.builder }).ok, true);
  assert.equal(selected(f.station), f.builder);
  assert.equal(selected(W.deserialize(JSON.parse(JSON.stringify(f.station.serialize())))), f.builder);
  assert.equal(box.currentLoopBackTarget({ links: [
    { from: { node: f.loop, port: 'done' }, to: { node: f.outbox } },
    { from: { node: f.loop, port: 'esc' }, to: { node: 'owner' } },
    { from: { node: f.loop, port: 'back' }, to: { node: f.builder } }
  ] }, f.loop), f.builder);
});

test('revision target changes actual same-line belt and undoes as one transaction', () => {
  const f = fixture(), before = JSON.stringify(f.station.serialize());
  const g = f.station.lineGraph(f.loop).graph;
  assert.ok(E.loopBackCandidates(g, f.loop).includes(f.builder));
  assert.equal(E.run(f.station, f.loop, 'setLoopBack', { id: f.loop, target: f.builder }).ok, true);
  const { router, plan } = routerFor(f.station);
  const step = router.chainStepDock(f.reviewer, { lineId: plan.lineOfDock[f.reviewer], verdict: 'revise' });
  assert.equal(step.backTo.dockId, f.builder);
  assert.equal(f.station.undo().ok, true); assert.equal(JSON.stringify(f.station.serialize()), before);
});

test('foreign, downstream and malformed targets are rejected without mutation', () => {
  const f = fixture();
  const foreign = E.run(f.station, null, 'newLine', {}, { near: { x: 50, y: 25 } }); assert.equal(foreign.ok, true);
  const foreignBay = f.station.lineGraph(foreign.focus).graph.nodes.find(n => n.t === 'bay').id;
  const merch = appendMerch(f), before = JSON.stringify(f.station.serialize());
  for (const target of [foreignBay, merch, f.outbox, f.loop, 'missing']) {
    assert.equal(E.run(f.station, f.loop, 'setLoopBack', { id: f.loop, target }).error, 'NOT_UPSTREAM');
    assert.equal(JSON.stringify(f.station.serialize()), before);
  }
});

test('approval requirement round-trips and reaches both dock and legacy agent plans', () => {
  const f = fixture(), oldPlan = P.compileRoutingPlan(f.station.projectGeometry()); requireApproval(f);
  const copy = W.deserialize(JSON.parse(JSON.stringify(f.station.serialize())));
  assert.equal(copy.propById(f.loop).requireApproval, true);
  const { router, plan } = routerFor(copy), lineId = plan.lineOfDock[f.reviewer];
  assert.notEqual(plan.hash, oldPlan.hash);
  assert.equal(router.chainStepDock(f.reviewer, { lineId }).requireApproval, true);
  assert.equal(router.chainStep('checker', { lineId, dockId: f.reviewer }).requireApproval, true);
  copy.configureJunction(f.loop, { maxIter: 2, when: 'approved', done: copy.propById(f.loop).done });
  assert.equal(copy.propById(f.loop).requireApproval, undefined);
});

async function fullRun(approved) {
  const f = fixture(); E.run(f.station, f.loop, 'setLoopBack', { id: f.loop, target: f.builder }); requireApproval(f); appendMerch(f);
  const { router, plan } = routerFor(f.station), calls = [];
  const runner = makeChainRunner({ nextAgent: router.chainNext, stepDock: router.chainStepDock, entryDockOf: router.entryDockOf,
    lineOf: router.lineOfAgent, shipsToOutbox: router.chainShipsToOutbox,
    runAgent: async ({ agentId }) => { calls.push(agentId); return { text: agentId === 'checker' ? 'Reviewed actual files\nVERDICT: ' + (approved ? 'approved' : 'revise') : 'Saved files', usd: 0 }; } });
  const result = await runner.advance({ agentId: 'builder', dockId: f.builder, lineId: plan.lineOfDock[f.builder], text: 'Initial build', originalText: 'Build one product' });
  return { calls, result };
}
test('required approval stops exhausted reviews before MERCH; an approval continues', async () => {
  const exhausted = await fullRun(false);
  assert.deepEqual(exhausted.calls, ['designer', 'checker', 'builder', 'designer', 'checker', 'builder', 'designer', 'checker']);
  assert.equal(exhausted.result.loopExhausted, true); assert.equal(exhausted.result.stopped, 'review loop exhausted without approval');
  const approved = await fullRun(true);
  assert.deepEqual(approved.calls, ['designer', 'checker', 'merch']); assert.equal(approved.result.stopped, null);
});

test('opt-in cannot be defeated by an alternate when or escalation lane; legacy loops keep behavior', () => {
  const step = { loop: 'g', max: 2, when: 'approved', backTo: 'builder', next: 'merch', esc: 'escalation' };
  assert.equal(loopDecision(step, { verdict: 'revise' }, 2, {}, 'Revise').target, 'escalation');
  const held = loopDecision({ ...step, requireApproval: true, when: 'revise' }, { verdict: 'revise' }, 2, {}, 'Revise');
  assert.equal(held.target, null); assert.match(held.stopped, /without approval/);
  assert.equal(loopDecision({ ...step, requireApproval: true }, { verdict: 'approved' }, 2, {}, 'Ready\nVERDICT: approved').target, 'merch');
});

test('step-through preview cannot claim OUTBOX or run final stage at the approval limit', async () => {
  const f = fixture(); E.run(f.station, f.loop, 'setLoopBack', { id: f.loop, target: f.builder }); requireApproval(f); appendMerch(f);
  const { router, plan } = routerFor(f.station), calls = [];
  const session = makeStepTest({ plan: { get: () => plan, lineOf: router.lineOfAgent, dockRef: router.dockRef,
    stepDock: router.chainStepDock, peekDock: router.chainPeekDock, shipsToOutbox: router.chainShipsToOutbox },
    runDock: async ({ agentId }) => { calls.push(agentId); return { text: agentId === 'checker' ? 'Needs correction\nVERDICT: revise' : 'Saved file', usd: 0 }; } });
  const started = session.start({ line: plan.lineOfDock[f.builder], startAt: f.builder, text: 'Initial build', pause: 'none' });
  assert.equal(started.ok, true); await session.settled(started.session.id);
  let state = session.get(started.session.id).session;
  assert.equal(state.state, 'paused'); assert.equal(state.paused.next.kind, 'end'); assert.match(state.paused.next.reason, /without approval/);
  assert.equal(calls.includes('merch'), false);
  session.continue(started.session.id, {}); await session.settled(started.session.id);
  state = session.get(started.session.id).session;
  assert.equal(state.state, 'stopped'); assert.equal(calls.includes('merch'), false);
});
