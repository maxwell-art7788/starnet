#!/usr/bin/env node
// Offline whole-station backup/inspect/restore CLI. Stop StarNet before backup or restore.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Recovery = require('../sidecar/station-recovery.js');

function usage(code = 1) {
  const msg = [
    'StarNet station recovery (offline — stop StarNet first)',
    '',
    'Backup:',
    '  node scripts/station-recovery.mjs backup --workspace <WORKSPACES> --output <file> [--browser-state <backup.json>] [--app-version <v>] [--mutation <id>] [--empty-categories <comma-separated names>]',
    '  Declare an optional category empty only after verifying it is unused in the running station. Missing files alone are not proof. Existing/skipped category files are refused.',
    '',
    'Inspect:',
    '  node scripts/station-recovery.mjs inspect --bundle <file>',
    '',
    'Restore onto a clean profile:',
    '  node scripts/station-recovery.mjs restore --bundle <file> --target <new-WORKSPACES> [--browser-output <file>]',
    '',
    'Rollback an existing profile (the current directory is retained as .rollback-*):',
    '  node scripts/station-recovery.mjs restore --bundle <older-file> --target <WORKSPACES> --replace-existing [--browser-output <file>]'
  ].join('\n');
  (code ? console.error : console.log)(msg);
  process.exit(code);
}

function argsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    const k = a.slice(2, eq >= 0 ? eq : undefined);
    if (eq >= 0) out[k] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}
function required(v, name) { if (!v || v === true) throw new Error('--' + name + ' is required'); return path.resolve(String(v)); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function browserStoreFrom(file) {
  if (!file) return {};
  const doc = readJson(path.resolve(String(file)));
  if (doc && doc.store && typeof doc.store === 'object') return doc.store;
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc;
  throw new Error('browser state must be an object or a StarNet browser backup with {store}');
}
function printReport(doc) { console.log(JSON.stringify(doc, null, 2)); }

const a = argsOf(process.argv.slice(2));
const cmd = a._[0];
if (!cmd || a.help) usage(a.help ? 0 : 1);

try {
  if (cmd === 'backup') {
    const workspace = required(a.workspace, 'workspace');
    const output = required(a.output, 'output');
    const bundle = Recovery.capture({
      workspaceRoot: workspace,
      browserStore: browserStoreFrom(a['browser-state']),
      emptyCategories: a['empty-categories'] == null ? [] : String(a['empty-categories']).split(',').map(s => s.trim()).filter(Boolean),
      now: Date.now(),
      appVersion: a['app-version'] || 'unknown',
      lastCompletedMutation: a.mutation == null ? null : String(a.mutation)
    });
    if (!bundle.report.complete) {
      printReport({ ok: false, action: 'backup', output, report: bundle.report });
      process.exit(2);
    }
    const receipt = Recovery.writeBundleAtomic({ bundle, file: output });
    printReport({ ok: true, action: 'backup', receipt, recoveryPoint: bundle.recoveryPoint, requirements: bundle.report.requirements, skipped: bundle.report.skipped, reauthentication: bundle.report.reauthentication });
  } else if (cmd === 'inspect') {
    const file = required(a.bundle, 'bundle');
    const bundle = Recovery.readBundle(file);
    printReport({ ok: true, action: 'inspect', file, schema: bundle.schema, version: bundle.version, createdAt: bundle.createdAt, appVersion: bundle.appVersion, manifestSha256: bundle.manifestSha256, recoveryPoint: bundle.recoveryPoint, requirements: bundle.report.requirements, files: bundle.files.length, browserKeys: bundle.browser.length, skipped: bundle.report.skipped, reauthentication: bundle.report.reauthentication, semanticFingerprint: Recovery.semanticFingerprint(bundle) });
  } else if (cmd === 'restore') {
    const file = required(a.bundle, 'bundle');
    const target = required(a.target, 'target');
    const bundle = Recovery.readBundle(file);
    const browserOutput = path.resolve(String(a['browser-output'] || path.join(path.dirname(target), 'starnet-browser-restore.json')));
    const browserWithinTarget = path.relative(target, browserOutput);
    if (browserWithinTarget === '' || (!path.isAbsolute(browserWithinTarget) && browserWithinTarget !== '..' && !browserWithinTarget.startsWith('..' + path.sep))) {
      throw new Error('browser output must be outside the workspace target: ' + browserOutput);
    }
    const browserStore = Object.fromEntries(bundle.browser.map(row => [row.key, row.value]));
    const browserPayload = JSON.stringify({ schema: 'starnet.backup', version: 1, app: 'starnet', exportedAt: bundle.createdAt, agentName: 'restored-station', secretsIncluded: false, secretPolicy: 'credentials-excluded', store: browserStore, notebook: null }, null, 2) + '\n';
    const browserStage = browserOutput + '.restore-stage-' + process.pid + '-' + Date.now();
    const browserRollback = browserOutput + '.restore-rollback-' + process.pid + '-' + Date.now();
    let browserActivated = false;
    let browserMoved = false;
    fs.mkdirSync(path.dirname(browserOutput), { recursive: true });
    if (fs.existsSync(browserOutput) && !fs.statSync(browserOutput).isFile()) throw new Error('browser output is not a file: ' + browserOutput);
    try {
      fs.writeFileSync(browserStage, browserPayload, { flag: 'wx' });
      if (fs.readFileSync(browserStage, 'utf8') !== browserPayload) throw new Error('browser output staging read-back mismatch');
    } catch (e) {
      if (fs.existsSync(browserStage)) fs.unlinkSync(browserStage);
      throw e;
    }
    try {
      const receipt = Recovery.restore({
        bundle,
        targetRoot: target,
        replaceExisting: !!a['replace-existing'],
        beforeActivate() {
          if (fs.existsSync(browserOutput)) { fs.renameSync(browserOutput, browserRollback); browserMoved = true; }
          fs.renameSync(browserStage, browserOutput);
          browserActivated = true;
        }
      });
      if (browserMoved && fs.existsSync(browserRollback)) fs.unlinkSync(browserRollback);
      printReport({ ok: true, action: 'restore', receipt, browserImport: { file: browserOutput, instruction: 'Open StarNet and choose RESTORE BACKUP to import this browser-owned state.' } });
    } catch (e) {
      if (browserActivated && fs.existsSync(browserOutput)) fs.unlinkSync(browserOutput);
      if (browserMoved && fs.existsSync(browserRollback)) fs.renameSync(browserRollback, browserOutput);
      if (fs.existsSync(browserStage)) fs.unlinkSync(browserStage);
      throw e;
    }
  } else usage(1);
} catch (e) {
  console.error(JSON.stringify({ ok: false, action: cmd, error: (e && e.message) || String(e) }, null, 2));
  process.exit(1);
}
