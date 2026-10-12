import { createRemoteJWKSet, jwtVerify } from 'jose';

const keys = new Map();
export async function checkAccess(request, env) {
  const url = new URL(request.url);
  if (url.origin !== env.ORIGIN) return new Response('Forbidden', { status: 403 });
  // This exception is limited to local HTTP development, never a deployed hostname.
  if (url.origin === 'http://localhost:8787') return null;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response('Access is not configured', { status: 503 });
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN)) return new Response('Invalid Access configuration', { status: 503 });
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return new Response('Forbidden', { status: 403 });
  try {
    if (!keys.has(issuer)) keys.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
    await jwtVerify(token, keys.get(issuer), { issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'sub'] });
    return null;
  } catch { return new Response('Forbidden', { status: 403 }); }
}
