import { BusinesscentralHttpError, nestedFailuresAsStatus } from '../errors.js';
import type { UpstreamClient } from './client.js';
import { guid } from './items.js';

/**
 * Business Central API v2.0 changes. Every path is built from fixed entity names and GUIDs checked here, never from
 * caller text. No function here touches the chart of accounts, bank accounts, users, permission sets or settings, and
 * none deletes anything but a document whose status was read as Draft right before the delete.
 */

/** The refusal texts a host can recognise. Stable prefixes: change them only with a new major version. */
export const REFUSED_NOT_DRAFT = 'Refused: only a draft can be deleted.';
export const REFUSED_NOT_POSTED = 'Refused: only a posted invoice can be sent.';
export const REFUSED_NO_PARTY = 'Refused: give either an id or a number for the';
export const REFUSED_NO_FIELDS = 'Refused: nothing to change.';
export const REFUSED_BAD_CONTENT = 'Refused: the file content is not valid base64 or is too large.';

/** The largest attachment accepted, decoded. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export type SalesKind = 'quote' | 'order' | 'invoice';

/** Each sales document kind: its entity set, its lines and the attachment parent type. Fixed. */
export const SALES_DOCUMENTS: Readonly<Record<SalesKind, { entity: string; lines: string }>> = Object.freeze({
  quote: { entity: 'salesQuotes', lines: 'salesQuoteLines' },
  order: { entity: 'salesOrders', lines: 'salesOrderLines' },
  invoice: { entity: 'salesInvoices', lines: 'salesInvoiceLines' },
});

export const PURCHASE_INVOICE = Object.freeze({ entity: 'purchaseInvoices', lines: 'purchaseInvoiceLines' });

type Json = Record<string, unknown>;

export interface DimensionInput {
  dimensionId: string;
  valueCode: string;
}

export interface LineInput {
  dimensions?: DimensionInput[];
  [field: string]: unknown;
}

const company = (companyId: string) => `/companies(${guid(companyId, 'companyId')})`;

/** Only the fields given, in a fresh object: an absent field is never sent as null. */
export function pick(input: Json, fields: readonly string[]): Json {
  const out: Json = {};
  for (const field of fields) {
    if (Object.hasOwn(input, field) && input[field] !== undefined) out[field] = input[field];
  }
  return out;
}

function record(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

/** The HTTP status of a failed request, or undefined. Never the error's text. */
function statusOf(error: unknown): number | undefined {
  return error instanceof BusinesscentralHttpError ? error.status : undefined;
}

/** A failure inside an otherwise returned answer: the step, the position and the HTTP status only. */
function failure(step: string, position: number | undefined, error: unknown): Json {
  const status = statusOf(error);
  return {
    step,
    ...(position === undefined ? {} : { position }),
    ...(status === undefined ? {} : { httpStatus: status }),
    error: status === undefined ? 'Businesscentral API request failed.' : `Businesscentral API request failed with HTTP ${status}`,
  };
}

/** The party (customer or vendor) of a new document: by id or by number, at least one. */
export function party(input: Json, kind: 'customer' | 'vendor'): Json {
  const idField = `${kind}Id`;
  const numberField = `${kind}Number`;
  const out = pick(input, [idField, numberField]);
  if (Object.keys(out).length === 0) throw new Error(`${REFUSED_NO_PARTY} ${kind}.`);
  return out;
}

export async function createRecord(client: UpstreamClient, companyId: string, entity: string, body: Json): Promise<unknown> {
  return nestedFailuresAsStatus(await client.post(`${company(companyId)}/${entity}`, body));
}

export async function updateRecord(
  client: UpstreamClient,
  companyId: string,
  entity: string,
  id: string,
  body: Json,
): Promise<unknown> {
  if (Object.keys(body).length === 0) throw new Error(REFUSED_NO_FIELDS);
  return nestedFailuresAsStatus(await client.patch(`${company(companyId)}/${entity}(${guid(id, 'id')})`, body));
}

/**
 * Set dimensions on one line, one request each, under `base` (the path the line's dimensionSetLines hang under).
 * Returns the failure of the first one that fails, if any.
 */
async function setDimensions(
  client: UpstreamClient,
  base: string,
  dimensions: DimensionInput[] | undefined,
): Promise<{ set: number; failed?: unknown }> {
  let set = 0;
  for (const dimension of dimensions ?? []) {
    try {
      await client.post(`${base}/dimensionSetLines`, {
        id: guid(dimension.dimensionId, 'dimensionId'),
        valueCode: dimension.valueCode,
      });
      set += 1;
    } catch (error) {
      return { set, failed: error };
    }
  }
  return { set };
}

/**
 * Create lines under a parent (a document or a journal), with their dimensions. Stops at the first failure and says
 * what was made: a partly made document is never hidden.
 */
async function createLines(
  client: UpstreamClient,
  companyId: string,
  parentPath: string,
  linesEntity: string,
  lines: LineInput[],
  fields: readonly string[],
  dimensionsUnderParent: boolean,
): Promise<{ lines: unknown[]; failure?: Json }> {
  const made: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    let created: Json;
    try {
      created = record(await client.post(`${parentPath}/${linesEntity}`, pick(line, fields)));
    } catch (error) {
      return { lines: made, failure: failure('line', index + 1, error) };
    }
    made.push(nestedFailuresAsStatus(created));
    if (line.dimensions?.length) {
      if (typeof created.id !== 'string') {
        return { lines: made, failure: failure('dimension', index + 1, undefined) };
      }
      // A document line's dimensions hang under its document (Business Central answers 400 on the top-level lines entity,
      // #21); a journal line's under the company's journalLines, which Business Central takes.
      const lineId = guid(created.id, 'lineId');
      const base = dimensionsUnderParent ? `${parentPath}/${linesEntity}(${lineId})` : `${company(companyId)}/${linesEntity}(${lineId})`;
      const dims = await setDimensions(client, base, line.dimensions);
      if (dims.failed !== undefined) return { lines: made, failure: failure('dimension', index + 1, dims.failed) };
    }
  }
  return { lines: made };
}

