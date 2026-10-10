/* node test/loop.verify-on-stop-artifacts.test.js
   Replay the document-only production handoff that used to buy an unwanted shell-verification turn.
   No filesystem, shell, provider, or network side effects: the real loop uses an injected tool registry. */
'use strict';
const A = require('./_assert.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { runAgentLoop, _internals } = require('../sidecar/loop.js');

const tools = ['fs_write', 'fs_read', 'shell_exec', 'verify_run'].map(name => ({
  type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } }
}));
const stop = [{ type: 'text', delta: 'The requested files are saved and read back.' }, { type: 'done', finishReason: 'stop' }];
const calls = (...rows) => rows.flatMap(([id, name, args], index) => [
  { type: 'tool_start', index, id, name }, { type: 'tool_args', index, chunk: JSON.stringify(args) }
]).concat({ type: 'done', finishReason: 'tool_calls' });
const write = path => calls(['w1', 'fs_write', { path, content: '{}' }]);

async function run(turns, user = 'Complete the requested work.', resultOf = () => 'saved') {
  let providerCalls = 0;
  const registry = makeRegistry();
  const dispatched = [];
  for (const tool of tools) registry.register({
    name: tool.function.name, schema: { type: 'object', properties: {} },
    run: async args => { dispatched.push([tool.function.name, args]); return resultOf(tool.function.name, args); }
  });
  const messages = [{ role: 'user', content: user }];
  const res = await runAgentLoop({
    messages, tools,
    provider: { contextLimit: () => 0, stream: async function* () {
      const next = turns[providerCalls++] || stop;
      for (const event of next) yield event;
    } },
    emit: makeEmitter(A.makeBus(), () => {}),
    model: 'replay/model', agentId: 'a', runId: 'r',
    limits: { maxIters: 10, grace: false, continueGuard: false },
    dispatch: (call, ctx) => registry.dispatch(call, ctx),
    capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }
  });
  const nudges = messages.filter(m => m.role === 'system' && String(m.content).startsWith('<verify_before_done>'));
  return { res, providerCalls, nudges, dispatched };
}

(async () => {
  const base = 'C:/Users/Owner/Studio/production-v2/craft-market/pro-2026-10-10/';
  const spec = base + 'REGRESSION-CASES.json', handoff = base + 'native-agent-handoff.md';
  const handoffTurns = [
    calls(['w1', 'fs_write', { path: spec, content: '{"regressionsExecutedThisRun":false,"cases":[]}' }],
      ['w2', 'fs_write', { path: handoff, content: '# Repair handoff\nNo tests executed.' }]),
    calls(['r1', 'fs_read', { path: spec }], ['r2', 'fs_read', { path: handoff }]), stop
  ];
  for (const user of ['Write the regression specification and handoff, read both back, then stop.',
    'Filesystem only: no shell/code. Write exactly two handoff files, read them back, then stop.']) {
    const r = await run(handoffTurns, user);
    A.eq(r.nudges.length, 0, 'document JSON and Markdown do not acquire a code-test requirement');
    A.eq(r.providerCalls, 3, 'the handoff terminates immediately after write, read-back, and final');
    A.eq(r.res.reason, 'done', 'document-only task finishes normally');
    A.eq(r.dispatched.map(c => c[0]), ['fs_write', 'fs_write', 'fs_read', 'fs_read'], 'only the requested file tools run');
  }

  for (const path of ['report.pdf', 'Profit-Tracker.xlsx', 'guide.docx', 'slides.pptx', 'hero.png', 'preview.jpg',
    'demo.webp', 'delivery.zip', 'reports/2026.json', 'technical-audit.json', 'regression-cases.json']) {
    const r = await run([write(path), stop]);
    A.eq(r.nudges.length, 0, path + ' does not trigger a shell test');
    A.eq(r.providerCalls, 2, path + ' does not spend a redundant provider call');
  }

  for (const path of ['src/app.js', 'repair.py', 'style.css', 'Makefile', 'package.json', 'package-lock.json',
    'tsconfig.json', 'docs/tsconfig.build.json', 'reports/package.json', 'vercel.json', 'manifest.json',
    'test/regression-cases.json', 'config/audit.json', 'src/data.json', 'schema.config.json',
    'C:\\project\\src\\review.json', 'unknown.json', 'C:/Users/Owner/Documents/Studio/unknown.json']) {
    const r = await run([write(path), stop]);
    A.eq(r.nudges.length, 1, path + ' retains one bounded code/config verification nudge');
    A.eq(r.providerCalls, 3, path + ' receives exactly one extra evidence turn');
    A.ok(/does not authorize additional tools/.test(r.nudges[0].content), 'automatic reminder does not create authority');
  }

  for (const user of ['No shell. Edit this file and report what remains unverified.',
    'Do not run commands. Save the proposed code only.',
    'Filesystem-only; update the file, read it back, then stop.',
    'Do not execute code; provide a reviewable patch.']) {
    const r = await run([write('src/app.js'), stop], user);
    A.eq(r.nudges.length, 0, 'explicit execution restriction is not superseded by a host reminder');
    A.eq(r.providerCalls, 2, 'restricted work does not incur another paid turn');
  }

  // A read-back of a document cannot discharge a separate executable change.
  {
    const r = await run([write('src/app.js'), calls(['r1', 'fs_read', { path: handoff }]), stop]);
    A.eq(r.nudges.length, 1, 'document read-back is not code verification');
  }
  // A data fixture contains quoted restrictions; tool arguments/results must not set user scope.
  {
    const r = await run([calls(['w1', 'fs_write', { path: 'src/app.js', content: '// no shell' }]), stop],
      'Fix and test the application.', () => 'no shell');
    A.eq(r.nudges.length, 1, 'tool data cannot suppress the execution reminder');
  }
  // Do not weaken failing-check evidence while fixing the false artifact classification.
  for (const exit of [0, 1]) {
    const r = await run([write('src/app.js'), calls(['x1', 'shell_exec', { command: 'npm test' }]), stop],
      'Fix and test the application.', name => name === 'shell_exec' ? 'test output\n[exit ' + exit + ']' : 'saved');
    A.eq(r.nudges.length, exit, 'only a passing check disarms verification');
  }
  A.eq(_internals.vosIsCodePath(''), false, 'missing path remains unclassified');
  A.report('loop.verify-on-stop-artifacts.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
