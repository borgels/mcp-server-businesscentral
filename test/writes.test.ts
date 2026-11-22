import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOnlyClient, type UpstreamClient } from '../src/businesscentral/client.js';
import { MAX_ATTACHMENT_BYTES, REFUSED_BAD_CONTENT, REFUSED_NOT_DRAFT, REFUSED_NOT_POSTED, REFUSED_NO_FIELDS } from '../src/businesscentral/writes.js';
import { createBusinesscentralGateway } from '../src/gateway.js';

const BASE = 'https://api.businesscentral.dynamics.com/v2.0/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/Production/api/v2.0';
const COMPANY = '11111111-2222-4333-8444-555555555555';
const DOC = '22222222-3333-4444-8555-666666666666';
const LINE1 = '33333333-4444-4555-8666-777777777777';
const LINE2 = '44444444-5555-4666-8777-888888888888';
const DIM = '55555555-6666-4777-8888-999999999999';
const JOURNAL = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const ATTACHMENT = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const ETAG = 'W/"JzQ0O0VnQUFBQUo3LzBNQUFBQUFBQUE9MTsxMjM0NTY3ODk7Jw=="';
const TOKEN = `eyJ0eXAiOiJKV1Qi.${'Qm4Rt'.repeat(8)}.sig-${'Hd2Wy'.repeat(6)}`;
const C = `${BASE}/companies(${COMPANY})`;

const originalEnv = { ...process.env };
beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('BC_')) delete process.env[name];
});
afterEach(() => {
  process.env = { ...originalEnv };
});

type Seen = { method: string; url: string; headers: Record<string, string>; body: unknown };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const empty = () => new Response(null, { status: 204 });

function host(answer: (method: string, url: string) => Response, enableWrites = true) {
  const seen: Seen[] = [];
  const gw = createBusinesscentralGateway({
    apiKey: TOKEN,
    baseUrl: BASE,
    policy: { enableWrites },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input).split('?')[0]!;
      const method = init?.method ?? 'GET';
      const raw = init?.body;
      const body = typeof raw === 'string' ? JSON.parse(raw) : raw instanceof Uint8Array ? raw : undefined;
      seen.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body });
      return answer(method, url);
    }) as typeof fetch,
  });
  return { gw, seen };
}

const calls = (seen: Seen[]) => seen.map(s => `${s.method} ${s.url.replace(BASE, '')}`);
const text = (result: { content: Array<{ text: string }> }) => result.content.map(c => c.text).join(' ');

