import { post, ApiError, API_KEY } from "../api.js";
import { CHAINS, resolveChains } from "../chains.js";
import {
  result, errorResult, addr, num, WEIGHT_CAVEAT, CHAIN_COVERAGE_NOTES,
} from "../format.js";

// The backward walk aggregates only the entity types it is asked for, and the
// API's own default is ['gambling'] — far too narrow for "where did the money
// come from". Anything that can plausibly be an origin of funds is surfaced.
const SURFACE_CATEGORIES = [
  "cex", "exchange", "custodian", "dex", "bridge", "gambling", "mixer",
  "darknet", "scam", "phishing", "fraud", "ransomware", "sanction",
  "stolen", "hack", "exploit",
];

// A `done: false` answer is a partial walk. Continuing it costs one more call
// each and the results are cumulative, so a small number of automatic resumes
// buys a materially better answer without the model having to know about cursors.
const MAX_CONTINUES = Number(process.env.PUBLICAML_TRACE_CONTINUES || 2);

export const definition = {
  name: "trace_funds",
  title: "Trace where an address's money came from or went",
  description:
    "Follows the money one direction at a time.\n\n" +
    "`incoming` walks funding backwards: who paid this wallet. The trail stops " +
    "at labelled entities (it reports the exchange rather than walking into its " +
    "other customers) and at unlabelled addresses whose degree makes them a service.\n\n" +
    "`outgoing` follows the largest outgoing flows forward to where the money " +
    "left the anonymous part of the chain (exchange, OTC, mixer) and what is " +
    "still sitting in unlabelled dead ends. Outgoing tracing needs an API key.\n\n" +
    "This is a lead-generating tool, not exhaustive accounting: the walk is " +
    "bounded by wall clock, so a partial answer is returned rather than a " +
    "timeout, and 'nothing found' can mean 'the budget ran out'. The answer says " +
    "which one it was; report that honestly.",
  inputSchema: {
    type: "object",
    properties: {
      address: { type: "string", description: "The address to trace." },
      direction: {
        type: "string",
        enum: ["incoming", "outgoing"],
        description:
          "incoming = who funded this address (works without an API key). " +
          "outgoing = where its money went (requires an API key).",
      },
      chain: {
        type: "string",
        enum: CHAINS,
        description:
          "Required unless the address format identifies exactly one chain. A 0x " +
          "address is ambiguous between ethereum and bsc and must name its chain.",
      },
      max_hops: {
        type: "integer",
        minimum: 1,
        maximum: 8,
        description:
          "Default 5, 8 on bitcoin. On bitcoin one hop is HALF an economic step: " +
          "the graph runs address -> transaction -> address.",
      },
    },
    required: ["address", "direction"],
    additionalProperties: false,
  },
};

function tokensOf(row) {
  const toks = row?.tokens || row?.assets || [];
  return toks
    .map((t) => {
      const amount = t.amount ?? t.received ?? t.value ?? null;
      const sym = t.symbol || t.token || "?";
      return amount == null ? sym : `${num(amount, 4)} ${sym}`;
    })
    .slice(0, 4)
    .join(", ");
}

function renderIncoming(d, chain) {
  const out = [];
  const root = d.root || {};
  out.push(
    `Funding trace (backwards) for ${chain} ${d.address}` +
    (root.aml_score != null ? ` — subject scores ${num(root.aml_score, 1)}/100 (${root.risk_level || "?"})` : "")
  );

  const links = d.source_links || [];
  if (links.length) {
    out.push("Labelled funding sources, largest first:");
    for (const L of links.slice(0, 12)) {
      const who = L.name || L.label || addr(L.addresses?.[0]);
      const toks = tokensOf(L);
      out.push(
        `  - ${who} (${L.category || "uncategorised"}) at hop ${L.hop}` +
        (toks ? ` — ${toks}` : "") +
        (L.confidence != null ? ` [confidence ${L.confidence}]` : "")
      );
    }
  } else {
    out.push(
      "No labelled funding source was reached. That is not the same as 'funded " +
      "anonymously': the walk may have stopped at hubs or run out of budget."
    );
  }

  const hops = (d.hop_trace || []).filter((h) => h.label || h.category);
  if (hops.length) {
    out.push(
      "Named addresses on the path: " +
      hops.slice(0, 8).map((h) => `${h.label || h.category} (${addr(h.address)}, hop ${h.hop})`).join("; ")
    );
  }

  const ds = d.direct_sources || {};
  if (ds.returned_by_store != null) {
    out.push(
      `Direct funders: ${ds.shown ?? ds.returned_by_store} seen, ${ds.expanded ?? 0} walked back from` +
      (ds.truncated ? " (the direct-funder list itself was capped)" : "") + "."
    );
  }

  const scope = [];
  scope.push(`${d.hops_traced ?? "?"} hop(s) traced, ${d.nodes_visited ?? "?"} addresses visited`);
  if (d.hub_stops) scope.push(`${d.hub_stops} service-sized address(es) not expanded`);
  if (d.truncated) scope.push("hit the node ceiling");
  if (d.done === false) scope.push("walk INCOMPLETE — the time budget ran out before the graph was exhausted");
  out.push(`Scope: ${scope.join("; ")}.`);

  return out.join("\n");
}

