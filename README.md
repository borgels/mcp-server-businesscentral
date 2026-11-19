# mcp-server-businesscentral

A [Model Context Protocol](https://modelcontextprotocol.io) server for the Dynamics 365 Business Central API. It lets an MCP client (Claude or any other MCP-capable assistant) read data from the Dynamics 365 Business Central API v2.0. It has no write tools.

> This is an independent, unofficial project. It is not developed, endorsed or supported by Microsoft.

- Read-only: every tool makes one GET. There are no write tools, so `BC_ENABLE_WRITES` changes nothing.
- One set of upstream credentials per server instance; the server does no per-user authorization itself (see [Security model](#security-model)).
- Two transports: stdio for local clients, stateless streamable HTTP for containers and gateways.
- Embeddable: the `./gateway` export exposes the same tools, validation, policy and audit to a host application.

## Tools

| Tool | Purpose |
|---|---|
| `businesscentral_list_companies` | The companies in the environment. |
| `businesscentral_list_customers` | Customers, paged, with an OData filter. |
| `businesscentral_get_customer` | One customer with its financial details. |
| `businesscentral_list_vendors` | Vendors (no bank accounts). |
| `businesscentral_list_items` | Items with price, cost and inventory. |
| `businesscentral_list_sales_invoices` | Sales invoices. |
| `businesscentral_get_sales_invoice` | One sales invoice with its lines. |
| `businesscentral_list_purchase_invoices` | Purchase invoices. |
| `businesscentral_list_accounts` | The chart of accounts. |
| `businesscentral_list_general_ledger_entries` | Posted general ledger entries. |

Every tool reads. `BC_API_KEY` is a bearer access token for the tenant from Microsoft Entra (client credentials, `https://api.businesscentral.dynamics.com/.default`), and `BC_BASE_URL` is `https://api.businesscentral.dynamics.com/v2.0/<tenant id>/<environment>/api/v2.0`. The app must be set up in Business Central on the page Microsoft Entra Applications, with the permission set D365 READ.

## Quick start

Requires Node.js 22 or later and an API key for the Dynamics 365 Business Central API.

```bash
npx mcp-server-businesscentral
```

Or build from source:

```bash
git clone https://github.com/borgels/mcp-server-businesscentral.git
cd mcp-server-businesscentral
npm ci
npm run build
```

Claude Code:

```bash
claude mcp add businesscentral \
  --env BC_API_KEY=<key> --env BC_BASE_URL=<base url> \
  -- npx -y mcp-server-businesscentral
```

Claude Desktop (`claude_desktop_config.json`), or any client that launches stdio servers:

```json
{
  "mcpServers": {
    "businesscentral": {
      "command": "npx",
      "args": ["-y", "mcp-server-businesscentral"],
      "env": {
        "BC_API_KEY": "<key>",
        "BC_BASE_URL": "<base url>"
      }
    }
  }
}
```

### Docker and HTTP

Images are published to `ghcr.io/borgels/mcp-server-businesscentral`: `latest` and the commit SHA from `main`, and `vX.Y.Z` for release tags. The container serves streamable HTTP at `/mcp` on port 3000, plus an unauthenticated `GET /healthz`.

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
docker run -d --name businesscentral-mcp -p 127.0.0.1:3000:3000 \
  -e BC_API_KEY=<key> \
  -e BC_BASE_URL=<base url> \
  -e MCP_HTTP_TOKEN="$TOKEN" \
  ghcr.io/borgels/mcp-server-businesscentral:latest

claude mcp add --transport http businesscentral http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
```

To keep an audit log in the container, mount a writable directory and point `BC_AUDIT_LOG` into it (e.g. `-v businesscentral-audit:/audit -e BC_AUDIT_LOG=/audit/audit.jsonl`); the image runs as the `node` user and `/app` is not writable.

Clients send `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server will not start on a non-loopback address without a token of at least 32 characters. It does not terminate TLS; run it behind a reverse proxy or gateway that does.

## Configuration

Configuration is read from the environment (see `.env.example`). Invalid numbers, booleans, URLs and unknown tool names stop the server at startup. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`.

### Upstream API

| Variable | Default | Description |
|---|---|---|
| `BC_API_KEY` | – | **Required.** API key. |
| `BC_BASE_URL` | – | **Required.** Base URL of the API. Must be `https` (loopback `http` is allowed for local mocks). |
| `BC_TIMEOUT_MS` | `30000` | Timeout per request attempt. |
| `BC_MAX_CONCURRENCY` | `4` | Maximum concurrent upstream requests. |
| `BC_MAX_RESPONSE_BYTES` | `10485760` | Largest response body read (at most 100 MB). |

### Access control

| Variable | Default | Description |
|---|---|---|
| `BC_ENABLE_WRITES` | `false` | No effect: the server has no write tools. |
| `BC_DISABLED_TOOLS` | – | Comma-separated tool names to disable, with or without the `businesscentral_` prefix. |
| `BC_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with ids in clear text, free text hashed, duration, status and the caller passed by an embedding host. Write tools refuse to run if the log cannot be written. |

### HTTP transport

| Variable | Default | Description |
|---|---|---|
| `MCP_HTTP_TOKEN` | – | Bearer token, at least 32 printable ASCII characters (also on loopback). Required unless bound to loopback. |
| `MCP_HTTP_HOST` or `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address; `MCP_HTTP_HOST` takes precedence. |
| `PORT` | `3000` | Listen port. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated browser origins allowed to call the server. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any origin; requires a token. |
| `MCP_ALLOWED_HOSTS` | loopback names on a loopback bind | Comma-separated accepted `Host` header names. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS` | `20`, `60000` | Failed-authentication limit per client address; `0` disables it. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Permit a non-loopback bind without a token. Only for isolated networks. |

## Embedding (`./gateway`)

A host application can run the tools in-process instead of over MCP:

```ts
import { createBusinesscentralGateway, businesscentralToolCatalog } from 'mcp-server-businesscentral/gateway';

// One instance per call, with an access token the host has just fetched for the tenant.
const gateway = createBusinesscentralGateway({
  apiKey: await tokens.accessToken(tenantId),
  baseUrl: `https://api.businesscentral.dynamics.com/v2.0/${tenantId}/Production/api/v2.0`,
  policy: {},
});
const companies = await gateway.callTool('list_companies', {}, { caller: 'user-42' });
const customers = await gateway.callTool('list_customers', { companyId, top: 50 }, { caller: 'user-42' });
```

## Authentication (Microsoft Entra)

Business Central's API takes a bearer access token from Microsoft Entra. This server does not fetch one: the key it is given (`apiKey`, or `BC_API_KEY`) *is* the access token, and the host is the token provider.

- **The app.** Register a multitenant app in Microsoft Entra with the application permission **Dynamics 365 Business Central, `API.ReadWrite.All`** and a certificate. An administrator in the customer's tenant gives admin consent (`https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=...&scope=https://api.businesscentral.dynamics.com/.default&redirect_uri=...`). In Business Central, a user with `SUPER` adds the app on the page **Microsoft Entra Applications** with state Enabled and the permission set **D365 READ**: that set, not the Entra permission's name, decides what the app can read. See Microsoft's [service-to-service guide](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/automation-apis-using-s2s-authentication).
- **The token provider hook (gateway).** The host fetches an access token for the tenant with client credentials and its certificate (`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, scope `https://api.businesscentral.dynamics.com/.default`), caches it until shortly before it ends, and creates a gateway instance per call with the current token. Renewal is the host's: an instance never outlives the token it was given.
- **Standalone server.** `BC_API_KEY` is a token fetched the same way. It lasts about an hour, and the process does not renew it: the standalone server is for trying the tools, not for running unattended.

- **Explicit credentials.** `apiKey` and `baseUrl` are required; a missing value throws when the gateway is created. A gateway never reads `BC_API_KEY` or `BC_BASE_URL` from the environment, so one tenant cannot silently fall back to the process's credentials. The stdio and HTTP transports still read them from the environment.
- **Several tenants in one process.** Create one gateway per set of credentials. Each instance redacts error text, tool results and audit records with its own key only; no secret is kept in a process-wide registry, and a dropped instance releases its key.
- **Instance policy from the host.** Pass `policy` to `createBusinesscentralGateway`: `enableWrites` (default false), `disabledTools` (must name known tools) and `audit`, a function that receives each audit record instead of `BC_AUDIT_LOG` (without it the instance writes no audit; a write tool does not run if the sink throws on its start record). An instance with `policy` reads none of `BC_ENABLE_WRITES`, `BC_DISABLED_TOOLS` or `BC_AUDIT_LOG`, so tenants in one process can have different settings. Without `policy` the instance uses the environment, like the MCP server. Each call runs in a scope of its own, so a call made from inside another instance's call never inherits its policy, sink or redactor, and every audit record is redacted as a whole with the instance's own key before the sink sees it. The limits (`BC_TIMEOUT_MS`, ...) are still read from the environment and apply to every gateway in the process. Per-user and per-tenant authorization is the host's job.
- **Result format.** A successful `callTool` result has `structuredContent` and one text block: a short summary, a blank line, and the same data as compact JSON, as the MCP specification recommends (many clients read only the text). The JSON is built from the redacted result, so it holds exactly `structuredContent`. An error result has only its text.
- **Tool catalog.** `businesscentralToolCatalog` is a frozen list of every tool: `name` (without the `businesscentral_` prefix), `title`, `description`, `riskLevel` (`read`, `write` or `destructive`), `enabledByDefault`, `inputSchema` (JSON Schema), `broad` (true when a tool can read more than its name says, so a host gives it only to roles that may read everything) and `upstream`, the API requests the tool may make (`access`, `method` and path template). It is generated from the same tool table as the MCP server, so it cannot drift from the registered tools. `businesscentralGatewayTools` holds the same definitions without `upstream` and `broad`; `gateway.tools` lists those enabled on the instance.

## Threat model

What this server guarantees about the API key, and what it does not. It is
the yardstick for every change that touches errors, results or audit.

**Scope.** Guarantees (a), (b) and (c) apply to the embeddable gateway
(`./gateway`), the surface a multi-tenant host uses. The standalone MCP
server, configured from the environment for one key, keeps best-effort
redaction: its errors and audit records are redacted with its key, but it is
not held to these guarantees.

**Guaranteed:**

- **(a) The key never reaches anything persisted or shared:** audit sinks and
  the audit log file, logs, error texts, export hooks or files. Errors are
  our own texts; audit records and everything a gateway instance returns are
  redacted with the instance's own key before they leave it.
- **(b) No vendor-controlled free text in errors.** An error carries our own
  fixed text, the HTTP status, numbers we parse (Retry-After), and codes from
  a fixed list we wrote down; never a response body, a vendor message or
  code, a redirect's `Location`, a type or field name from the vendor, or
  the message of an error thrown while reading a response. A failure kept
  inside an otherwise returned result is the status or a fixed text as well.
  Errors never quote the key, the configured address or a refused configuration value (a timeout names its limit in milliseconds).
- **(c) Results go only to the tenant whose key it is.** One gateway
  instance per tenant; every call runs in a scope of its own; nothing about a
  tenant is kept in process-wide state. The MCP server serves one key.

**Not guaranteed (residual risk):** a vendor that deliberately echoes the
customer's own key back in data. Results are redacted on a best-effort
basis: the exact key, its URL- and JSON-encoded forms and any piece of it of
6 characters or more, in strings, object keys and the string form of
numbers and booleans, are replaced by `"‹redacted›"` before anything is
serialised. A key that comes back otherwise transformed (split into pieces
shorter than 6 characters, reversed, re-encoded, hashed) is not recognised.
Such data reaches only the tenant whose key it is, which already holds the
key. **What leaves a gateway holds no piece of the key.** This is checked at
the sink, not inferred from our texts: every output is checked in its final
form, and one that holds a piece of 6 characters of the key (or of one of
its encoded forms) is replaced by a fixed fallback. The outputs are the tool
list, every tool result as a whole (outer fields such as `isError`
included), audit records and stderr lines, and construction errors. A result becomes a fixed
"withheld" error, an audit record or line becomes a fixed one, and a
construction error becomes the fixed refusal. Every error a gateway throws is a fresh error in final form: no `cause`, a `stack` of only `name: message` (no frames, paths or function names), and name, message and stack masked against the secret. The fallbacks are a small,
closed set (`src/fallbacks.ts`), and a key that shares a piece with any of
them, or with the tool list, is refused when the gateway is created.

**Key admission.** Every key is a secret the vendor issues. A gateway
accepts only printable ASCII (0x21-0x7E) of at least 16 characters, checked
before anything is built from the key. As a cheap first filter it also
refuses a key that shares a piece of 6 characters with a string literal in
`src/` (`src/fixed-corpus.generated.ts`, kept up to date by a test). The
refusal is a fixed text that never repeats the key. The standalone MCP server (stdio and HTTP) redacts its results like the
gateway: the data is redacted before it is serialised, and a result or error
that still holds a piece of the key is withheld.

## Security model

- **One shared identity.** Every caller acts with the rights of the configured API key. Give it the least rights that work and rotate it regularly.
- **Per-user authorization belongs in front of the server.** The server checks a single bearer token and does not know the end user. For multi-user use, run it behind an identity-aware gateway that decides which users may call which tools, holds the bearer token, and is the only network path to the server. Hosts can also embed the tools through the `./gateway` module export and pass the caller identity into the audit log.
- **Tool access is not data access.** A gateway controls who may call which tool; every permitted caller still sees everything the API key can see. To separate data, run several instances with different keys.
- **No writes.** Every tool is read-only and gets a client that refuses non-GET requests. The second fence is Business Central's own permission set on the app (D365 READ).
- **Upstream content is untrusted input.** Data returned by the API may be written by anyone with access to it. Tool results label it as data; clients that combine this server with other tools should treat it accordingly.
- **The token stays on the API host.** It is sent to `https://api.businesscentral.dynamics.com` exactly (no subdomain, other port or loopback, on every surface; there is no override), redirects are never followed, answers must be JSON objects, results on every surface (gateway, stdio and HTTP) are redacted and withheld when they still hold a piece of the token, the HTTP transport logs only its own paths and no stacks, and error messages and audit records are redacted (by each instance, with that instance's key) and size-capped. See the threat model above for what is and is not guaranteed.
- **The HTTP transport fails closed.** It refuses to start on a non-loopback address or with any origin allowed unless a token is set, compares tokens in constant time, throttles failed authentication per client address, checks `Origin` and `Host` (DNS rebinding), and caps request bodies.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm run dev          # stdio transport
npm run dev:http     # HTTP transport on 127.0.0.1:3000
npm run typecheck
npm test
npm run build
```

Project layout:

| Path | Contents |
|---|---|
| `src/tools/businesscentral.ts` | Shared tool table (MCP and gateway), policy and audit wrapper. |
| `src/businesscentral/` | Upstream client, API calls, policy, audit, tool annotations. |
| `src/transports/` | stdio and HTTP entry points; HTTP auth, origin and host checks. |
| `src/gateway.ts` | Embeddable entry point (`./gateway` export). |
| `src/config-env.ts` | Validated environment readers. |

## Releasing

1. Bump the version in `package.json`, `server.json` (`version` and the npm package `version`) and `src/version.ts`; tests and CI check that they agree. Update `CHANGELOG.md`. Merge.
2. Tag the merged commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `release.yml` tests, packs and publishes the tarball to npm through trusted publishing (no stored token; npm adds provenance when the repository is public), then publishes `server.json` to the MCP Registry. Versions already on npm or in the registry are skipped, so a failed run can be re-run. Pre-release tags (`vX.Y.Z-rc.1`) go to the npm dist-tag `next` and not to the registry. `publish.yml` pushes the `vX.Y.Z` image.

The first version of a new package is published by hand; see the header of `.github/workflows/release.yml` (and [docs/NEW-SERVER.md](docs/NEW-SERVER.md)).

## License

Apache-2.0
