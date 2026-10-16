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

test('GET /api/data with resolve=1 includes resolved data', async (t) => {
  const h = await startServer(t);
  
  const state = {
    workouts: [{
      d: '2026-10-15',
      entries: [{
        id: '0025',
        sets: [
          { w: 100, r: 8, done: true },
          { w: 100, r: 8, done: true }
        ]
      }]
    }],
    routines: [{
      id: 'r1',
      name: 'Push Day',
      slots: [{ id: '0025' }]
    }],
    customEx: [{
      id: 'custom1',
      n: 'My Custom Exercise',
      bp: 'chest',
      eq: 'dumbbell'
    }],
    favEx: ['0025', 'custom1'],
    exNotes: { '0025': 'Focus on form' },
    settings: { unit: 'kg', effort: 'rpe' }
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
  assert.ok(resolved.body.resolved.meta);
});

test('resolved exercises include built-in exercise data', async (t) => {
  const h = await startServer(t);
  
  const state = {
    workouts: [{
      d: '2026-10-15',
      entries: [{ id: '0025', sets: [{ w: 100, r: 8, done: true }] }]
    }],
    settings: { unit: 'kg' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const ex = resolved.body.resolved.exercises['0025'];
  assert.ok(ex, 'exercise 0025 should be resolved');
  assert.ok(ex.name, 'should have name');
  assert.ok(ex.bodyPart, 'should have bodyPart');
  assert.ok(ex.equipment, 'should have equipment');
  assert.ok(Array.isArray(ex.primaryMuscles), 'should have primaryMuscles array');
  assert.ok(Array.isArray(ex.secondaryMuscles), 'should have secondaryMuscles array');
  assert.ok(!ex.custom, 'built-in exercise should not be marked as custom');
  assert.ok(!ex.missing, 'known exercise should not be marked as missing');
});

test('resolved exercises merge custom exercises', async (t) => {
  const h = await startServer(t);
  
  const state = {
    customEx: [{
      id: 'custom1',
      n: 'My Custom Squat',
      bp: 'legs',
      eq: 'barbell',
      primaries: ['quadriceps'],
      sm: ['glutes']
    }],
    workouts: [{
      d: '2026-10-15',
      entries: [{ id: 'custom1', sets: [{ w: 120, r: 5, done: true }] }]
    }],
    settings: { unit: 'kg' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const ex = resolved.body.resolved.exercises.custom1;
  assert.ok(ex, 'custom exercise should be resolved');
  assert.equal(ex.name, 'My Custom Squat');
  assert.equal(ex.bodyPart, 'legs');
  assert.equal(ex.equipment, 'barbell');
  assert.equal(ex.custom, true, 'custom exercise should be marked as custom');
  assert.ok(!ex.missing, 'custom exercise should not be marked as missing');
});

test('resolved exercises mark unknown IDs as missing', async (t) => {
  const h = await startServer(t);
  
  const state = {
    workouts: [{
      d: '2026-10-15',
      entries: [{ id: 'unknown999', sets: [{ w: 50, r: 10, done: true }] }]
    }],
    settings: { unit: 'kg' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const ex = resolved.body.resolved.exercises.unknown999;
  assert.ok(ex, 'unknown exercise should still have an entry');
  assert.equal(ex.id, 'unknown999');
  assert.equal(ex.missing, true, 'unknown exercise should be marked as missing');
});

test('resolved workouts include exercise details and set data', async (t) => {
  const h = await startServer(t);
  
  const state = {
    workouts: [{
      d: '2026-10-15',
      label: 'Morning Session',
      note: 'Felt strong',
      entries: [{
        id: '0025',
        note: 'Good depth',
        sets: [
          { w: 100, r: 8, done: true, rpe: 7 },
          { w: 100, r: 8, done: true, rpe: 8 },
          { w: 60, r: 12, done: true, warmup: true }
        ]
      }]
    }],
    settings: { unit: 'kg', effort: 'rpe' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const workout = resolved.body.resolved.workouts[0];
  assert.equal(workout.date, '2026-10-15');
  assert.equal(workout.unit, 'kg');
  assert.equal(workout.note, 'Felt strong');
  assert.equal(workout.label, 'Morning Session');
  
  const entry = workout.entries[0];
  assert.ok(entry.exercise, 'entry should have exercise details');
  assert.equal(entry.exercise.id, '0025');
  assert.ok(entry.exercise.name, 'exercise should have name');
  assert.ok(entry.exercise.bodyPart, 'exercise should have bodyPart');
  assert.equal(entry.note, 'Good depth');
  
  assert.equal(entry.sets.length, 3);
  assert.equal(entry.sets[0].w, 100);
  assert.equal(entry.sets[0].r, 8);
  assert.equal(entry.sets[0].done, true);
  assert.equal(entry.sets[0].rpe, 7);
  assert.ok(!entry.sets[0].warmup, 'work set should not be marked as warmup');
  assert.equal(entry.sets[2].warmup, true, 'warmup set should be marked');
});

test('resolved workouts respect effort scale setting', async (t) => {
  const h = await startServer(t);
  
  const state = {
    workouts: [{
      d: '2026-10-15',
      entries: [{
        id: '0025',
        sets: [{ w: 100, r: 8, done: true, rir: 2 }]
      }]
    }],
    settings: { unit: 'kg', effort: 'rir' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const set = resolved.body.resolved.workouts[0].entries[0].sets[0];
  assert.equal(set.rir, 2, 'RIR should be included when effort=rir');
  assert.ok(!set.rpe, 'RPE should not be included when effort=rir');
});

test('resolved routines include exercise details', async (t) => {
  const h = await startServer(t);
  
  const state = {
    routines: [{
      id: 'r1',
      name: 'Push Day',
      note: 'Upper body focus',
      slots: [
        { id: '0025', note: 'Main lift' },
        { id: '0085' }
      ]
    }],
    settings: { unit: 'kg' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const routine = resolved.body.resolved.routines[0];
  assert.equal(routine.id, 'r1');
  assert.equal(routine.name, 'Push Day');
  assert.equal(routine.note, 'Upper body focus');
  assert.equal(routine.slots.length, 2);
  
  const slot = routine.slots[0];
  assert.ok(slot.exercise, 'slot should have exercise details');
  assert.equal(slot.exercise.id, '0025');
  assert.ok(slot.exercise.name, 'exercise should have name');
  assert.equal(slot.note, 'Main lift');
});

test('resolved exNotes include exercise names', async (t) => {
  const h = await startServer(t);
  
  const state = {
    exNotes: {
      '0025': 'Focus on depth and control',
      '0085': 'Keep elbows tucked'
    },
    settings: { unit: 'kg' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const notes = resolved.body.resolved.exNotes;
  assert.ok(notes['0025'], 'should have note for 0025');
  assert.ok(notes['0025'].name, 'should include exercise name');
  assert.equal(notes['0025'].note, 'Focus on depth and control');
  assert.ok(notes['0085'].name, 'should include exercise name for 0085');
});

test('resolved meta includes catalogue version and settings', async (t) => {
  const h = await startServer(t);
  
  const state = {
    workouts: [{ d: '2026-10-15', entries: [] }],
    settings: { unit: 'lb', effort: 'rpe' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const meta = resolved.body.resolved.meta;
  assert.ok(meta.catalogueVersion >= 0, 'should have catalogue version');
  assert.equal(meta.unit, 'lb');
  assert.equal(meta.effortScale, 'rpe');
  assert.ok(meta.generatedAt, 'should have generatedAt timestamp');
  assert.ok(Date.parse(meta.generatedAt), 'generatedAt should be valid ISO date');
});

test('read token access with resolve=1 works', async (t) => {
  const h = await startServer(t);
  
  const state = {
    workouts: [{
      d: '2026-10-15',
      entries: [{ id: '0025', sets: [{ w: 100, r: 8, done: true }] }]
    }],
    settings: { unit: 'kg' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const token = await h.createToken('u_one', 'Test Bot');
  
  const resolved = await h.req('GET', '/api/data?resolve=1', bearer(token));
  assert.equal(resolved.status, 200);
  assert.ok(resolved.body.resolved, 'read token should get resolved data');
  assert.ok(resolved.body.resolved.exercises['0025'], 'should resolve exercises');
});

test('read token excludes gymCards from state', async (t) => {
  const h = await startServer(t);
  
  const state = {
    workouts: [],
    gymCards: { cardId: 'secret123', validUntil: '2027-01-01' },
    settings: { unit: 'kg' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const token = await h.createToken('u_one', 'Test Bot');
  
  const withToken = await h.req('GET', '/api/data?resolve=1', bearer(token));
  assert.equal(withToken.status, 200);
  assert.ok(!withToken.body.state.gymCards, 'gymCards should be filtered for read token');
  
  const withSession = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(withSession.status, 200);
  assert.ok(withSession.body.state.gymCards, 'gymCards should be present for session');
});

test('read token still forbidden on other routes', async (t) => {
  const h = await startServer(t);
  
  const token = await h.createToken('u_one', 'Test Bot');
  
  const put = await h.req('PUT', '/api/data', bearer(token), { state: {}, baseRev: 0 });
  assert.equal(put.status, 403, 'PUT /api/data should be forbidden with read token');
  
  const account = await h.req('GET', '/api/account', bearer(token));
  assert.equal(account.status, 403, 'other GET routes should be forbidden with read token');
});

test('include=catalogue also triggers resolve', async (t) => {
  const h = await startServer(t);
  
  const state = {
    workouts: [{
      d: '2026-10-15',
      entries: [{ id: '0025', sets: [{ w: 100, r: 8, done: true }] }]
    }],
    settings: { unit: 'kg' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?include=catalogue', cookie('u_one'));
  assert.equal(resolved.status, 200);
  assert.ok(resolved.body.resolved, 'include=catalogue should trigger resolve');
  assert.ok(resolved.body.resolved.exercises['0025']);
});

test('warmup and failure flags are preserved in resolved workouts', async (t) => {
  const h = await startServer(t);
  
  const state = {
    workouts: [{
      d: '2026-10-15',
      entries: [{
        id: '0025',
        sets: [
          { w: 60, r: 10, done: true, warmup: true },
          { w: 100, r: 8, done: true },
          { w: 100, r: 12, done: true, failure: true }
        ]
      }]
    }],
    settings: { unit: 'kg' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const resolved = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  assert.equal(resolved.status, 200);
  
  const sets = resolved.body.resolved.workouts[0].entries[0].sets;
  assert.equal(sets[0].warmup, true, 'warmup set should be marked');
  assert.ok(!sets[1].warmup, 'work set should not have warmup flag');
  assert.ok(!sets[1].failure, 'regular work set should not have failure flag');
  assert.equal(sets[2].failure, true, 'failure set should be marked');
});

test('state fields are not filtered differently than before', async (t) => {
  const h = await startServer(t);
  
  const state = {
    workouts: [],
    routines: [],
    bodyweight: [{ d: '2026-10-15', w: 80 }],
    measurements: { chest: [{ d: '2026-10-15', v: 100 }] },
    customMeasurements: { test: { name: 'Test', unit: 'cm' } },
    dayNotes: { '2026-10-15': 'Good day' },
    settings: { unit: 'kg' },
    _unstamped: { should: 'be filtered' },
    _prior: { should: 'be filtered' }
  };
  
  await h.req('PUT', '/api/data', cookie('u_one'), { state, baseRev: 0 });
  
  const without = await h.req('GET', '/api/data', cookie('u_one'));
  const withResolve = await h.req('GET', '/api/data?resolve=1', cookie('u_one'));
  
  assert.equal(without.status, 200);
  assert.equal(withResolve.status, 200);
  
  assert.ok(without.body.state.bodyweight);
  assert.ok(without.body.state.measurements);
  assert.ok(without.body.state.customMeasurements);
  assert.ok(without.body.state.dayNotes);
  assert.ok(without.body.state.settings);
  assert.ok(!without.body.state._unstamped, 'internal fields should be filtered');
  assert.ok(!without.body.state._prior, 'internal fields should be filtered');
  
  assert.ok(withResolve.body.state.bodyweight);
  assert.ok(withResolve.body.state.measurements);
  assert.ok(withResolve.body.state.customMeasurements);
  assert.ok(withResolve.body.state.dayNotes);
  assert.ok(withResolve.body.state.settings);
  assert.ok(!withResolve.body.state._unstamped, 'internal fields should be filtered with resolve');
  assert.ok(!withResolve.body.state._prior, 'internal fields should be filtered with resolve');
});
