import { post, ApiError } from "../api.js";
import { SCREEN_CHAINS, resolveChains, normalizeChain } from "../chains.js";
import {
  result, errorResult, addr, num, line,
  SCORE_CAVEAT, NO_DATA_CAVEAT, CHAIN_COVERAGE_NOTES,
  isCommunityClaim, victimReportUrl,
} from "../format.js";

// How many incidents and victim claims are printed per address. The rest is
// counted ("and N more"), never silently dropped.
export const MAX_INCIDENTS = 5;
export const MAX_CLAIMS = 5;

// `incidents` is an add-on block: asking for it does not switch the score or the
// identity off, but naming them keeps the counterparties and source-of-funds
// blocks (the expensive half of the answer) out of a screening call.
const INCLUDE = ["risk", "axes", "incidents"];

export const definition = {
  name: "screen_address",
  title: "Screen a crypto address for AML risk",
  description:
    "AML screening for one blockchain address: risk level and score, sanctions, " +
    "issuer freezes (Tether/Circle), what the address is (exchange, mixer, " +
    "gambling, bridge, personal wallet), where its risk comes from, and the " +
    "incidents (hacks, scams, reports) it is named in, with its role in each. " +
    "Chains: bitcoin, ethereum, bsc, tron, solana (on solana the score uses " +
    "direct evidence only).\n\n" +
    "Read the answer this way: SANCTIONED is a blocking fact on its own, " +
    "independent of the score. The score is a risk reading 0-100, never a share " +
    "of the funds. NOT SCORED is not 0 and not clean. An address absent from " +
    "the data is reported as NOT FOUND and must not be presented as clean. A " +
    "line starting 'Reported by a victim (not confirmed…)' is one person's " +
    "report, not PublicAML's attribution: quote it as a report, never as who the " +
    "address is; likewise a 'community report, not confirmed' incident accuses " +
    "nobody.\n\n" +
    "If the user says they lost funds to this address, you may point them to " +
    "the victim-report form linked in the answer (the address is prefilled). " +
    "This server cannot file a report or change any label itself.\n\n" +
    "Chain is part of the address's identity, not a hint: the same 0x address is " +
    "a different wallet on ethereum, bsc and tron. Pass `chain` when you know it; " +
    "if you omit it, every chain the format allows is screened and each result is " +
    "labelled with its chain.",
  inputSchema: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description:
          "The address to screen. Bitcoin, Ethereum/BSC (0x…), Tron (T…) or Solana (base58). " +
          "Solana addresses are case-sensitive.",
      },
      chain: {
        type: "string",
        enum: SCREEN_CHAINS,
        description:
          "Which chain the address belongs to. Omit only if you genuinely do not " +
          "know: the candidates implied by the address format are screened instead.",
      },
    },
    required: ["address"],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------- identity

// Display order: blocking facts first, then what the address is, then shape.
const AXIS_ORDER = ["legal_status", "asset_control", "actor", "business", "account_type", "structure", "membership"];

function sourceOf(a) {
  const bits = [];
  if (a.source) bits.push(a.source);
  if (a.source_rank != null) bits.push(`rank ${a.source_rank}`);
  return bits.length ? ` (${bits.join(", ")})` : "";
}

function renderAxis(name, a) {
  if (name === "membership") {
    const size = a.members != null ? `, ${num(a.members, 0)} addresses` : "";
    return `membership ${a.category || "group"}${a.group_id ? ` ${a.group_id}` : ""}${size}${sourceOf(a)}`;
  }
  if (name === "business" && !a.category && a.brand) {
    return `business: venue ${a.brand.display_name || a.brand.name_key || "?"} (category not stated)`;
  }
  let s = `${name} ${a.category || "?"}`;
  if (a.role) s += `, role ${a.role}`;
  if (a.basis === "structural") s += " [graph shape, not an attribution]";
  s += sourceOf(a);
  return s;
}

