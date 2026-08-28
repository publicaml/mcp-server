import { post, ApiError } from "../api.js";
import { CHAINS, resolveChains } from "../chains.js";
import { result, errorResult, addr, num, usd, USD_CAVEAT, CHAIN_COVERAGE_NOTES } from "../format.js";

const KINDS = ["personal", "venue", "hub", "deposit_wallet", "contract", "mint_burn", "unknown"];

export const definition = {
  name: "list_counterparties",
  title: "List who an address transacted with",
  description:
    "Who a wallet dealt with and for how much, in one of three modes:\n\n" +
    "`classify` — enumerate the counterparties and say what each one IS: a " +
    "person, a venue (exchange/service), a hub, a deposit address, a contract " +
    "or a mint/burn pseudo-address. This is the mode for 'which ordinary people " +
    "funded this wallet'. An unlabelled counterparty is NOT thereby a person; " +
    "that is what this mode's degree probe decides.\n" +
    "`category` — did this wallet touch any exchange / mixer / gambling site / " +
    "bridge at all.\n" +
    "`check` — you already have suspect addresses and want to know whether this " +
    "wallet dealt with them, and for how much. Addresses with no recorded " +
    "interaction are simply absent from the answer.\n\n" +
    "The list is ranked and capped, so a `partial` answer is a floor, not the " +
    "complete set, and a degree figure is a lower bound measured in a window.",
  inputSchema: {
    type: "object",
    properties: {
      address: { type: "string", description: "The wallet whose counterparties to look at." },
      chain: { type: "string", enum: CHAINS, description: "Required unless the address format identifies exactly one chain." },
      mode: {
        type: "string",
        enum: ["classify", "category", "check"],
        description: "Which question you are asking. The modes do not combine.",
      },
      kinds: {
        type: "array",
        items: { type: "string", enum: KINDS },
        description: "`classify` mode: which classes to return. Default: all of them.",
      },
      category: {
        type: "string",
        description: "`category` mode: the entity type to look for — cex, mixer, gambling, bridge, darknet, …",
      },
      addresses: {
        type: "array",
        items: { type: "string" },
        maxItems: 100,
        description: "`check` mode: the candidate counterparty addresses to test.",
      },
      direction: {
        type: "string",
        enum: ["in", "out", "both"],
        description: "`classify` mode. 'in' (default) = who paid this address.",
      },
      rank_by: {
        type: "string",
        enum: ["value", "tx_count"],
        description:
          "'value' (default) weighs token units with no price attached, so a memecoin " +
          "sender can outrank an ETH sender. Use 'tx_count' when that would mislead.",
      },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 25." },
      since: { type: "string", description: "Restrict to a window. ISO date ('2026-06-21') or epoch seconds." },
      until: { type: "string" },
    },
    required: ["address", "mode"],
    additionalProperties: false,
  },
};

function renderRow(c) {
  const bits = [addr(c.address)];
  if (c.kind) bits.push(c.kind);
  if (c.label) bits.push(c.label);
  else if (c.category) bits.push(c.category);
  if (c.sanctioned) bits.push("SANCTIONED");
  if (c.risk_level) bits.push(`${c.risk_level} ${num(c.aml_score, 0) ?? "?"}`);

  const money = [];
  if (c.received_usd) money.push(`received ~${usd(c.received_usd)}`);
  if (c.sent_usd) money.push(`sent ~${usd(c.sent_usd)}`);
  const toks = (c.tokens || []).slice(0, 3).map((t) => {
    const sym = t.symbol || `token ${addr(t.token)}`;
    const parts = [];
    if (t.received) parts.push(`+${num(t.received, 4)}`);
    if (t.sent) parts.push(`-${num(t.sent, 4)}`);
    return `${parts.join("/") || "0"} ${sym}${t.symbol ? "" : " (unregistered token, amount unreliable)"}`;
  });

  let s = `  - ${bits.join(" | ")} — ${c.tx_count ?? "?"} tx`;
  if (money.length) s += `, ${money.join(", ")}`;
  if (toks.length) s += `\n      ${toks.join("; ")}`;
  if (c.kind_reason) s += `\n      why ${c.kind}: ${c.kind_reason}`;
  return s;
}

export async function handler(args) {
  const address = String(args?.address || "").trim();
  if (!address) return errorResult("address is required.");

  const mode = args?.mode;
  // The API selects its mode by WHICH field arrives and 400s when two of them do.
  // Validating here means a mode mix-up never reaches the wire.
  if (mode === "category" && !args?.category) {
    return errorResult("mode 'category' needs `category` (e.g. cex, mixer, gambling, bridge).");
  }
  if (mode === "check" && !(Array.isArray(args?.addresses) && args.addresses.length)) {
    return errorResult("mode 'check' needs `addresses` — the candidate counterparties to test.");
  }
  if (mode === "classify" && args?.category) {
    return errorResult("`category` belongs to mode 'category'. In 'classify' use `kinds`.");
  }

  const resolved = resolveChains(address, args?.chain);
  if (resolved.error) return errorResult(resolved.error);
  if (resolved.chains.length > 1) {
    return errorResult(
      `'${address}' could be on ${resolved.chains.join(" or ")}, which are different wallets. Pass \`chain\`.`
    );
  }
  const chain = resolved.chains[0];

  const body = { wallet_address: address, chain, include: ["risk"], limit: args?.limit || 25 };
  if (args?.rank_by) body.rank_by = args.rank_by;
  if (args?.since) body.since = args.since;
  if (args?.until) body.until = args.until;

  if (mode === "classify") {
    body.kinds = args?.kinds?.length ? args.kinds : KINDS;
    if (args?.direction) body.direction = args.direction;
  } else if (mode === "category") {
    body.category = args.category;
  } else {
    body.filter = args.addresses;
  }

  let d;
  try {
    d = await post("/v1/counterparties", body);
  } catch (e) {
    if (e instanceof ApiError) return errorResult(`Counterparty lookup failed (${e.kind}): ${e.message}`);
    throw e;
  }

  const rows = d.counterparties || [];
  const out = [];
  const header = {
    classify: `Counterparties of ${chain} ${address}, classified`,
    category: `Counterparties of ${chain} ${address} matching category '${args.category}'`,
    check: `Which of the ${args.addresses?.length} candidate address(es) ${chain} ${address} dealt with`,
  }[mode];
  out.push(header);

  if (!rows.length) {
    out.push(
      mode === "check"
        ? "None of them: no recorded interaction with any candidate."
        : "No counterparty matched. If `partial` is true below, that is a cap, not an empty wallet."
    );
  } else {
    out.push(rows.map(renderRow).join("\n"));
  }

  if (d.summary && Object.keys(d.summary).length) {
    out.push(
      "Counts per kind: " +
      Object.entries(d.summary).map(([k, v]) => `${k} ${v}`).join(", ") + "."
    );
  }
  if (d.counterparties_total != null) {
    out.push(`Showing ${d.returned ?? rows.length} of ${d.counterparties_total} known counterparties.`);
  }
  if (d.partial) {
    out.push("PARTIAL: a cap or time budget cut this list. Treat it as a floor, not the whole set.");
  }
  if (d.warnings?.length) out.push(`Warnings: ${d.warnings.join("; ")}.`);

  const note = CHAIN_COVERAGE_NOTES[chain];
  out.push([USD_CAVEAT, note].filter(Boolean).join(" "));

  return result(out.join("\n\n"), d);
}