/** A new document with its lines: the header first, then each line. Nothing is posted. */
export async function createDocument(
  client: UpstreamClient,
  companyId: string,
  document: { entity: string; lines: string },
  header: Json,
  lines: LineInput[],
  lineFields: readonly string[],
): Promise<unknown> {
  const created = record(await client.post(`${company(companyId)}/${document.entity}`, header));
  if (typeof created.id !== 'string') {
    return { document: nestedFailuresAsStatus(created), lines: [], incomplete: true, failure: failure('line', 1, undefined) };
  }
  const parentPath = `${company(companyId)}/${document.entity}(${guid(created.id, 'documentId')})`;
  const result = await createLines(client, companyId, parentPath, document.lines, lines, lineFields, true);
  return {
    document: nestedFailuresAsStatus(created),
    lines: result.lines,
    ...(result.failure ? { incomplete: true, failure: result.failure } : {}),
  };
}

/** The status word passed on in a refusal: one of Business Central's own, or a fixed word. */
function statusWord(value: unknown): string {
  const known = ['Draft', 'In Review', 'Open', 'Released', 'Paid', 'Canceled', 'Corrective', 'Sent', 'Accepted', 'Expired'];
  return typeof value === 'string' && known.includes(value) ? value : 'another status';
}

/**
 * Delete a document only when Business Central says it is a draft. The status is read right before the delete, and
 * the delete carries that read's etag, so a document that changed in between is not deleted.
 */
export async function deleteDraft(client: UpstreamClient, companyId: string, entity: string, documentId: string): Promise<unknown> {
  const path = `${company(companyId)}/${entity}(${guid(documentId, 'documentId')})`;
  const current = record(await client.get(path));
  if (current.status !== 'Draft') {
    throw new Error(`${REFUSED_NOT_DRAFT} This document has status ${statusWord(current.status)}.`);
  }
  // The read's own version, never a wildcard: a document that changed since the read is not deleted.
  const etag = typeof current['@odata.etag'] === 'string' ? (current['@odata.etag'] as string).trim() : '';
  if (etag === '' || etag === '*') throw new Error(`${REFUSED_NOT_DRAFT} Business Central gave no record version to delete.`);
  await client.delete(path, etag);
  return { deleted: true, id: current.id, number: current.number };
}

