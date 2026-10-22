/* Write tokens with 'routines' scope: made, listed and revoked with a session; can read and write
   routines but cannot access workouts, settings, or other state. Tokens test on real server.js in
   a child, with Date.now() driven by test/fake-clock.mjs. */
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

// Same construction as makeSession(), good for a year so moving the server's clock keeps it valid.
function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 365 * DAY}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const cookie = (uid, sv) => ({ Cookie: `gymsid=${mintSession(uid, sv)}`, Origin: ORIGIN });
const bearer = token => ({ Authorization: `Bearer ${token}` });

const USERS = [
  { id: 'u_one', name: 'One', created: new Date().toISOString() },
  { id: 'u_two', name: 'Two', created: new Date().toISOString() }
];
const STATE = {
  _rev: 3, _wid: 'w3', unit: 'kg',
  routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 60 }] }],
  workouts: [{ id: 'w1', d: '2026-10-01', entries: [] }],
  week: { 1: ['r1'] },
  dayPlan: { '2026-10-22': 'r1' }
};

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-writetok-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: USERS, creds: [], subs: [], invites: [], readTokens: [] }));
  fs.writeFileSync(path.join(dataDir, 'state-u_one.json'), JSON.stringify(STATE));
  const child = spawn(process.execPath, ['--import', './test/fake-clock.mjs', 'server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
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
  h.state = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'state-u_one.json'), 'utf8'));
  h.create = async (uid, body) => {
    const r = await h.req('POST', '/api/account/read-tokens', cookie(uid), body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  return h;
}

test('a routines write token is created with scope, reads and writes routines, but not other routes', async t => {
  const h = await startServer(t);
  const { token, readToken } = await h.create('u_one', { name: 'Pulso', scope: 'routines' });
  assert.match(token, /^ogw_[A-Za-z0-9_-]{43}$/);
  assert.equal(readToken.scope, 'routines');
  assert.equal(readToken.name, 'Pulso');

  // Can read routines
  const list = await h.req('GET', '/api/routines', bearer(token));
  assert.equal(list.status, 200);
  assert.equal(list.body.routines.length, 1);
  assert.equal(list.body.routines[0].id, 'r1');
  assert.equal(list.body.rev, 3);

  // Can read full data
  const data = await h.req('GET', '/api/data', bearer(token));
  assert.equal(data.status, 200);
  assert.deepEqual(data.body.state.routines, STATE.routines);

  // Can create a routine
  const newRoutine = {
    id: 'r2',
    name: 'Pull',
    ex: [{ id: '0100', sets: 3, reps: 8, weight: 50 }]
  };
  const create = await h.req('PUT', '/api/routines/r2', bearer(token), { routine: newRoutine, baseRev: 3 });
  assert.equal(create.status, 200);
  assert.equal(create.body.rev, 4);
  assert.equal(h.state().routines.length, 2);

  // Can update a routine
  const updated = { ...newRoutine, name: 'Pull Day' };
  const update = await h.req('PUT', '/api/routines/r2', bearer(token), { routine: updated, baseRev: 4 });
  assert.equal(update.status, 200);
  assert.equal(update.body.rev, 5);
  assert.equal(h.state().routines[1].name, 'Pull Day');

  // Can delete a routine
  const del = await h.req('DELETE', '/api/routines/r2', bearer(token), { baseRev: 5 });
  assert.equal(del.status, 200);
  assert.equal(del.body.rev, 6);
  assert.equal(h.state().routines.length, 1);

  // Cannot write to /api/data
  const putData = await h.req('PUT', '/api/data', bearer(token), { state: { unit: 'lb' }, baseRev: 6 });
  assert.equal(putData.status, 403);
  assert.equal(putData.body.code, 'scope-denied');

  // Cannot access other routes
  for (const [method, path] of [
    ['POST', '/api/push/subscribe'],
    ['DELETE', '/api/account/passkeys'],
    ['GET', '/api/me']
  ]) {
    const r = await h.req(method, path, bearer(token), method === 'GET' ? undefined : {});
    assert.equal(r.status, 403, `${method} ${path} should be denied`);
  }
});

test('write token validates routine structure and exercise catalogue', async t => {
  const h = await startServer(t);
  const { token } = await h.create('u_one', { name: 'Pulso', scope: 'routines' });

  // Missing required fields
  const noId = await h.req('PUT', '/api/routines/r3', bearer(token), { routine: { name: 'Test', ex: [] } });
  assert.equal(noId.status, 400);
  assert.equal(noId.body.code, 'id-mismatch');

  const noName = await h.req('PUT', '/api/routines/r3', bearer(token), { routine: { id: 'r3', ex: [] } });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.code, 'name-required');

  const notArray = await h.req('PUT', '/api/routines/r3', bearer(token), { routine: { id: 'r3', name: 'Test', ex: 'not-array' } });
  assert.equal(notArray.status, 400);
  assert.equal(notArray.body.code, 'invalid-ex');

  // Exercise not in catalogue
  const badEx = await h.req('PUT', '/api/routines/r3', bearer(token), {
    routine: { id: 'r3', name: 'Test', ex: [{ id: 'fake-exercise' }] },
    baseRev: 3
  });
  assert.equal(badEx.status, 400);
  assert.equal(badEx.body.code, 'exercise-not-found');
});

