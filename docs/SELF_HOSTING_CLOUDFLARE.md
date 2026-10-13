# Cloudflare Workers (optional)

Docker remains the default and supports every server feature. This optional target runs the
same HTTP API and Vite frontend on Workers, using one SQLite-backed Durable Object per
installation. It is intended for a small personal/household installation, not a public service.
No external server, D1 database or R2 bucket is needed.

## Supported scope

Passkey registration/login, sessions and revocation, multiple profiles, first-user admin,
invites, device links, workout synchronization, revision/write-id conflicts, reset stamps,
admin operations and the app's JSON import/export retain their existing routes and formats.
The exercise catalogue's bundled stills/animations are served as static assets.

| Feature | Workers target |
| --- | --- |
| Password login | Same optional `PASSWORD_LOGIN=1` and scrypt format as Docker |
| Server Coach | Existing create/refine/review/debrief, consent, validation, repair, caps, apply/revert and cohort logic; HTTP providers or optional Workers AI |
| Scheduled reviews | Durable Object alarms, including when no browser is connected |
| Custom images/videos | Existing validation, hashes, quotas and cleanup; streamed SQLite chunks |
| Web Push and reminders | Encrypted Web Push through fetch; persisted rest timers and alarm-driven reminders |
| CLI Coach providers | Docker only: Workers cannot spawn Codex/Claude processes or their sandboxes |
| Local-model prefix warmup | Docker only; Workers cannot reach a model on the owner's private LAN |
| Read-only filesystem MCP server | Runs separately against an exported/local filesystem copy; no remote MCP endpoint is added |

The Workers push transport accepts Chrome/FCM, Mozilla, Apple and Windows browser push
endpoints and rejects redirects. Other push services require extending its explicit allowlist.
Media uses a conservative 1 GB installation budget, with 128 MiB reserved for overhead plus
`MEDIA_MIN_FREE_MB` (512 MiB by default). This is deliberately below paid storage capacity;
account-wide quotas and SQL overhead can still exhaust storage first. JSON export does not
include uploaded media; use the existing ZIP export with photos/videos for a portable
media backup, or full-instance recovery.

Docker's filesystem, CLI providers, local-model warmup and deployment remain available.
This is a personal installation target: streaming media from SQLite and frequent reminder
alarms can incur storage, read and compute charges. It is not an unlimited media host.

## Optional Workers AI Coach

The default configuration has no AI binding and makes no model calls. After reviewing your
account's Workers AI pricing and approving an allowance, add these to the private Wrangler
configuration:

```json
"ai": { "binding": "AI" }
```

Set `COACH_AI_BUDGET_USD` in `vars` to an explicitly approved lifetime dollar allowance.
Absent or zero refuses inference. The durable SQLite ledger reserves the full model context
and requested maximum output before each binding call, including repairs, admin tests and
synthetic validation. It never resets with the day, restart, profile deletion or conversation
forgetting. Valid provider token receipts settle the estimate; missing, invalid, failed,
cancelled or ambiguous responses keep their full reservation. There is no automatic top-up.
Legacy call-count ledgers require reconciliation rather than silently resetting past usage.

Rates round upward from both published token and neuron prices, ignore shared free credits,
and expire after 30 days. This is an application allowance using the checked price book, not
an account billing limit or invoice guarantee: provider price changes, taxes, other services
and other applications are outside it. Review `cloudflare/pricing.js` against current official
pricing before deployment and before its expiry. Admin → Coach displays estimates, uncertain
reservations, remaining allowance and a low-balance warning. Increasing the total is a manual
operator decision requiring a fresh spending authorization.

Set `COACH_AI_ONLY=1` to offer only the budgeted binding provider, preventing HTTP providers
from spending through separate credentials. Without it, optional HTTP providers retain their
own credentials and existing job caps. `COACH_AI_DEFAULT=1` enables the binding only when no
Coach configuration exists; per-profile consent remains mandatory.

