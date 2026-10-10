/* sidecar/tool-progress-guard.js - successful-but-stuck tool route detector.

   The older loop guard correctly stopped one byte-identical FAILING call, but a model could still spend a
   whole run on nominal successes: snapshot the same page, re-read the parked snapshot through code.run, click
   controls that change no durable state, then repeat with fresh refs. This controller treats NEW EVIDENCE as
   progress instead of treating `ok:true` as progress.

   Pure bookkeeping only. The run host owns dispatch and decides how warnings/blocks reach the model. Raw tool
   arguments and raw results never leave this module; public decisions carry fixed host-authored guidance. */
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const BROWSER_ACTION_RE = /^browser\.(?:attach|back|click|detach|dialog|drag|emulate|eval|forward|hover|intercept|navigate|press|scroll|select|tab_select|tab_close|type|upload|viewport)$/;
const BROWSER_OBSERVE_RE = /^browser\.(?:snapshot|get_text|find|wait|console|network|inspect|tabs|test_state|test_snapshot)$/;
const COMPOSE_READ_RE = /^tool\.search$/;

function digest(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function canonicalArgs(call) {
  if (call && typeof call.argsRaw === 'string') return call.argsRaw;
  try { return JSON.stringify((call && call.args) || {}, Object.keys((call && call.args) || {}).sort()); }
  catch (_) { return '{}'; }
}

/* Receipts contain a fresh run id / sequence even when they point at byte-identical evidence. Browser refs are
   likewise ephemeral labels, not page progress. Normalize only host-generated volatility; page text remains in
   the digest and can therefore prove a genuinely new observation. */
function normalizeEvidence(value) {
  return String(value == null ? '' : value)
    .replace(/\.output\/[A-Za-z0-9._-]+-[0-9a-f-]{16,}-\d+\.txt/gi, '.output/<parked-result>.txt')
    .replace(/\bcall_[A-Za-z0-9_-]+\b/g, 'call_<id>')
    .replace(/\bref\s+b\d+\b/gi, 'ref b<id>')
    .replace(/\bb\d+\s+\[/g, 'b<id> [')
    .replace(/after\s+~?\d+(?:\.\d+)?ms/gi, 'after <duration>')
    .replace(/\s+/g, ' ')
    .trim();
}

function routeOf(name) {
  name = String(name || '');
  if (name.startsWith('browser.')) return 'browser';
  if (/^fs\.(?:read|list|search)$/.test(name) || COMPOSE_READ_RE.test(name)) return 'workspace-read';
  if (/^(?:web\.|web_)/.test(name)) return 'web-read';
  return name || 'unknown';
}

/* A stale read of one local file is not evidence that every file in the workspace is stale. In particular,
   revisiting several page previews must not prevent reading a different preview or a just-written report.
   This is only lexical bookkeeping, not path authority: dispatch still resolves/jails each target. It does
   not equate relative/absolute paths, symlinks or filesystem aliases. Never surface a target in decisions. */
function normalizedReadPath(value, platform) {
  if (typeof value !== 'string' || !value) return '';
  const windows = (platform || process.platform) === 'win32';
  const normalized = (windows ? path.win32 : path.posix).normalize(value);
  return windows ? normalized.toLowerCase() : normalized;
}

function progressRoute(call) {
  const route = routeOf(call && call.name);
  if (!call || call.name !== 'fs.read') return route;
  let args = call.args;
  if (!args || typeof args !== 'object') {
    try { args = JSON.parse(call.argsRaw || '{}'); } catch (_) { args = {}; }
  }
  const target = normalizedReadPath(args && args.path);
  return target ? route + ':file:' + digest(target) : route;
}

function trackable(call, tool) {
  const name = String((call && call.name) || '');
  // code.run is a read-scoped composition container. Its nested calls re-enter central dispatch and are the
  // evidence that matters; counting the outer aggregate as well would double-charge legitimate programs.
  if (name === 'code.run') return false;
  return !!(name.startsWith('browser.') || COMPOSE_READ_RE.test(name) || (tool && tool.scope === 'read'));
}

function observation(call, tool) {
  const name = String((call && call.name) || '');
  if (BROWSER_OBSERVE_RE.test(name)) return true;
  if (BROWSER_ACTION_RE.test(name)) return false;
  return !!(COMPOSE_READ_RE.test(name) || (tool && tool.scope === 'read'));
}

function action(call) {
  return BROWSER_ACTION_RE.test(String((call && call.name) || ''));
}

function evidenceKey(call, result) {
  const r = result || {};
  const hostKey = r.progress && typeof r.progress.key === 'string' ? r.progress.key : '';
  const body = normalizeEvidence(r.content);
  const summary = normalizeEvidence(r.summary || (r.isError ? 'error' : 'ok'));
  // Image descriptions contain only dimensions/rounded byte counts. Different pixels with the same label
  // are new evidence too. Hash inline bytes privately; URLs and caller-controlled image metadata are not
  // evidence of changed pixels. This does not certify that a provider actually displayed an image.
  const pixels = (call && call.name === 'fs.read' && Array.isArray(r.images) ? r.images : [])
    .filter(img => img && typeof img.data === 'string' && img.data)
    .map(img => digest(img.data)).join('\0');
  // fs.read describes the caller's path spelling. A ./ alias or Windows case change must not manufacture
  // progress for identical image bytes; the normalized resource and pixels already identify that evidence.
  const evidenceBody = call && call.name === 'fs.read' && pixels ? '' : body;
  return digest(progressRoute(call) + '\0' + hostKey + '\0' + summary + '\0' + evidenceBody + '\0' + pixels);
}

function makeToolProgressGuard(options) {
  const o = options || {};
  const warnAfter = Math.max(1, Number(o.warnAfter) || 3);
  const exactBlockAfter = Math.max(warnAfter + 1, Number(o.exactBlockAfter) || 4);
  const routeBlockAfter = Math.max(warnAfter + 1, Number(o.routeBlockAfter) || 6);
  const maxEvidence = Math.max(32, Number(o.maxEvidence) || 512);
  const evidence = new Set();
  const exact = new Map();
  const routes = new Map();

  function routeState(call) {
    const key = progressRoute(call);
    let state = routes.get(key);
    if (!state) {
      state = { route: routeOf(call && call.name), stale: 0, warned: false, probe: false };
      routes.set(key, state);
    }
    return state;
  }

  function publicDecision(actionName, code, call, count, message) {
    return {
      action: actionName, code, count,
      toolName: String((call && call.name) || 'tool'),
      route: routeOf(call && call.name), message
    };
  }

  function before(call, tool) {
    if (!trackable(call, tool)) return publicDecision('allow', 'untracked', call, 0, '');
    const sig = digest(String(call.name || '') + '\0' + canonicalArgs(call));
    const same = exact.get(sig);
    // Never infer that a state-changing action is safe to suppress from a generic result such as "clicked".
    // Repeating one control can be the task (quantity +, paging, game input). Its following observations still
    // feed the route breaker, while the action itself remains available.
    if (observation(call, tool) && same && same.count >= exactBlockAfter) {
      return publicDecision('block', 'repeated_success_no_progress', call, same.count,
        'This exact tool call has already returned the same result ' + same.count + ' times. It is blocked because repeating it cannot add evidence. Change the arguments or use a different strategy.');
    }

    const state = routeState(call);
    if (observation(call, tool) && state.stale >= routeBlockAfter) {
      if (state.probe) {
        state.probe = false;
      } else {
        return publicDecision('block', 'strategy_route_exhausted', call, state.stale,
          'This route has produced no new evidence for ' + state.stale + ' attempts. Another inspection-only call on the unchanged route is blocked. Use a state-changing or alternate route, such as downloading the file and reading it locally, using an authorized connector/API, or reporting the proven blocker.');
      }
    }
    return publicDecision('allow', 'allow', call, state.stale, '');
  }

  function after(call, result, tool) {
    if (!trackable(call, tool)) return publicDecision('allow', 'untracked', call, 0, '');
    const state = routeState(call);
    const key = evidenceKey(call, result);
    const novel = !evidence.has(key);
    if (novel) {
      evidence.add(key);
      if (evidence.size > maxEvidence) evidence.delete(evidence.values().next().value);
      state.stale = 0;
      state.warned = false;
      state.probe = false;
      // A genuinely new observation invalidates every old exact-repeat streak: the world has moved on.
      exact.clear();
    } else {
      state.stale++;
    }

    const sig = digest(String(call.name || '') + '\0' + canonicalArgs(call));
    const prior = exact.get(sig);
    const count = prior && prior.key === key ? prior.count + 1 : 1;
    exact.set(sig, { key, count });

    // A browser action is allowed to buy one fresh observation even when the route was already stale. If the
    // observation is unchanged, the streak continues; repeating the exact action is still bounded above.
    if (action(call) && !(result && result.isError)) state.probe = true;

    if (count >= warnAfter) {
      return publicDecision('warn', 'repeated_success_no_progress_warning', call, count,
        'This tool call returned evidence already seen in this run. Use the existing result or change strategy instead of repeating it.');
    }
    if (state.stale >= warnAfter && !state.warned) {
      state.warned = true;
      return publicDecision('warn', 'strategy_route_stale_warning', call, state.stale,
        'This route is no longer producing new evidence. Re-plan now: choose a state-changing or alternate route instead of continuing to inspect the same state.');
    }
    return publicDecision('allow', novel ? 'new_evidence' : 'no_new_evidence', call, state.stale, '');
  }

  return { before, after, snapshot: () => ({ evidence: evidence.size, routes: Array.from(routes.values()).map(state => ({ route: state.route, stale: state.stale })) }) };
}

module.exports = { makeToolProgressGuard, _internals: { normalizeEvidence, routeOf, trackable, observation, action, evidenceKey, canonicalArgs, normalizedReadPath } };
