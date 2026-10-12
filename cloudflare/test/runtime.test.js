import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { softPasskey } from './passkey.mjs';

const origin = 'http://localhost:8787';
test('real Workers runtime: passkeys, first admin, sessions, large state, conflicts, restart and export', async t => {
  const persist = await mkdtemp(join(tmpdir(), 'opengym-worker-test-'));
  const options = {
    modules: true, scriptPath: resolve('build/worker.js'),
    compatibilityDate: '2026-10-12', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { GYM: { className: 'Gym', useSQLite: true } },
    resourcePersistencePath: persist,
    bindings: { ORIGIN: origin, RP_ID: 'localhost', FIRST_USER_ADMIN: '1', ALLOW_GUEST: '0', TRUST_PROXY: '1', PASSWORD_LOGIN: '1' }
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  const req = async (method, path, body, cookie, headers = {}) => {
    const r = await mf.dispatchFetch(origin + path, { method,
      headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  assert.equal((await req('GET', '/api/health')).status, 200);
  assert.equal((await req('GET', '/api/data')).status, 401);
  assert.equal((await req('PUT', '/api/data', { state: {} }, null, { Origin: 'https://evil.example' })).status, 403);
  async function register(name) {
    const key = softPasskey();
    const opts = await req('POST', '/api/register/options', { name });
    assert.equal(opts.status, 200);
    const result = await req('POST', '/api/register/verify', { cid: opts.body.cid, credential: key.attestation(opts.body.options.challenge) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { ...result, key };
  }
  const users = await Promise.all([register('Fixture A'), register('Fixture B')]);
  assert.equal(users.filter(x => x.body.user.admin).length, 1);
  const admin = users.find(x => x.body.user.admin);
  const ordinary = users.find(x => !x.body.user.admin);
  assert.equal((await req('GET', '/api/admin/users', undefined, ordinary.cookie)).status, 403);
  const state = { workouts: [], routines: [], futureField: '🏋️'.repeat(650000), resetAt: 123, resetIds: {} };
  const saved = await req('PUT', '/api/data', { state, baseRev: 0 }, admin.cookie);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.rev, 1);
  assert.equal((await req('GET', '/api/data', undefined, ordinary.cookie)).body.state, null);
  const oversized = await req('PUT', '/api/data', { state: { futureField: 'x'.repeat(5 * 1024 * 1024) } }, admin.cookie);
  assert.equal(oversized.status, 413);
  const attempts = await Promise.all(['one','two'].map(value => req('PUT', '/api/data', {
    state: { workouts: [], routines: [], winner: value }, baseRev: 1, baseWid: saved.body.wid
  }, admin.cookie)));
  assert.deepEqual(attempts.map(x => x.status).sort(), [200, 409]);
  const conflict = attempts.find(x => x.status === 409);
  assert.equal(conflict.body.state.resetAt, 123);
  const large = await req('PUT', '/api/data', { state }, admin.cookie);
  assert.equal(large.status, 200);
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions(options));
  const restored = await req('GET', '/api/data', undefined, admin.cookie);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.state.futureField, state.futureField);
  assert.equal(restored.body.state._wid, large.body.wid);
  const opts = await req('POST', '/api/login/options', {});
  const login = await req('POST', '/api/login/verify', { cid: opts.body.cid, credential: admin.key.assertion(opts.body.options.challenge) });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.user.id, admin.body.user.id);
  const exported = await req('GET', '/api/admin/user?id=' + admin.body.user.id, undefined, login.cookie);
  assert.equal(exported.status, 200);
  assert.equal((await req('POST', '/api/logout/all', {}, login.cookie)).status, 200);
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions(options));
  assert.equal((await req('GET', '/api/data', undefined, admin.cookie)).status, 401);
  assert.equal((await req('GET', '/api/data', undefined, login.cookie)).status, 401);
  assert.equal((await req('GET', '/api/data', undefined, ordinary.cookie)).status, 200);
  const password = 'synthetic correct horse battery';
  const pwUser = await req('POST', '/api/register/password', { name: 'Password fixture', password });
  assert.equal(pwUser.status, 200, JSON.stringify(pwUser.body));
  assert.equal((await req('POST', '/api/login/password', { name: 'Password fixture', password: 'wrong password' })).status, 401);
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions(options));
  const pwLogin = await req('POST', '/api/login/password', { name: 'Password fixture', password });
  assert.equal(pwLogin.status, 200, JSON.stringify(pwLogin.body));
  assert.equal(pwLogin.body.user.id, pwUser.body.user.id);

  // Stream a synthetic, signature-valid image across multiple SQLite chunks.
  const bytes = Buffer.alloc(1200000, 42); Buffer.from('GIF89a').copy(bytes);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const media = await mf.dispatchFetch(origin + '/api/media/' + hash, { method: 'PUT',
    headers: { Origin: origin, Cookie: pwLogin.cookie, 'Content-Type': 'image/gif' }, body: bytes });
  assert.equal(media.status, 201, await media.text());
  const foreign = await mf.dispatchFetch(origin + '/api/media/' + hash, { headers: { Cookie: ordinary.cookie } });
  assert.equal(foreign.status, 404);
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  const download = await mf.dispatchFetch(origin + '/api/media/' + hash, { headers: { Cookie: pwLogin.cookie } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('Content-Security-Policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  const badMedia = await mf.dispatchFetch(origin + '/api/media/' + '0'.repeat(64), { method: 'PUT',
    headers: { Origin: origin, Cookie: pwLogin.cookie, 'Content-Type': 'image/gif' }, body: bytes });
  assert.equal(badMedia.status, 400);
  const badBody = await badMedia.json(); assert.equal(badBody.code, 'hash-mismatch');
  assert.equal((await req('GET', '/api/push/public-key')).status, 200);

});
