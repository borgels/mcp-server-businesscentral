import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_KEY_HEADER } from '../src/businesscentral/client.js';
import { createBusinesscentralGateway, businesscentralGatewayTools, businesscentralToolCatalog } from '../src/gateway.js';
import { BC_TOOLS } from '../src/tools/businesscentral.js';
import { connect, texts } from './helpers.js';

const BASE = 'https://api.businesscentral.dynamics.com/v2.0/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/Production/api/v2.0';
const COMPANY = '11111111-2222-4333-8444-555555555555';
const CUSTOMER = '66666666-7777-4888-9999-000000000000';
// A bearer token shaped as Entra gives it: long, base64url pieces. Built at runtime, never a real one.
const TOKEN = `eyJ0eXAiOiJKV1Qi.${'Zq9Xw'.repeat(8)}.sig-${'Pv7Lk'.repeat(6)}`;
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('BC_')) delete process.env[name];
});
afterEach(() => {
  process.env = { ...originalEnv };
});

type Seen = { url: URL; headers: Record<string, string>; method: string };

function host(answer: (url: URL) => Response, options: { apiKey?: string; baseUrl?: string } = {}) {
  const seen: Seen[] = [];
  const gw = createBusinesscentralGateway({
    apiKey: options.apiKey ?? TOKEN,
    baseUrl: options.baseUrl ?? BASE,
    policy: {},
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, method: init?.method ?? 'GET' });
      return answer(url);
    }) as typeof fetch,
  });
  return { gw, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the tool table', () => {
  it('has fixed reads and non-destructive changes, and no broad tool', () => {
    const reads = businesscentralToolCatalog.filter(entry => entry.riskLevel === 'read').map(entry => entry.name);
    const changes = businesscentralToolCatalog.filter(entry => entry.riskLevel !== 'read').map(entry => entry.name);
    expect(reads.sort()).toEqual(
      [
        'get_customer',
        'get_purchase_invoice',
        'get_sales_invoice',
        'get_sales_order',
        'get_sales_quote',
        'list_accounts',
        'list_companies',
        'list_customer_payment_journals',
        'list_customer_payments',
        'list_customers',
        'list_dimensions',
        'list_general_ledger_entries',
        'list_items',
        'list_journal_lines',
        'list_journals',
        'list_purchase_invoices',
        'list_sales_invoices',
        'list_sales_orders',
        'list_sales_quotes',
        'list_vendors',
      ].sort(),
    );
    expect(changes.sort()).toEqual(
      [
        'add_journal_lines',
        'attach_document',
        'create_customer',
        'create_item',
        'create_purchase_invoice',
        'create_sales_invoice',
        'create_sales_order',
        'create_sales_quote',
        'create_vendor',
        'delete_purchase_invoice_draft',
        'delete_sales_draft',
        'post_journal',
        'post_purchase_invoice',
        'post_sales_invoice',
        'register_customer_payment',
        'send_sales_invoice',
        'update_customer',
        'update_item',
        'update_vendor',
      ].sort(),
    );
    for (const entry of businesscentralToolCatalog) {
      expect(entry.broad, entry.name).toBe(false);
      expect(entry.riskLevel, entry.name).not.toBe('destructive');
      if (entry.riskLevel === 'read') {
        expect(
          entry.upstream.every(op => op.access === 'read' && op.method === 'GET'),
          entry.name,
        ).toBe(true);
        expect(entry.enabledByDefault, entry.name).toBe(true);
      } else {
        expect(entry.riskLevel, entry.name).toBe('write');
        expect(entry.enabledByDefault, entry.name).toBe(false);
        expect(entry.upstream.some(op => op.access === 'write'), entry.name).toBe(true);
      }
      // Never the chart of accounts, bank accounts, users, permissions or settings.
      for (const op of entry.upstream) {
        if (op.access === 'write') expect(op.path, entry.name).not.toMatch(/accounts\(|bankAccount|users|permission|setup|companyInformation/i);
      }
    }
    expect(businesscentralGatewayTools.length).toBe(BC_TOOLS.length);
  });
});

