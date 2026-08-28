# PublicAML MCP server

Blockchain AML screening inside Claude Desktop, Cursor, or any other MCP client.
Ask about an address in plain language and the assistant checks it against
PublicAML: sanctions, issuer freezes, risk propagated through the transaction
graph, who funded the wallet and who it dealt with.

Chains: bitcoin, ethereum, bsc, tron.

Works without an account. An API key only lifts the rate limit and unlocks
forward tracing.

## Install

Claude Desktop, `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "publicaml": {
      "command": "npx",
      "args": ["-y", "@publicaml/mcp-server"]
    }
  }
}
```

With an API key:

```json
{
  "mcpServers": {
    "publicaml": {
      "command": "npx",
      "args": ["-y", "@publicaml/mcp-server"],
      "env": { "PUBLICAML_API_KEY": "your-key" }
    }
  }
}
```

Cursor uses the same block in `.cursor/mcp.json`. Claude Code:

```
claude mcp add publicaml -- npx -y @publicaml/mcp-server
```

## Tools

### `screen_address`
Risk level and score, sanctions, Tether/Circle freezes, what the address is
(exchange, mixer, gambling, bridge, personal wallet) and where its risk comes
from.

`chain` is optional. Omit it and every chain the address format allows is
screened, each result labelled with its chain: the same `0x…` string is a
different wallet on ethereum, bsc and tron, so it is never guessed silently.

### `trace_funds`
`direction: "incoming"` walks the funding backwards to answer "who paid this
wallet", stopping at labelled entities rather than walking into an exchange's
other customers. `direction: "outgoing"` follows the largest outgoing flows to
where the money left the chain's anonymous part. Outgoing needs an API key.

The walk is bounded by wall clock, so an incomplete answer is returned rather
than a timeout, and the answer says which one it is.

### `list_counterparties`
Three questions, one tool. `classify` enumerates counterparties and says what
each one is (person, venue, hub, deposit address, contract, mint/burn).
`category` answers "did this wallet touch any exchange / mixer / casino".
`check` tests a list of suspect addresses against the wallet.

## Reading the answers

- `sanctioned: true` is a blocking fact on its own, whatever the score says.
- The score is a risk reading 0-100, never a share of the funds, and its parts
  combine by MAX, so the breakdown does not add up to the total.
- An address absent from the data comes back as NOT FOUND. That is unknown,
  not clean.
- Lists are ranked and capped. A `PARTIAL` answer is a floor, not a census.
- USD figures cover priced tokens only and can be inflated by low-liquidity
  tokens. Treat them as an order of magnitude.

This is evidence for a human decision, not the decision itself.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLICAML_API_KEY` | none | Lifts the anonymous rate limit, unlocks outgoing tracing. |
| `PUBLICAML_API_BASE` | `https://intelapi.publicaml.org` | API base URL. |
| `PUBLICAML_TIMEOUT_MS` | `60000` | Per-request timeout. |
| `PUBLICAML_TRACE_CONTINUES` | `2` | How many times an incomplete backward walk is resumed automatically. |

## Development

```
npm install
npm test          # unit tests, no network
node scripts/live.mjs  # end-to-end against the live API
```

MIT licensed. API docs: https://publicaml.org/api
