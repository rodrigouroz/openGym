import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { softPasskey } from './passkey.mjs';

const origin = 'http://localhost:8787';

test('real Workers runtime: routines write tokens can read and write routines but not other data', async t => {
  const persist = await mkdtemp(join(tmpdir(), 'opengym-writetok-test-'));
  const options = {
    modules: true, scriptPath: resolve('build/worker.js'),
    compatibilityDate: '2026-10-12', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { GYM: { className: 'Gym', useSQLite: true } },
    resourcePersistencePath: persist,
    bindings: { ORIGIN: origin, RP_ID: 'localhost', ALLOW_GUEST: '0', TRUST_PROXY: '1' }
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  const restart = async () => { await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options)); };
  const req = async (method, path, { cookie, token, body, headers = {} } = {}) => {
    const r = await mf.dispatchFetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie, Origin: origin } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...headers
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)
    });
    const type = r.headers.get('content-type') || '';
    return {
      status: r.status,
      body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()),
      cookie: r.headers.get('set-cookie')?.split(';')[0]
    };
  };
  
  async function register(name) {
    const key = softPasskey();
    const opts = await req('POST', '/api/register/options', { body: { name } });
    const result = await req('POST', '/api/register/verify', {
      body: { cid: opts.body.cid, credential: key.attestation(opts.body.options.challenge) }
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result;
  }
  
  const owner = await register('Owner');
  
  // Save initial state with a routine
  const saved = await req('PUT', '/api/data', {
    cookie: owner.cookie,
    body: {
      state: {
        workouts: [],
        routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 60 }] }],
        unit: 'kg',
        week: { 1: ['r1'] },
        dayPlan: { '2026-10-22': 'r1' }
      },
      baseRev: 0
    }
  });
  assert.equal(saved.status, 200);

  // Create write token with routines scope
  const created = await req('POST', '/api/account/read-tokens', {
    cookie: owner.cookie,
    body: { name: 'Pulso', scope: 'routines' }
  });
  assert.equal(created.status, 201);
  const { token, readToken } = created.body;
  assert.match(token, /^ogw_/);
  assert.equal(readToken.scope, 'routines');

  // Can list routines
  await restart();
  const list = await req('GET', '/api/routines', { token });
  assert.equal(list.status, 200);
  assert.equal(list.body.routines.length, 1);
  assert.equal(list.body.routines[0].name, 'Push');

  // Can read full data
  const data = await req('GET', '/api/data', { token });
  assert.equal(data.status, 200);
  assert.equal(data.body.state.routines[0].name, 'Push');

  // Can create a routine
  const newRoutine = {
    id: 'r2',
    name: 'Pull',
    ex: [{ id: '0100', sets: 3, reps: 8, weight: 50 }]
  };
  const create = await req('PUT', '/api/routines/r2', {
    token,
    body: { routine: newRoutine, baseRev: 1 }
  });
  assert.equal(create.status, 200);
  assert.equal(create.body.ok, true);
  assert.equal(create.body.rev, 2);

  // Can update a routine
  const updated = { ...newRoutine, name: 'Pull Day' };
  const update = await req('PUT', '/api/routines/r2', {
    token,
    body: { routine: updated, baseRev: 2 }
  });
  assert.equal(update.status, 200);
  assert.equal(update.body.rev, 3);

  // Can delete a routine
  const del = await req('DELETE', '/api/routines/r2', {
    token,
    body: { baseRev: 3 }
  });
  assert.equal(del.status, 200);
  assert.equal(del.body.rev, 4);

  // Verify the routine is gone
  const afterDel = await req('GET', '/api/routines', { token });
  assert.equal(afterDel.body.routines.length, 1);
  assert.equal(afterDel.body.routines[0].id, 'r1');

  // Cannot write to PUT /api/data
  const putData = await req('PUT', '/api/data', {
    token,
    body: { state: { unit: 'lb' }, baseRev: 4 }
  });
  assert.equal(putData.status, 403);
  assert.equal(putData.body.code, 'scope-denied');

  // Cannot access other write routes
  const pushSub = await req('POST', '/api/push/subscribe', {
    token,
    body: { subscription: { endpoint: 'https://example.com', keys: { p256dh: 'x', auth: 'y' } } }
  });
  assert.equal(pushSub.status, 403);

  // Verify state after restart
  await restart();
  const finalList = await req('GET', '/api/routines', { token });
  assert.equal(finalList.status, 200);
  assert.equal(finalList.body.routines.length, 1);
});

