/* A second client must never recover a run that this process still owns.
   Real HTTP host, isolated data, held fake model response; no live credentials. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { bootToken } = require('./_httpToken.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-active-recovery-'));
  const isolatedProfile = path.join(ws, 'profile');
  fs.mkdirSync(isolatedProfile);
  let child, heldResponse, providerCalls = 0, runPromise, output = '';
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_length: 32000 }] }));
      }
      providerCalls++;
      heldResponse = res;
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const release = () => {
    if (!heldResponse || heldResponse.writableEnded) return;
    heldResponse.writeHead(200, { 'Content-Type': 'text/event-stream' });
    heldResponse.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Original run completed.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  };
  try {
    child = spawn(process.execPath, [path.resolve(__dirname, '../sidecar/index.js')], {
      env: Object.assign({}, process.env, {
        STARNET_PORT: String(port), STARNET_WORKSPACES: ws,
        APPDATA: isolatedProfile, LOCALAPPDATA: isolatedProfile, XDG_DATA_HOME: isolatedProfile
      }), stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { output += b; });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(base + '/api/health')).ok; } catch (_) {}
      if (ready || child.exitCode !== null) break;
      await pause(100);
    }
    assert.ok(ready, 'isolated sidecar boots: ' + output);
    const token = await bootToken(base);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token };
    const post = async (route, body) => {
      const r = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
      const text = await r.text();
      let result; try { result = JSON.parse(text); } catch (_) { result = { error: text }; }
      return { status: r.status, body: result };
    };
    runPromise = fetch(base + '/api/run', {
      method: 'POST', headers,
      body: JSON.stringify({
        agentId: 'agent', streamId: 'active-recovery-test', provider: 'custom', model: 'fixture-model',
        baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1',
        messages: [{ role: 'user', content: 'Say original run completed. Do not use tools.' }], system: ''
      })
    }).then(async r => ({ status: r.status, text: await r.text() })).catch(error => ({ status: 0, text: String(error) }));
    for (let i = 0; i < 150 && !heldResponse; i++) await pause(100);
    assert.ok(heldResponse, 'live run reaches the fake provider: ' + output);
    const files = fs.readdirSync(path.join(ws, '.run-journal')).filter(n => n.endsWith('.jsonl'));
    assert.equal(files.length, 1, 'exactly one active run journal');
    const begin = JSON.parse(fs.readFileSync(path.join(ws, '.run-journal', files[0]), 'utf8').split('\n')[0]);
    const runId = begin.runId;
    const list = await (await fetch(base + '/api/run-recoveries', { headers })).json();
    assert.equal(list.recoveries.some(row => row.runId === runId), false, 'a second client cannot discover a live run as interrupted');
    for (const mode of ['automatic', 'reviewed']) {
      const r = await post('/api/run-recoveries/continue', {
        runId, agentId: 'agent', continuationId: 'active-' + mode, mode,
        recoveryToken: 'stale', confirmedSafeContinuation: true
      });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'run is still active', mode + ' continuation refuses a live source');
    }
    const resolved = await post('/api/run-recoveries/resolve', {
      runId, agentId: 'agent', resolutionId: 'active-resolution', confirmedNoReplay: true,
      recoveryToken: 'stale', outcomes: []
    });
    assert.equal(resolved.status, 409);
    assert.equal(resolved.body.error, 'run is still active');
    const consume = await post('/api/run', {
      agentId: 'agent', streamId: 'active-recovery-test', provider: 'custom', model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1', messages: [],
      recovery: { sourceRunId: runId, continuationId: 'active-automatic', continuationToken: 'stale' }
    });
    assert.equal(consume.status, 409);
    assert.equal(consume.body.error, 'run is still active');
    release();
    const run = await runPromise;
    assert.equal(run.status, 200);
    assert.ok(run.text.includes('Original run completed.'));
    assert.equal(providerCalls, 1, 'no duplicate model run dispatched');
    console.log('run-recovery-active.api.test: OK (live listing, resolve, prepare, consume, original completion)');
  } finally {
    release();
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await Promise.race([exited, pause(3000)]);
    }
    if (runPromise) await runPromise.catch(() => {});
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    const resolved = path.resolve(ws);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('starnet-active-recovery-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