/** The document after a bound action, when it can be read; a failed read after a done action is not an error. */
async function afterAction(client: UpstreamClient, path: string, id: string): Promise<Json> {
  try {
    const now = record(await client.get(path));
    return { id: now.id ?? id, number: now.number, status: now.status };
  } catch {
    return { id };
  }
}

/** A bound action (Microsoft.NAV.post, Microsoft.NAV.send) on one document or journal. */
export async function boundAction(
  client: UpstreamClient,
  companyId: string,
  entity: string,
  id: string,
  action: 'post' | 'send',
): Promise<unknown> {
  const path = `${company(companyId)}/${entity}(${guid(id, 'id')})`;
  await client.post(`${path}/Microsoft.NAV.${action}`);
  const done = action === 'post' ? { posted: true } : { sent: true };
  return entity === 'journals' ? { ...done, journalId: id } : { ...done, ...(await afterAction(client, path, id)) };
}

/** Send a posted sales invoice by e-mail, after reading that it is posted (Open or Paid). */
export async function sendSalesInvoice(client: UpstreamClient, companyId: string, invoiceId: string): Promise<unknown> {
  const path = `${company(companyId)}/salesInvoices(${guid(invoiceId, 'invoiceId')})`;
  const current = record(await client.get(path));
  if (current.status !== 'Open' && current.status !== 'Paid') {
    throw new Error(`${REFUSED_NOT_POSTED} This invoice has status ${statusWord(current.status)}.`);
  }
  return boundAction(client, companyId, 'salesInvoices', invoiceId, 'send');
}

/** Lines in a general journal batch, with their dimensions. Nothing is posted. */
export async function addJournalLines(
  client: UpstreamClient,
  companyId: string,
  journalId: string,
  lines: LineInput[],
  fields: readonly string[],
): Promise<unknown> {
  const parentPath = `${company(companyId)}/journals(${guid(journalId, 'journalId')})`;
  const result = await createLines(client, companyId, parentPath, 'journalLines', lines, fields, false);
  return { journalId, lines: result.lines, ...(result.failure ? { incomplete: true, failure: result.failure } : {}) };
}

/** A payment line in a customer payment journal. It records the payment in the books, is not posted and moves no money. */
export async function registerCustomerPayment(
  client: UpstreamClient,
  companyId: string,
  journalId: string,
  body: Json,
): Promise<unknown> {
  return nestedFailuresAsStatus(
    await client.post(`${company(companyId)}/customerPaymentJournals(${guid(journalId, 'journalId')})/customerPayments`, body),
  );
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The decoded bytes of a base64 text, or a refusal: no other alphabet, no line breaks, not over the limit. */
export function decodeContent(text: string): Uint8Array {
  const clean = text.trim();
  if (clean.length === 0 || clean.length % 4 !== 0 || !BASE64.test(clean) || (clean.length / 4) * 3 > MAX_ATTACHMENT_BYTES + 3) {
    throw new Error(REFUSED_BAD_CONTENT);
  }
  const bytes = Uint8Array.from(Buffer.from(clean, 'base64'));
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(REFUSED_BAD_CONTENT);
  return bytes;
}

/** Attach a file to a document or a journal: the attachment record first, then its content with the record's etag. */
export async function attachDocument(
  client: UpstreamClient,
  companyId: string,
  input: { parentType: string; parentId: string; fileName: string; contentBase64: string },
): Promise<unknown> {
  const bytes = decodeContent(input.contentBase64);
  const created = record(
    await client.post(`${company(companyId)}/documentAttachments`, {
      fileName: input.fileName,
      parentType: input.parentType,
      parentId: guid(input.parentId, 'parentId'),
    }),
  );
  if (typeof created.id !== 'string') {
    return { attachment: nestedFailuresAsStatus(created), incomplete: true, failure: failure('content', undefined, undefined) };
  }
  const etag = typeof created['@odata.etag'] === 'string' ? (created['@odata.etag'] as string) : undefined;
  const summary = { id: created.id, fileName: created.fileName, parentType: created.parentType, parentId: created.parentId, bytes: bytes.length };
  try {
    await client.patchBinary(`${company(companyId)}/documentAttachments(${guid(created.id, 'attachmentId')})/attachmentContent`, bytes, etag);
  } catch (error) {
    return { attachment: summary, incomplete: true, failure: failure('content', undefined, error) };
  }
  return { attachment: summary };
}
