import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as screen from "../src/tools/screen_address.js";
import { rateLimitMessage } from "../src/api.js";
import { isCommunityClaim, victimReportUrl } from "../src/format.js";

// Real /v2/enrich answers (06.11.2026), trimmed of the blocks screening does not ask for.
const FX = JSON.parse(readFileSync(new URL("./fixtures/v2_enrich.json", import.meta.url), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const SOL = "BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(body, { status = 200, headers = {} } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers });
  };
  return calls;
}

test("screen_address calls /v2/enrich with the screening blocks only", async () => {
  const calls = mockFetch(FX.sol_claim);
  const r = await screen.handler({ address: SOL });
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v2\/enrich$/);
  assert.deepEqual(calls[0].body.addresses, [{ wallet_address: SOL, chain: "solana" }]);
  assert.deepEqual(calls[0].body.include.sort(), ["axes", "incidents", "risk"]);
});

test("a pending victim claim is a report line, never the identity", async () => {
  mockFetch(FX.sol_claim);
  const text = (await screen.handler({ address: SOL, chain: "solana" })).content[0].text;
  const identity = text.split("\n").find((l) => l.startsWith("Identity:"));
  assert.ok(identity, text);
  assert.doesNotMatch(identity, /exchange_deposit|KuCoin/);
  assert.match(
    text,
    /Reported by a victim \(not confirmed, does not affect the score\): exchange_deposit "KuCoin hot wallet" — https:\/\/publicaml\.org\/reports\/VR-AF7D0CD9\//
  );
  // Printed once, although the API carries it both in community_claims[] and on the axis.
  assert.equal(text.match(/KuCoin hot wallet/g).length, 1);
});

test("a claim folded into an empty label is not the label either", () => {
  const e = clone(FX.sol_claim.entities[0]);
  delete e.community_claims;
  e.label = "KuCoin hot wallet";
  e.label_basis = {
    kind: "community_claim", confirmed: false, affects_score: false,
    source: "community:victim-report", stated_as: "KuCoin hot wallet",
    report_ref: "VR-AF7D0CD9", url: "https://publicaml.org/reports/VR-AF7D0CD9/",
  };
  const text = screen.renderEntity(e);
  assert.match(text, /^Identity: no label/m);
  assert.match(text, /Reported by a victim \(not confirmed, does not affect the score\): exchange_deposit "KuCoin hot wallet"/);
});

test("community:confirmed is an ordinary attribution", () => {
  const e = clone(FX.sol_claim.entities[0]);
  delete e.community_claims;
  e.axes.business = {
    basis: "attribution", category: "cex", source: "community:confirmed", source_rank: 50,
  };
  assert.equal(isCommunityClaim(e.axes.business), false);
  const text = screen.renderEntity(e);
  assert.match(text, /^Identity: .*business cex \(community:confirmed, rank 50\)/m);
  assert.doesNotMatch(text, /Reported by a victim/);
});

test("label-only scored:false is NOT SCORED, never 0", () => {
  const text = screen.renderEntity(clone(FX.sol_claim.entities[0]));
  assert.match(text, /— NOT SCORED \(chain_label_only\)\. This is not a score of 0/);
  assert.doesNotMatch(text, /risk score 0/);
});

test("a direct-only score says so and does not print indirect 0", () => {
  const e = clone(FX.sol_claim.entities[0]);
  e.risk = {
    score: 90, level: "CRITICAL", scored: true, scope: "direct_only",
    breakdown: { direct_exposure: 90, indirect_exposure: null, exposure_direction: "inbound" },
  };
  const text = screen.renderEntity(e);
  assert.match(text, /CRITICAL \(risk score 90\/100\)/);
  assert.match(text, /Score scope: direct_only/);
  assert.match(text, /indirect not assessed/);
});

test("community incidents are marked, curated ones carry the role", () => {
  const text = screen.renderEntity(clone(FX.eth_bybit.entities[0]));
  assert.match(text, /Bybit cold wallet hack \(21 Feb 2025\) \[hack\] — role: perpetrator/);
  assert.match(text, /Chainabuse report: Hack \[hack\].*role: perpetrator \(community report, not confirmed\)/);
  assert.match(text, /not named in it; funds link to 0x55cca2…feb734 1 hop away/);
});

test("incidents are capped with a count of the rest", () => {
  const e = clone(FX.eth_bybit.entities[0]);
  const base = e.incidents[0];
  e.incidents = Array.from({ length: 8 }, (_, i) => ({ ...base, slug: `s${i}`, name: `Incident ${i}` }));
  e.incident_links = [
    ...e.incidents.map((i) => ({ slug: i.slug, link: "direct", role: "perpetrator" })),
    ...Array.from({ length: 30 }, (_, i) => ({ slug: `x${i}`, link: "direct", role: "victim" })),
  ];
  const text = screen.renderEntity(e);
  assert.equal((text.match(/^ {2}- Incident/gm) || []).length, screen.MAX_INCIDENTS);
  assert.match(text, /…and 33 more\./);
});

test("a victim role is never read as an accusation", () => {
  const e = clone(FX.eth_bybit.entities[0]);
  e.incidents = [{ ...e.incidents[0], role: "victim", implicates_address: false }];
  e.incident_links = [{ slug: e.incidents[0].slug, link: "direct", role: "victim" }];
  assert.match(screen.renderEntity(e), /role: victim \(this address is the VICTIM, not accused\)/);
});

test("sanction and freeze come from the axes", () => {
  const text = screen.renderEntity(clone(FX.eth_chatex.entities[0]));
  assert.match(text, /^SANCTIONED — CHATEX, OFAC SDN, source ofac:sdn_advanced, jurisdictions US\. This alone is a blocking fact/m);
  assert.match(text, /^Issuer freeze: USDC by circle on 2021-11-09/m);
  assert.match(text, /^Identity: CHATEX \| business cex, role hot_wallet/m);
});

test("NOT FOUND stays unknown, not clean", async () => {
  mockFetch({ entities: [], not_found: [{ chain: "bsc", wallet_address: "0x" + "a".repeat(40), reason: "address_not_found" }] });
  const text = (await screen.handler({ address: "0x" + "a".repeat(40), chain: "bsc" })).content[0].text;
  assert.match(text, /— NOT FOUND \(address_not_found\)/);
  assert.match(text, /NOT FOUND is not a clean verdict/);
});

test("the answer links the prefilled victim-report form and nothing writes", async () => {
  mockFetch(FX.sol_claim);
  const text = (await screen.handler({ address: SOL })).content[0].text;
  assert.ok(text.includes(`https://publicaml.org/victim-reports/?chain=solana&address=${SOL}`), text);
  assert.equal(victimReportUrl("ethereum", "0xab"), "https://publicaml.org/victim-reports/?chain=ethereum&address=0xab");
});

test("429 explains the anonymous limit and when it resets", async () => {
  mockFetch({ error: "rate_limited" }, { status: 429, headers: { "RateLimit-Reset": "600" } });
  const r = await screen.handler({ address: SOL });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /rate_limited.*anonymous use.*about 10 minutes.*PUBLICAML_API_KEY/);
  assert.match(rateLimitMessage(new Headers({ "Retry-After": "30" })), /about 30 seconds/);
});
