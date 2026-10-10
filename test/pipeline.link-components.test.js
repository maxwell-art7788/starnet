'use strict';
const assert = require('node:assert/strict');
const P = require('../frontend/app/pipeline.js');
const W = require('../frontend/app/worldmodel.js');
const E = require('../frontend/app/lineedit.js');
let checks = 0;
const eq = (a, b) => { assert.deepEqual(a, b); checks++; };
const components = g => P.lineComponents(g).map(c => ({ key: c.key, props: c.props }));

// Side-by-side lanes are separate explicit workflows, even one tile apart.
const parallel = { props: [], belts: [], links: [] };
for (let y = 0; y < 2; y++) {
  const a = 'p' + (y * 2 + 1), b = 'p' + (y * 2 + 2);
  parallel.props.push({ id: a, t: 'intake', x: 0, y, w: 1, h: 1 }, { id: b, t: 'bay', x: 4, y, w: 1, h: 1, agentId: 'agent' + y });
  const path = [1, 2, 3].map(x => ({ x, y, d: 'E' }));
  parallel.belts.push(...path.map(t => ({ x: t.x, y: t.y, dir: t.d })));
  parallel.links.push({ id: 'l' + y, from: { prop: a }, to: { prop: b }, path });
}
const input = JSON.stringify(parallel);
eq(components(parallel), [{ key: 'p1', props: ['p1', 'p2'] }, { key: 'p3', props: ['p3', 'p4'] }]);
eq(JSON.stringify(parallel), input);
const legacy = { props: parallel.props, belts: parallel.belts };
eq(components(legacy), [{ key: 'p1', props: ['p1', 'p2', 'p3', 'p4'] }]);

// Existing single-line blueprints retain their legacy routing and components.
for (const bp of W.BLUEPRINTS) {
  const props = bp.props.map((p, i) => ({ ...p, id: 'p' + (i + 1), ...(p.t === 'bay' ? { agentId: 'agent' + i } : {}) }));
  const belts = bp.belts.map(t => ({ x: t.x, y: t.y, dir: t.d }));
  const geo = { props, belts }, linked = { ...geo, links: P.deriveLinks(geo) };
  eq(components(linked), components(geo));
  const a = P.compileRoutingPlan(geo), b = P.compileRoutingPlan(linked);
  eq(b.dockChains, a.dockChains); eq(b.gateDocks, a.gateDocks);
}

// Synthetic version of the live failure: a new builder's return lane wraps past
// a neighbouring review line. No user save or live state is loaded/mutated.
function crowdedStation() {
  const doc = W.defaultDoc(), roomId = doc.order[0];
  doc.rooms[roomId].rects = [{ x1: 0, y1: 0, x2: 52, y2: 14 }];
  doc.order = [roomId]; doc.props = []; doc.belts = {}; doc.edges = []; doc.links = []; doc._nid = 122;
  const bp = W.BLUEPRINTS.find(b => b.id === 'revision_loop');
  const props = bp.props.map((p, i) => ({ ...p, id: 'p' + (23 + i), x: p.x + 27, y: p.y + 1,
    ...(p.t === 'bay' ? { agentId: 'old' + i } : {}) }));
  const belts = bp.belts.map(t => ({ x: t.x + 27, y: t.y + 1, dir: t.d }));
  doc.props.push(...props); doc.links.push(...P.deriveLinks({ props, belts }));
  for (const b of belts) doc.belts[b.x + ',' + b.y] = b.dir;
  doc.props.push(
    { id: 'p117', t: 'intake', x: 26, y: 9, w: 2, h: 2 },
    { id: 'p118', t: 'bay', x: 30, y: 9, w: 2, h: 2, agentId: 'researcher' },
    { id: 'p119', t: 'bay', x: 34, y: 9, w: 2, h: 2, agentId: 'lead' },
    { id: 'p120', t: 'outbox', x: 38, y: 9, w: 2, h: 2 },
    { id: 'p121', t: 'bay', x: 38, y: 6, w: 2, h: 2, agentId: 'builder' });
  const add = (id, a, b, path) => {
    doc.links.push({ id, from: { prop: a, port: 'out' }, to: { prop: b, port: 'in' }, path });
    for (const t of path) doc.belts[t.x + ',' + t.y] = t.d;
  };
  add('l51', 'p117', 'p118', [{ x: 28, y: 9, d: 'E' }, { x: 29, y: 9, d: 'E' }]);
  add('l52', 'p118', 'p119', [{ x: 32, y: 9, d: 'E' }, { x: 33, y: 9, d: 'E' }]);
  add('l53', 'p119', 'p121', [{ x: 36, y: 8, d: 'E' }, { x: 37, y: 8, d: 'E' }, { x: 38, y: 8, d: 'N' }]);
  add('l54', 'p121', 'p120', [{ x: 39, y: 8, d: 'S' }]);
  return W.deserialize(doc);
}
const station = crowdedStation(), before = P.compileRoutingPlan(station.projectGeometry());
eq(before.lines.length, 2);
const oldLinksBefore = station.links().filter(l => Number(l.from.prop?.slice(1)) < 117 && Number(l.to.prop?.slice(1)) < 117);
const result = E.run(station, 'p121', 'addLoop', { around: 'p121', max: 2, when: 'approved' },
  { near: { x: 37, y: 9 }, sizes: { bay: [2, 2], intake: [2, 2], outbox: [2, 2] } });
eq(result.ok, true);
const after = P.compileRoutingPlan(station.projectGeometry());
eq(after.lines.length, 2);
eq(after.lines.find(l => l.lineId === 'p23').propIds, before.lines.find(l => l.lineId === 'p23').propIds);
for (const id of ['p24', 'p25']) eq(after.dockChains[id], before.dockChains[id]);
eq(after.lineOfDock.p121, 'p117');
eq(after.lines.find(l => l.lineId === 'p117').propIds, ['p117', 'p118', 'p119', 'p120', 'p121', 'p122', 'p123']);
const oldLinks = station.links().filter(l => Number(l.from.prop?.slice(1)) < 117 && Number(l.to.prop?.slice(1)) < 117);
eq(oldLinks, oldLinksBefore);
const oldCount = oldLinks.length;
eq(station.undo().ok, true);
eq(P.compileRoutingPlan(station.projectGeometry()).lines, before.lines);
eq(station.links().filter(l => Number(l.from.prop?.slice(1)) < 117 && Number(l.to.prop?.slice(1)) < 117).length, oldCount);
// Fault injection proves a collateral edit is rejected and rolled back as one transaction.
const probe = crowdedStation(), originalApply = probe.applyLineLayout;
const originalDoc = JSON.stringify(probe.serialize());
// Inject a real foreign link mutation.
probe.applyLineLayout = (graph, layout) => { const r = originalApply(graph, layout); if (r.ok) probe.removeProp('p25'); return r; };
const refused = E.run(probe, 'p121', 'addLoop', { around: 'p121', max: 2 }, { near: { x: 37, y: 9 } });
eq(refused.error, 'OTHER_LINE_CHANGED');
eq(JSON.stringify(probe.serialize()), originalDoc);
console.log('pipeline.link-components: ' + checks + ' assertions passed; ' + W.BLUEPRINTS.length + ' legacy blueprint routes preserved');