In Admin → Coach, enable Coach and select **Workers AI**, instance authentication mode,
and a model. The binding needs no API key. The adapter supports Llama 3.3 70B FP8 fast
(24k context), Llama 4 Scout (131k), and the default DeepSeek R1 Distill Qwen 32B (80k).
`COACH_AI_MODEL` explicitly selects a deployment default when no admin model is stored; there
is no automatic fallback. In live synthetic testing, DeepSeek exceeded the five-minute job
timeout, so validate your chosen model before relying on it. It uses native JSON schema mode,
then the existing strict response validator and at most one repair. Model quality and live
provider behavior should be checked with synthetic data before sharing workout history.
The normal consent flow remains mandatory for each profile.

Input bytes (including schema) conservatively bound tokens, with a framing/output reserve.
Large histories can exceed a model's budget and fail before any inference; they are never
silently truncated or sent to a different model. Output is capped at 8192 tokens per attempt.
The smaller model may reject complex create/repair prompts; choose the larger context model
or another HTTP provider explicitly. A binding call may continue after local cancellation or
timeout, so cancellation cannot guarantee a billing refund.

Jobs return a polling ID immediately and run from durable alarms, not `waitUntil`.
Queued jobs survive a restart. An interrupted running job is marked failed instead of being
replayed, because replay could bill twice. Completed job IDs are not re-executed by alarm
retries. Rest alerts are claimed before sending; a process failure at that point can lose an
alert rather than send it twice. Notification delivery itself is best effort, as with Docker.

### Bounded synthetic validation

`node cloudflare/scripts/smoke-ai.mjs --plan` prints a network-free plan. `--fixture`
runs the four create/refine/review/debrief scenarios against the repository's fake model.
Live checks use the actual deployment binding and **the same installation ledger**.
Temporarily set `AI_VALIDATION=1` and `AI_OWNER_EMAIL` to the exact Access owner's email in
private configuration. The outer Access JWT check remains mandatory. Only that owner can
open `/api/cloudflare/validation`; a same-origin POST starts one persisted, idempotent run.
Its isolated synthetic documents never read or modify real profiles. Four scenarios allow
at most eight inference attempts including repairs, with no automatic network retries.
Refresh reads progress without starting another run. Disable `AI_VALIDATION` after checking.
No REST test path with a separate spending ledger is provided.

At the conservatively rounded rates checked on 2026-10-12, eight full-context/output attempts
reserve at most **$0.638032**. These reservations consume the installation's approved total.
A valid token receipt can reduce that estimate; uncertainty never releases it. Existing
Workers and storage costs are separate. `/api/cloudflare/budget` exposes only budget metadata
to the configured, authenticated owner and can support an owner-authorized notification check.

### Optional decision-model observations

`AI_DECISION_OBSERVE=1` adds three synthetic Clef-flash triage observations after the
validation run. It is off by default and is not used on real profiles. The injected adapter
returns only `continue`, `full_review`, or `insufficient_data` probabilities; it never creates
plans, changes progression or loads, suppresses a review, or bypasses the validator. Invalid
and low-confidence answers remain rejected or uncertain. The same lifetime ledger reserves
before each call; the overall diagnostic run still allows at most eight attempts. A crash
claims the observation run without replaying paid requests.

Cloudflare's [Clef-flash documentation](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
specifies typed decisions, a 24,576-token context and input-only billing. The adapter uses
that smaller documented context, reserves at a rounded-up $0.039/M input rate, and rejects
oversized input locally so the service does not silently truncate it. These observations are
an evaluation aid, not a replacement for the generative Coach. Turn the flag off after evaluation.

### Browser and native-app access

The browser/PWA uses its own Access login cookie. The packaged native app's existing
remote pairing flow instead expects an Access service token (`frontend/src/lib/cf-access.js`).
A browser-only owner policy does not admit that flow. Provisioning a service credential
and policy is a separate security decision; this target does not create either or weaken
Access. Use the phone's browser/PWA for this configuration. Native device features and
remote pairing must not be claimed verified without testing the actual native client.

CLI runtimes, local-model warmup and filesystem MCP do not implement separate in-app
fitness actions. Routines, logging, statistics, progression and Coach's plan/review/debrief
flows use shared frontend/core code. The missing choices are subscription-backed CLI
providers, a private-LAN model backend, and an external LLM's live filesystem connection.
Workers AI is instance-funded; it does not provide per-profile subscription sign-in.

## Local development and checks

Use Node 22, matching the repository's CI:

