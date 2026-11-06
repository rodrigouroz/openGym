// Reviewed 2026-11-06 against Workers AI token AND neuron prices. Values are
// nanodollars per token, rounded UP where the neuron price at $0.011 / 1,000
// neurons exceeds the displayed USD price. Pin supported models; unknown or
// stale pricing fails closed. No free allowance is assumed because it is shared
// with other applications on the account.
export const PRICE_VALID_UNTIL = Date.parse('2026-12-06T00:00:00Z');
export const PRICE_CHECKED = '2026-11-06';
// Cloudflare stops this id on 2026-11-20. Keep its price so existing ledger
// receipts still resolve. New calls use MODEL.
export const RETIRED_MODEL = '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b';
export const MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const DECISION_MODEL = '@cf/cloudflare/clef-flash';
export const PRICES = {
  '@cf/meta/llama-4-scout-17b-16e-instruct': { context: 131000, inputNano: 270, outputNano: 851 },
  [DECISION_MODEL]: { context: 24576, inputNano: 39, outputNano: 0 },
  [RETIRED_MODEL]: { context: 80000, inputNano: 497, outputNano: 4882 },
  [MODEL]: { context: 256000, inputNano: 101, outputNano: 301 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { context: 24000, inputNano: 294, outputNano: 2253 }
};
export const costMicros = (model, input, output) => {
  const p = PRICES[model];
  if (!p || ![input, output].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Unknown AI price');
  return Math.ceil((input * p.inputNano + output * p.outputNano) / 1000);
};
