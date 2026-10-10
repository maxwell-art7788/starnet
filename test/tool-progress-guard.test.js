/* node test/tool-progress-guard.test.js - evidence-based successful-tool loop guard.
   The replay fixture is the privacy-scrubbed SHAPE of the 156-call Drive incident: refs and limits change, but
   the agent keeps observing the same document row. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { makeToolProgressGuard, _internals: T } = require('../sidecar/tool-progress-guard.js');
const { makeRunExecutionState } = require('../sidecar/run-execution-state.js');

const call = (name, args, id) => ({ id: id || name, name, args: args || {}, argsRaw: JSON.stringify(args || {}) });
const tool = scope => ({ scope: scope || 'read' });
const ok = (content, summary) => ({ ok: true, isError: false, content, summary: summary || 'ok' });

// Host-generated volatility must not manufacture evidence.
A.eq(T.normalizeEvidence('b12 [button] X ref b9 .output/browser.snapshot-12345678-1234-1234-1234-123456789abc-9.txt'),
  'b<id> [button] X ref b<id> .output/<parked-result>.txt', 'refs and parked receipt ids normalize away');

// Identical successful calls warn, then block BEFORE another paid dispatch.
{
  const g = makeToolProgressGuard({ warnAfter: 2, exactBlockAfter: 4, routeBlockAfter: 20 });
  const c = call('browser.get_text', { selector: 'body' });
  A.eq(g.before(c, tool()).action, 'allow', 'first read admitted');
  A.eq(g.after(c, ok('same page', 'text'), tool()).action, 'allow', 'first read is evidence');
  A.eq(g.after(c, ok('same page', 'text'), tool()).action, 'warn', 'second identical success warns');
  g.after(c, ok('same page', 'text'), tool());
  g.after(c, ok('same page', 'text'), tool());
  const blocked = g.before(c, tool());
  A.eq(blocked.action, 'block', 'fifth identical successful read is blocked before dispatch');
  A.eq(blocked.code, 'repeated_success_no_progress', 'block names successful no-progress repetition');
}

// New evidence resets the old exact-call streak.
{
  const g = makeToolProgressGuard({ warnAfter: 2, exactBlockAfter: 4, routeBlockAfter: 20 });
  const c = call('browser.snapshot', { limit: 20 });
  g.after(c, ok('b1 [button] old'), tool());
  g.after(c, ok('b9 [button] old'), tool()); // same after ref normalization
  g.after(c, ok('b10 [button] new menu'), tool());
  A.eq(g.before(c, tool()).action, 'allow', 'changed page evidence clears the exact-repeat streak');
}

// Replay: changing refs and search limits cannot disguise one unchanged Drive state forever.
{
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'drive-docx-no-progress.json'), 'utf8'));
  const g = makeToolProgressGuard({ warnAfter: 3, exactBlockAfter: 8, routeBlockAfter: 6 });
  let warning = null;
  for (const [i, row] of fixture.calls.entries()) {
    const c = call(row.name, row.args, 'r' + i);
    const gate = g.before(c, tool('read'));
    if (gate.action === 'block') break;
    const decision = g.after(c, ok(row.content, row.summary), tool('read'));
    if (decision.action === 'warn') warning = warning || decision;
  }
  A.ok(warning && /change strategy|Re-plan/.test(warning.message), 'replay receives a fixed strategy-change warning');
  const finalProbe = g.before(call('browser.get_text', { selector: 'body' }, 'final'), tool('read'));
  A.eq(finalProbe.action, 'block', 'privacy-scrubbed Drive churn reaches the route circuit breaker');
  A.eq(finalProbe.code, 'strategy_route_exhausted', 'varied calls are blocked as one exhausted route');
  A.ok(!/Latest Resume|Drive/.test(finalProbe.message), 'guard guidance contains no page-authored text');
  // Escape routes remain available: the task is replanned, not killed.
  A.eq(g.before(call('fs.read', { path: 'downloads/resume.docx' }), tool('read')).action, 'allow', 'local document read remains available');
  A.eq(g.before(call('browser.navigate', { url: 'https://drive.example/download' }), tool('execute')).action, 'allow', 'state-changing browser route remains available');
}

// The run-state seam exposes one controller to nested and ordinary dispatch paths. code.run itself is not
// counted: its nested dispatches already cross this seam, and the composition may legitimately mutate state.
{
  const state = makeRunExecutionState({ progressLimits: { warnAfter: 2, exactBlockAfter: 3, routeBlockAfter: 10 } });
  const outer = call('code.run', { code: 'return tool("browser_get_text",{})' });
  for (let i = 0; i < 10; i++) state.observeProgress(outer, ok('same composed observation'), tool('read'));
  A.eq(state.beforeProgress(outer, tool('read')).action, 'allow', 'outer code.run remains available without double-counting nested reads');
  const c = call('browser.get_text', { selector: 'body' });
  state.observeProgress(c, ok('same nested observation'), tool('read'));
  const warning = state.observeProgress(c, ok('same nested observation'), tool('read'));
  A.eq(warning.action, 'warn', 'composed read participates in the same evidence ledger');
  state.observeProgress(c, ok('same nested observation'), tool('read'));
  A.eq(state.beforeProgress(c, tool('read')).action, 'block', 'composed read is blocked before another dispatch');
}

// State-changing browser calls remain capabilities even when their generic receipts are identical.
{
  const g = makeToolProgressGuard({ warnAfter: 2, exactBlockAfter: 3, routeBlockAfter: 4 });
  const c = call('browser.click', { ref: 'b7' });
  for (let i = 0; i < 20; i++) {
    A.eq(g.before(c, tool('execute')).action, 'allow', 'repeated browser actions are never suppressed');
    g.after(c, ok('clicked', 'clicked'), tool('execute'));
  }
}

// Untracked workspace mutations are never inferred safe or blocked from result text.
{
  const g = makeToolProgressGuard({ warnAfter: 1, exactBlockAfter: 2, routeBlockAfter: 2 });
  const c = call('fs.write', { path: 'x', content: 'x' });
  for (let i = 0; i < 10; i++) g.after(c, ok('wrote'), tool('write'));
  A.eq(g.before(c, tool('write')).action, 'allow', 'guard does not police unknown mutation semantics');
}

// A multi-page review may revisit distinct images. Six rereads of six different files used to exhaust the
// shared workspace-read route, blocking the remaining pages and even a newly-written review receipt.
{
  const g = makeToolProgressGuard();
  const pages = Array.from({ length: 9 }, (_, i) => call('fs.read', { path: 'previews/page-' + i + '.png' }));
  const image = i => Object.assign(ok('previews/page-' + i + '.png: PNG 600×800', 'png 600×800'), { images: [{ mime: 'image/png', data: 'page-bytes-' + i }] });
  for (let pass = 0; pass < 2; pass++) {
    for (const [i, c] of pages.entries()) {
      A.eq(g.before(c, tool()).action, 'allow', 'distinct page ' + i + ' remains readable on pass ' + pass);
      g.after(c, image(i), tool());
    }
  }
  A.eq(g.before(call('fs.read', { path: 'review.json' }), tool()).action, 'allow', 'a fresh review receipt is not blocked by preview rereads');
  A.eq(g.before(call('tool.search', { query: 'image' }), tool()).action, 'allow', 'preview rereads do not exhaust tool discovery');
}

// The original exact-call bound remains four identical successful reads, without another dispatch.
{
  const g = makeToolProgressGuard();
  const c = call('fs.read', { path: 'previews/page.png' });
  for (let i = 0; i < 4; i++) {
    A.eq(g.before(c, tool()).action, 'allow', 'file repeat ' + i + ' is within the existing allowance');
    g.after(c, ok('unchanged file'), tool());
  }
  A.eq(g.before(c, tool()).code, 'repeated_success_no_progress', 'same-file exact repetition still stops at four');
}

// Changing ignored image-read limits or lexical aliases cannot evade the per-file stale budget. A distinct
// file remains readable afterward. Resource identities stay private in decisions and diagnostics.
{
  const g = makeToolProgressGuard();
  const target = 'private-previews/page.png';
  for (let i = 0; i <= 6; i++) {
    const p = i % 2 ? './private-previews/../private-previews/page.png' : target;
    const c = call('fs.read', { path: p, limit: i + 1 });
    A.eq(g.before(c, tool()).action, 'allow', 'distinct limit ' + i + ' is admitted before stale bound');
    g.after(c, Object.assign(ok(p + ': PNG 600×800', 'png 600×800'), { images: [{ mime: 'image/png', data: 'same-pixels' }] }), tool());
  }
  const blocked = g.before(call('fs.read', { path: target, limit: 100 }), tool());
  A.eq(blocked.code, 'strategy_route_exhausted', 'same file remains route-blocked after six unchanged results');
  A.eq(blocked.route, 'workspace-read', 'public route label stays stable');
  A.ok(!JSON.stringify([blocked, g.snapshot()]).includes('private-previews'), 'diagnostics do not reveal paths');
  A.eq(g.before(call('fs.read', { path: 'another-page.png' }), tool()).action, 'allow', 'one stale file does not block another file');
  A.eq(g.before(call('fs.search', { query: 'new evidence' }), tool()).action, 'allow', 'one stale file does not block a different search strategy');
}

// Normalize only the host platform's lexical path rules. No filesystem alias or authority claim is made.
{
  A.eq(T.normalizedReadPath('C:\\Previews\\..\\Pages\\ONE.PNG', 'win32'),
    T.normalizedReadPath('c:/Pages/one.png', 'win32'), 'Windows separators, dot segments and case normalize');
  A.ok(T.normalizedReadPath('/Pages/ONE.PNG', 'linux') !== T.normalizedReadPath('/Pages/one.png', 'linux'), 'POSIX case distinctions remain distinct');
  A.ok(T.normalizedReadPath('pages/one.png', 'linux') !== T.normalizedReadPath('/project/pages/one.png', 'linux'), 'relative and absolute aliases are not inferred');
  const g = makeToolProgressGuard();
  const rawOnly = { name: 'fs.read', argsRaw: JSON.stringify({ path: './pages/one.png' }) };
  g.after(rawOnly, ok('same file'), tool());
  const next = g.after(call('fs.read', { path: 'pages/one.png' }), ok('same file'), tool());
  A.eq(next.code, 'no_new_evidence', 'parsed args and argsRaw identify the same local read');
}

// Same metadata does not mean same pixels. Inline bytes distinguish a revised image; remote URL churn is
// deliberately not treated as pixel evidence, and public notices never expose image bytes.
{
  const g = makeToolProgressGuard();
  const c = call('fs.read', { path: 'proof.png' });
  const image = data => Object.assign(ok('proof.png: PNG 600×800, 12 KB', 'png 600×800'), { images: [{ mime: 'image/png', data }] });
  A.eq(g.after(c, image('pixels-v1'), tool()).code, 'new_evidence', 'first inline image is evidence');
  A.eq(g.after(c, image('pixels-v1'), tool()).code, 'no_new_evidence', 'same inline pixels are unchanged');
  const changed = g.after(c, image('pixels-v2'), tool());
  A.eq(changed.code, 'new_evidence', 'changed image pixels reset stale evidence despite unchanged description');
  A.ok(!JSON.stringify([changed, g.snapshot()]).includes('pixels-v'), 'image payload is not exposed in decisions');
  A.eq(T.evidenceKey(c, { content: 'same', images: [{ url: 'https://example.test/a' }] }),
    T.evidenceKey(c, { content: 'same', images: [{ url: 'https://example.test/b' }] }), 'URL changes alone do not prove new image pixels');
  A.eq(T.evidenceKey(call('browser.snapshot'), image('pixels-v1')),
    T.evidenceKey(call('browser.snapshot'), image('pixels-v2')), 'browser evidence policy is unchanged by the local-file fix');
}

// Non-file workspace searches retain their shared route bound; this fix does not lift strategy limits.
{
  const g = makeToolProgressGuard();
  for (let i = 0; i <= 6; i++) {
    const c = call(i % 2 ? 'fs.search' : 'tool.search', { query: 'query-' + i });
    g.after(c, ok('same search result'), tool());
  }
  A.eq(g.before(call('fs.list', { path: '.' }), tool()).code, 'strategy_route_exhausted', 'unchanged workspace search route still stops');
}

A.report('tool-progress-guard.test');
