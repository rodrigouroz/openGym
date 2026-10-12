/* Coach instance configuration — the one place that knows whether this instance offers the
   AI Coach at all, which provider drives it, and whose account pays for a job.

   Instance settings live in ./data/coach.json rather than the environment, because the whole
   point of the admin-dashboard flow is that enabling the Coach never requires editing a file
   or restarting the stack. The one env knob is COACH_DISABLED, which force-disables the
   feature regardless of what is stored — a fleet operator's kill switch, not a configuration
   step.

   Credentials have two shapes, and the difference is the whole reason this file is careful:

     instance  — one account, stored here, encrypted. The convenient default for the
                 single-profile instance most people run.
     profile   — one account per profile, stored in its own coach-auth-<uid>.json. What a
                 multi-profile instance must use, because an instance-level credential means
                 somebody's personal subscription is being spent by people who are not the
                 subscriber.

   openGym does not interpret any provider's terms on a self-hoster's behalf. It just makes
   the shape that doesn't need the interpretation available, and refuses the shape that does:
   in instance mode a *personal* credential (a Claude Code setup token, an OAuth login) binds
   to the first profile that uses it, and any other profile is refused rather than warned. A
   warning moves the decision onto whoever clicks past it — the same posture payload.js takes
   with its allowlist. An API key is the other shape: metered, issued for exactly this kind of
   use, and shared by every profile on the instance under the daily caps. */
import crypto from 'node:crypto';
import path from 'node:path';
import { baseUrlFor } from './core/providers.js';
import { MAX_OUTPUT_TOKENS } from './core/adapters/http.js';

// Per-installation services; Node and Workers supply storage and execution.
export function createCoachConfig({ fs, env: runtimeEnv, providers }) {
const PROVIDERS = providers;
const DATA = runtimeEnv.DATA_DIR || '/data';
const FILE = path.join(DATA, 'coach.json');

/* Where a provider runtime that manages its own credential cache is allowed to keep it.
 *
 * A sibling of ./data, never inside it, and that placement is the whole point. docs/SELF_HOSTING
 * tells people to back up with `tar czf … data/`; anything under ./data therefore ends up in
 * every backup archive an owner is told to make. A refresh token is not workout history — it is
 * a live credential that keeps working after the archive is copied to a laptop or a cloud drive.
 *
 * So the runtime gets its own mount, and the backup instructions stay true rather than being
 * quietly wrong about what they capture. */
const CREDENTIAL_HOME = runtimeEnv.COACH_CREDENTIAL_DIR || '/coach-auth';
const COACH_DISABLED = /^(1|true|yes|on)$/i.test(runtimeEnv.COACH_DISABLED || '');

// Providers this build can drive. `runtime` is what the adapter runs. Adding one is an adapter
// file plus a row here — nothing else in the codebase branches on provider identity. The real
// providers arrive with their adapters; this PR ships only the in-repo fixture, so an instance
// can be exercised end to end without an AI account.

const DEFAULTS = {
  enabled: false,
  provider: providers.fixture ? 'fixture' : Object.keys(providers)[0],
  authMode: 'instance',                              // 'instance' | 'profile'
  // Everything a provider owns is keyed by provider, so switching between them never throws
  // a key away — the one that was pasted for Anthropic is still there when you come back.
  auth: {},                                          // instance mode: { [provider]: { type, account, data:<encrypted>, connectedAt } }
  models: {},                                        // { [provider]: model id }
  providerOptions: {},                               // { [provider]: { baseUrl } }
  boundUid: {},                                      // instance mode: { [provider]: the profile its credential bound to }
  caps: { perProfileDaily: 10, instanceDaily: 0 },   // 0 = unlimited
  daily: null,                                       // { date, count }: jobs enqueued today across every profile
  // Anonymous medians across profiles that opt in ("compare with others"). Off by default: it
  // is the one feature where one person's numbers feed into what another person sees.
  community: false,
  // How long a chat/refine message or review note can be. Was a bare 1000 literal in three
  // different files (routes.js, jobs.js, payload.js) before this was configurable — see issue
  // #267. The admin route clamps a write to [MAX_MESSAGE_LEN_FLOOR, MAX_MESSAGE_LEN_CEILING];
  // payload.js's own MAX_NOTE_CHARS ceiling has to stay at or above the latter, or a raised
  // limit here would still get clipped back down at build().
  maxMessageLen: 1000,
  // The ceiling on one provider answer. A reasoning model — a DeepSeek V3/R1-class endpoint, or
  // a "thinking" Gemini/OpenAI model — counts its hidden reasoning against this, so a plan can be
  // cut off at the old 16000 constant even though the plan itself is short (one report spent
  // ~12k of the 16k thinking). The admin route clamps a write to [floor, ceiling]; the adapter's
  // own MAX_OUTPUT_TOKENS is the fallback for callers that configure nothing (the phone, warmup).
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  log: []
};
const MAX_MESSAGE_LEN_FLOOR = 200;
const MAX_MESSAGE_LEN_CEILING = 4000;
const MAX_OUTPUT_TOKENS_FLOOR = 1024;
const MAX_OUTPUT_TOKENS_CEILING = 65536;
const PER_PROVIDER = ['auth', 'models', 'providerOptions', 'boundUid'];
const isPlainObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const LOG_MAX = 100;

/* ---------- at-rest encryption ---------- */

let keyCache = null;
function key() {
  if (keyCache) return keyCache;
  // Read the secret lazily: server.js creates it at boot, and this module may be imported first.
  const secret = fs.readFileSync(path.join(DATA, 'secret'), 'utf8').trim();
  keyCache = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from('opengym-coach-v1'), 32));
  return keyCache;
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
  try {
    const buf = Buffer.from(String(blob || ''), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }   // wrong key (restored ./data without the secret), or tampered file
}

