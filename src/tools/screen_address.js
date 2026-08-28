import { post, ApiError } from "../api.js";
import { CHAINS, resolveChains, normalizeChain } from "../chains.js";
import {
  result, errorResult, addr, num, line,
  SCORE_CAVEAT, NO_DATA_CAVEAT, CHAIN_COVERAGE_NOTES,
} from "../format.js";

export const definition = {
  name: "screen_address",
  title: "Screen a crypto address for AML risk",
  description:
    "AML screening for one blockchain address: risk level and score, sanctions, " +
    "issuer freezes (Tether/Circle), what the address is (exchange, mixer, " +
    "gambling, bridge, personal wallet) and where its risk comes from. " +
    "Chains: bitcoin, ethereum, bsc, tron.\n\n" +
    "Read the answer this way: `sanctioned: true` is a blocking fact on its own, " +
    "independent of the score. The score is a risk reading 0-100, never a share " +
    "of the funds. An address absent from the data is reported as NOT FOUND and " +
    "must not be presented as clean.\n\n" +
    "Chain is part of the address's identity, not a hint: the same 0x address is " +
    "a different wallet on ethereum, bsc and tron. Pass `chain` when you know it; " +
    "if you omit it, every chain the format allows is screened and each result is " +
    "labelled with its chain.",
  inputSchema: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "The address to screen. Bitcoin, Ethereum/BSC (0x…) or Tron (T…).",
      },
      chain: {
        type: "string",
        enum: CHAINS,
        description:
          "Which chain the address belongs to. Omit only if you genuinely do not " +
          "know: the candidates implied by the address format are screened instead.",
      },
    },
    required: ["address"],
    additionalProperties: false,
  },
};

function renderFreeze(freeze) {
  if (!freeze || freeze.state !== "frozen") return null;
  const assets = (freeze.assets || [])
    .filter((a) => a.state === "frozen")
    .map((a) => `${a.token} by ${a.issuer}${a.frozen_at ? ` on ${String(a.frozen_at).slice(0, 10)}` : ""}`);
  if (!assets.length) return "Issuer freeze: active.";
  return (
    `Issuer freeze: ${assets.join("; ")}. This is the issuer's own on-chain action, ` +
    "not our assessment: the address can still receive those tokens but cannot send them."
  );
}

function renderSources(breakdown) {
  const src = (breakdown?.propagated_sources || []).filter((s) => Number(s.score) > 0);
  if (!src.length) return null;
  const top = src.slice(0, 5).map((s) => {
    // A generic src_label ("sanction") tells the reader nothing and makes three
    // different sources look like one row repeated; fall back to source + address.
    const generic = !s.src_label || s.src_label === s.category;
    const who = generic ? `${s.source || "unknown source"} ${addr(s.src)}` : s.src_label;
    return `${s.category} ${num(s.score, 0)} at ${s.hops} hop${s.hops === 1 ? "" : "s"} (${who})`;
  });
  const more = src.length > top.length ? `, +${src.length - top.length} more` : "";
  return `Risk sources: ${top.join("; ")}${more}.`;
}

function renderEntity(e) {
  const chain = normalizeChain(e.chain) || e.chain;
  const b = e.aml_score_breakdown || {};
  const out = [];

  out.push(`${chain} ${e.wallet_address} — ${e.risk_level} (aml_score ${num(e.aml_score, 1)}/100)`);

  if (e.sanctioned) {
    const s = e.sanction || {};
    const j = (s.jurisdictions || []).join(", ");
    out.push(
      `SANCTIONED — ${s.label || "sanction"}, source ${s.source || "unknown"}` +
      (j ? `, jurisdictions ${j}` : "") +
      ". This alone is a blocking fact, regardless of the score."
    );
  }

  out.push(line(
    `Identity: ${e.label || "no label"}`,
    e.category ? `category ${e.category}${e.category_confidence != null ? ` (conf ${e.category_confidence})` : ""}` : null,
    e.entity_role ? `role ${e.entity_role}${e.entity_role_source ? ` (${e.entity_role_source})` : ""}` : null
  ));

  const freeze = renderFreeze(e.freeze);
  if (freeze) out.push(freeze);

  if (b.non_wallet?.reason) {
    out.push(`Not a spendable wallet: ${b.non_wallet.reason}. Its risk is suppressed on purpose.`);
  }

  const exposure = [];
  if (b.direct_exposure != null) exposure.push(`direct ${num(b.direct_exposure, 0)}`);
  if (b.indirect_exposure != null) exposure.push(`indirect ${num(b.indirect_exposure, 0)}`);
  if (b.behavioral_risk != null) exposure.push(`behavioural ${num(b.behavioral_risk, 0)}`);
  if (exposure.length) {
    out.push(`Exposure: ${exposure.join(", ")}${b.exposure_direction ? ` (${b.exposure_direction})` : ""}.`);
  }

  const sources = renderSources(b);
  if (sources) out.push(sources);

  if (b.suppressed_sources?.count) {
    out.push(`${b.suppressed_sources.count} stored source(s) suppressed: ${b.suppressed_sources.reason}.`);
  }

  if (e.cluster_id) {
    out.push(`Cluster: ${e.cluster_id}${e.cluster_size ? ` (${num(e.cluster_size, 0)} addresses)` : ""}.`);
  }

  const note = CHAIN_COVERAGE_NOTES[chain];
  if (note && !e.sanctioned && Number(e.aml_score) === 0) out.push(note);

  return out.join("\n");
}

function renderNotFound(nf) {
  const chain = normalizeChain(nf.chain) || nf.chain;
  return `${chain} ${nf.wallet_address} — NOT FOUND (${nf.reason || "absent from the indexed data"}).`;
}

export async function handler(args) {
  const address = String(args?.address || "").trim();
  if (!address) return errorResult("address is required.");

  const resolved = resolveChains(address, args?.chain);
  if (resolved.error) return errorResult(resolved.error);

  let data;
  try {
    data = await post("/v1/enrich", {
      addresses: resolved.chains.map((chain) => ({ wallet_address: address, chain })),
      include: ["aml_score", "category"],
    });
  } catch (e) {
    if (e instanceof ApiError) return errorResult(`Screening failed (${e.kind}): ${e.message}`);
    throw e;
  }

  const blocks = [];
  if (resolved.inferred && resolved.chains.length > 1) {
    blocks.push(
      `No chain was given, so ${address} was screened on ${resolved.chains.join(" and ")}. ` +
      "These are different wallets that happen to share an address string; read each result separately."
    );
  }

  for (const e of data.entities || []) blocks.push(renderEntity(e));
  for (const nf of data.not_found || []) blocks.push(renderNotFound(nf));

  if (!blocks.length || (!(data.entities || []).length && !(data.not_found || []).length)) {
    blocks.push(`${address}: the API returned no result for this address.`);
  }

  const caveats = [SCORE_CAVEAT];
  if ((data.not_found || []).length) caveats.push(NO_DATA_CAVEAT);
  blocks.push(caveats.join(" "));

  return result(blocks.join("\n\n"), {
    address,
    chains_screened: resolved.chains,
    chain_inferred: resolved.inferred,
    entities: data.entities || [],
    not_found: data.not_found || [],
    request_id: data.request_id,
  });
}
