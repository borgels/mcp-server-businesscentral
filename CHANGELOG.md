# Changelog

## Unreleased

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