/* ---------- load / save ---------- */

let cache = null;
function atomicWrite(file, content, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}
function load() {
  if (cache) return cache;
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* absent = feature off */ }
  cache = { ...DEFAULTS, ...stored, caps: { ...DEFAULTS.caps, ...(stored.caps || {}) } };

  // Until v1.2.11 this file held ONE credential, ONE model and ONE binding — for whichever
  // provider was selected at the time. Lift each onto that provider. One-way on purpose: a
  // downgrade will not read the maps back, which costs the owner one paste of the key.
  const legacy = PROVIDERS[stored.provider] ? stored.provider : null;
  if (stored.auth && stored.auth.data) cache.auth = legacy ? { [legacy]: stored.auth } : {};
  if (typeof stored.model === 'string' && stored.model) {
    cache.models = { ...(legacy ? { [legacy]: stored.model } : {}), ...(isPlainObj(stored.models) ? stored.models : {}) };
  }
  if (typeof stored.boundUid === 'string') cache.boundUid = legacy ? { [legacy]: stored.boundUid } : {};
  delete cache.model;
  // Every per-provider map holds only providers this build knows. That drops a retired
  // provider's leftovers and, because the keys are checked against the table, anything a
  // hand-edited file might smuggle in as a key.
  for (const k of PER_PROVIDER) {
    const src = isPlainObj(cache[k]) ? cache[k] : {};
    const clean = {};
    for (const p of Object.keys(src)) if (Object.prototype.hasOwnProperty.call(PROVIDERS, p)) clean[p] = src[p];
    cache[k] = clean;
  }
  // A retired provider must not leave the admin page with no chip selected.
  if (!PROVIDERS[cache.provider]) cache.provider = DEFAULTS.provider;
  if (cache.authMode !== 'profile') cache.authMode = 'instance';
  return cache;
}
function save(patch) {
  const next = { ...load(), ...patch };
  cache = next;
  atomicWrite(FILE, JSON.stringify(next, null, 2), 0o600);
  return next;
}
// Test seam: forget the in-memory copy so the next load() re-reads from disk.
function reset() { cache = null; keyCache = null; }

/* ---------- what one provider owns ----------
   The only way the rest of the code reads the per-provider maps, so the shape stays here. */
const authFor = (cfg = load(), p = cfg.provider) => (cfg.auth && cfg.auth[p]) || null;
const modelFor = (cfg = load(), p = cfg.provider) => (cfg.models && cfg.models[p]) || (PROVIDERS[p] && PROVIDERS[p].defaultModel) || null;
const optionsFor = (cfg = load(), p = cfg.provider) => (cfg.providerOptions && cfg.providerOptions[p]) || {};
const boundUidFor = (cfg = load(), p = cfg.provider) => (cfg.boundUid && cfg.boundUid[p]) || null;
function saveAuth(provider, auth) {
  const cfg = load();
  const next = { ...cfg.auth };
  if (auth) next[provider] = auth; else delete next[provider];
  // boundUid resets with the credential: a new account has not been spent by anyone yet.
  const bound = { ...cfg.boundUid }; delete bound[provider];
  return save({ auth: next, boundUid: bound });
}
function saveModel(provider, model) {
  const next = { ...load().models };
  if (model) next[provider] = model; else delete next[provider];
  return save({ models: next });
}
function saveOptions(provider, patch) {
  const all = { ...load().providerOptions };
  all[provider] = { ...(all[provider] || {}), ...patch };
  return save({ providerOptions: all });
}

