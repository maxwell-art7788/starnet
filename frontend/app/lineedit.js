/* frontend/app/lineedit.js — EDITING A LINE AS A GRAPH (conveyor-links plan, phase D, 2026-09-29).

   Pure, zero-dep, UMD (node tests + the browser). The Workflow panel builds lines through this: every edit is a change
   to the line's GRAPH (its machines and the links between them), laid out by the layout engine (linelayout.js) and
   written back by the station in ONE undo slot (worldmodel applyLineLayout).

     LineEdit.run(station, propId, op, args, opts)   -> { ok, focus, ids } | { ok: false, error, msg }
       propId  any machine of the line (null for NEW_LINE)
       op      'insertStep' | 'appendStep' | 'addBranch' | 'addLoop' | 'addSorter' | 'removeStep' | 'removeLoop' |
               'moveStep' | 'tidy' | 'newLine'
       opts    { near: { x, y } }  where a NEW line should go (the middle of the view), sizes: { bay: [w, h], … }

   ONLY WHAT CHANGED MOVES (the plan's decision 2): every machine already on the floor is pinned where it stands and every
   belt the edit does not touch is handed to the engine with its path, so it stays exactly where it is. TIDY LINE is the one
   edit that re-lays the whole line (anchored on its INBOX). Each op checks the line is the shape it expects and refuses in
   plain words when it is not — never a half-edit. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.LineEdit = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const JUNCTION = { splitter: 1, filter: 1, merger: 1, joiner: 1, loop: 1 };
  const fail = (error, msg) => ({ ok: false, error, msg });
  const clone = o => JSON.parse(JSON.stringify(o));
  function layoutModule() {
    let L = (typeof LineLayout !== 'undefined') ? LineLayout : null;
    if (!L && typeof require === 'function') { try { L = require('./linelayout.js'); } catch (_) { L = null; } }
    return L;
  }
  function pipelineModule() {
    let P = (typeof Pipeline !== 'undefined') ? Pipeline : null;
    if (!P && typeof require === 'function') { try { P = require('./pipeline.js'); } catch (_) { P = null; } }
    return P;
  }
  function foreignRouting(plan, edited) {
    return (plan.lines || []).filter(l => !(l.propIds || []).some(id => edited.has(id))).map(l => ({
      id: l.lineId, props: l.propIds.slice().sort(),
      docks: l.propIds.filter(id => plan.dockChains && plan.dockChains[id]).sort().map(id => ({
        id, next: (plan.dockChains[id].next || []).slice().sort(),
        outbox: !!plan.dockChains[id].outbox, gated: !!plan.dockChains[id].gated
      }))
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  /* ---------- graph helpers ---------- */
  const nodeOf = (g, id) => g.nodes.find(n => n.id === id) || null;
  // a LOOP's way back: its out-link that is neither DONE nor the escape (the compiler infers it the same way)
  const isBack = (g, l) => { const a = nodeOf(g, l.from.node); return !!a && a.t === 'loop' && l.from.port !== 'done' && l.from.port !== 'esc'; };
  const outsOf = (g, id) => g.links.filter(l => l.from.node === id && !isBack(g, l));
  const insOf = (g, id) => g.links.filter(l => l.to.node === id && !isBack(g, l));
  const backsAt = (g, id) => g.links.filter(l => isBack(g, l) && (l.to.node === id || l.from.node === id));
  // Only a preceding bay with one uninterrupted forward path to THIS gate can
  // anchor its review span. Branches, other gates and foreign lines are excluded.
  function loopBackCandidates(g, gateId) {
    if (!nodeOf(g, gateId) || nodeOf(g, gateId).t !== 'loop') return [];
    return g.nodes.filter(n => n.t === 'bay' && (() => {
      let id = n.id; const seen = new Set();
      while (!seen.has(id)) {
        seen.add(id);
        const outs = outsOf(g, id);
        if (outs.length !== 1) return false;
        id = outs[0].to.node;
        if (id === gateId) return true;
        const next = nodeOf(g, id);
        if (!next || next.t !== 'bay' || insOf(g, id).length !== 1) return false;
      }
      return false;
    })()).map(n => n.id);
  }
  const drop = (g, ls) => { g.links = g.links.filter(l => ls.indexOf(l) < 0); };
  // a fresh id for a new machine / link — '+' marks it new (the station numbers it for real when it is laid)
  function fresh(g) {
    let n = 0;
    const used = new Set(g.nodes.map(x => x.id).concat(g.links.map(x => x.id)));
    return p => { let id; do { id = '+' + p + (++n); } while (used.has(id)); used.add(id); return id; };
  }
  const sizeOf = (opts, t) => { const s = opts && opts.sizes && opts.sizes[t]; return JUNCTION[t] ? [1, 1] : (Array.isArray(s) ? s : [2, 2]); };
  function box(g, id, t, opts, extra) {
    const [w, h] = sizeOf(opts, t);
    const n = Object.assign({ id, t, w, h }, extra || {});
    if (JUNCTION[t]) n.block = false;   // a junction stands ON its belt (the catalog's blocks: false, as every blueprint stamps it)
    g.nodes.push(n);
    return n;
  }
  // a link keeps its id (and what it carries — a FILTER tag, a LOOP port) when only its far end changed; its belt is re-laid
  const relink = (l, to) => ({ id: l.id, from: clone(l.from), to: { node: to } });
  const link = (id, from, to, port) => ({ id, from: { node: from, port: port || 'out' }, to: { node: to } });
  const bayRole = r => (typeof r === 'string' && r) ? r : undefined;
  /* a BRANCH: from the lane `l` out of a SPLITTER / FILTER along a plain run of steps (one way in, one way out, no review loop
     sending work back to them) — { steps, links, end }: the belts it rides (the lane in, the belts between its steps, the belt
     out) and the machine it reaches (null when its last step sends nothing on) */
  function armOf(g, l) {
    const steps = [], links = [l];
    let cur = l.to.node;
    for (let guard = 0; guard < 64; guard++) {
      const n = nodeOf(g, cur);
      if (!n || n.t !== 'bay' || insOf(g, n.id).length !== 1 || backsAt(g, n.id).length) break;
      const outs = outsOf(g, n.id);
      if (outs.length > 1) break;
      steps.push(n.id);
      if (!outs.length) return { steps, links, end: null };
      links.push(outs[0]); cur = outs[0].to.node;
    }
    return { steps, links, end: cur };
  }
  /* a SPLIT left with one way through folds away — the SPLITTER and the JOINER / MERGER go and the last branch joins the line;
     one left with none closes up (what fed the split feeds what the join fed). A split with two ways or more is left as it is. */
  function foldSplit(g, S, J) {
    const sOut = outsOf(g, S.id), jIn = insOf(g, J.id), into = insOf(g, S.id)[0], onward = outsOf(g, J.id)[0];
    const arm = sOut.length === 1 ? armOf(g, sOut[0]) : null;
    const one = !!arm && jIn.length === 1 && arm.end === J.id;
    if (!one && sOut.length) return { ok: true, graph: g, focus: S.id };
    g.nodes = g.nodes.filter(n => n.id !== S.id && n.id !== J.id);
    drop(g, [into, onward].concat(sOut, jIn).filter(Boolean));
    const first = one && arm.steps.length ? arm.steps[0] : null, last = first ? arm.steps[arm.steps.length - 1] : null;
    if (into && (first || onward)) g.links.push(relink(into, first || onward.to.node));
    if (last && onward) g.links.push({ id: onward.id, from: { node: last, port: 'out' }, to: { node: onward.to.node } });
    return { ok: true, graph: g, focus: first || (into && into.from.node) };
  }
  // a SPLITTER whose branches never meet again, left with one branch, folds away (the belt into it runs to that branch)
  function foldSplitter(g, S) {
    const outs = outsOf(g, S.id), into = insOf(g, S.id);
    if (outs.length > 1) return { ok: true, graph: g, focus: S.id };
    g.nodes = g.nodes.filter(n => n.id !== S.id);
    drop(g, into.concat(outs));
    if (into.length === 1 && outs.length === 1) g.links.push(relink(into[0], outs[0].to.node));
    return { ok: true, graph: g, focus: outs.length ? outs[0].to.node : (into[0] && into[0].from.node) };
  }
  // a SORTER left sorting nothing (its EVERYTHING ELSE belt its only way out) folds away: the belt into it runs straight on
  function foldSorter(g, F) {
    const outs = outsOf(g, F.id), into = insOf(g, F.id);
    if (outs.length !== 1 || !outs[0].from.else || into.length !== 1) return { ok: true, graph: g, focus: F.id };
    g.nodes = g.nodes.filter(n => n.id !== F.id);
    drop(g, [into[0], outs[0]]);
    g.links.push(relink(into[0], outs[0].to.node));
    return { ok: true, graph: g, focus: outs[0].to.node };
  }
  /* the same graph with a junction's NEW lane `lid` read in each other place among its lanes: a sorter's routes are named by
     their links and a split's turns go round every branch, so any place routes the same work — the engine takes the first
     place it can lay (the compiler reads a junction's lanes E, S, W, N, and the free side decides where the new one reads) */
  function laneAlts(g, jId, lid) {
    return outsOf(g, jId).filter(l => l.id !== lid).reverse().map(o => {
      const h = clone(g), i = h.links.findIndex(l => l.id === lid), nl = h.links.splice(i, 1)[0];
      h.links.splice(h.links.findIndex(l => l.id === o.id), 0, nl);
      return h;
    });
  }
  const TYPE_ROLE = { code: 'ENGINEER', research: 'RESEARCHER' };

  /* ---------- the edits ---------- */
  const OPS = {
    /* ADD A STEP between two machines one link joins: A → B becomes A → [new BAY] → B */
    insertStep(g, a, o) {
      const l = g.links.find(q => q.from.node === a.from && q.to.node === a.to);
      if (!l) return fail('NO_LINK', 'those two machines are not joined by a belt');
      const id = fresh(g);
      const N = box(g, id('n'), 'bay', o, { role: bayRole(a.role) });
      drop(g, [l]);
      g.links.push(relink(l, N.id), link(id('l'), N.id, l.to.node));
      return { ok: true, graph: g, focus: N.id };
    },
    /* ADD A STEP after a machine: onto its one way out, or — at the end of the line — as its new last step */
    appendStep(g, a, o) {
      const outs = outsOf(g, a.after);
      if (outs.length === 1) return OPS.insertStep(g, { from: a.after, to: outs[0].to.node, role: a.role }, o);
      if (outs.length > 1) return fail('MANY_WAYS', 'this machine sends work several ways: use a + on the belt you mean');
      const A = nodeOf(g, a.after);
      if (!A || A.t === 'outbox') return fail('LINE_END', 'nothing comes after the OUTBOX');
      const id = fresh(g);
      const N = box(g, id('n'), 'bay', o, { role: bayRole(a.role) });
      g.links.push(link(id('l'), A.id, N.id));
      return { ok: true, graph: g, focus: N.id };
    },
    /* ADD A BRANCH. Around a step X (A → X → B): A → SPLITTER → { X, new BAY … } → JOINER / MERGER → B. Between two machines
       (A → B): A → SPLITTER → { new BAYs } → JOINER / MERGER → B. COPY TO EACH brings a JOINER (every branch gets the job,
       their results are combined); TAKE TURNS brings a MERGER (each job goes to one branch). */
    addBranch(g, a, o) {
      const n = Math.max(2, Math.min(3, (a.n | 0) || 2)), joinT = a.mode === 'turns' ? 'merger' : 'joiner';
      const id = fresh(g);
      let head, tail, keep = [], role = bayRole(a.role);
      if (a.around) {
        const X = nodeOf(g, a.around);
        if (!X || X.t !== 'bay') return fail('NOT_A_STEP', 'pick a step (a BAY) to branch around');
        const ins = insOf(g, X.id), outs = outsOf(g, X.id);
        if (ins.length !== 1 || outs.length !== 1) return fail('NOT_SIMPLE', 'a branch goes round a step with one way in and one way out');
        head = ins[0]; tail = outs[0]; keep = [X.id];
        role = role || bayRole(X.role);   // a second opinion / a second hand is named like the step it partners
      } else {
        const l = g.links.find(q => q.from.node === a.from && q.to.node === a.to);
        if (!l) return fail('NO_LINK', 'those two machines are not joined by a belt');
        head = l; tail = null;
      }
      const S = box(g, id('s'), 'splitter', o), J = box(g, id('j'), joinT, o);
      const kids = keep.slice();
      while (kids.length < n) kids.push(box(g, id('n'), 'bay', o, { role }).id);
      drop(g, [head].concat(tail ? [tail] : []));
      g.links.push(relink(head, S.id));
      for (const k of kids) g.links.push(link(id('l'), S.id, k));
      for (const k of kids) g.links.push(tail && k === keep[0] ? { id: tail.id, from: clone(tail.from), to: { node: J.id } } : link(id('l'), k, J.id));
      g.links.push(link(id('l'), J.id, tail ? tail.to.node : a.to));
      return { ok: true, graph: g, focus: S.id };
    },
    /* ADD A REVIEW LOOP round a step X (X → B): X → REVIEWER → LOOP; the LOOP sends the work back to X until the reviewer
       approves (or it has gone round `max` times), then on to B */
    addLoop(g, a, o) {
      const X = nodeOf(g, a.around);
      if (!X || X.t !== 'bay') return fail('NOT_A_STEP', 'pick a step (a BAY) to review');
      const outs = outsOf(g, X.id);
      if (outs.length !== 1) return fail('NOT_SIMPLE', 'a review loop goes round a step with one way out');
      if (backsAt(g, X.id).length) return fail('HAS_LOOP', 'this step already has a review loop');
      const max = Math.max(1, Math.min(20, (a.max | 0) || 3)), when = typeof a.when === 'string' && a.when ? a.when : 'approved';
      const id = fresh(g), next = outs[0];
      const R = box(g, id('n'), 'bay', o, { role: 'REVIEWER' });
      const G = box(g, id('g'), 'loop', o, { cfg: { maxIter: max, when } });
      drop(g, [next]);
      g.links.push(relink(next, R.id), link(id('l'), R.id, G.id), link(id('l'), G.id, next.to.node, 'done'), link(id('l'), G.id, X.id, 'back'));
      return { ok: true, graph: g, focus: G.id };
    },
    setLoopBack(g, a) {
      const G = nodeOf(g, a.id), target = nodeOf(g, a.target);
      if (!G || G.t !== 'loop') return fail('NOT_A_LOOP', 'pick a LOOP gate');
      if (!target || target.t !== 'bay' || !loopBackCandidates(g, G.id).includes(target.id)) return fail('NOT_UPSTREAM', 'choose a preceding step on this line with one forward path to this review gate');
      const back = g.links.filter(l => l.from.node === G.id && isBack(g, l));
      if (back.length !== 1) return fail('NOT_SIMPLE', 'this review gate needs exactly one return belt');
      drop(g, back); g.links.push(relink(back[0], target.id));
      return { ok: true, graph: g, focus: G.id };
    },
    /* ADD A SORTER between two machines (A → B, B a step or the OUTBOX): A → FILTER; CODE work → a new ENGINEER step, RESEARCH
       → a new RESEARCHER step, EVERYTHING ELSE straight on to B; the new steps hand on to B too */
    addSorter(g, a, o) {
      const l = g.links.find(q => q.from.node === a.from && q.to.node === a.to);
      if (!l) return fail('NO_LINK', 'those two machines are not joined by a belt');
      const B = nodeOf(g, a.to);
      if (!B || JUNCTION[B.t]) return fail('NOT_BEFORE_STEP', 'put a sorter in front of a step or the OUTBOX');
      const routes = Array.isArray(a.routes) && a.routes.length ? a.routes.slice(0, 2) : [{ tag: 'code', role: 'ENGINEER' }, { tag: 'research', role: 'RESEARCHER' }];
      const id = fresh(g);
      const F = box(g, id('f'), 'filter', o);
      drop(g, [l]);
      g.links.push(relink(l, F.id));
      for (const r of routes) {
        const N = box(g, id('n'), 'bay', o, { role: bayRole(r.role) });
        g.links.push({ id: id('l'), from: { node: F.id, port: 'out', tags: [String(r.tag)] }, to: { node: N.id } }, link(id('l'), N.id, B.id));
      }
      g.links.push({ id: id('l'), from: { node: F.id, port: 'out', else: true }, to: { node: B.id } });
      return { ok: true, graph: g, focus: F.id };
    },
    /* REMOVE A STEP: its way in joins its way out (A → X → B becomes A → B). A branch left with one way through folds away; a
       sorter's route step takes its route with it (that type of work then goes with everything else). */
    removeStep(g, a) {
      const X = nodeOf(g, a.id);
      if (!X || X.t !== 'bay') return fail('NOT_A_STEP', 'only a step (a BAY) is removed this way');
      if (backsAt(g, X.id).length) return fail('LOOP_ANCHOR', 'a review loop sends work back to this step: remove the loop first');
      const ins = insOf(g, X.id), outs = outsOf(g, X.id);
      if (ins.length !== 1 || outs.length > 1) return fail('NOT_SIMPLE', 'this step has several ways in or out: remove its branch instead');
      const A = nodeOf(g, ins[0].from.node), B = outs[0] ? nodeOf(g, outs[0].to.node) : null;
      g.nodes = g.nodes.filter(n => n.id !== X.id);
      drop(g, ins.concat(outs));
      // X was one branch of a split: that branch goes (a split left with one way through folds away — foldSplit)
      if (A && A.t === 'splitter' && B && (B.t === 'joiner' || B.t === 'merger')) return foldSplit(g, A, B);
      // X was a sorter's route to where everything else goes: the route goes too — never a second belt beside EVERYTHING ELSE
      // (a sorter left sorting nothing folds away)
      if (A && A.t === 'filter' && B && ins[0].from.tags && g.links.some(l => l.from.node === A.id && l.from.else && l.to.node === B.id)) return foldSorter(g, A);
      if (outs.length === 1) g.links.push(relink(ins[0], outs[0].to.node));
      return { ok: true, graph: g, focus: ins[0].from.node };
    },
    /* REMOVE A REVIEW LOOP: the LOOP gate and the REVIEWER step that fed it go; the step it reviewed hands straight on */
    removeLoop(g, a) {
      const G = nodeOf(g, a.id);
      if (!G || G.t !== 'loop') return fail('NOT_A_LOOP', 'pick a LOOP gate');
      const into = insOf(g, G.id), done = g.links.find(l => l.from.node === G.id && l.from.port === 'done');
      const back = g.links.filter(l => l.from.node === G.id && isBack(g, l));
      if (into.length !== 1 || !done) return fail('NOT_SIMPLE', 'this LOOP gate is not a plain review loop: remove its belts by hand');
      let from = into[0].from.node, R = nodeOf(g, from);
      const rIns = R ? insOf(g, R.id) : [];
      const drops = [into[0], done].concat(back), gone = [G.id];
      // the REVIEWER goes with its loop when it is the plain one the loop was added with (one way in, the loop its only way out)
      if (R && R.t === 'bay' && rIns.length === 1 && outsOf(g, R.id).length === 1 && !backsAt(g, R.id).length) { drops.push(rIns[0]); gone.push(R.id); }
      g.nodes = g.nodes.filter(n => gone.indexOf(n.id) < 0);
      drop(g, drops);
      if (gone.length === 2) g.links.push(relink(rIns[0], done.to.node));
      else g.links.push(relink(into[0], done.to.node));
      return { ok: true, graph: g, focus: gone.length === 2 ? rIns[0].from.node : from };
    },
    /* ANOTHER BRANCH on a split: a new step where the branches split and meet again (S → new BAY → where they meet), named like
       the branches beside it — a third opinion on a COPY split (the JOINER then waits for it too), a third hand on TURNS */
    addArm(g, a, o) {
      const S = nodeOf(g, a.split);
      if (!S || S.t !== 'splitter') return fail('NOT_A_SPLIT', 'pick a SPLITTER');
      const outs = outsOf(g, S.id);
      if (!outs.length) return fail('NO_BRANCHES', 'this splitter sends nothing out yet: add a step on the belt into it instead');
      if (outs.length >= 3) return fail('FULL', 'a splitter has four sides — one belt in and three branches out at most: this one is full');
      const arms = outs.map(l => armOf(g, l)), end = arms[0].end;
      if (end == null || arms.some(x => x.end !== end)) return fail('NOT_SIMPLE', 'this splitter\'s branches do not meet again — add a step on one of its belts instead');
      const E = nodeOf(g, end);
      if (E && JUNCTION[E.t] && insOf(g, E.id).length >= 3) return fail('FULL', 'the ' + E.t.toUpperCase() + ' where the branches meet takes three belts in at most: it is full');
      const roles = arms.map(x => x.steps.length ? nodeOf(g, x.steps[0]).role : undefined);
      const role = bayRole(a.role) || (roles[0] && roles.every(r => r === roles[0]) ? roles[0] : undefined);
      const id = fresh(g), N = box(g, id('n'), 'bay', o, { role });
      const lane = link(id('l'), S.id, N.id);
      g.links.push(lane, link(id('l'), N.id, end));
      // (the branches beside it may spread to make room: their lanes out of the SPLITTER and into where they meet)
      const loose = [].concat.apply([], arms.map(x => [x.links[0].id, x.links[x.links.length - 1].id]));
      return { ok: true, graph: g, focus: N.id, alts: laneAlts(g, S.id, lane.id), loose };
    },
    /* REMOVE A BRANCH as one piece: every step on it goes (the run of steps from the SPLITTER to where the branches meet); a
       split left with one way through folds away */
    removeArm(g, a) {
      const S = nodeOf(g, a.split);
      if (!S || S.t !== 'splitter') return fail('NOT_A_SPLIT', 'pick a SPLITTER');
      const l = outsOf(g, S.id).find(q => q.to.node === a.head);
      if (!l) return fail('NOT_A_BRANCH', 'that is not one of this splitter\'s branches');
      const arm = armOf(g, l), E = arm.end != null ? nodeOf(g, arm.end) : null;
      if (!arm.steps.length) return fail('NOT_SIMPLE', 'this branch is not a run of steps: take its machines out one by one');
      g.nodes = g.nodes.filter(n => arm.steps.indexOf(n.id) < 0);
      drop(g, arm.links);
      if (E && (E.t === 'joiner' || E.t === 'merger')) return foldSplit(g, S, E);
      // branches that never meet again: the branch's own OUTBOX goes with it (one another branch still fills stays)
      if (E && E.t === 'outbox' && !insOf(g, E.id).length) g.nodes = g.nodes.filter(n => n.id !== E.id);
      return foldSplitter(g, S);
    },
    /* A ROUTE FOR A TYPE on a sorter that has none: a new step (CODE → an ENGINEER, RESEARCH → a RESEARCHER) takes that type of
       work and hands on to where everything else goes */
    addRoute(g, a, o) {
      const F = nodeOf(g, a.id);
      if (!F || F.t !== 'filter') return fail('NOT_A_SORTER', 'pick a FILTER');
      const tag = TYPE_ROLE[a.tag] ? a.tag : null;
      if (!tag) return fail('BAD_TYPE', 'a sorter knows two types of work by name: CODE and RESEARCH');
      const outs = outsOf(g, F.id);
      if (outs.some(l => (l.from.tags || []).indexOf(tag) >= 0)) return fail('HAS_ROUTE', tag.toUpperCase() + ' work already has its own way out of this sorter');
      if (outs.length >= 3) return fail('FULL', 'a FILTER has four sides — one belt in and three out at most: this one is full');
      const els = outs.find(l => l.from.else), T = els ? nodeOf(g, els.to.node) : null;
      if (!T) return fail('NO_ELSE', 'choose where EVERYTHING ELSE goes first — the new step hands on there');
      if (JUNCTION[T.t] && T.t !== 'merger') return fail('NOT_SIMPLE', 'everything else goes into a ' + T.t.toUpperCase() + ' here, which cannot take another belt in — add the route by hand');
      const id = fresh(g), N = box(g, id('n'), 'bay', o, { role: bayRole(a.role) || TYPE_ROLE[tag] });
      const lane = { id: id('l'), from: { node: F.id, port: 'out', tags: [tag] }, to: { node: N.id } };
      g.links.push(lane, link(id('l'), N.id, T.id));
      // (the routes beside it may spread to make room: the sorter's lanes and the belts they hand on by)
      const loose = [].concat.apply([], outs.map(l => { const x = armOf(g, l); return [x.links[0].id, x.links[x.links.length - 1].id]; }));
      return { ok: true, graph: g, focus: N.id, alts: laneAlts(g, F.id, lane.id), loose };
    },
    /* REMOVE A SORTER as one piece: the FILTER goes with every route step it sorts work to (each a run of steps that rejoins
       where everything else goes); the belt into it runs straight on to where everything else went */
    removeSorter(g, a) {
      const F = nodeOf(g, a.id);
      if (!F || F.t !== 'filter') return fail('NOT_A_SORTER', 'pick a FILTER');
      const ins = insOf(g, F.id), outs = outsOf(g, F.id), els = outs.find(l => l.from.else);
      if (ins.length !== 1) return fail('NOT_SIMPLE', 'this sorter has several belts in: take it apart by hand');
      if (!els) return fail('NO_ELSE', 'this sorter sends nothing on for everything else, so the line has no one way to run on — choose a belt for EVERYTHING ELSE first');
      const T = els.to.node, gone = [F.id], drops = [ins[0]].concat(outs);
      for (const l of outs) {
        if (l === els) continue;
        const arm = armOf(g, l);
        if (arm.end !== T) return fail('NOT_SIMPLE', 'a route of this sorter does not rejoin the line where everything else goes — take its steps out first');
        gone.push.apply(gone, arm.steps);
        drops.push.apply(drops, arm.links);
      }
      g.nodes = g.nodes.filter(n => gone.indexOf(n.id) < 0);
      drop(g, drops);
      g.links.push(relink(ins[0], T));
      return { ok: true, graph: g, focus: T };
    },
    /* MOVE A STEP one place earlier (dir -1) or later (+1) along a plain run of steps: A → P → X → B becomes A → X → P → B, and
       two steps the same size swap places on the floor */
    moveStep(g, a) {
      const X = nodeOf(g, a.id), dir = a.dir < 0 ? -1 : 1;
      if (!X || X.t !== 'bay') return fail('NOT_A_STEP', 'pick a step (a BAY)');
      const plain = n => n && n.t === 'bay' && insOf(g, n.id).length === 1 && outsOf(g, n.id).length === 1 && !backsAt(g, n.id).length;
      if (!plain(X)) return fail('NOT_SIMPLE', 'only a step with one way in and one way out moves along the line');
      const other = dir < 0 ? nodeOf(g, insOf(g, X.id)[0].from.node) : nodeOf(g, outsOf(g, X.id)[0].to.node);
      if (!other || other.t !== 'bay') return fail('NO_NEIGHBOUR', dir < 0 ? 'there is no step before it to swap with' : 'there is no step after it to swap with');
      if (!plain(other)) return fail('NO_NEIGHBOUR', (dir < 0 ? 'the step before it' : 'the step after it') + ' is part of a loop or a branch, so they cannot swap places');
      const [P, Q] = dir < 0 ? [other, X] : [X, other];   // P → Q becomes Q → P
      const inP = insOf(g, P.id)[0], mid = outsOf(g, P.id)[0], outQ = outsOf(g, Q.id)[0];
      drop(g, [inP, mid, outQ]);
      g.links.push(relink(inP, Q.id), { id: mid.id, from: { node: Q.id, port: 'out' }, to: { node: P.id } }, { id: outQ.id, from: { node: P.id, port: 'out' }, to: { node: outQ.to.node } });
      if (P.w === Q.w && P.h === Q.h && P.pin && Q.pin) { const t = P.pin; P.pin = Q.pin; Q.pin = t; }
      return { ok: true, graph: g, focus: X.id };
    },
    /* TIDY LINE: the whole line laid out afresh, anchored where its INBOX stands */
    tidy(g) {
      const anchor = g.nodes.find(n => n.t === 'intake') || g.nodes[0];
      if (!anchor) return fail('EMPTY', 'there is no line here');
      for (const n of g.nodes) if (n !== anchor) delete n.pin;
      for (const l of g.links) delete l.path;
      return { ok: true, graph: g, focus: anchor.id };
    },
    /* ADD AN OUTBOX after the machine a line ends on (one that sends its work nowhere yet) */
    addOutbox(g, a, o) {
      const X = nodeOf(g, a.after);
      if (!X || X.t === 'outbox' || X.t === 'intake') return fail('NOT_AN_END', 'an OUTBOX goes after the last step of a line');
      if (outsOf(g, X.id).length) return fail('NOT_AN_END', 'this machine already sends its work on');
      const id = fresh(g), O = box(g, id('o'), 'outbox', o);
      g.links.push(link(id('l'), X.id, O.id, X.t === 'loop' ? 'done' : 'out'));   // after a LOOP, finished work leaves on DONE
      return { ok: true, graph: g, focus: O.id };
    },
    /* MAKE A LONE STEP A LINE: an INBOX feeds it and an OUTBOX takes its work */
    wrapLine(g, a, o) {
      const X = nodeOf(g, a.id);
      if (!X || X.t !== 'bay') return fail('NOT_A_STEP', 'pick a step (a BAY)');
      if (g.links.length || g.nodes.length !== 1) return fail('ON_A_LINE', 'this step is already on a line');
      const id = fresh(g);
      const I = box(g, id('i'), 'intake', o), O = box(g, id('o'), 'outbox', o);
      g.links.push(link(id('l'), I.id, X.id), link(id('l'), X.id, O.id));
      return { ok: true, graph: g, focus: I.id };
    },
    /* A NEW LINE: INBOX → one step → OUTBOX, placed on clear floor near the middle of the view */
    newLine(g, a, o) {
      const id = fresh(g);
      const I = box(g, id('i'), 'intake', o, a && a.label ? { label: a.label } : null);
      const N = box(g, id('n'), 'bay', o, { role: bayRole(a && a.role) });
      const O = box(g, id('o'), 'outbox', o);
      g.links.push(link(id('l'), I.id, N.id), link(id('l'), N.id, O.id));
      return { ok: true, graph: g, focus: I.id };
    },
  };

  /* ---------- a layout answer, in the Commander's words ---------- */
  function why(L) {
    if (L.error === 'NO_ROOM') return fail('NO_ROOM', 'there is no clear floor big enough for this line — MAKE ROOM, or clear some space');
    if (L.error === 'NO_SPACE') return fail('NO_SPACE', 'there is no clear floor next to the line for the new machine — clear a little space round it and try again');
    if (L.why === 'SIDES') return fail('NO_SIDES', 'a junction there has no free side for every belt it needs — clear the tiles round it, or TIDY LINE');
    if (L.why === 'LANE_ORDER') return fail('NO_ROUTE', 'the belts could not keep this junction\'s lanes in order here — TIDY LINE, or clear space round it');
    return fail('NO_ROUTE', 'a belt could not find a way round what stands there — clear a path, or TIDY LINE');
  }

  /* ---------- run an edit on a station: graph → layout → one undo slot ---------- */
  const hasPath = l => Array.isArray(l.path) && l.path.length > 0;
  // the same graph with belts let go: the links named (ids), else every belt of a machine a changed link touches (the
  // round-the-change set), or all of them
  function loosen(gr, all, ids) {
    const h = clone(gr), hot = new Set(), named = ids ? new Set(ids) : null;
    if (!all && !named) for (const l of h.links) if (!hasPath(l)) { hot.add(l.from.node); hot.add(l.to.node); }
    for (const l of h.links) if (hasPath(l) && (all || (named ? named.has(l.id) : (hot.has(l.from.node) || hot.has(l.to.node))))) delete l.path;
    return h;
  }
  function run(station, propId, op, args, opts) {
    const LL = layoutModule();
    if (!LL) return fail('NO_ENGINE', 'the layout engine is not loaded');
    if (!OPS[op]) return fail('BAD_OP', 'no such edit');
    if (!station || typeof station.lineGraph !== 'function') return fail('NO_STATION', 'this station cannot edit lines');
    const g = station.lineGraph(op === 'newLine' ? null : propId);
    if (!g || !g.ok) return g || fail('NOT_LINKED', 'this line cannot be edited here');
    const e = OPS[op](clone(g.graph), args || {}, opts || {});
    if (!e.ok) return e;
    /* WHERE THE LINE STANDS: first every belt the edit did not touch is kept exactly (only what changed moves); when that leaves
       the change no way through, the belts it names may spread (e.loose — a split's or a sorter's own lanes), then every belt
       of a machine the edit touched, then every belt of the line. Its machines never move — only TIDY LINE moves them. Another
       branch / another route may read in any place among its junction's lanes (e.alts): each is tried at each level. */
    const near = opts && opts.near, tries = [e.graph].concat(Array.isArray(e.alts) ? e.alts : []);
    const levels = [gr => gr, Array.isArray(e.loose) && e.loose.length ? gr => loosen(gr, false, e.loose) : null, gr => loosen(gr, false), gr => loosen(gr, true)].filter(Boolean);
    let graph = null, L = null, relaid = 0, tidied = false;
    for (let level = 0; level < levels.length && !graph; level++) {
      for (const gr of tries) {
        if (level && !gr.links.some(hasPath)) continue;   // nothing kept to loosen (a new line, TIDY LINE)
        const gg = levels[level](gr), T = LL.layout(gg, g.floor, { near });
        if (T.ok) { graph = gg; L = T; relaid = level; break; }
        if (!L) L = T;   // (the first answer is the one a refusal explains)
      }
    }
    if (!graph) {
      /* say what would actually help: TIDY LINE only when the same edit fits with the line laid out afresh; when even that
         cannot fit, the floor is too small for this line — a bigger room is the answer, never "tidy it" in a circle */
      if (op === 'tidy' || op === 'newLine') return op === 'tidy' ? fail('NO_FIT', 'this whole line does not fit here laid out afresh — give it a bigger room (Rooms), or keep it as it is') : why(L);
      const t = OPS.tidy(clone(e.graph));
      const T = t.ok ? LL.layout(t.graph, g.floor, { near: opts && opts.near }) : null;
      if (!(T && T.ok)) return fail(L.error === 'NO_SPACE' || L.error === 'NO_ROOM' ? L.error : 'NO_FIT', 'there is not enough clear floor round this line for that — give it a bigger room (Rooms), or clear some space');
      // it fits with the line laid out afresh: that moves every machine of the line, so it is done only when asked (opts.tidy —
      // the panel's armed second click), never on the first
      if (!(opts && opts.tidy)) return Object.assign(fail('NEEDS_TIDY', 'there is no room for that with the line where it stands — TIDY LINE first, then try again'), { canTidy: true });
      graph = t.graph; L = T; tidied = true;
    }
    // A successful geometric placement must not merge or reroute another workflow.
    // Use the station's existing transaction so a refusal also preserves undo/redo.
    const P = pipelineModule(), edited = new Set(g.graph.nodes.map(n => n.id));
    const guarded = P && typeof station.projectGeometry === 'function' && typeof station.transact === 'function';
    const before = guarded ? foreignRouting(P.compileRoutingPlan(station.projectGeometry()), edited) : null;
    const apply = () => {
      const r = station.applyLineLayout(graph, L);
      if (!r || !r.ok || !guarded) return r;
      const after = foreignRouting(P.compileRoutingPlan(station.projectGeometry()), new Set(Object.values(r.ids || {})));
      if (JSON.stringify(before) !== JSON.stringify(after)) return fail('OTHER_LINE_CHANGED', 'this edit would change another workflow — move this line to clear floor and try again');
      if (op === 'setLoopBack') {
        const geo = station.projectGeometry(), plan = P.compileRoutingPlan(geo);
        const gate = (geo.props || []).find(p => p.id === ((r.ids && r.ids[args.id]) || args.id));
        const routed = gate && plan.gateDocks && plan.gateDocks[gate.x + ',' + gate.y];
        if (!routed || routed.backTo !== ((r.ids && r.ids[args.target]) || args.target)) return fail('RETURN_NOT_ROUTED', 'the return belt did not reach the selected step; the change was rolled back');
      }
      return r;
    };
    const r = guarded ? station.transact(apply) : apply();
    if (!r || !r.ok) return r || fail('NOT_APPLIED', 'the edit could not be laid');
    return { ok: true, focus: (r.ids && r.ids[e.focus]) || e.focus, ids: r.ids, removed: r.removed || [], relaid, tidied };
  }
  /* ---------- A READY-MADE LINE, LAID OUT TO FIT (conveyor-links phase E) ----------
     A shelf line is a graph (worldmodel blueprintGraph). Where its drawn tile map will not go, the engine lays the same
     line out on the floor near the spot: its own tidy shape first (nearest the spot), then — when no clear rectangle
     holds that shape — anchored on its INBOX at the clear spots nearest the spot, every other machine stepping round
     what stands there. Every line so laid routes exactly as the drawn one (the engine keeps each junction's lane order). */
  function layoutNear(LL, graph, floor, near, maxTries) {
    const U = LL.layout(graph, floor, { near });
    if (U.ok) return Object.assign(U, { via: 'shape' });
    const A = graph.nodes.find(n => n.t === 'intake') || graph.nodes[0];
    if (!A) return U;
    const fl = LL._internals.floorOf(floor), spots = [];
    // the INBOX opens a line that runs east: aim it half the line's length WEST of the spot, so the line lands centred on it
    const half = U.needs && U.needs.w ? U.needs.w >> 1 : 0;
    const cx = near && isFinite(near.x) ? near.x - half : null, cy = near && isFinite(near.y) ? near.y : null;
    for (const r of fl.rects) for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) {
      let clear = true;
      for (let yy = y; yy < y + (A.h || 2) && clear; yy++) for (let xx = x; xx < x + (A.w || 2) && clear; xx++) if (!fl.free(xx, yy) || fl.inflow(xx, yy)) clear = false;
      if (clear) spots.push({ x, y, d: cx == null ? 0 : Math.abs(x - cx) + Math.abs(y - cy) });
    }
    spots.sort((p, q) => p.d - q.d || p.y - q.y || p.x - q.x);
    let last = U;
    for (let i = 0; i < spots.length && i < (maxTries || 12); i++) {
      const s = spots[i];
      const r = LL.layout({ nodes: graph.nodes.map(n => n === A ? Object.assign({}, n, { pin: { x: s.x, y: s.y } }) : n), links: graph.links }, floor);
      if (r.ok) return Object.assign(r, { via: 'anchored' });
      last = r;
    }
    return U.error === 'NO_ROOM' ? U : last;   // (NO_ROOM carries the room the line needs — MAKE ROOM's size)
  }
  function placeBlueprint(station, bpId, near, opts) {
    const LL = layoutModule();
    if (!LL) return fail('NO_ENGINE', 'the layout engine is not loaded');
    if (!station || typeof station.blueprintGraph !== 'function') return fail('NO_STATION', 'this station cannot lay out lines');
    const b = station.blueprintGraph(bpId, opts && opts.stamp);
    if (!b || !b.ok) return b || fail('NOT_FOUND', 'no such line');
    const g = station.lineGraph(null);
    if (!g || !g.ok) return g || fail('NOT_LINKED', 'this floor does not build by links');
    const L = layoutNear(LL, b.graph, g.floor, near, 12);
    if (!L.ok) return Object.assign(fail(L.error === 'NO_ROOM' ? 'NO_ROOM' : 'NO_FIT', 'there is no clear floor here this line can be laid out on — MAKE ROOM FOR IT, or clear some space'), L.needs ? { needs: L.needs } : {});
    const r = station.applyLineLayout(b.graph, L);
    if (!r || !r.ok) return r || fail('NOT_APPLIED', 'the line could not be laid');
    return { ok: true, ids: b.graph.nodes.map(n => r.ids[n.id]).filter(Boolean), via: L.via };
  }
  // does it fit ANYWHERE, laid out? (the shelf card's answer when the drawn shape fits nowhere) — { ok, via, needs }
  function canPlaceBlueprint(station, bpId, near) {
    const LL = layoutModule();
    if (!LL || !station || typeof station.blueprintGraph !== 'function') return fail('NO_ENGINE', 'the layout engine is not loaded');
    const b = station.blueprintGraph(bpId), g = station.lineGraph(null);
    if (!b || !b.ok || !g || !g.ok) return fail('NOT_LINKED', 'this floor does not build by links');
    const L = layoutNear(LL, b.graph, g.floor, near, 6);
    return L.ok ? { ok: true, via: L.via } : Object.assign(fail(L.error, 'no clear floor for it'), L.needs ? { needs: L.needs } : {});
  }

  // the same edit, answered without laying anything (the panel greys out what would only fail)
  function check(station, propId, op, args, opts) {
    const g = station && typeof station.lineGraph === 'function' ? station.lineGraph(op === 'newLine' ? null : propId) : null;
    if (!g || !g.ok) return g || fail('NOT_LINKED', 'this line cannot be edited here');
    return OPS[op] ? OPS[op](clone(g.graph), args || {}, opts || {}) : fail('BAD_OP', 'no such edit');
  }

  return { run, check, placeBlueprint, canPlaceBlueprint, loopBackCandidates, OPS, _internals: { why, isBack, outsOf, insOf, layoutNear, armOf, laneAlts, loosen } };
});
