import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { softPasskey } from './passkey.mjs';

const origin = 'http://localhost:8787';
test('real Workers runtime: read-only tokens read, are refused everything else, persist, revoke and expire', async t => {
  const persist = await mkdtemp(join(tmpdir(), 'opengym-readtok-test-'));
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
    const r = await mf.dispatchFetch(origin + path, { method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie, Origin: origin } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  async function register(name) {
    const key = softPasskey();
    const opts = await req('POST', '/api/register/options', { body: { name } });
    const result = await req('POST', '/api/register/verify', { body: { cid: opts.body.cid, credential: key.attestation(opts.body.options.challenge) } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result;
  }
  const [owner, other] = [await register('Owner'), await register('Other')];
  const saved = await req('PUT', '/api/data', { cookie: owner.cookie, body: { state: { workouts: [], routines: [{ id: 'r1', name: 'Legs' }], unit: 'kg' }, baseRev: 0 } });
  assert.equal(saved.status, 200);
  const file = Buffer.concat([Buffer.from('GIF89a'), crypto.randomBytes(2000)]);
  const hash = crypto.createHash('sha256').update(file).digest('hex');
  assert.equal((await req('PUT', '/api/media/' + hash, { cookie: owner.cookie, body: file, headers: { 'Content-Type': 'image/gif' } })).status, 201);

  // Create: the token once, a hash in storage.
  const created = await req('POST', '/api/account/read-tokens', { cookie: owner.cookie, body: { name: 'Assistant' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { token, readToken } = created.body;
  assert.match(token, /^ogr_/);
  const listed = await req('GET', '/api/account/read-tokens', { cookie: owner.cookie });
  assert.deepEqual(listed.body.tokens.map(x => x.name), ['Assistant']);
  assert.ok(!JSON.stringify(listed.body).includes(token));

  // Read: the document, its revision and the profile's own media, after a restart of the object.
  await restart();
  const data = await req('GET', '/api/data', { token });
  assert.equal(data.status, 200);
  assert.deepEqual(data.body.state.routines, [{ id: 'r1', name: 'Legs' }]);
  assert.equal(data.body.rev, 1);
  assert.equal((await req('GET', '/api/data/rev', { token })).body.rev, 1);
  const media = await req('GET', '/api/media/' + hash, { token });
  assert.equal(media.status, 200);
  assert.deepEqual(media.body, file);

  // Everything else: 403, and nothing changes.
  const src = ['app.js', join('coach', 'routes-service.js')].map(f => readFileSync(resolve('..', 'api', f), 'utf8')).join('\n');
  const keys = [...new Set([...src.matchAll(/^\s*'(GET|POST|PUT|DELETE) (\/api\/[^']*)':/gm)].map(m => `${m[1]} ${m[2]}`))];
  const allowed = new Set(['GET /api/data', 'GET /api/data/rev', 'GET /api/media/{hash}']);
  const refused = [...keys.filter(k => !allowed.has(k)), 'DELETE /api/data', 'PATCH /api/data', 'GET /api/nope'];
  assert.ok(refused.length > 40);
  for (const key of refused) {
    const [method, path] = key.split(' ');
    const r = await req(method, path.replace('{hash}', hash), { token,
      body: method === 'GET' ? undefined : { state: { unit: 'lb' }, baseRev: 1, name: 'x' } });
    assert.equal(r.status, 403, `${key} answered ${r.status}`);
    assert.equal(r.body.code, 'read-only', key);
  }
  const after = await req('GET', '/api/data', { cookie: owner.cookie });
  assert.equal(after.body.rev, 1);
  assert.equal(after.body.state.unit, 'kg');
  assert.equal((await req('GET', '/api/media/' + hash, { cookie: owner.cookie })).status, 200);
  assert.equal((await req('GET', '/api/account/read-tokens', { cookie: owner.cookie })).body.tokens.length, 1);

  // Revoke: refused on the very next request, and still refused after a restart.
  assert.equal((await req('DELETE', '/api/account/read-tokens?id=' + readToken.id, { cookie: other.cookie })).status, 404);
  assert.equal((await req('DELETE', '/api/account/read-tokens?id=' + readToken.id, { cookie: owner.cookie })).status, 200);
  assert.equal((await req('GET', '/api/data', { token })).status, 401);
  await restart();
  assert.equal((await req('GET', '/api/data', { token })).status, 401);

  // Expire: good until its expiry, refused after it.
  const brief = await req('POST', '/api/account/read-tokens', { cookie: owner.cookie, body: { name: 'Brief', expiresAt: new Date(Date.now() + 2500).toISOString() } });
  assert.equal(brief.status, 201);
  assert.equal((await req('GET', '/api/data/rev', { token: brief.body.token })).status, 200);
  await sleep(3000);
  assert.equal((await req('GET', '/api/data/rev', { token: brief.body.token })).status, 401);
  assert.equal((await req('POST', '/api/account/read-tokens', { cookie: owner.cookie, body: { name: 'Past', expiresAt: new Date(Date.now() - 1000).toISOString() } })).body.code, 'expiry-invalid');

  // Sign out everywhere: every token of the profile goes, the other profile's stays.
  const kept = await req('POST', '/api/account/read-tokens', { cookie: other.cookie, body: { name: 'Kept' } });
  const lost = await req('POST', '/api/account/read-tokens', { cookie: owner.cookie, body: { name: 'Lost' } });
  assert.equal((await req('POST', '/api/logout/all', { cookie: owner.cookie, body: {} })).status, 200);
  assert.equal((await req('GET', '/api/data', { token: lost.body.token })).status, 401);
  assert.equal((await req('GET', '/api/data', { token: kept.body.token })).status, 200);
  assert.equal((await req('GET', '/api/data', { cookie: other.cookie })).status, 200, 'sessions of others unchanged');
});
