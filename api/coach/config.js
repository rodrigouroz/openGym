import fs from 'node:fs';
import { HTTP_PROVIDERS } from './core/providers.js';
export const PROVIDERS = {
  fixture: { label: 'Fixture (testing)', runtime: 'Fixture', apiKeyEnv: null, oauthEnv: null },
  // `apiKeyEnv` / `oauthEnv` name the variable jobEnv injects the credential as; the runtime
  // reads it from its environment and from nothing else, which is what makes the sanitised env
  // the only channel a credential can travel down. `claude setup-token` mints the long-lived
  // token that rides in CLAUDE_CODE_OAUTH_TOKEN — hence setupToken rather than a device login.
  claude: {
    label: 'Claude (Anthropic)', runtime: 'Claude Agent SDK',
    apiKeyEnv: 'ANTHROPIC_API_KEY', oauthEnv: 'CLAUDE_CODE_OAUTH_TOKEN', setupToken: true
  },
  // Codex keeps a refreshable login cache in $CODEX_HOME rather than taking a token on the
  // environment, so it is the one provider that needs somewhere durable to write. That
  // somewhere is CREDENTIAL_HOME — outside ./data, so `tar czf … data/` cannot capture it.
  codex: {
    label: 'Codex (OpenAI)', runtime: 'Codex CLI',
    apiKeyEnv: 'CODEX_API_KEY', oauthEnv: null, credentialHomeEnv: 'CODEX_HOME'
  },
  // The plain-HTTPS providers — Anthropic, OpenAI, Gemini and any OpenAI-compatible endpoint.
  // Described once in core/providers.js so the phone's picker and this table cannot disagree.
  // They spawn nothing and need no runtime in the image: the default api image runs them.
  ...HTTP_PROVIDERS
};

import { createCoachConfig } from './config-service.js';
export const { CREDENTIAL_HOME, COACH_DISABLED, MAX_MESSAGE_LEN_FLOOR, MAX_MESSAGE_LEN_CEILING, MAX_OUTPUT_TOKENS_FLOOR, MAX_OUTPUT_TOKENS_CEILING, encrypt, decrypt, load, save, reset, authFor, modelFor, optionsFor, boundUidFor, saveAuth, saveModel, saveOptions, profileAuthFile, loadProfileAuth, saveProfileAuth, clearProfileAuth, SHARED_ACCOUNT_REFUSAL, credentialFor, isPersonalCredential, bindInstanceCredential, accountFor, providerMeta, isEnabled, isConnected, publicConfig, jobEnv, logJob, lastError, lastSuccess } = createCoachConfig({ fs, env: process.env, providers: PROVIDERS });