describe('writes are off unless the host turns them on', () => {
  it('refuses a change and sends nothing', async () => {
    const { gw, seen } = host(() => json({ id: DOC }), false);
    const result = await gw.callTool('create_customer', { companyId: COMPANY, displayName: 'Demo Kunde' });
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

describe('customers, vendors and items', () => {
  it('creates a customer with the fields given, and nothing else', async () => {
    const { gw, seen } = host(() => json({ id: DOC, number: 'C0001', displayName: 'Demo Kunde' }, 201));
    const result = await gw.callTool('create_customer', { companyId: COMPANY, displayName: 'Demo Kunde', city: 'Aarhus', email: 'demo@example.com' });
    expect(result.isError).toBeFalsy();
    expect(calls(seen)).toEqual([`POST /companies(${COMPANY})/customers`]);
    expect(seen[0]!.body).toEqual({ displayName: 'Demo Kunde', city: 'Aarhus', email: 'demo@example.com' });
    expect(seen[0]!.headers['Content-Type']).toBe('application/json');
  });

  it('refuses a field it does not know, such as a bank account, before anything is sent', async () => {
    const { gw, seen } = host(() => json({}));
    for (const tool of ['create_customer', 'create_vendor']) {
      const result = await gw.callTool(tool, { companyId: COMPANY, displayName: 'Demo', bankAccountNumber: '1234' });
      expect(result.isError, tool).toBe(true);
    }
    expect(seen).toHaveLength(0);
  });

  it('updates only the fields given, with If-Match', async () => {
    const { gw, seen } = host(() => json({ id: DOC }));
    const result = await gw.callTool('update_vendor', { companyId: COMPANY, vendorId: DOC, phoneNumber: '12345678' });
    expect(result.isError).toBeFalsy();
    expect(calls(seen)).toEqual([`PATCH /companies(${COMPANY})/vendors(${DOC})`]);
    expect(seen[0]!.body).toEqual({ phoneNumber: '12345678' });
    expect(seen[0]!.headers['If-Match']).toBe('*');
  });

  it('refuses an update with nothing to change', async () => {
    const { gw, seen } = host(() => json({}));
    const result = await gw.callTool('update_item', { companyId: COMPANY, itemId: DOC });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(REFUSED_NO_FIELDS);
    expect(seen).toHaveLength(0);
  });

  it('creates an item', async () => {
    const { gw, seen } = host(() => json({ id: DOC }, 201));
    await gw.callTool('create_item', { companyId: COMPANY, displayName: 'Kaffe', type: 'Inventory', unitPrice: 12.5 });
    expect(calls(seen)).toEqual([`POST /companies(${COMPANY})/items`]);
    expect(seen[0]!.body).toEqual({ displayName: 'Kaffe', type: 'Inventory', unitPrice: 12.5 });
  });
});

describe('sales documents', () => {
  it('creates the header, then each line, with a line dimension after its line', async () => {
    let line = 0;
    const { gw, seen } = host((method, url) => {
      if (url === `${C}/salesInvoices`) return json({ id: DOC, number: '1001', status: 'Draft' }, 201);
      if (url.endsWith('/salesInvoiceLines')) return json({ id: [LINE1, LINE2][line++], sequence: line * 10000 }, 201);
      return json({ id: DIM, valueCode: 'SALG' }, 201);
    });
    const result = await gw.callTool('create_sales_invoice', {
      companyId: COMPANY,
      customerNumber: '10000',
      invoiceDate: '2026-11-22',
      lines: [
        { lineType: 'Item', lineObjectNumber: '1896-S', quantity: 2, unitPrice: 100, dimensions: [{ dimensionId: DIM, valueCode: 'SALG' }] },
        { lineType: 'Comment', description: 'Tak for handlen' },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(calls(seen)).toEqual([
      `POST /companies(${COMPANY})/salesInvoices`,
      `POST /companies(${COMPANY})/salesInvoices(${DOC})/salesInvoiceLines`,
      `POST /companies(${COMPANY})/salesInvoiceLines(${LINE1})/dimensionSetLines`,
      `POST /companies(${COMPANY})/salesInvoices(${DOC})/salesInvoiceLines`,
    ]);
    expect(seen[0]!.body).toEqual({ customerNumber: '10000', invoiceDate: '2026-11-22' });
    expect(seen[1]!.body).toEqual({ lineType: 'Item', lineObjectNumber: '1896-S', quantity: 2, unitPrice: 100 });
    expect(seen[2]!.body).toEqual({ id: DIM, valueCode: 'SALG' });
    const data = result.structuredContent as { document: { number: string }; lines: unknown[]; incomplete?: boolean };
    expect(data.document.number).toBe('1001');
    expect(data.lines).toHaveLength(2);
    expect(data.incomplete).toBeUndefined();
  });

  it('says what was made when a line fails, with the status only', async () => {
    const { gw, seen } = host((_method, url) => {
      if (url === `${C}/salesQuotes`) return json({ id: DOC, number: 'T1', status: 'Draft' }, 201);
      if (seen.filter(s => s.url.endsWith('/salesQuoteLines')).length === 2) {
        return new Response(JSON.stringify({ error: { message: `secret vendor text ${TOKEN}` } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return json({ id: LINE1 }, 201);
    });
    const result = await gw.callTool('create_sales_quote', {
      companyId: COMPANY,
      customerId: DOC,
      lines: [{ description: 'a' }, { description: 'b' }, { description: 'c' }],
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { lines: unknown[]; incomplete: boolean; failure: Record<string, unknown> };
    expect(data.incomplete).toBe(true);
    expect(data.lines).toHaveLength(1);
    expect(data.failure).toEqual({ step: 'line', position: 2, httpStatus: 400, error: 'Businesscentral API request failed with HTTP 400' });
    expect(JSON.stringify(result)).not.toContain('secret vendor text');
    expect(seen).toHaveLength(3);
  });

  it('refuses a document without a customer before anything is sent', async () => {
    const { gw, seen } = host(() => json({}));
    const result = await gw.callTool('create_sales_order', { companyId: COMPANY, lines: [{ description: 'a' }] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Refused: give either an id or a number for the customer.');
    expect(seen).toHaveLength(0);
  });

  it('deletes a draft with the etag of the read right before', async () => {
    const { gw, seen } = host(method => (method === 'GET' ? json({ id: DOC, number: 'O1', status: 'Draft', '@odata.etag': ETAG }) : empty()));
    const result = await gw.callTool('delete_sales_draft', { companyId: COMPANY, documentType: 'order', documentId: DOC });
    expect(result.isError).toBeFalsy();
    expect(calls(seen)).toEqual([`GET /companies(${COMPANY})/salesOrders(${DOC})`, `DELETE /companies(${COMPANY})/salesOrders(${DOC})`]);
    expect(seen[1]!.headers['If-Match']).toBe(ETAG);
    expect(result.structuredContent).toEqual({ deleted: true, id: DOC, number: 'O1' });
  });

  it('refuses to delete anything that is not a draft', async () => {
    for (const status of ['Open', 'Paid', 'Sent', 'Released', 'something new']) {
      const { gw, seen } = host(() => json({ id: DOC, status, '@odata.etag': ETAG }));
      const result = await gw.callTool('delete_sales_draft', { companyId: COMPANY, documentType: 'invoice', documentId: DOC });
      expect(result.isError, status).toBe(true);
      expect(text(result)).toContain(REFUSED_NOT_DRAFT);
      expect(text(result)).not.toContain('something new');
      expect(calls(seen)).toEqual([`GET /companies(${COMPANY})/salesInvoices(${DOC})`]);
    }
  });

  it('posts an invoice with the bound action and reads it back', async () => {
    const { gw, seen } = host(method => (method === 'POST' ? empty() : json({ id: DOC, number: '103001', status: 'Open' })));
    const result = await gw.callTool('post_sales_invoice', { companyId: COMPANY, invoiceId: DOC });
    expect(result.isError).toBeFalsy();
    expect(calls(seen)).toEqual([
      `POST /companies(${COMPANY})/salesInvoices(${DOC})/Microsoft.NAV.post`,
      `GET /companies(${COMPANY})/salesInvoices(${DOC})`,
    ]);
    expect(result.structuredContent).toEqual({ posted: true, id: DOC, number: '103001', status: 'Open' });
  });

  it('says it is posted even when the read afterwards fails', async () => {
    const { gw } = host(method => (method === 'POST' ? empty() : new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })));
    const result = await gw.callTool('post_sales_invoice', { companyId: COMPANY, invoiceId: DOC });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ posted: true, id: DOC });
  });

  it('sends only a posted invoice', async () => {
    const draft = host(() => json({ id: DOC, status: 'Draft' }));
    const refused = await draft.gw.callTool('send_sales_invoice', { companyId: COMPANY, invoiceId: DOC });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain(REFUSED_NOT_POSTED);
    expect(calls(draft.seen)).toEqual([`GET /companies(${COMPANY})/salesInvoices(${DOC})`]);

    const open = host(method => (method === 'POST' ? empty() : json({ id: DOC, number: '103001', status: 'Open' })));
    const sent = await open.gw.callTool('send_sales_invoice', { companyId: COMPANY, invoiceId: DOC });
    expect(sent.isError).toBeFalsy();
    expect(calls(open.seen)).toContain(`POST /companies(${COMPANY})/salesInvoices(${DOC})/Microsoft.NAV.send`);
  });
});

describe('purchase invoices', () => {
  it('creates a draft with a direct unit cost per line', async () => {
    const { gw, seen } = host((_m, url) => (url.endsWith('purchaseInvoices') ? json({ id: DOC, status: 'Draft' }, 201) : json({ id: LINE1 }, 201)));
    const result = await gw.callTool('create_purchase_invoice', {
      companyId: COMPANY,
      vendorNumber: '20000',
      vendorInvoiceNumber: 'F-77',
      lines: [{ lineType: 'Account', lineObjectNumber: '6100', quantity: 1, directUnitCost: 500 }],
    });
    expect(result.isError).toBeFalsy();
    expect(calls(seen)).toEqual([
      `POST /companies(${COMPANY})/purchaseInvoices`,
      `POST /companies(${COMPANY})/purchaseInvoices(${DOC})/purchaseInvoiceLines`,
    ]);
    expect(seen[0]!.body).toEqual({ vendorNumber: '20000', vendorInvoiceNumber: 'F-77' });
    expect(seen[1]!.body).toEqual({ lineType: 'Account', lineObjectNumber: '6100', quantity: 1, directUnitCost: 500 });
  });

  it('posts and deletes a draft only', async () => {
    const posted = host(method => (method === 'POST' ? empty() : json({ id: DOC, status: 'Open' })));
    await posted.gw.callTool('post_purchase_invoice', { companyId: COMPANY, invoiceId: DOC });
    expect(calls(posted.seen)[0]).toBe(`POST /companies(${COMPANY})/purchaseInvoices(${DOC})/Microsoft.NAV.post`);

    const open = host(() => json({ id: DOC, status: 'Open', '@odata.etag': ETAG }));
    const refused = await open.gw.callTool('delete_purchase_invoice_draft', { companyId: COMPANY, documentId: DOC });
    expect(refused.isError).toBe(true);
    expect(open.seen.every(s => s.method === 'GET')).toBe(true);
  });
});

describe('journals and payments', () => {
  it('adds journal lines with dimensions and posts the journal', async () => {
    const { gw, seen } = host((method, url) => (url.endsWith('Microsoft.NAV.post') ? empty() : json({ id: url.endsWith('journalLines') ? LINE1 : DIM }, 201)));
    const added = await gw.callTool('add_journal_lines', {
      companyId: COMPANY,
      journalId: JOURNAL,
      lines: [{ accountNumber: '6100', postingDate: '2026-11-22', amount: 250, description: 'Kontorartikler', dimensions: [{ dimensionId: DIM, valueCode: 'ADM' }] }],
    });
    expect(added.isError).toBeFalsy();
    const posted = await gw.callTool('post_journal', { companyId: COMPANY, journalId: JOURNAL });
    expect(posted.isError).toBeFalsy();
    expect(posted.structuredContent).toEqual({ posted: true, journalId: JOURNAL });
    expect(calls(seen)).toEqual([
      `POST /companies(${COMPANY})/journals(${JOURNAL})/journalLines`,
      `POST /companies(${COMPANY})/journalLines(${LINE1})/dimensionSetLines`,
      `POST /companies(${COMPANY})/journals(${JOURNAL})/Microsoft.NAV.post`,
    ]);
    expect(seen[0]!.body).toEqual({ accountNumber: '6100', postingDate: '2026-11-22', amount: 250, description: 'Kontorartikler' });
  });

  it('registers a customer payment in the payment journal, applied to an invoice, without posting', async () => {
    const { gw, seen } = host(() => json({ id: LINE1, amount: 1500 }, 201));
    const result = await gw.callTool('register_customer_payment', {
      companyId: COMPANY,
      journalId: JOURNAL,
      customerNumber: '10000',
      amount: 1500,
      postingDate: '2026-11-22',
      appliesToInvoiceId: DOC,
    });
    expect(result.isError).toBeFalsy();
    expect(calls(seen)).toEqual([`POST /companies(${COMPANY})/customerPaymentJournals(${JOURNAL})/customerPayments`]);
    expect(seen[0]!.body).toEqual({ customerNumber: '10000', amount: 1500, postingDate: '2026-11-22', appliesToInvoiceId: DOC });
  });

  it('refuses a payment that is not positive', async () => {
    const { gw, seen } = host(() => json({}));
    const result = await gw.callTool('register_customer_payment', { companyId: COMPANY, journalId: JOURNAL, customerNumber: '1', amount: -5, postingDate: '2026-11-22' });
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

describe('attachments', () => {
  it('creates the attachment, then sends its content as bytes with the etag', async () => {
    const { gw, seen } = host(method =>
      method === 'POST' ? json({ id: ATTACHMENT, fileName: 'bilag.pdf', parentType: 'Purchase Invoice', parentId: DOC, '@odata.etag': ETAG }, 201) : empty(),
    );
    const content = Buffer.from('%PDF-1.4 demo').toString('base64');
    const result = await gw.callTool('attach_document', { companyId: COMPANY, parentType: 'Purchase Invoice', parentId: DOC, fileName: 'bilag.pdf', contentBase64: content });
    expect(result.isError).toBeFalsy();
    expect(calls(seen)).toEqual([
      `POST /companies(${COMPANY})/documentAttachments`,
      `PATCH /companies(${COMPANY})/documentAttachments(${ATTACHMENT})/attachmentContent`,
    ]);
    expect(seen[0]!.body).toEqual({ fileName: 'bilag.pdf', parentType: 'Purchase Invoice', parentId: DOC });
    expect(seen[1]!.headers['Content-Type']).toBe('application/octet-stream');
    expect(seen[1]!.headers['If-Match']).toBe(ETAG);
    expect(Buffer.from(seen[1]!.body as Uint8Array).toString()).toBe('%PDF-1.4 demo');
    expect((result.structuredContent as { attachment: { bytes: number } }).attachment.bytes).toBe(13);
  });

  it('refuses content that is not base64 or too large, before anything is sent', async () => {
    const { gw, seen } = host(() => json({}));
    for (const contentBase64 of ['not base64!!', 'QUJD\nREVG', 'A'.repeat(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 8)]) {
      const result = await gw.callTool('attach_document', { companyId: COMPANY, parentType: 'Journal', parentId: DOC, fileName: 'a.pdf', contentBase64 });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(REFUSED_BAD_CONTENT);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses a file name with a path', async () => {
    const { gw, seen } = host(() => json({}));
    const result = await gw.callTool('attach_document', { companyId: COMPANY, parentType: 'Journal', parentId: DOC, fileName: '../a.pdf', contentBase64: 'QUJD' });
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('says the content is missing when its upload fails', async () => {
    const { gw } = host(method => (method === 'POST' ? json({ id: ATTACHMENT, '@odata.etag': ETAG }, 201) : json({}, 409)));
    const result = await gw.callTool('attach_document', { companyId: COMPANY, parentType: 'Journal', parentId: DOC, fileName: 'a.pdf', contentBase64: 'QUJD' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ incomplete: true, failure: { step: 'content', httpStatus: 409 } });
  });
});

describe('errors', () => {
  it('passes on the status, never the vendor text or the token', async () => {
    const { gw } = host(() => new Response(`denied for ${TOKEN}`, { status: 403 }));
    const result = await gw.callTool('post_sales_invoice', { companyId: COMPANY, invoiceId: DOC });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('HTTP 403');
    expect(JSON.stringify(result)).not.toContain('denied for');
    expect(JSON.stringify(result)).not.toContain(TOKEN.slice(0, 12));
  });

  it('never retries a change', async () => {
    const { gw, seen } = host(() => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    await gw.callTool('post_journal', { companyId: COMPANY, journalId: JOURNAL });
    expect(seen).toHaveLength(1);
  });
});

describe('the read-only client view', () => {
  it('refuses every method but GET', async () => {
    const calls: string[] = [];
    const inner: UpstreamClient = {
      get: async () => (calls.push('GET'), {}) as never,
      post: async () => (calls.push('POST'), {}) as never,
      patch: async () => (calls.push('PATCH'), {}) as never,
      patchBinary: async () => (calls.push('PATCH'), {}) as never,
      delete: async () => (calls.push('DELETE'), {}) as never,
    };
    const view = readOnlyClient(inner, 'businesscentral_list_customers');
    await expect(view.post('/x')).rejects.toThrow(/refused/);
    await expect(view.patch('/x', {})).rejects.toThrow(/refused/);
    await expect(view.patchBinary('/x', new Uint8Array([1]))).rejects.toThrow(/refused/);
    await expect(view.delete('/x', '*')).rejects.toThrow(/refused/);
    await view.get('/x');
    expect(calls).toEqual(['GET']);
  });
});