test('write token enforces concurrency control with baseRev', async t => {
  const h = await startServer(t);
  const { token } = await h.create('u_one', { name: 'Pulso', scope: 'routines' });

  // Conflict on wrong baseRev
  const conflict = await h.req('PUT', '/api/routines/r2', bearer(token), {
    routine: { id: 'r2', name: 'New', ex: [] },
    baseRev: 99
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'conflict');
  assert.equal(conflict.body.rev, 3);

  // No baseRev allows overwrite
  const noBase = await h.req('PUT', '/api/routines/r2', bearer(token), {
    routine: { id: 'r2', name: 'New', ex: [] }
  });
  assert.equal(noBase.status, 200);
});

test('deleting a routine cleans up references in week, dayPlan, queue and rotation', async t => {
  const h = await startServer(t);
  const { token } = await h.create('u_one', { name: 'Pulso', scope: 'routines' });

  const del = await h.req('DELETE', '/api/routines/r1', bearer(token), { baseRev: 3 });
  assert.equal(del.status, 200);

  const state = h.state();
  assert.equal(state.routines.length, 0);
  assert.deepEqual(state.week, {}, 'week reference should be removed');
  assert.deepEqual(state.dayPlan, {}, 'dayPlan reference should be removed');
});

test('read token (ogr_) cannot access write routes', async t => {
  const h = await startServer(t);
  const { token } = await h.create('u_one', { name: 'Assistant', scope: 'read' });
  assert.match(token, /^ogr_/);

  // Can read
  const data = await h.req('GET', '/api/data', bearer(token));
  assert.equal(data.status, 200);

  // Cannot write routines
  const put = await h.req('PUT', '/api/routines/r2', bearer(token), {
    routine: { id: 'r2', name: 'Test', ex: [] }
  });
  assert.equal(put.status, 403);
  assert.equal(put.body.code, 'read-only');

  const del = await h.req('DELETE', '/api/routines/r1', bearer(token), {});
  assert.equal(del.status, 403);
  assert.equal(del.body.code, 'read-only');

  const get = await h.req('GET', '/api/routines', bearer(token));
  assert.equal(get.status, 403);
  assert.equal(get.body.code, 'read-only');
});

test('routines token with missing exercises shows helpful error', async t => {
  const h = await startServer(t);
  const { token } = await h.create('u_one', { name: 'Pulso', scope: 'routines' });

  const r = await h.req('PUT', '/api/routines/r3', bearer(token), {
    routine: {
      id: 'r3',
      name: 'Test',
      ex: [
        { id: '0025', sets: 3, reps: 5 },
        { id: 'nonexistent', sets: 3, reps: 8 }
      ]
    },
    baseRev: 3
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'exercise-not-found');
  assert.ok(r.body.error.includes('nonexistent'));
});

test('token write wins over client push with stale copy (sync stamps)', async t => {
  const h = await startServer(t);
  const { token } = await h.create('u_one', { name: 'Pulso', scope: 'routines' });

  const initial = await h.req('GET', '/api/data', cookie('u_one'));
  assert.equal(initial.status, 200);
  // An updated app always carries an `edited` map; stampPut only protects per-field stamps
  // against a writer that sends one (or entry `_f`). Empty object is enough.
  const clientCopy = { ...initial.body.state, edited: { ...(initial.body.state.edited || {}) } };
  const baseRev = initial.body.rev;

  const tokenUpdate = await h.req('PUT', '/api/routines/r1', bearer(token), {
    routine: {
      id: 'r1',
      name: 'Push Updated by Token',
      ex: [{ id: '0025', sets: 3, reps: 5, weight: 60 }]
    },
    baseRev
  });
  assert.equal(tokenUpdate.status, 200);
  assert.ok(tokenUpdate.body.routine._ts, 'PUT stamps _ts');
  assert.ok(tokenUpdate.body.routine._f?.name, 'PUT stamps _f for changed fields');
  const tokenRev = tokenUpdate.body.rev;

  const clientPush = await h.req('PUT', '/api/data', cookie('u_one'), {
    state: clientCopy,
    baseRev,
    stamped: false
  });
  assert.equal(clientPush.status, 409);

  const clientRetry = await h.req('PUT', '/api/data', cookie('u_one'), {
    state: clientCopy,
    baseRev: tokenRev,
    stamped: false
  });
  assert.equal(clientRetry.status, 200);

  const final = await h.req('GET', '/api/data', cookie('u_one'));
  assert.equal(final.status, 200);
  const routine = final.body.state.routines.find(r => r.id === 'r1');
  assert.ok(routine, 'routine should exist');
  assert.equal(routine.name, 'Push Updated by Token', 'token change should win over stale client copy');
  assert.ok(routine._ts, 'routine should have _ts stamp');
  assert.ok(routine._f?.name, 'routine should keep the token\'s per-field stamp');
});

test('deleted routine stays deleted after client merges the conflict (tombstone)', async t => {
  const h = await startServer(t);
  const { token } = await h.create('u_one', { name: 'Pulso', scope: 'routines' });

  const initial = await h.req('GET', '/api/data', cookie('u_one'));
  const clientCopy = { ...initial.body.state, edited: { ...(initial.body.state.edited || {}) } };
  const baseRev = initial.body.rev;

  const tokenDelete = await h.req('DELETE', '/api/routines/r1', bearer(token), { baseRev });
  assert.equal(tokenDelete.status, 200);
  const tokenRev = tokenDelete.body.rev;

  let state = h.state();
  assert.equal(state.routines.length, 0, 'routine should be removed');
  assert.ok(Number(state.deleted?.routines?.r1) > 0, 'routine should be in deleted.routines');
  assert.equal(state.week?.[1], undefined, 'week pointer cleaned up');

  // Stale baseRev → 409 with the tombstoned document (what the app merges against).
  const conflict = await h.req('PUT', '/api/data', cookie('u_one'), {
    state: clientCopy,
    baseRev,
    stamped: false
  });
  assert.equal(conflict.status, 409);
  assert.equal((conflict.body.state.routines || []).length, 0);
  assert.ok(Number(conflict.body.state.deleted?.routines?.r1) > 0);

  // After mergeStates/applyDeletions the phone pushes without the routine and keeps the tombstone.
  const merged = {
    ...clientCopy,
    routines: conflict.body.state.routines,
    deleted: conflict.body.state.deleted,
    week: conflict.body.state.week,
    dayPlan: conflict.body.state.dayPlan,
  };
  const clientRetry = await h.req('PUT', '/api/data', cookie('u_one'), {
    state: merged,
    baseRev: tokenRev,
    stamped: true
  });
  assert.equal(clientRetry.status, 200);

  state = h.state();
  assert.equal(state.routines.length, 0, 'routine should stay deleted');
  assert.ok(Number(state.deleted?.routines?.r1) > 0, 'deletion tombstone should be preserved');
});
