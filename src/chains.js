// The four chains the API answers for. Anything else is rejected here rather
// than sent, so the caller gets a usable message instead of a 400 body.
export const CHAINS = ["bitcoin", "ethereum", "bsc", "tron"];

// Short forms the older clients use. The API accepts them, but normalising
// locally keeps our own detection and messages consistent.
const ALIASES = {
  eth: "ethereum", ether: "ethereum", ethereum: "ethereum", mainnet: "ethereum",
  btc: "bitcoin", bitcoin: "bitcoin", xbt: "bitcoin",
  bnb: "bsc", bsc: "bsc", binance: "bsc", "binance-smart-chain": "bsc", bep20: "bsc",
  trx: "tron", tron: "tron", trc20: "tron",
};

export function normalizeChain(chain) {
  if (!chain) return null;
  return ALIASES[String(chain).trim().toLowerCase()] || null;
}

// Which chains an address COULD belong to, by format alone.
//
// This is the single commonest integration bug and the reason the model is
// allowed to omit `chain`: one 0x address exists on ethereum, bsc and tron and
// is a different wallet on each. We never guess one of them — we screen the
// candidates and label every answer with its chain.
export function candidateChains(address) {
  const a = String(address || "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return ["ethereum", "bsc"];
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return ["tron"];
  if (/^(bc1|tb1)[0-9ac-hj-np-z]{6,87}$/i.test(a)) return ["bitcoin"];
  if (/^[13][1-9A-HJ-NP-Za-km-z]{25,39}$/.test(a)) return ["bitcoin"];
  return [];
}

// Resolve the chains to query. Explicit chain always wins; detection only fills
// a gap, and an unresolvable gap is an error, never a default.
export function resolveChains(address, chain) {
  if (chain) {
    const c = normalizeChain(chain);
    if (!c) {
      return { error: `unknown chain '${chain}'. Supported: ${CHAINS.join(", ")}.` };
    }
    return { chains: [c], inferred: false };
  }
  const cands = candidateChains(address);
  if (cands.length === 0) {
    return {
      error:
        `cannot tell which chain '${address}' belongs to. Pass chain explicitly ` +
        `(one of: ${CHAINS.join(", ")}).`,
    };
  }
  return { chains: cands, inferred: true };
}

export function shortAddr(a) {
  const s = String(a || "");
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}
