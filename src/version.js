import { readFileSync } from "node:fs";

// One version, read from package.json, so the MCP handshake, the User-Agent and
// the published package cannot disagree. The MCPB bundle ships a trimmed
// package.json next to src/ with the same version, so the path holds there too.
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
