// Reviewed 2026-10-12 against Workers AI token AND neuron prices. Values are
// nanodollars per token, rounded UP where the displayed USD price is rounded.
// Pin supported models; unknown or stale pricing fails closed. No free allowance
// is assumed because it is shared with other applications on the account.
export const PRICE_VALID_UNTIL = Date.parse('2026-11-12T00:00:00Z');
export const PRICE_CHECKED = '2026-10-12';
export const MODEL = '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b';
export const DECISION_MODEL = '@cf/cloudflare/clef-flash';
export const PRICES = {
  '@cf/meta/llama-4-scout-17b-16e-instruct': { context: 131000, inputNano: 270, outputNano: 851 },
  [DECISION_MODEL]: { context: 24576, inputNano: 39, outputNano: 0 },
  [MODEL]: { context: 80000, inputNano: 497, outputNano: 4882 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { context: 24000, inputNano: 294, outputNano: 2253 }
};
export const costMicros = (model, input, output) => {
  const p = PRICES[model];
  if (!p || ![input, output].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Unknown AI price');
  return Math.ceil((input * p.inputNano + output * p.outputNano) / 1000);
};