/* ---------- per-profile credentials ---------- */

/* Deliberately its own file rather than a field on state-<uid>.json. Profile state syncs across
   devices and travels in the user's JSON export; a credential that rides along in a backup is
   the same class of mistake as a token inside the directory the README tells you to archive. */
const uidSafe = uid => /^[A-Za-z0-9_-]{1,64}$/.test(String(uid || ''));
function profileAuthFile(uid) {
  if (!uidSafe(uid)) throw new Error('bad profile id');
  return path.join(DATA, `coach-auth-${uid}.json`);
}
function loadProfileAuth(uid) {
  try { return JSON.parse(fs.readFileSync(profileAuthFile(uid), 'utf8')); } catch { return null; }
}
function saveProfileAuth(uid, auth) {
  atomicWrite(profileAuthFile(uid), JSON.stringify(auth, null, 2), 0o600);
  return auth;
}
function clearProfileAuth(uid) {
  try { fs.unlinkSync(profileAuthFile(uid)); return true; } catch { return false; }
}

/* ---------- which credential pays for this job ---------- */

const SHARED_ACCOUNT_REFUSAL =
  'This instance is configured with a single shared account. Ask your admin to enable per-profile sign-in.';

/**
 * Resolve the credential for one profile, or say why there isn't one. Never throws and never
 * returns a token to a caller that only asked whether a job may run: `auth` is the decrypted
 * payload and is only ever handed to jobEnv().
 *
 * Refusals are terminal by design (Duarte, PR-1 constraints): no job is enqueued, rather than a
 * job that runs on somebody else's subscription behind a dismissible warning.
 */
function credentialFor(uid) {
  const cfg = load();
  if (providerMeta(cfg).binding) return cfg.authMode === 'instance'
    ? { ok: true, auth: null, mode: 'instance' } : { ok: false, reason: 'no-credential', mode: cfg.authMode };
  if (cfg.provider === 'fixture') return { ok: true, auth: null, mode: cfg.authMode };

  if (cfg.authMode === 'profile') {
    const rec = loadProfileAuth(uid);
    const auth = rec && rec.data ? decrypt(rec.data) : null;
    if (!auth || !auth.token) return { ok: false, reason: 'no-credential', mode: 'profile' };
    return { ok: true, auth, type: rec.type, account: rec.account || null, mode: 'profile' };
  }

  // instance mode
  const bound = boundUidFor(cfg);
  if (bound && bound !== uid) {
    return { ok: false, reason: 'shared-account', message: SHARED_ACCOUNT_REFUSAL, mode: 'instance' };
  }
  const rec = authFor(cfg);
  const auth = rec && rec.data ? decrypt(rec.data) : null;
  if (!auth || !auth.token) {
    // An endpoint that takes no key (a model on the LAN) is connected without one. Only when
    // nothing was ever filed — a filed key that fails to decrypt is still a failure.
    if (providerMeta(cfg).keyOptional && !rec) return { ok: true, auth: null, type: null, account: null, mode: 'instance' };
    return { ok: false, reason: 'no-credential', mode: 'instance' };
  }
  return { ok: true, auth, type: rec.type, account: rec.account || null, mode: 'instance' };
}

/* Which credential types are one person's *subscription* — a Claude Code setup token or an
   OAuth login — as opposed to an API key, which is metered, pay-per-use, and issued precisely
   so that software can call the provider on behalf of many people. The binding below exists
   for the first kind: spending someone's personal subscription from another profile is what
   the provider terms forbid. An API key is what an admin pastes so their household can use the
   Coach; binding it to whoever happened to click first would just look broken, and the daily
   caps are what bound its spend. */
const isPersonalCredential = type => type === 'cli-token' || type === 'oauth';

/** First profile to actually spend the instance credential binds it — a personal credential
 *  only; an API key is shared by every profile on the instance. */
function bindInstanceCredential(uid) {
  const cfg = load();
  const rec = authFor(cfg);
  if (cfg.authMode === 'instance' && !boundUidFor(cfg) && cfg.provider !== 'fixture' && rec && isPersonalCredential(rec.type)) {
    save({ boundUid: { ...cfg.boundUid, [cfg.provider]: uid } });
  }
}