test('routines token validates exercise IDs against catalogue', async t => {
  const persist = await mkdtemp(join(tmpdir(), 'opengym-writetok-validation-'));
  const options = {
    modules: true, scriptPath: resolve('build/worker.js'),
    compatibilityDate: '2026-10-12', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { GYM: { className: 'Gym', useSQLite: true } },
    resourcePersistencePath: persist,
    bindings: { ORIGIN: origin, RP_ID: 'localhost', ALLOW_GUEST: '0', TRUST_PROXY: '1' }
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  
  const req = async (method, path, { cookie, token, body } = {}) => {
    const r = await mf.dispatchFetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie, Origin: origin } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const type = r.headers.get('content-type') || '';
    return {
      status: r.status,
      body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()),
      cookie: r.headers.get('set-cookie')?.split(';')[0]
    };
  };
  
  async function register(name) {
    const key = softPasskey();
    const opts = await req('POST', '/api/register/options', { body: { name } });
    const result = await req('POST', '/api/register/verify', {
      body: { cid: opts.body.cid, credential: key.attestation(opts.body.options.challenge) }
    });
    return result;
  }
  
  const owner = await register('Owner');
  await req('PUT', '/api/data', {
    cookie: owner.cookie,
    body: { state: { workouts: [], routines: [], unit: 'kg' }, baseRev: 0 }
  });
  
  const created = await req('POST', '/api/account/read-tokens', {
    cookie: owner.cookie,
    body: { name: 'Pulso', scope: 'routines' }
  });
  const { token } = created.body;

  // Invalid exercise ID
  const badEx = await req('PUT', '/api/routines/r1', {
    token,
    body: {
      routine: {
        id: 'r1',
        name: 'Test',
        ex: [{ id: 'fake-exercise-id', sets: 3, reps: 5 }]
      },
      baseRev: 1
    }
  });
  assert.equal(badEx.status, 400);
  assert.equal(badEx.body.code, 'exercise-not-found');

  // Valid exercise ID (0025 is barbell bench press)
  const goodEx = await req('PUT', '/api/routines/r1', {
    token,
    body: {
      routine: {
        id: 'r1',
        name: 'Test',
        ex: [{ id: '0025', sets: 3, reps: 5 }]
      },
      baseRev: 1
    }
  });
  assert.equal(goodEx.status, 200);
});

