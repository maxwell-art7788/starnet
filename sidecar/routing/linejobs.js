/* sidecar/routing/linejobs.js — LINE JOBS (2026-09-30, Andrew: "the easiest conveyor system we can possibly put together … clear as
   day"). Every job sent down a work line — from the WORKFLOWS window, or the Workflow panel's RUN ONE REAL JOB (one route, POST
   /api/routing/sample) — is kept as ONE record: what was asked, the line it rode, each step's run, what came out, what it cost and
   how it ended, plus what the Commander changed because of it (a suggested fix used or put back, a result kept as the example) and
   which earlier job it re-ran. The WORKFLOWS window and the OUTBOX open the same record, after a reload or a restart.

   TRUTH: a record says only what the route recorded. Its status is the route's own verdict (delivered = the route's `completed`:
   every stage ran clean and the line ships to the OUTBOX), its runs are runs.jsonl rows, its output is what the line delivered,
   and a job the station restarted under is said as interrupted — never left "running".

   Pure: state in, state out ({ jobs: [...] }, newest last). The sidecar persists it (makeDomainStore → line-jobs.json). */
'use strict';

const MAX_JOBS = 120;        // newest kept; an older record drops off (its runs and transcripts stay in the logbook)
const MAX_TEXT = 2000;       // the job as sent (the route reads at most 2000 characters)
const MAX_OUTPUT = 12000;    // what the line delivered
const MAX_RUNS = 40;
const MAX_NOTES = 12;
const MAX_NOTE = 2000;
const STATUSES = { running: 1, delivered: 1, 'no-work': 1, problem: 1, stopped: 1, failed: 1, interrupted: 1 };
const NOTE_KINDS = { fix: 1, example: 1, putback: 1 };
const ID_RE = /^job-[a-z0-9]{8,24}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,120}$/;   // a line key (its oldest machine's prop id) / a dock id / a run id / an agent id

const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const num = v => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);
const key = v => { const s = str(v, 120).trim(); return KEY_RE.test(s) ? s : ''; };

function normRun(r) {
  if (!r || typeof r !== 'object' || !key(r.runId)) return null;
  return { runId: key(r.runId), agentId: key(r.agentId), dockId: key(r.dockId) || null, reason: str(r.reason, 40) || 'done', usd: num(r.usd) };
}
function normNote(n) {
  if (!n || typeof n !== 'object' || !NOTE_KINDS[n.kind]) return null;
  return { kind: n.kind, at: num(n.at), dockId: key(n.dockId) || null, role: str(n.role, 40), field: n.field === 'hands' ? 'hands' : 'does',
    text: str(n.text, MAX_NOTE), was: str(n.was, MAX_NOTE), why: str(n.why, 400) };
}
function normJob(j) {
  if (!j || typeof j !== 'object' || !ID_RE.test(String(j.id || '')) || !key(j.line)) return null;
  return {
    id: String(j.id), line: key(j.line), name: str(j.name, 60), text: str(j.text, MAX_TEXT), streamId: key(j.streamId),
    status: STATUSES[j.status] ? j.status : 'interrupted', startedAt: num(j.startedAt), endedAt: num(j.endedAt) || null,
    usd: num(j.usd), output: str(j.output, MAX_OUTPUT), error: str(j.error, 400),
    runs: (Array.isArray(j.runs) ? j.runs : []).map(normRun).filter(Boolean).slice(0, MAX_RUNS),
    notes: (Array.isArray(j.notes) ? j.notes : []).map(normNote).filter(Boolean).slice(-MAX_NOTES),
    retryOf: ID_RE.test(String(j.retryOf || '')) ? String(j.retryOf) : null,
  };
}
function normalizeAll(value) {
  const seen = {}, jobs = [];
  for (const j of ((value && Array.isArray(value.jobs)) ? value.jobs : [])) { const n = normJob(j); if (n && !seen[n.id]) { seen[n.id] = 1; jobs.push(n); } }
  jobs.sort((a, b) => a.startedAt - b.startedAt);
  return { jobs: jobs.slice(-MAX_JOBS) };
}
const idx = (state, id) => (state && Array.isArray(state.jobs) ? state.jobs.findIndex(j => j.id === id) : -1);

