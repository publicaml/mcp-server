#!/usr/bin/env node
// Builds the MCPB bundle — the one-click desktop install of this server.
//
// The bundle is a second distribution artifact alongside npm, so nothing here
// is hand-maintained: the version, description, license and tool list are all
// read from package.json and from the server's own tool definitions. A release
// is `npm publish` plus a re-run of this script; the two cannot drift.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(root, "build", "mcpb");
const server = join(build, "server");
const dist = join(root, "dist");

const pkg = JSON.parse(
  execFileSync("cat", [join(root, "package.json")], { encoding: "utf8" })
);
const { TOOLS } = await import(join(root, "src", "index.js"));

console.log(`building mcpb bundle for ${pkg.name}@${pkg.version}`);

rmSync(build, { recursive: true, force: true });
mkdirSync(server, { recursive: true });
mkdirSync(dist, { recursive: true });

cpSync(join(root, "src"), join(server, "src"), { recursive: true });
for (const f of ["README.md", "LICENSE"]) cpSync(join(root, f), join(build, f));

// A trimmed package.json: the bundle ships its own node_modules and never runs
// the test or start scripts, and npm must not try to resolve a bin here.
writeFileSync(
  join(server, "package.json"),
  JSON.stringify(
    {
      name: pkg.name.replace("@", "").replace("/", "-"),
      version: pkg.version,
      private: true,
      type: "module",
      dependencies: pkg.dependencies,
    },
    null,
    2
  ) + "\n"
);

console.log("installing runtime dependencies into the bundle...");
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"], {
  cwd: server,
  stdio: "inherit",
});

const manifest = {
  manifest_version: "0.3",
  name: "publicaml",
  display_name: "PublicAML",
  version: pkg.version,
  description: pkg.description,
  long_description:
    "Screen any Bitcoin, Ethereum, BNB Chain or Tron address for money-laundering " +
    "risk without leaving your assistant.\n\n" +
    "**screen_address** returns a risk level and score, sanctions status, issuer " +
    "freezes (Tether/Circle), what the address is — exchange, mixer, gambling " +
    "site, bridge, personal wallet — and where its risk comes from.\n\n" +
    "**trace_funds** walks the money one direction at a time: who funded a " +
    "wallet, or where its money went and at which exchange it left the chain.\n\n" +
    "**list_counterparties** enumerates who a wallet dealt with and classifies " +
    "each one as a person, a venue, a hub or a deposit address.\n\n" +
    "Works with no account. An API key is optional: it lifts the rate limit and " +
    "enables forward tracing.\n\n" +
    "The answers are evidence for a human decision, not the decision itself. A " +
    "sanctions hit is blocking on its own; a score is a risk reading and never a " +
    "share of the funds; an address absent from the data is unknown, not clean.",
  author: { name: "PublicAML", url: "https://publicaml.org" },
  repository: { type: "git", url: pkg.repository.url.replace(/^git\+/, "") },
  homepage: pkg.homepage,
  documentation: "https://publicaml.org/api",
  support: "https://github.com/publicaml/mcp-server/issues",
  license: pkg.license,
  keywords: pkg.keywords,
  server: {
    type: "node",
    entry_point: "server/src/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/src/index.js"],
      env: { PUBLICAML_API_KEY: "${user_config.api_key}" },
    },
  },
  tools: TOOLS.map((t) => ({
    name: t.definition.name,
    description: t.definition.title,
  })),
  user_config: {
    api_key: {
      type: "string",
      title: "PublicAML API key",
      description:
        "Optional. Leave empty to use the service anonymously under a rate " +
        "limit. A key lifts that limit and enables outgoing fund tracing.",
      sensitive: true,
      required: false,
    },
  },
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: ">=20.0.0" },
  },
};

writeFileSync(join(build, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const out = join(dist, `publicaml-mcp-server-${pkg.version}.mcpb`);
rmSync(out, { force: true });
execFileSync("npx", ["-y", "@anthropic-ai/mcpb", "pack", build, out], { stdio: "inherit" });
console.log(`\nbundle: ${out}`);