test('read token (ogr_) cannot access routines write endpoints', async t => {
  const persist = await mkdtemp(join(tmpdir(), 'opengym-readtok-deny-'));
  const options = {
    modules: true, scriptPath: resolve('build/worker.js'),
    compatibilityDate: '2026-10-12', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { GYM: { className: 'Gym', useSQLite: true } },
    resourcePersistencePath: persist,
    bindings: { ORIGIN: origin, RP_ID: 'localhost', ALLOW_GUEST: '0', TRUST_PROXY: '1' }
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  
  const req = async (method, path, { cookie, token, body } = {}) => {
    const r = await mf.dispatchFetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie, Origin: origin } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  
  async function register(name) {
    const key = softPasskey();
    const opts = await req('POST', '/api/register/options', { body: { name } });
    const result = await req('POST', '/api/register/verify', {
      body: { cid: opts.body.cid, credential: key.attestation(opts.body.options.challenge) }
    });
    return result;
  }
  
  const owner = await register('Owner');
  await req('PUT', '/api/data', {
    cookie: owner.cookie,
    body: { state: { workouts: [], routines: [{ id: 'r1', name: 'Push', ex: [] }], unit: 'kg' }, baseRev: 0 }
  });
  
  // Create read token
  const created = await req('POST', '/api/account/read-tokens', {
    cookie: owner.cookie,
    body: { name: 'Assistant', scope: 'read' }
  });
  const { token } = created.body;
  assert.match(token, /^ogr_/);

  // Can read data
  const data = await req('GET', '/api/data', { token });
  assert.equal(data.status, 200);

  // Cannot access routines endpoints
  const list = await req('GET', '/api/routines', { token });
  assert.equal(list.status, 403);
  assert.equal(list.body.code, 'read-only');

  const put = await req('PUT', '/api/routines/r2', {
    token,
    body: { routine: { id: 'r2', name: 'Test', ex: [] } }
  });
  assert.equal(put.status, 403);
  assert.equal(put.body.code, 'read-only');

  const del = await req('DELETE', '/api/routines/r1', { token, body: {} });
  assert.equal(del.status, 403);
  assert.equal(del.body.code, 'read-only');
});

test('deleting routine cleans up week, dayPlan, queue and rotation references', async t => {
  const persist = await mkdtemp(join(tmpdir(), 'opengym-cleanup-'));
  const options = {
    modules: true, scriptPath: resolve('build/worker.js'),
    compatibilityDate: '2026-10-12', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { GYM: { className: 'Gym', useSQLite: true } },
    resourcePersistencePath: persist,
    bindings: { ORIGIN: origin, RP_ID: 'localhost', ALLOW_GUEST: '0', TRUST_PROXY: '1' }
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  
  const req = async (method, path, { cookie, token, body } = {}) => {
    const r = await mf.dispatchFetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie, Origin: origin } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  
  async function register(name) {
    const key = softPasskey();
    const opts = await req('POST', '/api/register/options', { body: { name } });
    const result = await req('POST', '/api/register/verify', {
      body: { cid: opts.body.cid, credential: key.attestation(opts.body.options.challenge) }
    });
    return result;
  }
  
  const owner = await register('Owner');
  await req('PUT', '/api/data', {
    cookie: owner.cookie,
    body: {
      state: {
        workouts: [],
        routines: [
          { id: 'r1', name: 'Push', ex: [] },
          { id: 'r2', name: 'Pull', ex: [] }
        ],
        unit: 'kg',
        week: { 1: ['r1', 'r2'], 3: ['r1'] },
        dayPlan: { '2026-10-22': 'r1', '2026-10-24': 'r2' },
        queue: { ids: ['r1', 'r2'], since: Date.now(), startsOn: '2026-10-21', label: 'Split' },
        rotation: { id: 'rot1', sequence: ['r1', 'r2'], label: 'Split' }
      },
      baseRev: 0
    }
  });
  
  const created = await req('POST', '/api/account/read-tokens', {
    cookie: owner.cookie,
    body: { name: 'Pulso', scope: 'routines' }
  });
  const { token } = created.body;

  // Delete r1
  const del = await req('DELETE', '/api/routines/r1', { token, body: { baseRev: 1 } });
  assert.equal(del.status, 200);

  // Verify cleanup
  const data = await req('GET', '/api/data', { cookie: owner.cookie });
  assert.equal(data.body.state.routines.length, 1);
  assert.equal(data.body.state.routines[0].id, 'r2');
  assert.deepEqual(data.body.state.week, { 1: ['r2'] }, 'r1 removed from week, r2 kept');
  assert.deepEqual(data.body.state.dayPlan, { '2026-10-24': 'r2' }, 'r1 date removed');
  assert.deepEqual(data.body.state.queue.ids, ['r2'], 'r1 removed from queue');
  assert.deepEqual(data.body.state.rotation.sequence, ['r2'], 'r1 removed from rotation');
});
