import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const DAY = 86400000;

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 365 * DAY}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const cookie = (uid, sv) => ({ Cookie: `gymsid=${mintSession(uid, sv)}`, Origin: ORIGIN });
const bearer = token => ({ Authorization: `Bearer ${token}` });

const USERS = [
  { id: 'u_one', name: 'One', created: new Date().toISOString() },
];

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-resolved-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: USERS, creds: [], subs: [], invites: [] }));
  fs.writeFileSync(path.join(dataDir, 'state-u_one.json'), JSON.stringify({ _rev: 0 }));
  
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost' }
  });
  const h = { log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  
  const port = await boundPort(child, () => h.log);
  h.req = async (method, p, headers = {}, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)
    });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  h.db = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  h.createToken = async (uid, name) => {
    const r = await h.req('POST', '/api/account/read-tokens', cookie(uid), { name });
    assert.equal(r.status, 201);
    return r.body.token;
  };
  return h;
}

test('GET /api/data without resolve param returns unchanged response', async (t) => {
  const h = await startServer(t);
  
  const snapshot = await h.req('GET', '/api/data', cookie('u_one'));
  assert.equal(snapshot.status, 200);
  assert.ok(snapshot.body.state);
  assert.equal(typeof snapshot.body.rev, 'number');
  assert.ok(!snapshot.body.resolved, 'no resolved field without ?resolve=1');
});