function renderBrand(b) {
  if (!b) return null;
  const name = b.display_name || b.name_key;
  if (!name) return null;
  const bits = [`Venue: ${name}`];
  if (b.designated) bits.push("the venue itself is under an active designation");
  if (b.risk_score != null) bits.push(`venue risk ${num(b.risk_score, 0)}/100${b.reason?.kind ? ` (${b.reason.kind})` : ""}`);
  return bits.join(" — ") + ".";
}

function legalSanction(axes) {
  const ls = axes?.legal_status;
  if (ls && !isCommunityClaim(ls) && ls.category === "sanction") return ls;
  return null;
}

function renderSanction(e) {
  const axes = e.axes || {};
  const ls = legalSanction(axes);
  const direct = e.risk?.breakdown?.direct_attribution;
  if (!ls && direct?.category !== "sanction") return null;
  const d = ls?.designation || {};
  const what = d.entity_name || e.label || "sanction";
  const bits = [`SANCTIONED — ${what}`];
  if (d.authority || d.list) bits.push(`${[d.authority, d.list].filter(Boolean).join(" ")}`);
  bits.push(`source ${ls?.source || direct?.source || "unknown"}`);
  const j = ls?.jurisdictions || (d.jurisdiction ? [d.jurisdiction] : []);
  if (j.length) bits.push(`jurisdictions ${j.join(", ")}`);
  return bits.join(", ") + ". This alone is a blocking fact, regardless of the score.";
}

function renderFreeze(axes) {
  const ac = axes?.asset_control;
  if (!ac || isCommunityClaim(ac) || ac.category !== "issuer-freeze") return null;
  const assets = (ac.assets || [])
    .filter((a) => a.state === "frozen")
    .map((a) => `${a.token} by ${a.issuer}${a.frozen_at ? ` on ${String(a.frozen_at).slice(0, 10)}` : ""}`);
  if (!assets.length) return `Issuer freeze: active (${ac.source || "issuer"}).`;
  return (
    `Issuer freeze: ${assets.join("; ")}. This is the issuer's own on-chain action, ` +
    "not our assessment: the address can still receive those tokens but cannot send them."
  );
}

function renderIdentity(e) {
  const axes = e.axes || {};
  const label = e.label && !isCommunityClaim(e.label_basis) ? e.label : null;
  const parts = [];
  for (const name of AXIS_ORDER) {
    const a = axes[name];
    if (!a || isCommunityClaim(a)) continue;
    // Already said in full on its own line.
    if (name === "legal_status" && a.category === "sanction") continue;
    if (name === "asset_control" && a.category === "issuer-freeze") continue;
    parts.push(renderAxis(name, a));
  }
  const out = [];
  out.push(line(`Identity: ${label || "no label"}`, parts.length ? parts.join("; ") : "no attribution"));
  const brand = renderBrand(axes.business && !isCommunityClaim(axes.business) ? axes.business.brand : null);
  if (brand) out.push(brand);
  return out;
}

// ---------------------------------------------------------------- claims

