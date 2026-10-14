/* Read-only tokens (`Authorization: Bearer ogr_…`) for an outside integration: made, listed and
   revoked with a session; good for GET /api/data, GET /api/data/rev and GET /api/media/{hash}
   and refused with 403 everywhere else; gone the moment they are revoked, expire, or the profile
   signs out everywhere. Real server.js in a child, its Date.now() driven by test/fake-clock.mjs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import * as M from './media-samples.mjs';

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
const STATE = { _rev: 3, _wid: 'w3', unit: 'kg', routines: [{ id: 'r1', name: 'Full body', ex: [] }], workouts: [] };

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-readtok-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: USERS, creds: [], subs: [], invites: [] }));
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
  h.setNow = now => new Promise(resolve => {
    const done = m => { if (m && m.now === now) { child.off('message', done); resolve(); } };
    child.on('message', done);
    child.send({ now });
  });
  h.db = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  h.audit = () => fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  h.create = async (uid, body) => {
    const r = await h.req('POST', '/api/account/read-tokens', cookie(uid), body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  return h;
}

test('a token is shown once, stored as a hash, listed without it, and reads the profile', async t => {
  const h = await startServer(t);
  const { token, readToken } = await h.create('u_one', { name: 'Assistant' });
  assert.match(token, /^ogr_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(readToken).sort(), ['created', 'expires', 'id', 'lastUsed', 'name']);
  assert.equal(readToken.name, 'Assistant');
  assert.equal(readToken.expires, null);

  const raw = fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8');
  assert.ok(!raw.includes(token), 'the token itself never reaches db.json');
  const [row] = h.db().readTokens;
  assert.equal(row.h, crypto.createHash('sha256').update('opengym-read:' + token).digest('hex'));
  assert.equal(row.userId, 'u_one');

  const list = await h.req('GET', '/api/account/read-tokens', cookie('u_one'));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.tokens.map(x => x.id), [readToken.id]);
  assert.ok(!JSON.stringify(list.body).includes(token) && !JSON.stringify(list.body).includes(row.h));
  assert.deepEqual((await h.req('GET', '/api/account/read-tokens', cookie('u_two'))).body, { tokens: [] });

  const data = await h.req('GET', '/api/data', bearer(token));
  assert.equal(data.status, 200);
  assert.equal(data.body.rev, 3);
  assert.deepEqual(data.body.state.routines, STATE.routines);
  assert.deepEqual((await h.req('GET', '/api/data/rev', bearer(token))).body, { rev: 3, wid: 'w3' });
  assert.ok(h.db().readTokens[0].lastUsed, 'the list says when it was last used');
  assert.ok(h.audit().some(e => e.ev === 'auth.readtoken.create' && e.uid === 'u_one' && e.msg === 'Assistant'));

  // The profile's own media too, and only its own.
  const file = M.gif(2000), hash = M.sha(file);
  const up = await h.req('PUT', '/api/media/' + hash, { ...cookie('u_one'), 'Content-Type': 'image/gif' }, file);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const media = await h.req('GET', '/api/media/' + hash, bearer(token));
  assert.equal(media.status, 200);
  assert.deepEqual(media.body, file);
  const { token: other } = await h.create('u_two', { name: 'Theirs' });
  assert.equal((await h.req('GET', '/api/media/' + hash, bearer(other))).status, 404);
  assert.equal((await h.req('GET', '/api/data', bearer(other))).body.state, null);
});

test('every other route and method answers 403, and nothing is written', async t => {
  const h = await startServer(t);
  const { token } = await h.create('u_one', { name: 'Assistant' });
  const src = ['app.js', path.join('coach', 'routes-service.js')].map(f => fs.readFileSync(path.join(API, f), 'utf8')).join('\n');
  const keys = [...new Set([...src.matchAll(/^\s*'(GET|POST|PUT|DELETE) (\/api\/[^']*)':/gm)].map(m => `${m[1]} ${m[2]}`))];
  assert.ok(keys.length > 40, `only found ${keys.length} routes`);
  const allowed = new Set(['GET /api/data', 'GET /api/data/rev', 'GET /api/media/{hash}']);
  const refused = [...keys.filter(k => !allowed.has(k)), 'DELETE /api/data', 'PATCH /api/data', 'POST /api/data/rev', 'GET /api/nope'];
  for (const key of refused) {
    const [method, p] = key.split(' ');
    const r = await h.req(method, p.replace('{hash}', 'a'.repeat(64)), bearer(token),
      method === 'GET' ? undefined : { state: { unit: 'lb' }, baseRev: 3, name: 'x', code: 'x', id: 'u_two', disabled: true });
    assert.equal(r.status, 403, `${key} answered ${r.status}`);
    assert.deepEqual(r.body, { error: 'this token can only read', code: 'read-only' }, key);
  }
  // A token that does not exist is refused the same way: what a token may do is decided by its shape.
  assert.equal((await h.req('PUT', '/api/data', bearer('ogr_nothing'), { state: { unit: 'lb' } })).status, 403);

  const state = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'state-u_one.json'), 'utf8'));
  assert.equal(state._rev, 3);
  assert.equal(state.unit, 'kg');
  const db = h.db();
  assert.equal(db.readTokens.length, 1, 'a read token cannot make or revoke tokens');
  assert.ok(db.users.every(u => !u.disabled && !u.sv));
  assert.equal((await h.req('GET', '/api/data', bearer(token))).status, 200, 'still a working token');
});

test('revoking takes effect on the next request, and only the owner can revoke', async t => {
  const h = await startServer(t);
  const a = await h.create('u_one', { name: 'Assistant' });
  const b = await h.create('u_one', { name: 'Spreadsheet' });
  assert.equal((await h.req('GET', '/api/data', bearer(a.token))).status, 200);

  const foreign = await h.req('DELETE', '/api/account/read-tokens?id=' + a.readToken.id, cookie('u_two'));
  assert.equal(foreign.status, 404);
  assert.equal((await h.req('GET', '/api/data', bearer(a.token))).status, 200);

  const r = await h.req('DELETE', '/api/account/read-tokens?id=' + a.readToken.id, cookie('u_one'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tokens.map(x => x.id), [b.readToken.id]);
  assert.deepEqual(await h.req('GET', '/api/data', bearer(a.token)), { status: 401, body: { error: 'not signed in' } });
  assert.equal((await h.req('GET', '/api/data/rev', bearer(a.token))).status, 401);
  assert.equal((await h.req('GET', '/api/data', bearer(b.token))).status, 200, 'the other token is untouched');
  assert.equal((await h.req('DELETE', '/api/account/read-tokens?id=' + a.readToken.id, cookie('u_one'))).status, 404);
  assert.ok(h.audit().some(e => e.ev === 'auth.readtoken.revoke' && e.msg === 'Assistant'));
  assert.equal((await h.req('GET', '/api/data', bearer('ogr_' + 'x'.repeat(43)))).status, 401);
});

test('an expired token is refused and drops off the list', async t => {
  const h = await startServer(t);
  const T0 = Date.now();
  await h.setNow(T0);
  const expiresAt = new Date(T0 + DAY).toISOString();
  const { token, readToken } = await h.create('u_one', { name: 'For a day', expiresAt });
  assert.equal(readToken.expires, expiresAt);
  const forever = await h.create('u_one', { name: 'Forever' });

  await h.setNow(T0 + DAY - 1000);
  assert.equal((await h.req('GET', '/api/data', bearer(token))).status, 200);
  await h.setNow(T0 + DAY);
  assert.equal((await h.req('GET', '/api/data', bearer(token))).status, 401);
  assert.equal((await h.req('GET', '/api/data/rev', bearer(token))).status, 401);
  assert.equal((await h.req('GET', '/api/data', bearer(forever.token))).status, 200);
  const list = await h.req('GET', '/api/account/read-tokens', cookie('u_one'));
  assert.deepEqual(list.body.tokens.map(x => x.name), ['Forever']);

  for (const [body, code] of [
    [{ name: 'Past', expiresAt: new Date(T0).toISOString() }, 'expiry-invalid'],
    [{ name: 'Garbage', expiresAt: 'tomorrow' }, 'expiry-invalid'],
    [{ name: 'Too far', expiresAt: new Date(T0 + 11 * 365 * DAY).toISOString() }, 'expiry-invalid'],
    [{ name: '   ' }, 'name-required'],
    [{ name: 'x'.repeat(61) }, 'name-too-long']
  ]) {
    const r = await h.req('POST', '/api/account/read-tokens', cookie('u_one'), body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, code);
  }
  assert.equal((await h.req('POST', '/api/account/read-tokens', {}, { name: 'x' })).status, 401);
});

test('signing out everywhere revokes every token of the profile and nobody else\'s', async t => {
  const h = await startServer(t);
  const mine = await Promise.all([h.create('u_one', { name: 'A' }), h.create('u_one', { name: 'B' })]);
  const theirs = await h.create('u_two', { name: 'C' });
  assert.equal((await h.req('POST', '/api/logout/all', cookie('u_one'))).status, 200);
  for (const { token } of mine) assert.equal((await h.req('GET', '/api/data', bearer(token))).status, 401);
  assert.equal((await h.req('GET', '/api/data', bearer(theirs.token))).status, 200);
  assert.deepEqual((await h.req('GET', '/api/account/read-tokens', cookie('u_one', 1))).body, { tokens: [] });
  // A token made after the sign-out, under the new session version, works.
  const fresh = await h.req('POST', '/api/account/read-tokens', cookie('u_one', 1), { name: 'New' });
  assert.equal(fresh.status, 201);
  assert.equal((await h.req('GET', '/api/data', bearer(fresh.body.token))).status, 200);
});

test('session cookies and bearer session tokens are unaffected, and a profile has at most 20 tokens', async t => {
  const h = await startServer(t);
  assert.equal((await h.req('GET', '/api/data', cookie('u_one'))).status, 200);
  assert.equal((await h.req('GET', '/api/me', { Authorization: `Bearer ${mintSession('u_one')}` })).status, 200);
  const put = await h.req('PUT', '/api/data', { Authorization: `Bearer ${mintSession('u_one')}` }, { state: { ...STATE, unit: 'lb' }, baseRev: 3 });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  for (let i = 0; i < 20; i++) await h.create('u_one', { name: 'T' + i });
  const over = await h.req('POST', '/api/account/read-tokens', cookie('u_one'), { name: 'one too many' });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, 'read-token-limit');
  // Cross-origin creation is refused like any other state-changing cookie request.
  assert.equal((await h.req('POST', '/api/account/read-tokens', { ...cookie('u_two'), Origin: 'https://evil.example' }, { name: 'x' })).status, 403);
});
