// Regression tests for the review of 56e74d8: exact hosts, the token never returned on any surface, JSON objects only,
// server-driven paging, logging without paths or stacks, and the actual GET of every tool.

import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { auditTarget } from '../src/businesscentral/audit.js';
import { BusinesscentralClient } from '../src/businesscentral/client.js';
import { createBusinesscentralGateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { BC_TOOLS } from '../src/tools/businesscentral.js';
import { type RunningHttpServer, startHttpServer } from '../src/transports/http-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const BASE = 'https://api.businesscentral.dynamics.com/v2.0/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/Production/api/v2.0';
const COMPANY = '11111111-2222-4333-8444-555555555555';
const ID = '66666666-7777-4888-9999-000000000000';
const TOKEN = `eyJ0eXAiOiJKV1Qi.${'Zq9Xw'.repeat(8)}.sig-${'Pv7Lk'.repeat(6)}`;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

type Seen = { url: URL; method: string };

function recordingFetch(answer: (url: URL) => Response) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, method: init?.method ?? 'GET' });
    return answer(url);
  }) as typeof fetch;
  return { seen, fetchImpl };
}

async function mcp(answer: (url: URL) => Response) {
  const { seen, fetchImpl } = recordingFetch(answer);
  const server = createServer({ client: new BusinesscentralClient({ apiKey: TOKEN, baseUrl: BASE, fetchImpl }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, seen };
}

describe('exact hosts in the gateway', () => {
  it('refuses loopback, subdomains, other ports and the custom-host override from a host', () => {
    for (const baseUrl of [
      'http://127.0.0.1:4321/api',
      'https://sub.api.businesscentral.dynamics.com/api/v2.0',
      'https://api.businesscentral.dynamics.com:444/api/v2.0',
    ]) {
      expect(() => createBusinesscentralGateway({ apiKey: TOKEN, baseUrl, policy: {} }), baseUrl).toThrow();
      expect(
        () => createBusinesscentralGateway({ apiKey: TOKEN, baseUrl, policy: {}, allowCustomBaseUrl: true } as never),
        baseUrl,
      ).toThrow();
    }
    expect(() => createBusinesscentralGateway({ apiKey: TOKEN, baseUrl: BASE, policy: {} })).not.toThrow();
  });
});

describe('the plain MCP surface', () => {
  it('withholds a successful answer that holds the token, or a piece of it', async () => {
    for (const note of [TOKEN, TOKEN.slice(20, 40)]) {
      const { client } = await mcp(() => json({ value: [{ note }] }));
      const result = await client.callTool({ name: 'businesscentral_list_companies', arguments: {} });
      // Redacted before it is serialised, and the whole result checked last, as in the gateway.
      expect(JSON.stringify(result)).not.toContain(note);
    }
  });

  it('passes an ordinary answer on, and never puts the token in an error', async () => {
    const { client } = await mcp(() => json({ value: [{ name: 'CRONUS' }] }));
    const ok = await client.callTool({ name: 'businesscentral_list_companies', arguments: {} });
    expect(JSON.stringify(ok)).toContain('CRONUS');
    const refused = await mcp(() => new Response(`bad token ${TOKEN}`, { status: 401 }));
    const error = await refused.client.callTool({ name: 'businesscentral_list_companies', arguments: {} });
    expect(error.isError).toBe(true);
    expect(JSON.stringify(error)).not.toContain(TOKEN.slice(0, 12));
  });
});

describe('server-driven paging', () => {
  it('gives the next page as nextSkipToken, without the link, and sends it back as $skiptoken', async () => {
    const { seen, fetchImpl } = recordingFetch(() =>
      json({ value: [{ number: '1' }], '@odata.nextLink': `${BASE}/companies(${COMPANY})/customers?$skiptoken=abc123` }),
    );
    const gw = createBusinesscentralGateway({ apiKey: TOKEN, baseUrl: BASE, policy: {}, fetchImpl });
    const first = await gw.callTool('list_customers', { companyId: COMPANY });
    expect(first.structuredContent).toEqual({ value: [{ number: '1' }], nextSkipToken: 'abc123' });
    expect(JSON.stringify(first)).not.toContain('nextLink');
    await gw.callTool('list_customers', { companyId: COMPANY, skipToken: 'abc123' });
    expect(seen[1]!.url.searchParams.get('$skiptoken')).toBe('abc123');
  });
});

describe('every tool', () => {
  const inputs: Record<string, { input: Record<string, unknown>; path: string; expand?: string }> = {
    list_companies: { input: {}, path: '/companies' },
    list_customers: { input: { companyId: COMPANY }, path: `/companies(${COMPANY})/customers` },
    get_customer: { input: { companyId: COMPANY, customerId: ID }, path: `/companies(${COMPANY})/customers(${ID})`, expand: 'customerFinancialDetails' },
    list_vendors: { input: { companyId: COMPANY }, path: `/companies(${COMPANY})/vendors` },
    list_items: { input: { companyId: COMPANY }, path: `/companies(${COMPANY})/items` },
    list_sales_invoices: { input: { companyId: COMPANY }, path: `/companies(${COMPANY})/salesInvoices` },
    get_sales_invoice: { input: { companyId: COMPANY, invoiceId: ID }, path: `/companies(${COMPANY})/salesInvoices(${ID})`, expand: 'salesInvoiceLines' },
    list_purchase_invoices: { input: { companyId: COMPANY }, path: `/companies(${COMPANY})/purchaseInvoices` },
    list_accounts: { input: { companyId: COMPANY }, path: `/companies(${COMPANY})/accounts` },
    list_general_ledger_entries: { input: { companyId: COMPANY }, path: `/companies(${COMPANY})/generalLedgerEntries` },
    list_sales_quotes: { input: { companyId: COMPANY }, path: `/companies(${COMPANY})/salesQuotes` },
    get_sales_quote: { input: { companyId: COMPANY, documentId: ID }, path: `/companies(${COMPANY})/salesQuotes(${ID})`, expand: 'salesQuoteLines' },
    list_sales_orders: { input: { companyId: COMPANY }, path: `/companies(${COMPANY})/salesOrders` },
    get_sales_order: { input: { companyId: COMPANY, documentId: ID }, path: `/companies(${COMPANY})/salesOrders(${ID})`, expand: 'salesOrderLines' },
    get_purchase_invoice: {
      input: { companyId: COMPANY, documentId: ID },
      path: `/companies(${COMPANY})/purchaseInvoices(${ID})`,
      expand: 'purchaseInvoiceLines',
    },
    list_journals: { input: { companyId: COMPANY }, path: `/companies(${COMPANY})/journals` },
    list_journal_lines: { input: { companyId: COMPANY, journalId: ID }, path: `/companies(${COMPANY})/journals(${ID})/journalLines` },
    list_dimensions: { input: { companyId: COMPANY }, path: `/companies(${COMPANY})/dimensions`, expand: 'dimensionValues' },
    list_customer_payment_journals: { input: { companyId: COMPANY }, path: `/companies(${COMPANY})/customerPaymentJournals` },
    list_customer_payments: {
      input: { companyId: COMPANY, journalId: ID },
      path: `/companies(${COMPANY})/customerPaymentJournals(${ID})/customerPayments`,
    },
  };

  it('covers every read in the table (the changes are in writes.test.ts)', () => {
    const reads = BC_TOOLS.filter(tool => tool.annotations.readOnlyHint).map(tool => tool.name.replace(/^businesscentral_/, ''));
    expect(Object.keys(inputs).sort()).toEqual(reads.sort());
  });

  for (const [name, { input, path, expand }] of Object.entries(inputs)) {
    it(`${name} makes exactly one GET to its own path`, async () => {
      const { seen, fetchImpl } = recordingFetch(() => json({ value: [] }));
      const gw = createBusinesscentralGateway({ apiKey: TOKEN, baseUrl: BASE, policy: {}, fetchImpl });
      const result = await gw.callTool(name, input as never);
      expect(result.isError, name).toBeFalsy();
      expect(seen.map(s => [s.method, s.url.origin + s.url.pathname])).toEqual([['GET', `${BASE}${path}`]]);
      expect(seen[0]!.url.searchParams.get('$expand')).toBe(expand ?? null);
    });
  }
});

describe('audit fields', () => {
  it('names the ids the tools take, and hashes free text', () => {
    const target = auditTarget({ companyId: COMPANY, customerId: ID, filter: "name eq 'Demo'" }) as Record<string, unknown>;
    expect(target.companyId).toBe(COMPANY);
    expect(target.customerId).toBe(ID);
    expect(JSON.stringify(target)).not.toContain('Demo');
  });
});

describe('HTTP logging', () => {
  let running: RunningHttpServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('never logs a path of its own choosing, a query string or a stack', async () => {
    const logs: string[] = [];
    running = await startHttpServer(
      { host: '127.0.0.1', port: 0, maxBodyBytes: 1024, httpToken: 'test-token-0123456789abcdef0123456789' },
      {
        createMcpServer: () => {
          throw new Error(`boom ${TOKEN}`);
        },
        log: line => logs.push(line),
      },
    );
    const port = running.port;
    const send = (path: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers }, res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end('{}');
      });
    await send(`/${TOKEN}`);
    await send(`/mcp?token=${TOKEN}`, {
      Authorization: 'Bearer test-token-0123456789abcdef0123456789',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    });
    const all = logs.join('\n');
    expect(all).not.toContain(TOKEN.slice(0, 12));
    expect(all).not.toMatch(/\n\s+at /);
    expect(all).toContain('(other path)');
  });
});
