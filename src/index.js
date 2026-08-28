#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import * as screenAddress from "./tools/screen_address.js";
import * as traceFunds from "./tools/trace_funds.js";
import * as listCounterparties from "./tools/list_counterparties.js";
import { BASE_URL, API_KEY } from "./api.js";

export const TOOLS = [screenAddress, traceFunds, listCounterparties];

const VERSION = "0.1.1";

export function buildServer() {
  const server = new Server(
    { name: "publicaml", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "PublicAML screens blockchain addresses for money-laundering risk on " +
        "bitcoin, ethereum, bsc and tron.\n\n" +
        "Two rules when reporting its answers. The chain is part of an address's " +
        "identity: the same 0x string is a different wallet on ethereum, bsc and " +
        "tron, so always say which chain a verdict is about. And an address that " +
        "is absent from the data is unknown, not clean.\n\n" +
        "The scores are risk readings, not shares of funds, and they are evidence " +
        "for a human decision rather than the decision itself.",
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => t.definition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.definition.name === req.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    }
    try {
      return await tool.handler(req.params.arguments || {});
    } catch (e) {
      // An exception here is our bug, not a refusal: report it as a tool error
      // so the model can say so, rather than killing the session.
      console.error(`[publicaml] ${req.params.name} failed:`, e);
      return {
        content: [{ type: "text", text: `${req.params.name} failed unexpectedly: ${e?.message || e}` }],
        isError: true,
      };
    }
  });

  return server;
}

async function main() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error(
    `[publicaml] mcp server ${VERSION} ready — api ${BASE_URL}, ` +
    `${API_KEY ? "api key configured" : "anonymous (rate limited; outgoing tracing unavailable)"}`
  );
}

// Only run when executed, so the module stays importable from tests. npm installs
// the bin as a symlink in node_modules/.bin, so argv[1] is that symlink while
// import.meta.url is the real file: compare resolved paths, not raw strings.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((e) => {
    console.error("[publicaml] fatal:", e);
    process.exit(1);
  });
}