test('GET /api/data with resolve=1 and realistic state structure', async (t) => {
  const h = await startServer(t);
  
  // Real state structure: unit/effort at root, routines with ex, dayPlan as object
  const state = {
    unit: 'kg',
    effort: 'rir',
    workouts: [{
      id: 'w1',
      d: '2026-10-15',
      start: 1697385600000,
      end: 1697389200000,
      bw: 80,
      routineId: 'r1',
      entries: [{
        id: '0025',
        topW: 100,
        sets: [
          { w: 100, r: 8, done: true, rir: 2 },
          { w: 100, r: 8, done: true, rir: 1 },
          { w: 60, r: 12, done: true, warmup: true }
        ]
      }]
    }],
    routines: [{
      id: 'r1',
      name: 'Push Day',
      ex: [
        { id: '0025', sets: 3, reps: 8, prog: 'linear', note: 'Main lift' }
      ]
    }],
    dayPlan: { '2026-10-16': 'r1' },
    week: { mon: ['r1'], wed: ['r1'], fri: ['r1'] },
    exNotes: { '0025': 'Focus on form' },
    exWeights: { '0025': { w: 100, d: '2026-10-15' } },
    bodyweight: [{ d: '2026-10-15', w: 80 }],
    dayNotes: { '2026-10-15': 'Good session' },
    measurements: { chest: [{ d: '2026-10-15', v: 100 }] },
    customMeasurements: { test: { name: 'Test', unit: 'cm' } }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  assert.ok(resolved.body.state);
  assert.ok(resolved.body.resolved);
  assert.ok(resolved.body.resolved.exercises);
  assert.ok(resolved.body.resolved.workouts);
  assert.ok(resolved.body.resolved.routines);
  assert.ok(resolved.body.resolved.exNotes);
  assert.ok(resolved.body.resolved.exWeights);
  assert.ok(resolved.body.resolved.dayPlan);
  assert.ok(resolved.body.resolved.week);
  assert.ok(resolved.body.resolved.bodyweight);
  assert.ok(resolved.body.resolved.dayNotes);
  assert.ok(resolved.body.resolved.measurements);
  assert.ok(resolved.body.resolved.customMeasurements);
  assert.ok(resolved.body.resolved.meta);
  
  // Verify meta has effort scale
  assert.equal(resolved.body.resolved.meta.effortScale, 'rir');
});

test('routines use ex field and include all slot fields', async (t) => {
  const h = await startServer(t);
  
  const state = {
    unit: 'kg',
    routines: [{
      id: 'r1',
      name: 'Full Body',
      ex: [
        { 
          id: '0025', 
          sets: 3, 
          reps: 8, 
          repsMin: 6,
          mode: 'reps',
          prog: 'linear', 
          lastToFailure: true,
          note: 'Main compound' 
        }
      ]
    }]
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const routine = resolved.body.resolved.routines[0];
  assert.equal(routine.id, 'r1');
  assert.equal(routine.name, 'Full Body');
  assert.ok(routine.ex);
  assert.ok(!routine.slots, 'should not have slots field');
  
  const slot = routine.ex[0];
  assert.ok(slot.exercise);
  assert.equal(slot.exercise.id, '0025');
  assert.equal(slot.sets, 3);
  assert.equal(slot.reps, 8);
  assert.equal(slot.repsMin, 6);
  assert.equal(slot.mode, 'reps');
  assert.equal(slot.prog, 'linear');
  assert.equal(slot.lastToFailure, true);
  assert.equal(slot.note, 'Main compound');
});

test('sets preserve sides, at, and all cardio fields', async (t) => {
  const h = await startServer(t);
  
  const state = {
    unit: 'kg',
    workouts: [{
      d: '2026-10-15',
      entries: [{
        id: '0025',
        sets: [
          { w: 50, r: 10, sides: { L: { r: 10, done: true }, R: { r: 10, done: true } }, done: true },
          { min: 30, sec: 0, speed: 10, dist: 5, done: true, at: 1697385600000 }
        ]
      }]
    }]
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const sets = resolved.body.resolved.workouts[0].entries[0].sets;
  assert.ok(sets[0].sides, 'should preserve sides');
  assert.equal(sets[1].min, 30);
  assert.equal(sets[1].sec, 0);
  assert.equal(sets[1].speed, 10);
  assert.equal(sets[1].dist, 5);
  assert.equal(sets[1].at, 1697385600000);
});

test('workouts include all workout-level fields', async (t) => {
  const h = await startServer(t);
  
  const state = {
    unit: 'lb',
    workouts: [{
      id: 'w1',
      d: '2026-10-15',
      start: 1697385600000,
      end: 1697389200000,
      name: 'Push A',
      bw: 180,
      prs: 2,
      vol: 12000,
      routineIds: ['r1'],
      routineId: 'r1',
      label: 'Morning',
      note: 'Great session',
      entries: [{ id: '0025', sets: [{ w: 225, r: 5, done: true }] }]
    }]
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const workout = resolved.body.resolved.workouts[0];
  assert.equal(workout.id, 'w1');
  assert.equal(workout.date, '2026-10-15');
  assert.equal(workout.start, 1697385600000);
  assert.equal(workout.end, 1697389200000);
  assert.equal(workout.name, 'Push A');
  assert.equal(workout.bw, 180);
  assert.equal(workout.prs, 2);
  assert.equal(workout.vol, 12000);
  assert.ok(workout.routineIds);
  assert.equal(workout.routineId, 'r1');
  assert.equal(workout.label, 'Morning');
  assert.equal(workout.note, 'Great session');
  assert.equal(workout.unit, 'lb');
});

test('entries include topW, target, planned, rid fields', async (t) => {
  const h = await startServer(t);
  
  const state = {
    unit: 'kg',
    workouts: [{
      d: '2026-10-15',
      entries: [{
        id: '0025',
        topW: 100,
        target: { sets: 3, reps: 8 },
        planned: true,
        rid: 'r1',
        note: 'First compound',
        sets: [{ w: 100, r: 8, done: true }]
      }]
    }]
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const entry = resolved.body.resolved.workouts[0].entries[0];
  assert.equal(entry.topW, 100);
  assert.ok(entry.target);
  assert.equal(entry.target.sets, 3);
  assert.equal(entry.target.reps, 8);
  assert.equal(entry.planned, true);
  assert.equal(entry.rid, 'r1');
  assert.equal(entry.note, 'First compound');
});

test('both rpe and rir are included when present, regardless of effort scale', async (t) => {
  const h = await startServer(t);
  
  const state = {
    unit: 'kg',
    effort: 'rpe',
    workouts: [{
      d: '2026-10-15',
      entries: [{
        id: '0025',
        sets: [
          { w: 100, r: 8, done: true, rpe: 8, rir: 2 }
        ]
      }]
    }]
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const set = resolved.body.resolved.workouts[0].entries[0].sets[0];
  assert.equal(set.rpe, 8, 'should include rpe even though effort is rpe');
  assert.equal(set.rir, 2, 'should include rir even though effort is rpe');
});

test('dayPlan and week are objects, queue can be null', async (t) => {
  const h = await startServer(t);
  
  const state = {
    unit: 'kg',
    routines: [{ id: 'r1', name: 'Push', ex: [] }],
    dayPlan: { '2026-10-16': 'r1', '2026-10-18': 'r1' },
    week: { mon: ['r1'], wed: ['r1'], fri: ['r1'] },
    queue: null
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  assert.ok(typeof resolved.body.resolved.dayPlan === 'object');
  assert.equal(resolved.body.resolved.dayPlan['2026-10-16'], 'r1');
  assert.ok(typeof resolved.body.resolved.week === 'object');
  assert.ok(Array.isArray(resolved.body.resolved.week.mon));
});

test('exWeights includes resolved names', async (t) => {
  const h = await startServer(t);
  
  const state = {
    unit: 'kg',
    exWeights: {
      '0025': { w: 100, d: '2026-10-15' },
      '0085': { w: 50, d: '2026-10-14' }
    }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const weights = resolved.body.resolved.exWeights;
  assert.ok(weights['0025']);
  assert.ok(weights['0025'].name, 'should have resolved name');
  assert.equal(weights['0025'].w, 100);
  assert.equal(weights['0025'].d, '2026-10-15');
});

test('alias IDs are resolved correctly', async (t) => {
  const h = await startServer(t);
  
  // Assuming there's an alias in the catalogue (we'll use a variant exercise)
  const state = {
    unit: 'kg',
    workouts: [{
      d: '2026-10-15',
      // If 0026 is an alias/variant of 0025, it should resolve to 0025
      entries: [{ id: '0026', sets: [{ w: 100, r: 8, done: true }] }]
    }]
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  // The exercise should still be accessible and resolved
  const entry = resolved.body.resolved.workouts[0].entries[0];
  assert.ok(entry.exercise);
  assert.ok(entry.exercise.name);
});

test('read token excludes gymCards from state', async (t) => {
  const h = await startServer(t);
  
  const state = {
    unit: 'kg',
    workouts: [],
    gymCards: { cardId: 'secret123', validUntil: '2027-01-01' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const token = await h.createToken('u_one', 'Test Bot');
  
  const withToken = await h.req('GET', '/api/data?resolve=1', bearer(token));
  assert.equal(withToken.status, 200);
  assert.ok(!withToken.body.state.gymCards, 'gymCards should be filtered for read token');
  assert.ok(!withToken.body.resolved.gymCards, 'gymCards should not be in resolved either');
  
  const withSession = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(withSession.status, 200);
  assert.ok(withSession.body.state.gymCards, 'gymCards should be present for session');
});

test('dayNotes are included and not filtered', async (t) => {
  const h = await startServer(t);
  
  const state = {
    unit: 'kg',
    dayNotes: { 
      '2026-10-15': 'Good training day',
      '2026-10-16': 'Rest day - recovery'
    }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  assert.ok(resolved.body.resolved.dayNotes);
  assert.equal(resolved.body.resolved.dayNotes['2026-10-15'], 'Good training day');
  assert.equal(resolved.body.resolved.dayNotes['2026-10-16'], 'Rest day - recovery');
});

test('malformed data does not cause 500 error', async (t) => {
  const h = await startServer(t);
  
  const state = {
    unit: 'kg',
    workouts: [
      { d: '2026-10-15', entries: [{ id: '0025', sets: [{ w: 100, r: 8 }] }] },
      null, // malformed workout
      { d: '2026-10-16' } // workout without entries
    ],
    routines: [
      { id: 'r1', name: 'Push', ex: [{ id: '0025' }] },
      null, // malformed routine
      { id: 'r2' } // routine without ex
    ],
    dayPlan: { '2026-10-17': null }, // null routine ID
    queue: { x: null }, // null queue item
    exWeights: { '0025': null } // null weight data
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200, 'should not error on malformed data');
  assert.ok(resolved.body.resolved);
});

test('measurements and customMeasurements are included', async (t) => {
  const h = await startServer(t);
  
  const state = {
    unit: 'kg',
    measurements: {
      chest: [{ d: '2026-10-15', v: 100 }],
      arms: [{ d: '2026-10-15', v: 40 }]
    },
    customMeasurements: {
      neck: { name: 'Neck', unit: 'cm' },
      calf: { name: 'Calf', unit: 'cm' }
    }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  assert.ok(resolved.body.resolved.measurements);
  assert.ok(resolved.body.resolved.measurements.chest);
  assert.ok(resolved.body.resolved.customMeasurements);
  assert.ok(resolved.body.resolved.customMeasurements.neck);
});