function renderOutgoing(d, chain) {
  const out = [];
  out.push(`Forward trace for ${chain} ${d.address} — where the money went`);

  const cash = d.cashout_summary || [];
  if (cash.length) {
    out.push("Cash-out points, largest first:");
    for (const c of cash.slice(0, 12)) {
      const toks = tokensOf(c);
      out.push(
        `  - ${c.entity || "unnamed"} (${c.category || "uncategorised"})` +
        (toks ? ` — ${toks}` : "") +
        ` — ${c.hits} flow(s), first reached at hop ${c.first_hop}`
      );
    }
  } else {
    out.push("No labelled cash-out point was reached within the walk's budget.");
  }

  const hanging = d.hanging || [];
  if (hanging.length) {
    out.push(`${hanging.length} unlabelled dead end(s) holding funds — resting, not exited.`);
  }
  const moving = d.still_moving || [];
  if (moving.length) {
    out.push(`${moving.length} address(es) where the walk stopped on its own limits, not because the money stopped.`);
  }

  out.push(`Scope: ${d.hops_traced ?? "?"} hop(s) traced in ${d.elapsed_ms ?? "?"}ms.`);
  return out.join("\n");
}

export async function handler(args) {
  const address = String(args?.address || "").trim();
  const direction = args?.direction;
  if (!address) return errorResult("address is required.");
  if (direction !== "incoming" && direction !== "outgoing") {
    return errorResult("direction must be 'incoming' or 'outgoing'.");
  }

  const resolved = resolveChains(address, args?.chain);
  if (resolved.error) return errorResult(resolved.error);
  if (resolved.chains.length > 1) {
    return errorResult(
      `'${address}' could be on ${resolved.chains.join(" or ")}, which are different ` +
      "wallets. Tracing is too expensive to run on a guess: pass `chain` explicitly."
    );
  }
  const chain = resolved.chains[0];

  const body = { address, chain };
  if (args?.max_hops) body.max_hops = args.max_hops;

  try {
    if (direction === "outgoing") {
      const d = await post("/v1/trace", body);
      const note = CHAIN_COVERAGE_NOTES[chain];
      const text = [renderOutgoing(d, chain), WEIGHT_CAVEAT, note].filter(Boolean).join("\n\n");
      return result(text, d);
    }

    body.surface_categories = SURFACE_CATEGORIES;
    let d = await post("/v1/source-trace", body);
    let continued = 0;
    while (d.done === false && d.cursor && continued < MAX_CONTINUES) {
      const next = await post("/v1/source-trace", { address, chain, cursor: d.cursor });
      continued += 1;
      // source_links and nodes_visited are cumulative server-side; hop_trace is
      // the delta for the call, so it is the one thing that must be concatenated.
      next.hop_trace = [...(d.hop_trace || []), ...(next.hop_trace || [])];
      d = next;
    }

    const note = CHAIN_COVERAGE_NOTES[chain];
    const cont = continued ? `The walk was automatically continued ${continued} time(s).` : null;
    // No value_raw is printed on this path, so its caveat would be noise.
    const text = [renderIncoming(d, chain), cont, note].filter(Boolean).join("\n\n");
    return result(text, d);
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.kind === "unauthorized") {
        return errorResult(
          API_KEY
            ? `Outgoing tracing was refused: ${e.message}. The configured API key may be inactive.`
            : "Outgoing tracing (/v1/trace) requires an API key. Set PUBLICAML_API_KEY in the " +
              "MCP server config, or use direction='incoming', which works anonymously."
        );
      }
      return errorResult(`Trace failed (${e.kind}): ${e.message}`);
    }
    throw e;
  }
}
