// End-to-end check over real stdio MCP against the live API.
// Not part of `npm test`: it needs network. Run with `node scripts/live.mjs`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0" }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: "node", args: ["src/index.js"] }));

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => `${t.name} (${JSON.stringify(t.inputSchema).length}B schema)`).join(", "));

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n===== ${name} ${JSON.stringify(args)} ${r.isError ? "[ERROR]" : ""}\n${r.content[0].text}`);
}

await call("screen_address", { address: "0x67d40ee1a85bf4a4bb7ffae16de985e8427b6b45", chain: "ethereum" });
await call("screen_address", { address: "TM2fQKjvwdUnCTkygPM4pxJKigHpMRr6Su" });
await call("screen_address", { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" });
await call("screen_address", { address: "bc1qxyz", chain: "ethereum" });
await call("list_counterparties", {
  address: "0x67d40ee1a85bf4a4bb7ffae16de985e8427b6b45", chain: "ethereum", mode: "classify", limit: 3,
});
await call("trace_funds", {
  address: "0x67d40ee1a85bf4a4bb7ffae16de985e8427b6b45", chain: "ethereum", direction: "incoming", max_hops: 2,
});
await call("trace_funds", {
  address: "0x67d40ee1a85bf4a4bb7ffae16de985e8427b6b45", chain: "ethereum", direction: "outgoing",
});

await client.close();