/** Whose account a profile is about to spend — rendered in the UI, never a secret. */
function accountFor(uid) {
  const cfg = load();
  const c = credentialFor(uid);
  return {
    mode: cfg.authMode,
    provider: cfg.provider,
    providerLabel: providerMeta(cfg).label,
    account: c.ok ? (c.account || null) : null,
    connected: !!c.ok,
    reason: c.ok ? null : c.reason,
    message: c.ok ? null : (c.message || null)
  };
}

/* ---------- derived state ---------- */

const providerMeta = cfg => PROVIDERS[(cfg || load()).provider] || PROVIDERS.fixture || Object.values(PROVIDERS)[0];

/** Is the feature switched on at all (before asking whether it can reach a model)? */
function isEnabled() {
  if (COACH_DISABLED) return false;
  const cfg = load();
  return !!cfg.enabled && !!PROVIDERS[cfg.provider];
}

/** Can this instance reach a model for anybody? Per-profile mode is connected once it is chosen:
 *  whether a given profile has signed in is that profile's question, answered by credentialFor. */
function isConnected() {
  const cfg = load();
  if (!isEnabled()) return false;
  if (providerMeta(cfg).binding) return cfg.authMode === 'instance';
  if (cfg.provider === 'fixture') return true;
  if (cfg.authMode === 'profile') return true;
  const rec = authFor(cfg);
  if (!rec) return !!providerMeta(cfg).keyOptional && !!baseUrlFor(cfg.provider, cfg);
  return !!decrypt(rec.data);
}

/** What /api/config tells every client. Absent ⇒ no Coach UI exists anywhere (FR-55/56). */
function publicConfig() {
  if (!isEnabled() || !isConnected()) return null;
  const cfg = load();
  return { enabled: true, provider: cfg.provider, providerLabel: providerMeta(cfg).label, authMode: cfg.authMode, community: !!cfg.community };
}

/**
 * The environment a job's provider process gets. Deliberately built from nothing rather than
 * filtered from env: the child must not inherit RP_ID, ADMIN_UIDS, VAPID material or
 * anything else this server happens to hold. The credential is passed in already resolved, so
 * this function never decides whose account is being spent.
 */
function jobEnv(jobDir, resolved) {
  const cfg = load();
  const meta = providerMeta(cfg);
  const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: jobDir, TMPDIR: jobDir };
  const auth = resolved && resolved.auth;
  if (auth && auth.token) {
    const name = (resolved.type === 'cli-token' || resolved.type === 'oauth') ? meta.oauthEnv
      : resolved.type === 'apikey' ? meta.apiKeyEnv : null;
    if (name) env[name] = auth.token;
  }
  // A provider whose runtime keeps its own credential cache needs a home that survives the job,
  // because HOME is a temp dir that dies with it. It is deliberately NOT under ./data — see
  // CREDENTIAL_HOME — so the documented backup of ./data cannot pick up a live refresh token.
  if (meta.credentialHomeEnv) env[meta.credentialHomeEnv] = CREDENTIAL_HOME;
  return env;
}

/* ---------- instance-level job log (counts and outcomes only, never contents — FR-12/42) ---------- */

function logJob(entry) {
  const cfg = load();
  const log = [...(cfg.log || []), entry].slice(-LOG_MAX);
  save({ log });
}
const lastError = () => [...(load().log || [])].reverse().find(e => e.outcome === 'failed') || null;
const lastSuccess = () => [...(load().log || [])].reverse().find(e => e.outcome === 'ready' || e.outcome === 'nochange') || null;

return { CREDENTIAL_HOME, COACH_DISABLED, MAX_MESSAGE_LEN_FLOOR, MAX_MESSAGE_LEN_CEILING, MAX_OUTPUT_TOKENS_FLOOR, MAX_OUTPUT_TOKENS_CEILING, encrypt, decrypt, load, save, reset, authFor, modelFor, optionsFor, boundUidFor, saveAuth, saveModel, saveOptions, profileAuthFile, loadProfileAuth, saveProfileAuth, clearProfileAuth, SHARED_ACCOUNT_REFUSAL, credentialFor, isPersonalCredential, bindInstanceCredential, accountFor, providerMeta, isEnabled, isConnected, publicConfig, jobEnv, logJob, lastError, lastSuccess, PROVIDERS };
}
