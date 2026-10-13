import { createCoach } from './coach.js';

// Opt-in deployment diagnostics. Synthetic profiles live in a separate document
// prefix and spend through the SAME budget as the actual installation. No user
// accounts, passkeys, workouts or profile state are read or changed.
export function createValidation({ fs, env, budget, defer, decision = null }) {
  const scoped = { ...fs };
  const key = name => name.replace(/^\/data(?=\/|$)/, '/validation');
  for (const method of ['mkdirSync', 'readFileSync', 'writeFileSync', 'existsSync', 'unlinkSync', 'readdirSync']) scoped[method] = (name, ...args) => fs[method](key(name), ...args);
  scoped.renameSync = (from, to) => fs.renameSync(key(from), key(to));
  if (!scoped.existsSync('/data/secret')) scoped.writeFileSync('/data/secret', 'synthetic-validation-secret');
  const shared = Object.assign(request => {
    const r = read();
    if (!r || budget.status().attempts - r.startAttempts >= 8) throw new Error('Synthetic attempt limit reached');
    return budget(request);
  }, { status: budget.status, flush: budget.flush, settle: budget.settle });
  const coach = createCoach({ fs: scoped, env: { ...env, DATA_DIR: '/data', COACH_AI_ONLY: '1' }, budget: shared, defer });
  coach.cfgStore.save({ enabled: true, provider: 'workers-ai', maxOutputTokens: 8192 });
  coach.jobs.recoverOnBoot();
  const file = '/validation/run.json', uid = 'synthetic';
  const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const save = r => fs.writeFileSync(file, JSON.stringify(r));
  const cases = [ { kind: 'create' }, { kind: 'create', refine: 'Use the same equipment and keep the session under 45 minutes.' }, { kind: 'review' }, { kind: 'debrief', workoutId: 'w1' } ];
  const decisionFile = '/validation/decisions.json';
  const decisions = () => fs.existsSync(decisionFile) ? JSON.parse(fs.readFileSync(decisionFile, 'utf8')) : null;
  const status = () => ({ run: read(), decisions: decisions(), budget: budget.status() });
  const queue = r => { try { coach.jobs.enqueue(uid, cases[r.next]); r.queued = true; save(r); }
    catch { r.done = true; r.error = 'Synthetic job could not be queued'; save(r); } };
  return {
    status,
    pending: () => { const r = read(); return !!r && (!r.done || (decision && !decisions())); },
    start() {
      if (read()) return status(); // Idempotent: refresh/retry never starts a second paid run.
      const today = new Date(); const date = back => new Date(today.getTime() - back * 86400000).toISOString().slice(0, 10);
      const state = { unit: 'kg', lang: 'en', effort: 'rpe', customEx: [], dayPlan: {}, bodyweight: [], exWeights: {},
        coach: { consent: { agreedAt: Date.now(), version: 1 }, profile: { goal: 'muscle', daysPerWeek: 3, sessionMin: 45, equipment: ['dumbbell'] } },
        routines: [{ id: 'r1', name: 'Synthetic routine', ex: [{ id: '0001', sets: 3, reps: 10, weight: 20, prog: 'linear' }] }],
        week: { 1: 'r1', 3: 'r1', 5: 'r1' },
        workouts: [14, 7, 0].map((back, i) => ({ id: 'w' + (i + 1), d: date(back), name: 'Synthetic session', start: today.getTime() - back * 86400000 - 1800000, end: today.getTime() - back * 86400000,
          entries: [{ id: '0001', target: { sets: 3, reps: 10, weight: 20 }, sets: Array.from({ length: 3 }, () => ({ w: 20, r: 10, done: true, rpe: 8 })) }] })) };
      scoped.writeFileSync('/data/state-' + uid + '.json', JSON.stringify(state));
      const r = { startAttempts: budget.status().attempts, next: 0, results: [], done: false, queued: false }; save(r); queue(r); return status();
    },
    async tick() {
      const r = read(); if (!r) return;
      if (r.done) {
        if (decision && !decisions()) {
          // Claim once before any paid request. An interrupted observation is not replayed.
          fs.writeFileSync(decisionFile, JSON.stringify({ status: 'started', results: [] }));
          const results = [];
          for (const state of [{ sessions: 1, spanDays: 0, stalls: 0 }, { sessions: 6, spanDays: 14, stalls: 0 }, { sessions: 6, spanDays: 14, stalls: 3 }]) {
            if (budget.status().attempts - r.startAttempts >= 8) break;
            results.push({ state, observation: await decision(state) });
          }
          fs.writeFileSync(decisionFile, JSON.stringify({ status: 'done', results }));
        }
        return;
      }
      await coach.jobs.runQueued();
      const last = coach.jobs.status(uid).last;
      if (r.queued) {
        r.results.push({ scenario: ['create', 'refine', 'review', 'debrief'][r.next], outcome: last?.outcome, errorClass: last?.errorClass || null,
          detail: coach.cfgStore.lastError()?.detail?.slice(0, 600) || null });
        if (r.next !== 0) coach.jobs.resolvePending(uid, { accepted: [] });
        r.next++; r.queued = false; r.done = r.next >= cases.length; save(r);
      }
      if (!r.done) queue(r);
    }
  };
}