// Victims' reports of who an address is. The `community_claims[]` block is the
// primary source; claims the API also folded into an empty label/axis are the
// same statements and are only used when the block is absent.
export function collectClaims(e) {
  const block = Array.isArray(e.community_claims) ? e.community_claims.filter(Boolean) : [];
  if (block.length) {
    return block.map((c) => ({
      category: c.category || null,
      stated_as: c.label || c.stated_as || null,
      url: c.url || null,
      report_ref: c.report_ref || null,
      confirmed: c.confirmed === true,
    }));
  }
  const seen = new Set();
  const out = [];
  const push = (x, category) => {
    const key = x.claim_id ?? x.report_ref ?? `${category}|${x.stated_as}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      category: category || null,
      stated_as: x.stated_as || null,
      url: x.url || null,
      report_ref: x.report_ref || null,
      confirmed: x.confirmed === true,
    });
  };
  for (const name of AXIS_ORDER) {
    const a = e.axes?.[name];
    if (isCommunityClaim(a)) push(a, a.category);
  }
  if (isCommunityClaim(e.label_basis)) push({ ...e.label_basis, stated_as: e.label_basis.stated_as || e.label }, null);
  return out;
}

export function renderClaims(e) {
  const claims = collectClaims(e);
  if (!claims.length) return [];
  const lines = claims.slice(0, MAX_CLAIMS).map((c) => {
    const head = c.confirmed
      ? "Reported by a victim (confirmed by a PublicAML curator)"
      : "Reported by a victim (not confirmed, does not affect the score)";
    const what = [c.category, c.stated_as ? `"${c.stated_as}"` : null].filter(Boolean).join(" ") || "report";
    const link = c.url || c.report_ref;
    return `${head}: ${what}${link ? ` — ${link}` : ""}`;
  });
  if (claims.length > MAX_CLAIMS) lines.push(`…and ${claims.length - MAX_CLAIMS} more victim report(s).`);
  return lines;
}

// ---------------------------------------------------------------- incidents

function incidentQualifier(i) {
  const notes = [];
  const community = i.stream === "community";
  const confirmed = i.status === "confirmed";
  if (community && !confirmed) notes.push("community report, not confirmed");
  else if (community) notes.push("community report, confirmed");
  else if (!confirmed && i.status) notes.push(`status ${i.status}`);
  if (i.role === "victim") notes.push("this address is the VICTIM, not accused");
  else if (i.link === "direct" && i.implicates_address === false && !(community && !confirmed)) {
    notes.push("does not implicate this address");
  }
  return notes;
}

function renderIncident(i) {
  const name = i.name || i.slug || "unnamed incident";
  const cat = i.category ? ` [${i.category}]` : "";
  const date = i.occurred_at ? `, ${String(i.occurred_at).slice(0, 10)}` : "";
  let how;
  if (i.link === "propagated") {
    const via = i.via?.address ? `${addr(i.via.address)}` : "a linked address";
    const hops = i.via?.hops != null ? ` ${i.via.hops} hop${i.via.hops === 1 ? "" : "s"} away` : "";
    how = `not named in it; funds link to ${via}${hops}`;
  } else {
    how = `role: ${i.role || "mentioned"}`;
  }
  const notes = incidentQualifier(i);
  const src = (i.sources || []).find((s) => s && s.url)?.url;
  return `  - ${name}${cat}${date} — ${how}${notes.length ? ` (${notes.join("; ")})` : ""}${src ? ` — ${src}` : ""}`;
}

export function renderIncidents(e) {
  const list = Array.isArray(e.incidents) ? e.incidents : [];
  const links = Array.isArray(e.incident_links) ? e.incident_links : [];
  const total = Math.max(list.length, links.length, Number(e.incidents_total) || 0);
  if (!total) return [];
  const out = ["Incidents:"];
  const shown = list.slice(0, MAX_INCIDENTS);
  for (const i of shown) out.push(renderIncident(i));
  // incident_links is the uncut index in the same order: name the ones the full
  // list did not carry by slug and role rather than dropping them.
  if (shown.length < MAX_INCIDENTS && links.length > list.length) {
    for (const L of links.slice(list.length, list.length + (MAX_INCIDENTS - shown.length))) {
      out.push(`  - ${L.slug}${L.role ? ` — role: ${L.role}` : L.link === "propagated" ? " — linked through funds" : ""}`);
      shown.push(L);
    }
  }
  if (total > shown.length) out.push(`  …and ${total - shown.length} more.`);
  return out;
}

// ---------------------------------------------------------------- risk

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

function headline(chain, e) {
  const r = e.risk || {};
  if (r.scored === false || r.score == null) {
    const why = r.unscorable_reason ? ` (${r.unscorable_reason})` : "";
    return `${chain} ${e.wallet_address} — NOT SCORED${why}. This is not a score of 0 and not a clean result.`;
  }
  return `${chain} ${e.wallet_address} — ${r.level || "?"} (risk score ${num(r.score, 1)}/100)`;
}

export function renderEntity(e) {
  const chain = normalizeChain(e.chain) || e.chain;
  const r = e.risk || {};
  const b = r.breakdown || {};
  const axes = e.axes || {};
  const out = [];

  out.push(headline(chain, e));
  if (r.unscorable_detail) out.push(r.unscorable_detail);
  if (r.scope) out.push(`Score scope: ${r.scope}${r.scope_detail ? ` — ${r.scope_detail}` : ""}.`);

  const sanction = renderSanction(e);
  if (sanction) out.push(sanction);

  out.push(...renderIdentity(e));
  out.push(...renderClaims(e));

  const freeze = renderFreeze(axes);
  if (freeze) out.push(freeze);

  if (b.non_wallet?.reason) {
    out.push(`Not a spendable wallet: ${b.non_wallet.reason}. Its risk is suppressed on purpose.`);
  }

  const exposure = [];
  if (b.direct_exposure != null) exposure.push(`direct ${num(b.direct_exposure, 0)}`);
  if (b.indirect_exposure != null) exposure.push(`indirect ${num(b.indirect_exposure, 0)}`);
  else if (r.scope === "direct_only") exposure.push("indirect not assessed");
  if (b.behavioral_risk != null) exposure.push(`behavioural ${num(b.behavioral_risk, 0)}`);
  if (exposure.length) {
    out.push(`Exposure: ${exposure.join(", ")}${b.exposure_direction ? ` (${b.exposure_direction})` : ""}.`);
  }

  const sources = renderSources(b);
  if (sources) out.push(sources);

  if (b.suppressed_sources?.count) {
    out.push(`${b.suppressed_sources.count} stored source(s) suppressed: ${b.suppressed_sources.reason}.`);
  }

  out.push(...renderIncidents(e));

  const note = CHAIN_COVERAGE_NOTES[chain];
  if (note && !sanction && Number(r.score) === 0) out.push(note);

  return out.join("\n");
}

function renderNotFound(nf) {
  const chain = normalizeChain(nf.chain) || nf.chain;
  return `${chain} ${nf.wallet_address} — NOT FOUND (${nf.reason || "absent from the indexed data"}).`;
}

// ---------------------------------------------------------------- handler

export async function handler(args) {
  const address = String(args?.address || "").trim();
  if (!address) return errorResult("address is required.");

  const resolved = resolveChains(address, args?.chain, SCREEN_CHAINS);
  if (resolved.error) return errorResult(resolved.error);

  let data;
  try {
    data = await post("/v2/enrich", {
      addresses: resolved.chains.map((chain) => ({ wallet_address: address, chain })),
      include: INCLUDE,
    });
  } catch (e) {
    if (e instanceof ApiError) return errorResult(`Screening failed (${e.kind}): ${e.message}`);
    throw e;
  }

  return result(renderScreening(address, resolved, data), {
    address,
    chains_screened: resolved.chains,
    chain_inferred: resolved.inferred,
    entities: data.entities || [],
    not_found: data.not_found || [],
    request_id: data.request_id,
  });
}

export function renderScreening(address, resolved, data) {
  const entities = data.entities || [];
  const notFound = data.not_found || [];
  const blocks = [];
  if (resolved.inferred && resolved.chains.length > 1) {
    blocks.push(
      `No chain was given, so ${address} was screened on ${resolved.chains.join(" and ")}. ` +
      "These are different wallets that happen to share an address string; read each result separately."
    );
  }

  for (const e of entities) blocks.push(renderEntity(e));
  for (const nf of notFound) blocks.push(renderNotFound(nf));

  if (!entities.length && !notFound.length) {
    blocks.push(`${address}: the API returned no result for this address.`);
  }
  if (data.degraded?.detail) blocks.push(`DEGRADED: ${data.degraded.detail}`);

  const caveats = [SCORE_CAVEAT];
  if (notFound.length) caveats.push(NO_DATA_CAVEAT);
  blocks.push(caveats.join(" "));

  // Where a victim can report this address. A link, not a write: this server
  // does not file reports or labels on anyone's behalf.
  const chains = entities.length
    ? [...new Set(entities.map((e) => normalizeChain(e.chain) || e.chain))]
    : resolved.chains;
  const links = chains.map((c) => victimReportUrl(c, address));
  blocks.push(
    "If the user lost funds to this address, they can file a victim report (address prefilled): " +
    links.join(" ; ") + ". Offer it only if relevant."
  );

  return blocks.join("\n\n");
}
