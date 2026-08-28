import { shortAddr } from "./chains.js";

// Sentences that must travel with the numbers. Without them a model reads an
// aml_score as "share of dirty funds", adds up a breakdown that combines by
// MAX, or reports "not in our data" as "clean".
export const SCORE_CAVEAT =
  "aml_score is a RISK reading 0-100, not a share of funds, and its parts " +
  "combine by MAX, so the breakdown does not add up to it.";

export const NO_DATA_CAVEAT =
  "NOT FOUND is not a clean verdict: it means the address is absent from the " +
  "indexed data. Do not report it as low risk.";

export const USD_CAVEAT =
  "USD sums cover priced tokens only and can be inflated by low-liquidity or " +
  "spam tokens; treat them as an order of magnitude, not an accounting figure.";

export const WEIGHT_CAVEAT =
  "value_raw is a cross-token 18-decimal weight for ranking, not a coin amount; " +
  "never show it as an amount.";

// Chains whose risk coverage is not currently complete. A quiet answer there is
// weaker evidence than a quiet answer on ethereum or bitcoin, and saying so is
// cheaper than being wrong.
export const CHAIN_COVERAGE_NOTES = {
  bsc:
    "BSC risk data is being rebuilt; a LOW/absent result on bsc is weaker " +
    "evidence than on ethereum or bitcoin.",
};

export function num(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function usd(v) {
  const n = num(v, 0);
  return n === null ? null : `$${n}`;
}

export function line(...parts) {
  return parts.filter(Boolean).join(" | ");
}

export function addr(a) {
  return shortAddr(a);
}

// One MCP result: human-readable text plus the structured payload. The text is
// what the model actually reasons over, so it carries the caveats; the
// structure is there for clients that store or re-display the answer.
export function result(text, structured) {
  const out = { content: [{ type: "text", text }] };
  if (structured !== undefined) out.structuredContent = structured;
  return out;
}

export function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}
