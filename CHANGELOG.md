# Changelog

## Unreleased

- `./gateway`: `createExampleGateway` takes `policy` (`enableWrites`,
  `disabledTools`, `audit` sink). An instance with a host policy reads no
  policy or audit variable from the environment (`EXAMPLE_ENABLE_WRITES`,
  `EXAMPLE_DISABLED_TOOLS`, `EXAMPLE_AUDIT_LOG`,
  `EXAMPLE_ALLOW_CUSTOM_BASE_URL`), so tenants in one process can have
  different settings. Without `policy` nothing changes.
- `./gateway`: every gateway call runs in a call scope of its own (policy or
  environment, sink, redactor), so a call made from inside another
  instance's call (from its audit sink or its fetch) never inherits that
  instance's policy, sink or redactor.
- `createExampleGateway` refuses an `apiKey` shorter than 8 characters,
  the shortest secret the redactor protects.
- Audit records are redacted as a whole with the instance's redactor before
  they reach the sink or the log file: tool name, input field names, caller,
  request id and reason, refusals included. Text is redacted before it is
  cut short, so no part of a key survives a cut.
- `exampleToolCatalog` entries carry `broad`, the mark for a tool that can
  read more than its name says. A tool declares it in the tool table
  (`broad: true`); it defaults to false. Hosts that grant tools per role read
  it from the catalog instead of setting it by hand.
- `./gateway`: `createExampleGateway` requires `apiKey` and `baseUrl` and no
  longer falls back to `EXAMPLE_API_KEY` and `EXAMPLE_BASE_URL`; a missing
  value throws when the gateway is created. The stdio and HTTP transports
  still read the environment. Behaviour change for embedders.
- Secret redaction is per client instance (`SecretRedactor`) instead of a
  process-wide registry, so gateways for different tenants in one process
  never share or retain each other's keys.
- `./gateway` exports `exampleToolCatalog`, a frozen, typed catalog of every
  tool with its schema, risk level and the upstream requests it may make,
  generated from the shared tool table, and the `ExampleGateway` type.

## 0.1.0

- Initial version: `example_get_item` (read) and `example_create_item`
  (write, disabled unless `EXAMPLE_ENABLE_WRITES=true`), stdio and
  streamable HTTP transports, `./gateway` export, JSONL audit log.
