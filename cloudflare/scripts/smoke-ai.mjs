// Synthetic-only, one-time validation. Default invocation is a network-free plan.
// Paid validation runs only through the protected installation and its shared ledger.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createStorage } from '../storage.js';
import { createCoach } from '../coach.js';
import { MODEL, costMicros } from '../pricing.js';
import { sampleState } from '../../api/test/helpers.mjs';

const mode = process.argv[2] || '--plan';
if (!['--plan', '--fixture'].includes(mode) || process.argv.length > 3) throw new Error('Use --plan or --fixture; live validation uses the protected deployment and its shared budget');
const CALLS = 8, MAX_INPUT = 80000, MAX_OUTPUT = 8192;
const ceiling = CALLS * costMicros(MODEL, MAX_INPUT, MAX_OUTPUT) / 1e6;
console.log(JSON.stringify({ model: MODEL, totalAttempts: CALLS, maxInputTokens: MAX_INPUT, maxOutputTokens: MAX_OUTPUT,
  modelCostCeilingUSD: ceiling, pricingChecked: '2026-10-12', recurringAllowance: false,
  note: 'Recheck current model prices before executing. No production profile data is read. Workers/storage charges are separate.' }));
if (mode === '--plan') process.exit(0);
const root = fileURLToPath(new URL('../.wrangler/', import.meta.url));
fs.mkdirSync(root, { recursive: true });
const name = 'synthetic-ai-fixture-dollar-budget';
const lock = path.join(root, name + '.lock');
// Concurrent processes must never race the read/reserve/write. A crash leaves the
// lock in place; inspect it and the durable budget before deliberately resuming.
const lockFd = fs.openSync(lock, 'wx', 0o600);
let db;
try {
  db = new DatabaseSync(path.join(root, name + '.sqlite'));
  db.exec('PRAGMA synchronous=FULL');
  const storage = {
    sql: { exec(q, ...args) { const rows = db.prepare(q).all(...args); return { toArray: () => rows }; } },
    transactionSync(fn) { db.exec('SAVEPOINT tx'); try { const r = fn(); db.exec('RELEASE tx'); return r; }
      catch(e) { db.exec('ROLLBACK TO tx; RELEASE tx'); throw e; } }
  };
  const files = createStorage(storage);
  if (!files.existsSync('/data/secret')) files.writeFileSync('/data/secret', 'synthetic-smoke-secret-not-a-production-credential');
  const ai = { async run(model, input) {
    if (model !== MODEL || input.max_tokens > MAX_OUTPUT) throw new Error('Unexpected model or output budget');
    if (mode === '--fixture') return { response: execFileSync(process.execPath,
      [fileURLToPath(new URL('../../api/coach/fixture-cli.mjs', import.meta.url))],
      { input: input.messages.map(m => m.content).join('\n\n'), encoding: 'utf8' }) };
    throw new Error('Live tests must use the deployment’s shared budget');
  } };
  const coach = createCoach({ fs: files, env: { DATA_DIR: '/data', AI: ai, COACH_AI_BUDGET_USD: '5' }, defer() {} });
  coach.cfgStore.save({ enabled: true, provider: 'workers-ai', maxOutputTokens: MAX_OUTPUT, models: { 'workers-ai': MODEL } });
  coach.jobs.recoverOnBoot();
  const uid = 'synthetic-validation';
  if (!files.existsSync('/data/state-' + uid + '.json')) files.writeFileSync('/data/state-' + uid + '.json', JSON.stringify(sampleState()));
  const scenarios = [{ id: 'create', kind: 'create' }, { id: 'refine', kind: 'create', refine: 'Keep the same equipment and use a shorter session.' },
    { id: 'review', kind: 'review' }, { id: 'debrief', kind: 'debrief', workoutId: 'w1' }];
  for (const scenario of scenarios) {
    const marker = '/data/smoke-' + scenario.id;
    if (files.existsSync(marker)) continue;
    const { id, ...job } = scenario;
    coach.jobs.enqueue(uid, job);
    await coach.jobs.runQueued();
    const last = coach.jobs.status(uid).last;
    const summary = { scenario: id, outcome: last?.outcome, errorClass: last?.errorClass ?? null };
    files.writeFileSync(marker, JSON.stringify(summary));
    console.log(JSON.stringify(summary));
    if (id !== 'create') coach.jobs.resolvePending(uid, { accepted: [] });
  }
  console.log(JSON.stringify({ budget: JSON.parse(files.readFileSync('/data/coach-ai-ledger.json', 'utf8')) }));
} finally {
  db?.close(); fs.closeSync(lockFd); fs.unlinkSync(lock);
}
