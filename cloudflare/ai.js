import { SYSTEM_PROMPT } from '../api/coach/core/system-prompt.js';

export const MODEL = '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b';
export const MODELS = { [MODEL]: 80000, '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 24000 };
export const AI_PROVIDER = { label: 'Workers AI', runtime: 'Workers AI binding', binding: true, defaultModel: MODEL };

// The binding is optional. Never acquire credentials or enable billable inference here.
// This adapter supplies complete JSON to the existing validator and single repair loop.
export function workersAI(ai, reserve = () => {}) {
  return {
    id: 'workers-ai', spawns: false, needsRuntime: false,
    async check() {
      return ai ? { ok: true, version: 'Workers AI', models: Object.keys(MODELS) }
        : { ok: false, error: 'Workers AI binding is not configured' };
    },
    async invoke({ prompt, system, schema, model = MODEL, maxTokens = 4096, timeoutMs = 300000, signal }) {
      const failure = stderr => ({ code: 1, text: '', stderr });
      if (!ai) return failure('Workers AI binding is not configured');
      if (!MODELS[model || MODEL]) return failure('Unsupported Workers AI model');
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT + (system ? '\n\n' + system : '') },
        { role: 'user', content: prompt }
      ];
      const response_format = schema ? { type: 'json_schema', json_schema: schema } : { type: 'json_object' };
      const output = Math.min(8192, Math.max(1024, maxTokens));
      // UTF-8 bytes conservatively bound byte-BPE input tokens. Include schema and a
      // reserve for chat framing rather than guessing characters per token. Large
      // histories fail before inference; they are never silently clipped.
      const bytes = new TextEncoder().encode(JSON.stringify({ messages, response_format })).length;
      if (bytes + output + 1024 > MODELS[model || MODEL]) return failure('Coach context exceeds this model’s conservative context budget; reduce the history or use another provider');
      if (signal?.aborted) return failure('cancelled');
      try { reserve(); } catch { return failure('Workers AI invocation allowance exhausted or not configured'); }
      let timer, onAbort;
      try {
        const stopped = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
          onAbort = () => reject(new Error('cancelled'));
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        const result = await Promise.race([
          ai.run(model || MODEL, { messages, response_format, max_tokens: output, temperature: 0, stream: false }), stopped
        ]);
        const text = typeof result.response === 'string' ? result.response : JSON.stringify(result.response);
        if (!text) return failure('Workers AI returned no response');
        return { code: 0, text, stderr: '' };
      } catch (e) {
        // Provider errors may echo prompts. Do not return or log their raw messages.
        return { ...failure(e.message === 'timeout' ? 'timeout' : e.message === 'cancelled' ? 'cancelled' : 'Workers AI inference failed'), timedOut: e.message === 'timeout' };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
  };
}
