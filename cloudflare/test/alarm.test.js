import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sampleState } from '../../api/test/helpers.mjs';

const origin = 'http://localhost:8787';
test('real DO alarm runs a persisted polling job with synthetic inference; rest timers survive restart and cancel', async t => {
  const persist = await mkdtemp(join(tmpdir(), 'gym-alarm-'));
  const options = { modules: await Promise.all(['test/fixture-worker.js', 'build/worker.js'].map(async name => ({ type: 'ESModule', path: resolve(name), contents: await readFile(name, 'utf8') }))), modulesRoot: resolve('.'),
    compatibilityDate: '2026-10-12', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { GYM: { className: 'TestGym', useSQLite: true } }, resourcePersistencePath: persist,
    bindings: { ORIGIN: origin, RP_ID: 'localhost', FIRST_USER_ADMIN: '1', PASSWORD_LOGIN: '1', AI_VALIDATION: '1', AI_OWNER_EMAIL: 'fixture@example.com' } };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(async () => { await mf.dispose(); await rm(persist, { recursive: true, force: true }); });
  let cookie;
  const req = async (method, path, body) => {
    const r = await mf.dispatchFetch(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': 'e30.' + Buffer.from(JSON.stringify({ email: 'fixture@example.com' })).toString('base64url') + '.x', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.headers.has('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await req('POST', '/api/register/password', { name: 'Alarm fixture', password: 'synthetic longer passphrase' })).status, 200);
  assert.equal((await req('POST', '/api/admin/coach/config', { enabled: true, provider: 'workers-ai', maxOutputTokens: 4096 })).status, 200);
  assert.equal((await req('PUT', '/api/data', { state: sampleState() })).status, 200);
  const queued = await req('POST', '/api/coach/review', {}); assert.equal(queued.status, 202, JSON.stringify(queued));
  assert.ok(queued.body.job.id);
  assert.equal((await req('POST', '/api/coach/review', {})).status, 409);
  let st;
  for (let i = 0; i < 100; i++) {
    st = await req('GET', '/api/coach/status'); if (!st.body.job) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(st.body.last?.outcome, 'nochange', JSON.stringify(st));
  assert.equal((await req('GET', '/__test/info')).body.calls, 1);
  const timer = await req('POST', '/api/push/rest-timer', { seconds: 120, deviceId: 'fixture-device' });
  assert.equal(timer.status, 200, JSON.stringify(timer));
  assert.equal((await req('GET', '/__test/info')).body.timers, 1);
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  assert.equal((await req('GET', '/__test/info')).body.timers, 1);
  assert.equal((await req('POST', '/api/push/rest-timer/cancel', { deviceId: 'fixture-device' })).status, 200);
  assert.equal((await req('GET', '/__test/info')).body.timers, 0);
  assert.equal((await req('GET', '/__test/info')).body.calls, 1);
  const b = await req('GET', '/api/cloudflare/budget'); assert.equal(b.status, 200); assert.equal(b.body.totalMicros, 5000000); assert.equal(b.body.attempts, 1);
  const rejected = await mf.dispatchFetch(origin + '/api/cloudflare/validation', { method: 'POST' }); assert.equal(rejected.status, 403);
  const wrongOrigin = await mf.dispatchFetch(origin + '/api/cloudflare/validation', { method: 'POST', headers: { Origin: 'https://evil.example', 'Cf-Access-Jwt-Assertion': 'e30.' + Buffer.from(JSON.stringify({ email: 'fixture@example.com' })).toString('base64url') + '.x' } });
  assert.equal(wrongOrigin.status, 403);
  const wrongOwner = await mf.dispatchFetch(origin + '/api/cloudflare/budget', { headers: { 'Cf-Access-Jwt-Assertion': 'e30.' + Buffer.from(JSON.stringify({ email: 'other@example.com' })).toString('base64url') + '.x' } });
  assert.equal(wrongOwner.status, 403);
  const started = await mf.dispatchFetch(origin + '/api/cloudflare/validation', { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Cf-Access-Jwt-Assertion': 'e30.' + Buffer.from(JSON.stringify({ email: 'fixture@example.com' })).toString('base64url') + '.x' } });
  assert.equal(started.status, 303);
  for (let i = 0; i < 100; i++) { const budget = await req('GET', '/api/cloudflare/budget'); if (budget.body.attempts >= 4) break; await new Promise(r => setTimeout(r, 30)); }
  assert.ok((await req('GET', '/api/cloudflare/budget')).body.attempts > 1, 'synthetic validation shares production ledger');
});
