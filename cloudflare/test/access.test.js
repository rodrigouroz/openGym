import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { checkAccess } from '../access.js';

const env = { ORIGIN: 'https://gym.example.com', ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', ACCESS_AUD: 'gym-audience' };
const request = token => new Request(env.ORIGIN + '/api/data', { headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} });

test('Access fails closed on missing settings, token, forged token and alternate hostname', async () => {
  assert.equal((await checkAccess(request(), { ORIGIN: env.ORIGIN })).status, 503);
  assert.equal((await checkAccess(request(), env)).status, 403);
  assert.equal((await checkAccess(request('forged'), env)).status, 403);
  assert.equal((await checkAccess(new Request('https://other.example/api/health'), env)).status, 403);
  assert.equal(await checkAccess(new Request('http://localhost:8787/api/health'), { ORIGIN: 'http://localhost:8787' }), null);
});

test('Access accepts a signed app JWT and rejects expired, wrong-audience, wrong-issuer and wrong-signature tokens', async t => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256' };
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'https://test-team.cloudflareaccess.com/cdn-cgi/access/certs');
    return Response.json({ keys: [jwk] });
  });
  const mint = (claims = {}, key = privateKey) => new SignJWT({ sub: 'owner', iss: 'https://' + env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD, exp: Math.floor(Date.now() / 1000) + 60, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(key);
  assert.equal(await checkAccess(request(await mint()), env), null);
  for (const claims of [{ exp: 1 }, { aud: 'another-app' }, { iss: 'https://another-team.cloudflareaccess.com' }]) {
    assert.equal((await checkAccess(request(await mint(claims)), env)).status, 403);
  }
  const other = await generateKeyPair('RS256');
  assert.equal((await checkAccess(request(await mint({}, other.privateKey)), env)).status, 403);
});
