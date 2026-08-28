import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveChains, candidateChains, normalizeChain } from "../src/chains.js";
import { TOOLS } from "../src/index.js";
import * as counterparties from "../src/tools/list_counterparties.js";

test("short forms normalise to canonical chains", () => {
  assert.equal(normalizeChain("ETH"), "ethereum");
  assert.equal(normalizeChain("BNB"), "bsc");
  assert.equal(normalizeChain("TRX"), "tron");
  assert.equal(normalizeChain("btc"), "bitcoin");
  assert.equal(normalizeChain("solana"), null);
});

test("address format narrows the chain, and 0x stays ambiguous", () => {
  assert.deepEqual(candidateChains("0x67d40ee1a85bf4a4bb7ffae16de985e8427b6b45"), ["ethereum", "bsc"]);
  assert.deepEqual(candidateChains("TM2fQKjvwdUnCTkygPM4pxJKigHpMRr6Su"), ["tron"]);
  assert.deepEqual(candidateChains("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"), ["bitcoin"]);
  assert.deepEqual(candidateChains("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"), ["bitcoin"]);
  assert.deepEqual(candidateChains("not-an-address"), []);
});

test("an explicit chain always wins over detection", () => {
  const r = resolveChains("0x67d40ee1a85bf4a4bb7ffae16de985e8427b6b45", "BSC");
  assert.deepEqual(r.chains, ["bsc"]);
  assert.equal(r.inferred, false);
});

test("an unresolvable chain is an error, never a default", () => {
  assert.match(resolveChains("garbage").error, /cannot tell which chain/);
  assert.match(resolveChains("0xabc", "solana").error, /unknown chain/);
});

test("every tool declares a name, description and object schema", () => {
  for (const t of TOOLS) {
    assert.ok(t.definition.name, "name");
    assert.ok(t.definition.description.length > 100, `${t.definition.name} description`);
    assert.equal(t.definition.inputSchema.type, "object");
    assert.ok(typeof t.handler === "function");
  }
  assert.deepEqual(TOOLS.map((t) => t.definition.name).sort(),
    ["list_counterparties", "screen_address", "trace_funds"]);
});

test("counterparty modes are validated before any request goes out", async () => {
  const noCategory = await counterparties.handler({ address: "0x" + "a".repeat(40), mode: "category" });
  assert.equal(noCategory.isError, true);
  assert.match(noCategory.content[0].text, /needs `category`/);

  const noAddresses = await counterparties.handler({ address: "0x" + "a".repeat(40), mode: "check" });
  assert.equal(noAddresses.isError, true);
  assert.match(noAddresses.content[0].text, /needs `addresses`/);

  const mixed = await counterparties.handler({ address: "0x" + "a".repeat(40), mode: "classify", category: "cex" });
  assert.equal(mixed.isError, true);
  assert.match(mixed.content[0].text, /belongs to mode 'category'/);
});

test("ambiguous 0x is refused for the expensive tools, not guessed", async () => {
  const { handler } = await import("../src/tools/trace_funds.js");
  const r = await handler({ address: "0x67d40ee1a85bf4a4bb7ffae16de985e8427b6b45", direction: "incoming" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /pass `chain` explicitly/);
});