describe('requests', () => {
  it('sends the bearer token to the company-scoped entity with a page size, and nothing else', async () => {
    const { gw, seen } = host(() => json({ value: [{ number: '10000', displayName: 'Demo Kunde' }] }));
    const result = await gw.callTool('list_customers', { companyId: COMPANY, filter: "number eq '10000'" });
    expect(result.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.origin + seen[0]!.url.pathname).toBe(`${BASE}/companies(${COMPANY})/customers`);
    expect(seen[0]!.url.searchParams.get('$top')).toBe('50');
    expect(seen[0]!.url.searchParams.get('$filter')).toBe("number eq '10000'");
    expect(seen[0]!.headers[API_KEY_HEADER]).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(result.structuredContent)).toContain('Demo Kunde');
  });

  it('reads one customer with its financial details, and one invoice with its lines', async () => {
    const { gw, seen } = host(() => json({ id: CUSTOMER }));
    await gw.callTool('get_customer', { companyId: COMPANY, customerId: CUSTOMER });
    await gw.callTool('get_sales_invoice', { companyId: COMPANY, invoiceId: CUSTOMER });
    expect(seen[0]!.url.pathname.endsWith(`/companies(${COMPANY})/customers(${CUSTOMER})`)).toBe(true);
    expect(seen[0]!.url.searchParams.get('$expand')).toBe('customerFinancialDetails');
    expect(seen[1]!.url.searchParams.get('$expand')).toBe('salesInvoiceLines');
  });

  it('refuses non-GUID ids, unknown fields and a page size out of range before any request', async () => {
    const { gw, seen } = host(() => json({}));
    for (const input of [
      { companyId: '../x' },
      { companyId: COMPANY, extra: 1 },
      { companyId: COMPANY, top: 1000 },
      { companyId: `${COMPANY})/vendorBankAccounts(` },
    ]) {
      expect((await gw.callTool('list_customers', input as never)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(seen).toHaveLength(0);
  });
});

describe('the token', () => {
  it('is required, never read from the environment, and only sent to Business Central', () => {
    process.env.BC_API_KEY = TOKEN;
    process.env.BC_BASE_URL = BASE;
    expect(() => createBusinesscentralGateway({ baseUrl: BASE } as never)).toThrow();
    expect(() => host(() => json({}), { baseUrl: 'https://elsewhere.invalid/api/v2.0' })).toThrow();
  });

  it('never appears in an error, which carries only the status', async () => {
    const { gw } = host(() => new Response(`token rejected ${TOKEN}`, { status: 401 }));
    const result = await gw.callTool('list_companies', {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN.slice(0, 12));
    expect(texts(result).join(' ')).toMatch(/401/);
  });

  it('withholds a result that holds a piece of it', async () => {
    const piece = TOKEN.slice(20, 40);
    const { gw } = host(() => json({ value: [{ note: piece }] }));
    const result = await gw.callTool('list_companies', {});
    expect(JSON.stringify(result)).not.toContain(piece);
  });

  it('belongs to its own instance: two tenants in one process never see each other', async () => {
    const other = `eyJ0eXAiOiJKV1Qi.${'Mn3Rt'.repeat(8)}.sig-${'Hb2Wd'.repeat(6)}`;
    const a = host(() => json({ value: [] }));
    const b = host(() => json({ value: [] }), { apiKey: other, baseUrl: BASE.replace('aaaaaaaa', 'bbbbbbbb') });
    await Promise.all([a.gw.callTool('list_companies', {}), b.gw.callTool('list_companies', {})]);
    expect(a.seen[0]!.headers[API_KEY_HEADER]).toBe(`Bearer ${TOKEN}`);
    expect(b.seen[0]!.headers[API_KEY_HEADER]).toBe(`Bearer ${other}`);
    expect(b.seen[0]!.url.pathname).toContain('/bbbbbbbb-');
  });
});

describe('MCP server', () => {
  it('registers every tool, reads as read-only and changes as non-destructive writes', async () => {
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(BC_TOOLS.map(tool => tool.name).sort());
    for (const tool of tools) {
      const read = /^businesscentral_(list|get)_/.test(tool.name);
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(read);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });
});
