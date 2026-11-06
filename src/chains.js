// The four graph chains: tracing and counterparties work on these. Anything
// else is rejected here rather than sent, so the caller gets a usable message
// instead of a 400 body.
export const CHAINS = ["bitcoin", "ethereum", "bsc", "tron"];

// screen_address also answers for Solana. There the API is label-only: the score
// comes from direct evidence (attribution, sanctions, freezes, incidents) and no
// risk is propagated, so a Solana address without its own evidence comes back
// `scored: false`, which is NOT a clean result.
export const SCREEN_CHAINS = [...CHAINS, "solana"];

// Short forms the older clients use. The API accepts them, but normalising
// locally keeps our own detection and messages consistent.
const ALIASES = {
  eth: "ethereum", ether: "ethereum", ethereum: "ethereum", mainnet: "ethereum",
  btc: "bitcoin", bitcoin: "bitcoin", xbt: "bitcoin",
  bnb: "bsc", bsc: "bsc", binance: "bsc", "binance-smart-chain": "bsc", bep20: "bsc",
  trx: "tron", tron: "tron", trc20: "tron",
  sol: "solana", solana: "solana", spl: "solana",
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
//
// Base58 shapes overlap (a legacy bitcoin address and a Solana key can both be
// 32-40 characters starting with 1 or 3), so the decoded length decides:
// a legacy bitcoin address is 25 bytes (version + hash + checksum), a Solana
// address is a 32-byte ed25519 key.
export function candidateChains(address, allowed = SCREEN_CHAINS) {
  const a = String(address || "").trim();
  let out = [];
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) out = ["ethereum", "bsc"];
  else if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) out = ["tron"];
  else if (/^(bc1|tb1)[0-9ac-hj-np-z]{6,87}$/i.test(a)) out = ["bitcoin"];
  else if (/^[1-9A-HJ-NP-Za-km-z]{25,44}$/.test(a)) {
    const n = base58Length(a);
    if (n === 25 && /^[13]/.test(a)) out = ["bitcoin"];
    else if (n === 32 && a.length >= 32) out = ["solana"];
  }
  return out.filter((c) => allowed.includes(c));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Decoded byte length of a base58 string (leading '1's are zero bytes), or -1.
export function base58Length(s) {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return -1;
    n = n * 58n + BigInt(v);
  }
  let bytes = 0;
  while (n > 0n) { n >>= 8n; bytes += 1; }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros += 1;
  return bytes + zeros;
}

// Resolve the chains to query. Explicit chain always wins; detection only fills
// a gap, and an unresolvable gap is an error, never a default.
//
// `allowed` is the tool's own chain list: screen_address passes SCREEN_CHAINS,
// the graph tools keep the default.
export function resolveChains(address, chain, allowed = CHAINS) {
  if (chain) {
    const c = normalizeChain(chain);
    if (!c) {
      return { error: `unknown chain '${chain}'. Supported: ${allowed.join(", ")}.` };
    }
    if (!allowed.includes(c)) {
      return {
        error:
          `${c} is supported by screen_address only; this tool works on ` +
          `${allowed.join(", ")}.`,
      };
    }
    return { chains: [c], inferred: false };
  }
  const cands = candidateChains(address, allowed);
  if (cands.length === 0) {
    const elsewhere = candidateChains(address, SCREEN_CHAINS);
    if (elsewhere.length) {
      return {
        error:
          `'${address}' looks like a ${elsewhere.join(" or ")} address, which this ` +
          `tool does not cover (it works on ${allowed.join(", ")}). Use screen_address.`,
      };
    }
    return {
      error:
        `cannot tell which chain '${address}' belongs to. Pass chain explicitly ` +
        `(one of: ${allowed.join(", ")}).`,
    };
  }
  return { chains: cands, inferred: true };
}

export function shortAddr(a) {
  const s = String(a || "");
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}
