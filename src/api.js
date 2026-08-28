// Thin client over the PublicAML HTTP API.
//
// The API key is optional on purpose: /v1/enrich, /v1/source-trace and
// /v1/counterparties answer anonymously under an IP rate limit, so the server
// is useful the moment it is installed. A key removes the limit and unlocks
// /v1/trace, which is the one authenticated endpoint we expose.
export const DEFAULT_BASE = "https://intelapi.publicaml.org";

export const BASE_URL = (process.env.PUBLICAML_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
export const API_KEY = process.env.PUBLICAML_API_KEY || null;
export const TIMEOUT_MS = Number(process.env.PUBLICAML_TIMEOUT_MS || 60000);

export class ApiError extends Error {
  constructor(kind, message, { status = 0, body = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;      // invalid_address | unauthorized | rate_limited | not_found | bad_request | http | network
    this.status = status;
    this.body = body;
  }
}

export async function post(path, body) {
  const headers = { "Content-Type": "application/json", "User-Agent": "publicaml-mcp/0.1.1" };
  if (API_KEY) headers["X-API-Key"] = API_KEY;

  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new ApiError(
      "network",
      timedOut
        ? `the API did not answer within ${Math.round(TIMEOUT_MS / 1000)}s`
        : `could not reach ${BASE_URL}: ${e?.message || e}`
    );
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body below */ }

  if (res.ok) {
    if (json === null) throw new ApiError("http", `unparseable response from ${path}`, { status: res.status });
    return json;
  }

  const detail = json?.detail || json?.error || text.slice(0, 400) || `HTTP ${res.status}`;

  if (res.status === 400 && json?.error === "invalid_address_format") {
    // Self-correcting by design: `detail` names the chain the address does look
    // like, so passing it through verbatim lets the caller retry correctly.
    throw new ApiError("invalid_address", detail, { status: 400, body: json });
  }
  if (res.status === 401 || res.status === 403) {
    throw new ApiError("unauthorized", detail, { status: res.status, body: json });
  }
  if (res.status === 429) {
    throw new ApiError(
      "rate_limited",
      "rate limit reached for anonymous use. Set PUBLICAML_API_KEY in the server config to lift it.",
      { status: 429, body: json }
    );
  }
  if (res.status === 404) throw new ApiError("not_found", detail, { status: 404, body: json });
  if (res.status === 400 || res.status === 422) {
    throw new ApiError("bad_request", detail, { status: res.status, body: json });
  }
  throw new ApiError("http", detail, { status: res.status, body: json });
}
