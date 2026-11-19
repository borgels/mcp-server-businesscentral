// Regression tests for the second review (4bab20b): no host override anywhere, empty answers refused, paging for the
// companies too and never silently cut, and the token never echoed through real stdio, real HTTP or the audit sink.

import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { BusinesscentralClient } from '../src/businesscentral/client.js';
import { createBusinesscentralGateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { type RunningHttpServer, startHttpServer } from '../src/transports/http-server.js';

const BASE = 'https://api.businesscentral.dynamics.com/v2.0/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/Production/api/v2.0';
const TOKEN = `eyJ0eXAiOiJKV1Qi.${'Zq9Xw'.repeat(8)}.sig-${'Pv7Lk'.repeat(6)}`;
const PIECE = TOKEN.slice(18, 34);
const HTTP_TOKEN = 'test-token-0123456789abcdef0123456789';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
/** Business Central echoing the Authorization header it was sent. */
const echo = (async (_input: string | URL | Request, init?: RequestInit) =>
  json({ value: [{ name: 'Echo', echoed: String((init?.headers as Record<string, string>)?.Authorization) }] })) as typeof fetch;

describe('no override', () => {
  it('is taken from the environment on the standalone surface either', () => {
    process.env.BC_ALLOW_CUSTOM_BASE_URL = 'true';
    try {
      for (const baseUrl of ['http://127.0.0.1:4321/api', 'https://sub.api.businesscentral.dynamics.com/api', 'https://elsewhere.invalid/api']) {
        expect(() => new BusinesscentralClient({ apiKey: TOKEN, baseUrl }), baseUrl).toThrow();
        expect(() => createServer({ client: new BusinesscentralClient({ apiKey: TOKEN, baseUrl }) }), baseUrl).toThrow();
      }
    } finally {
      delete process.env.BC_ALLOW_CUSTOM_BASE_URL;
    }
  });
});

describe('answers', () => {
  it('refuses an empty successful body', async () => {
    for (const type of ['text/html', 'application/json']) {
      const client = new BusinesscentralClient({
        apiKey: TOKEN,
        baseUrl: BASE,
        fetchImpl: (async () => new Response('', { status: 200, headers: { 'content-type': type } })) as typeof fetch,
      });
      await expect(client.get('/companies')).rejects.toThrow('empty body');
    }
  });
});

describe('paging', () => {
  function gw(next: string) {
    const seen: URL[] = [];
    const gateway = createBusinesscentralGateway({
      apiKey: TOKEN,
      baseUrl: BASE,
      policy: {},
      fetchImpl: (async (input: string | URL | Request) => {
        seen.push(new URL(String(input)));
        return json({ value: [{ name: 'A' }], '@odata.nextLink': next });
      }) as typeof fetch,
    });
    return { gateway, seen };
  }

  it('continues the companies with a skip token, never the raw link', async () => {
    const { gateway, seen } = gw(`${BASE}/companies?$skiptoken=c1`);
    const first = await gateway.callTool('list_companies', {});
    expect(first.structuredContent).toEqual({ value: [{ name: 'A' }], nextSkipToken: 'c1' });
    await gateway.callTool('list_companies', { skipToken: 'c1' });
    expect(seen[1]!.searchParams.get('$skiptoken')).toBe('c1');
  });

  it('says so instead of cutting the list when the next page cannot be passed on', async () => {
    for (const next of [`${BASE}/companies?$skiptoken=${'x'.repeat(2001)}`, `${BASE}/companies?other=1`, 'not a link']) {
      const result = await gw(next).gateway.callTool('list_companies', {});
      expect(result.isError, next.slice(0, 60)).toBe(true);
      expect(JSON.stringify(result)).toContain('next page cannot be passed on');
    }
  });
});

describe('the token is never echoed', () => {
  let running: RunningHttpServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('through real HTTP', async () => {
    running = await startHttpServer(
      { host: '127.0.0.1', port: 0, maxBodyBytes: 1024 * 1024, httpToken: HTTP_TOKEN },
      { createMcpServer: () => createServer({ client: new BusinesscentralClient({ apiKey: TOKEN, baseUrl: BASE, fetchImpl: echo }) }), log: () => {} },
    );
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${HTTP_TOKEN}` } },
      }),
    );
    const result = await client.callTool({ name: 'businesscentral_list_companies', arguments: {} });
    await client.close();
    expect(JSON.stringify(result)).toContain('Echo');
    expect(JSON.stringify(result)).not.toContain(PIECE);
  });

  it('through real stdio', async () => {
    const entry = fileURLToPath(new URL('../src/transports/stdio.ts', import.meta.url));
    const preload = new URL('./fixtures/echo-fetch.mjs', import.meta.url).href;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('BC_')) env[k] = v;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', '--import', preload, entry],
      env: { ...env, BC_API_KEY: TOKEN, BC_BASE_URL: BASE },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'businesscentral_list_companies', arguments: {} });
    await client.close();
    expect(JSON.stringify(result)).toContain('Echo');
    expect(JSON.stringify(result)).not.toContain(PIECE);
  }, 30_000);

  it('to the gateway audit sink, with the token in the context and in the error', async () => {
    const records: unknown[] = [];
    const gateway = createBusinesscentralGateway({
      apiKey: TOKEN,
      baseUrl: BASE,
      policy: { audit: record => void records.push(record) },
      fetchImpl: (async () => new Response(`failed for ${TOKEN}`, { status: 500 })) as typeof fetch,
      maxAttempts: 1,
    });
    const result = await gateway.callTool('list_companies', {}, { caller: `person ${TOKEN}`, requestId: TOKEN });
    expect(result.isError).toBe(true);
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(PIECE);
    expect(JSON.stringify(result)).not.toContain(PIECE);
  });
});