```sh
npm ci --prefix api --omit=optional
npm ci --prefix frontend
npm ci --prefix cloudflare
npm run build --prefix frontend
node scripts/catalogue/stage-media.mjs frontend/dist
npm test --prefix cloudflare
npm run dev --prefix cloudflare
```

Open **http://localhost:8787** (the origin is intentional for passkeys). Local data is under
`cloudflare/.wrangler/`, separate from Docker's `data/`. The Workers tests use their own
temporary database and synthetic passkeys; they never contact production or import user data.
The test command bundles with Wrangler and exercises the actual workerd runtime, including
concurrent first-admin signup, large state, stale-write rejection, password/passkey authentication,
media, mocked AI jobs, durable alarms and restart persistence. No live AI or push service is contacted.

## Private deployment with Cloudflare Access

1. Sign in with your existing Cloudflare account (`npx wrangler whoami` from `cloudflare/`).
   Check your plan's Workers/Durable Objects quotas and pricing before deployment.
2. Create a **Self-hosted** Access application for the exact hostname, with no path restriction.
   Allow only the intended people via verified email identities. Use no Bypass or service-token
   policy for a browser-only private installation. Confirm that all paths and assets are protected.
3. Copy `cloudflare/wrangler.jsonc` to `cloudflare/wrangler.production.jsonc` (gitignored).
   Set `ORIGIN` to `https://gym.example.com`, `RP_ID` to `gym.example.com`, and add the
   Access application's audience tag as `ACCESS_AUD` and its team hostname as
   `ACCESS_TEAM_DOMAIN` (for example `my-team.cloudflareaccess.com`) inside `vars`.
   Add `routes: [{ "pattern": "gym.example.com", "custom_domain": true }]` at the top level.
   Set `account_id` if your login has multiple accounts. Keep personal values out of commits.
4. Keep **both** `workers_dev: false` and `preview_urls: false`. The Worker checks the exact
   origin and verifies the Access JWT signature, issuer, audience and expiry before serving
   the API **or** static assets. Missing Access configuration fails closed. Only the exact
   local HTTP origin above is exempt for development.
5. Build and stage media as above, then from `cloudflare/` run:

   ```sh
   npx wrangler deploy --config wrangler.production.jsonc --dry-run
   npx wrangler deploy --config wrangler.production.jsonc
   ```

6. Check unauthenticated requests to `/`, `/api/health`, and an asset cannot reach the app;
   check the signed-in owner's browser can reach it. Confirm no workers.dev/version URL is
   available. Create your passkey in the browser; do not use a test credential in production.
   `FIRST_USER_ADMIN=1` makes the first profile admin, so Access must be installed first.

Access and openGym authentication are separate: Access admits the owner to the private
site; an openGym passkey selects their profile. Signing out of one does not sign out of the other.

## Storage, backup and recovery

`api/app.js` is the existing API wrapped in a factory. `api/server.js` supplies the unchanged
Node filesystem and optional Coach services. The Workers entrypoint supplies a small,
synchronous storage adapter. It stores the existing secret, db.json (including its backup),
per-profile JSON, Coach records, media and audit log in SQLite; it does not use the Workers ephemeral filesystem
for account or workout persistence.

A document is split into 512 KiB binary chunks to stay below SQLite's row limit even for a
5 MiB profile. Replacement/deletion is transactional. All account and profile state belongs
to one Durable Object: the existing synchronous compare/write and first-admin checks remain
atomic across requests. Storage write failures abort the object so its mutable account cache
cannot continue after a failed save. Durable Object output gates hold responses until writes
are durable. A new runtime reads the same secret and database.

Use **Settings → Export** for portable workout JSON backups and retain them outside Cloudflare.
The existing import flow restores this format; passkeys and session secrets are not part of
that export. Full installation recovery uses the Durable Object's SQLite **Time Travel**
(backups cover the last 30 days). Record the namespace/object ID after first use, and follow
Cloudflare's recovery procedure. Do not delete the namespace, change its class name or change
`getByName('installation')`: each would detach the app from its stored accounts. Rolling back
Worker code does not roll back its data. An existing Docker `/data` directory is not imported
automatically, and Docker's filesystem backup command does not back up this deployment.

References:
- [Node HTTP integration](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/)
- [SQLite storage and Time Travel](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

- [Workers AI JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Durable alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
