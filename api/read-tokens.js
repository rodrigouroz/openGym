/* Long-lived read-only tokens, for an outside integration (an assistant) that reads a profile.
 *
 * Made by a signed-in profile, each with a name and an optional expiry, and sent as
 * `Authorization: Bearer ogr_…`. What one may do is decided by server.js before any route runs:
 * GET /api/data, GET /api/data/rev and GET /api/media/{hash}, nothing else. So:
 *
 *   - `ogr_` and 32 random bytes, base64url: the prefix is what tells it from a signed session
 *     token at the door, and 256 bits leave nothing to guess;
 *   - stored only as a SHA-256, like a device link: a copy of db.json holds no token that works.
 *     The token is random, so a slow hash would add nothing;
 *   - shown once, at creation; revoking one, or "sign out everywhere", removes the row, and the
 *     next request carrying it finds nothing.
 *
 * Pure bookkeeping on `db.readTokens`; the routes, the gate and the audit are server.js's. */
import crypto from 'node:crypto';

export const READ_TOKEN_PREFIX = 'ogr_';
export const MAX_READ_TOKENS = 20;
export const READ_TOKEN_NAME_MAX = 60;
// Ten years: "optional expiry" means a long-lived token is allowed, not one that outlives the format.
export const READ_TOKEN_MAX_TTL_MS = 10 * 365 * 86400000;

export const isReadToken = value => typeof value === 'string' && value.startsWith(READ_TOKEN_PREFIX);
export const hashReadToken = token => crypto.createHash('sha256').update('opengym-read:' + token).digest('hex');

const live = (t, now) => t && typeof t.h === 'string' && (t.exp == null || t.exp > now);
function prune(db, now) {
  db.readTokens = (db.readTokens || []).filter(t => live(t, now));
}

const publicRow = t => ({
  id: t.id, name: t.name, created: t.created,
  expires: t.exp == null ? null : new Date(t.exp).toISOString(),
  lastUsed: t.lastUsed || null
});

export function listReadTokens(db, userId, now = Date.now()) {
  prune(db, now);
  return db.readTokens.filter(t => t.userId === userId).map(publicRow);
}

// The name and the expiry a request asked for, or { error, code }. `expiresAt` is an ISO 8601
// date-time or absent/null for a token that does not expire.
export function readTokenRequest(body, now = Date.now()) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { error: 'a name is required', code: 'name-required' };
  if (name.length > READ_TOKEN_NAME_MAX) return { error: `the name can have at most ${READ_TOKEN_NAME_MAX} characters`, code: 'name-too-long' };
  if (body.expiresAt == null) return { name, exp: null };
  const exp = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
  if (!Number.isFinite(exp) || exp <= now || exp - now > READ_TOKEN_MAX_TTL_MS) {
    return { error: 'expiresAt must be a date-time in the future, at most ten years away', code: 'expiry-invalid' };
  }
  return { name, exp };
}

// → { token, row } or { error, code }. The token is returned once and never stored.
export function createReadToken(db, userId, { name, exp = null }, now = Date.now()) {
  prune(db, now);
  if (db.readTokens.filter(t => t.userId === userId).length >= MAX_READ_TOKENS) {
    return { error: `a profile can have at most ${MAX_READ_TOKENS} read-only tokens`, code: 'read-token-limit' };
  }
  const token = READ_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const row = {
    id: crypto.randomBytes(9).toString('base64url'), userId, name, h: hashReadToken(token),
    created: new Date(now).toISOString(), exp, lastUsed: null
  };
  db.readTokens.push(row);
  return { token, row: publicRow(row) };
}

// The live row a token belongs to, or null: a wrong token, a revoked one and an expired one all
// look the same from outside.
export function findReadToken(db, token, now = Date.now()) {
  if (!isReadToken(token)) return null;
  const h = Buffer.from(hashReadToken(token), 'hex');
  return (db.readTokens || []).find(t => {
    if (!live(t, now)) return false;
    const stored = Buffer.from(t.h, 'hex');
    return stored.length === h.length && crypto.timingSafeEqual(stored, h);
  }) || null;
}

// The token of this profile with that id, as the list shows it, once removed; null when there was none.
export function revokeReadToken(db, userId, id) {
  const row = (db.readTokens || []).find(t => t.userId === userId && t.id === id);
  if (!row) return null;
  db.readTokens = db.readTokens.filter(t => t !== row);
  return publicRow(row);
}

// Every token of a profile, for "sign out everywhere" and account deletion. Says whether
// anything went, so a caller can skip a save.
export function dropReadTokens(db, userId) {
  const before = (db.readTokens || []).length;
  db.readTokens = (db.readTokens || []).filter(t => t.userId !== userId);
  return db.readTokens.length !== before;
}