// a job goes out: the record exists from the moment the line is dispatched, as running
function start(state, o) {
  const job = normJob({ id: o.id, line: o.line, name: o.name, text: o.text, streamId: o.streamId, status: 'running', startedAt: o.at, retryOf: o.retryOf });
  if (!job) return { state, job: null };
  const jobs = (state && Array.isArray(state.jobs) ? state.jobs : []).filter(j => j.id !== job.id).concat([job]);
  return { state: { jobs: jobs.slice(-MAX_JOBS) }, job };
}
// the route's own verdict: delivered | problem (steps ran, not all clean) | stopped | failed (nothing durable ran)
function finish(state, id, o) {
  const i = idx(state, id);
  if (i < 0) return { state, job: null };
  const job = normJob(Object.assign({}, state.jobs[i], { status: o.status, endedAt: o.at, usd: o.usd, output: o.output, error: o.error, runs: o.runs }));
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: { jobs }, job };
}
// what the Commander changed because of this job (a fix used or put back, the result kept as the example)
function note(state, id, n) {
  const i = idx(state, id), nn = normNote(n);
  if (i < 0 || !nn) return { state, job: null };
  const cur = state.jobs[i];
  const job = Object.assign({}, cur, { notes: cur.notes.concat([nn]).slice(-MAX_NOTES) });
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: { jobs }, job };
}
// the station (re)started: nothing is riding a line any more — a job left "running" is said as interrupted
function boot(state, at) {
  let changed = false;
  const jobs = (state && Array.isArray(state.jobs) ? state.jobs : []).map(j => {
    if (j.status !== 'running') return j;
    changed = true;
    return Object.assign({}, j, { status: 'interrupted', endedAt: num(at) || j.startedAt, error: 'the station stopped while this job was out — send it again' });
  });
  return { state: { jobs }, changed };
}
// the window's list: newest first, the heavy output cut to a glance (the full record is one GET away)
function summary(j) {
  return { id: j.id, line: j.line, name: j.name, text: j.text.slice(0, 240), status: j.status, startedAt: j.startedAt, endedAt: j.endedAt,
    usd: j.usd, steps: j.runs.length, preview: j.output.replace(/\s+/g, ' ').trim().slice(0, 240), error: j.error, retryOf: j.retryOf,
    streamId: j.streamId, notes: j.notes.length };
}
function list(state, o) {
  o = o || {};
  const line = o.line ? key(o.line) : '', stream = o.stream ? key(o.stream) : '';
  const limit = Math.max(1, Math.min(100, Number(o.limit) || 30));
  const out = [];
  const jobs = (state && Array.isArray(state.jobs)) ? state.jobs : [];
  for (let i = jobs.length - 1; i >= 0 && out.length < limit; i--) {
    const j = jobs[i];
    if (line && j.line !== line) continue;
    if (stream && j.streamId !== stream) continue;
    out.push(summary(j));
  }
  return out;
}
function get(state, id) { const i = idx(state, id); return i < 0 ? null : state.jobs[i]; }
const isId = id => ID_RE.test(String(id || ''));

// Send Job's verdict is the entire line's outcome, never just clean stage telemetry.
// Failure wins over an empty/no-work reply; only explicit host-recorded no-work is neutral.
function sampleOutcome(o) {
  o = o || {};
  const runs = Array.isArray(o.runs) ? o.runs : [], line = o.lineOutcome;
  let error = o.stopped ? 'you stopped this job'
    : o.onLine === false ? 'the job did not enter through this line'
    : !runs.length ? 'no step ran'
    : runs.some(r => r.reason !== 'done') ? 'a step did not finish cleanly'
    : !line ? 'the line returned no terminal outcome'
    : line.stopped ? String(line.stopped)
    : line.workflowStatus === 'blocked' ? 'a workflow stage reported that it was blocked'
    : line.loopExhausted ? 'review loop exhausted without approval' : '';
  const noWork = !error && line.workflowStatus === 'no-work';
  if (!error && !noWork && !o.shipsToOutbox) error = 'the line did not reach its OUTBOX';
  return { completed: !error && !noWork, noWork,
    status: o.stopped ? 'stopped' : error ? (runs.length ? 'problem' : 'failed') : noWork ? 'no-work' : 'delivered',
    error: error || (noWork ? 'No work produced. No result was delivered to the OUTBOX.' : '') };
}

module.exports = { start, finish, note, boot, list, get, isId, normalizeAll, normJob, summary, sampleOutcome, MAX_JOBS, MAX_OUTPUT, MAX_TEXT, MAX_NOTES };
