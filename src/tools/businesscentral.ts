import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import {
  CHANGE_TOOL_ANNOTATIONS,
  READ_TOOL_ANNOTATIONS,
  UNTRUSTED_CONTENT_NOTE,
  UNTRUSTED_RESULT_NOTE,
  WRITE_TOOL_ANNOTATIONS,
} from '../businesscentral/annotations.js';
import { assertAuditLogWritable, auditTarget, newRequestId, writeAuditEvent } from '../businesscentral/audit.js';
import { readOnlyClient, type UpstreamClient } from '../businesscentral/client.js';
import { formatUnknownError, redactDeep, type SecretRedactor } from '../errors.js';
import { withheldResult } from '../fallbacks.js';
import { leaksSecret } from '../key-admission.js';
import { getEntity, listCompanies, listEntity, listNested, type Entity } from '../businesscentral/items.js';
import {
  addJournalLines,
  attachDocument,
  boundAction,
  createDocument,
  createRecord,
  deleteDraft,
  party,
  pick,
  PURCHASE_INVOICE,
  registerCustomerPayment,
  SALES_DOCUMENTS,
  sendSalesInvoice,
  updateRecord,
  type LineInput,
  type SalesKind,
} from '../businesscentral/writes.js';
import { checkInputPolicy, checkToolPolicy, isToolDisabled, redactInScope, runInCallScope, validatePolicyConfig } from '../businesscentral/policy.js';

const guidSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 'Expected a GUID.');
const companyIdSchema = guidSchema.describe('Company id (GUID), as list_companies returns it.');
const listShape = {
  companyId: companyIdSchema,
  top: z.number().int().min(1).max(200).optional().describe('Page size, 1 to 200. Default 50.'),
  skip: z.number().int().min(0).max(100_000).optional().describe('Records to skip, for the next page.'),
  filter: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("OData $filter on this entity's fields, e.g. \"number eq '10000'\" or \"postingDate ge 2026-01-01\"."),
  skipToken: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .regex(/^[\x21-\x7e]+$/, 'Expected the nextSkipToken of the previous answer.')
    .optional()
    .describe('The nextSkipToken of the previous answer, for the next page when Business Central pages the list itself.'),
};

type ToolAnnotations = typeof READ_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS | typeof CHANGE_TOOL_ANNOTATIONS;

/**
 * One upstream request a tool may make: `read` or `write`, the HTTP method
 * and the path template relative to the base URL (`{name}` marks a
 * caller-supplied segment). Published in the gateway tool catalog so a host
 * can see what each tool touches; keep it in step with the handler.
 */
export interface UpstreamOperation {
  access: 'read' | 'write';
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
}

/** A client that carries the redactor of its instance (BusinesscentralClient does). */
export interface RedactingClient extends UpstreamClient {
  readonly redactor: SecretRedactor;
}

/**
 * One definition per tool, shared by the MCP server and the gateway entry
 * point: same input schema, same handler, same policy and audit path.
 */
export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name (`businesscentral_*`). The gateway exposes it without the prefix. */
  name: string;
  title: string;
  description: string;
  inputShape: S;
  /** Strict object built from inputShape: unknown arguments are rejected. */
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Whether the result carries upstream content (vs. server metadata). */
  returnsUpstreamContent: boolean;
  /** Short human-readable summary used by the gateway result text. */
  summary: string;
  /** Every upstream request the handler may make. */
  upstream: readonly UpstreamOperation[];
  /**
   * True when the tool can read more than its name says: anything in the
   * system, chosen by the input (a generic get-by-path, a raw query).
   * Published as `broad` in the gateway catalog, so a host that grants tools
   * per role gives it only to roles that may read everything. Default false.
   */
  broad?: boolean;
  /**
   * Read-only tools (readOnlyHint) receive a client view that refuses
   * non-GET requests, so a mis-annotated tool cannot write.
   */
  handler: (client: UpstreamClient, input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

function defineTool<S extends z.ZodRawShape>(definition: Omit<ToolDefinition<S>, 'inputSchema'>): ToolDefinition {
  const description = definition.returnsUpstreamContent
    ? `${definition.description} ${UNTRUSTED_CONTENT_NOTE}`
    : definition.description;
  return {
    ...definition,
    description,
    inputSchema: z.strictObject(definition.inputShape),
  } as unknown as ToolDefinition;
}

/** A read of one fixed, company-scoped entity, with paging and an OData filter on its own fields. */
function listTool(entity: Entity, name: string, title: string, description: string): ToolDefinition {
  return defineTool({
    name: `businesscentral_${name}`,
    title,
    description: `${description} Paged with top and skip, or with skipToken when an answer has nextSkipToken; filter is an OData $filter on this entity only.`,
    inputShape: listShape,
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: `Fetched ${entity}.`,
    upstream: [{ access: 'read', method: 'GET', path: `/companies({companyId})/${entity}` }],
    handler: async (client, input) => listEntity(client, entity, input as never),
  });
}

/** The first reads. Vendor bank accounts, employees and payroll are not read. */
const BASE_READS: ToolDefinition[] = [
  defineTool({
    name: 'businesscentral_list_companies',
    title: 'List companies (Business Central)',
    description: 'The companies in this Business Central environment, with id, name and display name. skipToken fetches the next page when an answer has nextSkipToken.',
    inputShape: { skipToken: listShape.skipToken },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched companies.',
    upstream: [{ access: 'read', method: 'GET', path: '/companies' }],
    handler: async (client, input) => listCompanies(client, input as { skipToken?: string }),
  }),
  listTool('customers', 'list_customers', 'List customers (Business Central)', 'Customers with number, name, contact details, balance and blocked status.'),
  defineTool({
    name: 'businesscentral_get_customer',
    title: 'Get customer (Business Central)',
    description: 'One customer by id, with its financial details (balance, overdue amount, sales).',
    inputShape: { companyId: companyIdSchema, customerId: guidSchema.describe('Customer id (GUID).') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched customer.',
    upstream: [{ access: 'read', method: 'GET', path: '/companies({companyId})/customers({customerId})' }],
    handler: async (client, input) => getEntity(client, 'customers', input.companyId as string, input.customerId as string, 'customerFinancialDetail'),
  }),
  listTool('vendors', 'list_vendors', 'List vendors (Business Central)', 'Vendors with number, name, contact details and balance. No bank accounts.'),
  listTool('items', 'list_items', 'List items (Business Central)', 'Items with number, description, type, unit price, unit cost and inventory.'),
  listTool('salesInvoices', 'list_sales_invoices', 'List sales invoices (Business Central)', 'Sales invoices with number, customer, dates, amounts, remaining amount and status.'),
  defineTool({
    name: 'businesscentral_get_sales_invoice',
    title: 'Get sales invoice (Business Central)',
    description: 'One sales invoice by id, with its lines.',
    inputShape: { companyId: companyIdSchema, invoiceId: guidSchema.describe('Sales invoice id (GUID).') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched sales invoice.',
    upstream: [{ access: 'read', method: 'GET', path: '/companies({companyId})/salesInvoices({invoiceId})' }],
    handler: async (client, input) => getEntity(client, 'salesInvoices', input.companyId as string, input.invoiceId as string, 'salesInvoiceLines'),
  }),
  listTool('purchaseInvoices', 'list_purchase_invoices', 'List purchase invoices (Business Central)', 'Purchase invoices with number, vendor, dates, amounts and status.'),
  listTool('accounts', 'list_accounts', 'List accounts (Business Central)', 'The chart of accounts: number, name, category and whether it can be posted to.'),
  listTool(
    'generalLedgerEntries',
    'list_general_ledger_entries',
    'List general ledger entries (Business Central)',
    'Posted general ledger entries: posting date, document number, account, description, debit and credit.',
  ),
];

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD.');
const code = (max: number, what: string) => z.string().trim().min(1).max(max).describe(what);
const text = (max: number, what: string) => z.string().max(max).describe(what);
const money = (what: string) => z.number().finite().min(-1e12).max(1e12).describe(what);
const dimensionsSchema = z
  .array(
    z.strictObject({
      dimensionId: guidSchema.describe('Dimension id (GUID), as list_dimensions returns it.'),
      valueCode: code(20, 'Dimension value code, as list_dimensions returns it.'),
    }),
  )
  .max(20)
  .optional()
  .describe('Dimensions on this line, one value per dimension.');

/** Fields of a customer that may be set. No bank fields: bank accounts are never touched. */
const CUSTOMER_FIELDS = [
  'displayName',
  'type',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'country',
  'postalCode',
  'phoneNumber',
  'email',
  'website',
  'taxRegistrationNumber',
  'currencyCode',
  'paymentTermsId',
  'paymentMethodId',
  'blocked',
] as const;
const customerShape = {
  displayName: text(100, 'Name.').optional(),
  type: z.enum(['Company', 'Person']).optional().describe('Company or Person.'),
  addressLine1: text(100, 'Address.').optional(),
  addressLine2: text(50, 'Address, second line.').optional(),
  city: text(30, 'City.').optional(),
  state: text(30, 'State or region.').optional(),
  country: text(10, 'Country/region code, e.g. DK.').optional(),
  postalCode: text(20, 'Postal code.').optional(),
  phoneNumber: text(30, 'Phone number.').optional(),
  email: text(80, 'E-mail address.').optional(),
  website: text(80, 'Website.').optional(),
  taxRegistrationNumber: text(20, 'VAT registration number.').optional(),
  currencyCode: text(10, 'Currency code; empty for the local currency.').optional(),
  paymentTermsId: guidSchema.optional().describe('Payment terms id (GUID).'),
  paymentMethodId: guidSchema.optional().describe('Payment method id (GUID).'),
  blocked: z.enum([' ', 'Ship', 'Invoice', 'All']).optional().describe("Blocked: ' ' (not blocked), Ship, Invoice or All."),
};

/** Fields of a vendor that may be set. No bank fields: vendor bank accounts are never touched. */
const VENDOR_FIELDS = [
  'displayName',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'country',
  'postalCode',
  'phoneNumber',
  'email',
  'website',
  'taxRegistrationNumber',
  'currencyCode',
  'paymentTermsId',
  'paymentMethodId',
  'blocked',
] as const;
const vendorShape = {
  displayName: customerShape.displayName,
  addressLine1: customerShape.addressLine1,
  addressLine2: customerShape.addressLine2,
  city: customerShape.city,
  state: customerShape.state,
  country: customerShape.country,
  postalCode: customerShape.postalCode,
  phoneNumber: customerShape.phoneNumber,
  email: customerShape.email,
  website: customerShape.website,
  taxRegistrationNumber: customerShape.taxRegistrationNumber,
  currencyCode: customerShape.currencyCode,
  paymentTermsId: customerShape.paymentTermsId,
  paymentMethodId: customerShape.paymentMethodId,
  blocked: z.enum([' ', 'Payment', 'All']).optional().describe("Blocked: ' ' (not blocked), Payment or All."),
};

const ITEM_FIELDS = ['displayName', 'type', 'itemCategoryCode', 'unitPrice', 'unitCost', 'baseUnitOfMeasureCode', 'gtin', 'blocked'] as const;
const itemShape = {
  displayName: text(100, 'Description.').optional(),
  type: z.enum(['Inventory', 'Service', 'Non-Inventory']).optional().describe('Inventory, Service or Non-Inventory.'),
  itemCategoryCode: text(20, 'Item category code.').optional(),
  unitPrice: z.number().finite().min(0).max(1e12).optional().describe('Unit price.'),
  unitCost: z.number().finite().min(0).max(1e12).optional().describe('Unit cost.'),
  baseUnitOfMeasureCode: text(10, 'Base unit of measure code, e.g. PCS.').optional(),
  gtin: text(14, 'GTIN (bar code).').optional(),
  blocked: z.boolean().optional().describe('Blocked.'),
};

const lineType = () => z.enum(['Item', 'Account', 'Comment']).optional().describe('Item, Account or Comment. Default Item.');
const SALES_LINE_FIELDS = ['lineType', 'itemId', 'accountId', 'lineObjectNumber', 'description', 'quantity', 'unitPrice', 'discountPercent'] as const;
const lineShape = {
  lineType: lineType(),
  itemId: guidSchema.optional().describe('Item id (GUID), for an Item line.'),
  accountId: guidSchema.optional().describe('G/L account id (GUID), for an Account line.'),
  lineObjectNumber: text(20, 'Item or account number, instead of its id.').optional(),
  description: text(100, 'Line text.').optional(),
  quantity: z.number().finite().min(0).max(1e9).optional().describe('Quantity.'),
  discountPercent: z.number().finite().min(0).max(100).optional().describe('Line discount in percent.'),
  dimensions: dimensionsSchema,
};
const salesLineSchema = z.strictObject({ ...lineShape, unitPrice: money('Unit price.').optional() });
/** Business Central's purchase invoice line takes the cost per unit as unitCost (API v2.0 purchaseInvoiceLine). */
const PURCHASE_LINE_FIELDS = ['lineType', 'itemId', 'accountId', 'lineObjectNumber', 'description', 'quantity', 'unitCost', 'discountPercent'] as const;
const purchaseLineSchema = z.strictObject({ ...lineShape, unitCost: money('Cost per unit, excluding VAT.').optional() });
const JOURNAL_LINE_FIELDS = [
  'accountType',
  'accountId',
  'accountNumber',
  'postingDate',
  'documentNumber',
  'externalDocumentNumber',
  'amount',
  'description',
  'comment',
  'balanceAccountType',
  'balancingAccountId',
  'balancingAccountNumber',
] as const;
const ACCOUNT_TYPES = ['G/L Account', 'Customer', 'Vendor', 'Bank Account'] as const;
const journalLineSchema = z.strictObject({
  accountType: z.enum(ACCOUNT_TYPES).optional().describe('G/L Account (default), Customer, Vendor or Bank Account.'),
  accountId: guidSchema.optional().describe('Account id (GUID) of the account type.'),
  accountNumber: text(20, 'Account number, instead of its id.').optional(),
  postingDate: dateSchema.describe('Posting date.'),
  documentNumber: text(20, 'Document number.').optional(),
  externalDocumentNumber: text(35, 'External document number.').optional(),
  amount: money('Amount: positive is debit, negative is credit.'),
  description: text(100, 'Line text.').optional(),
  comment: text(250, 'Comment.').optional(),
  balanceAccountType: z.enum(ACCOUNT_TYPES).optional().describe('Balancing account type.'),
  balancingAccountId: guidSchema.optional().describe('Balancing account id (GUID).'),
  balancingAccountNumber: text(20, 'Balancing account number, instead of its id.').optional(),
  dimensions: dimensionsSchema,
});
const linesOf = <T extends z.ZodType>(line: T) => z.array(line).min(1).max(100).describe('The lines, 1 to 100.');

const salesHeaderShape = {
  companyId: companyIdSchema,
  customerId: guidSchema.optional().describe('Customer id (GUID). Give this or customerNumber.'),
  customerNumber: code(20, 'Customer number. Give this or customerId.').optional(),
  externalDocumentNumber: text(35, "The customer's own reference.").optional(),
  currencyCode: text(10, "Currency code; empty for the customer's currency.").optional(),
};

/** A change tool: annotated as a non-destructive write, its result is the system's data. */
function changeTool<S extends z.ZodRawShape>(definition: {
  name: string;
  title: string;
  description: string;
  inputShape: S;
  summary: string;
  upstream: readonly UpstreamOperation[];
  handler: (client: UpstreamClient, input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}): ToolDefinition {
  return defineTool({
    ...definition,
    name: `businesscentral_${definition.name}`,
    annotations: CHANGE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
  });
}

function getTool(entity: 'salesQuotes' | 'salesOrders' | 'purchaseInvoices', name: string, what: string, lines: string): ToolDefinition {
  return defineTool({
    name: `businesscentral_${name}`,
    title: `Get ${what} (Business Central)`,
    description: `One ${what} by id, with its lines.`,
    inputShape: { companyId: companyIdSchema, documentId: guidSchema.describe(`The ${what} id (GUID).`) },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: `Fetched ${what}.`,
    upstream: [{ access: 'read', method: 'GET', path: `/companies({companyId})/${entity}({documentId})` }],
    handler: async (client, input) => getEntity(client, entity, input.companyId as string, input.documentId as string, lines),
  });
}

const journalIdSchema = guidSchema.describe('Journal id (GUID), as list_journals or list_customer_payment_journals returns it.');

/** Reads the changes need: documents, journals, dimensions. */
const MORE_READS: ToolDefinition[] = [
  listTool('salesQuotes', 'list_sales_quotes', 'List sales quotes (Business Central)', 'Sales quotes with number, customer, dates, amounts and status.'),
  getTool('salesQuotes', 'get_sales_quote', 'sales quote', 'salesQuoteLines'),
  listTool('salesOrders', 'list_sales_orders', 'List sales orders (Business Central)', 'Sales orders with number, customer, dates, amounts and status.'),
  getTool('salesOrders', 'get_sales_order', 'sales order', 'salesOrderLines'),
  getTool('purchaseInvoices', 'get_purchase_invoice', 'purchase invoice', 'purchaseInvoiceLines'),
  listTool('journals', 'list_journals', 'List general journals (Business Central)', 'General journal batches with code, name and balancing account.'),
  defineTool({
    name: 'businesscentral_list_journal_lines',
    title: 'List journal lines (Business Central)',
    description: 'The unposted lines of one general journal batch. Paged with top and skip, or with skipToken when an answer has nextSkipToken.',
    inputShape: { ...listShape, journalId: journalIdSchema },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched journal lines.',
    upstream: [{ access: 'read', method: 'GET', path: '/companies({companyId})/journals({journalId})/journalLines' }],
    handler: async (client, input) => listNested(client, { parent: 'journals', child: 'journalLines' }, input.journalId as string, input as never),
  }),
  defineTool({
    name: 'businesscentral_list_dimensions',
    title: 'List dimensions (Business Central)',
    description: 'Dimensions with their values (code and name), for setting dimensions on lines. Paged with top and skip.',
    inputShape: listShape,
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched dimensions.',
    upstream: [{ access: 'read', method: 'GET', path: '/companies({companyId})/dimensions' }],
    handler: async (client, input) => listEntity(client, 'dimensions', input as never, 'dimensionValues'),
  }),
  listTool(
    'customerPaymentJournals',
    'list_customer_payment_journals',
    'List customer payment journals (Business Central)',
    'Customer payment journal batches, where payments are registered before a person posts them.',
  ),
  defineTool({
    name: 'businesscentral_list_customer_payments',
    title: 'List customer payments (Business Central)',
    description: 'The unposted payment lines of one customer payment journal. Paged with top and skip, or with skipToken when an answer has nextSkipToken.',
    inputShape: { ...listShape, journalId: journalIdSchema },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched customer payments.',
    upstream: [{ access: 'read', method: 'GET', path: '/companies({companyId})/customerPaymentJournals({journalId})/customerPayments' }],
    handler: async (client, input) =>
      listNested(client, { parent: 'customerPaymentJournals', child: 'customerPayments' }, input.journalId as string, input as never),
  }),
];

function salesCreate(kind: SalesKind, dates: z.ZodRawShape, dateFields: readonly string[]): ToolDefinition {
  const document = SALES_DOCUMENTS[kind];
  return changeTool({
    name: `create_sales_${kind}`,
    title: `Create sales ${kind} (Business Central)`,
    description: `A new sales ${kind} as a draft, with its lines (and dimensions per line). Nothing is posted or sent. If a line fails, the answer says what was created (incomplete, failure).`,
    inputShape: { ...salesHeaderShape, ...dates, lines: linesOf(salesLineSchema) },
    summary: `Created sales ${kind}.`,
    upstream: [
      { access: 'write', method: 'POST', path: `/companies({companyId})/${document.entity}` },
      { access: 'write', method: 'POST', path: `/companies({companyId})/${document.entity}({documentId})/${document.lines}` },
      { access: 'write', method: 'POST', path: `/companies({companyId})/${document.lines}({lineId})/dimensionSetLines` },
    ],
    handler: async (client, input) => {
      const values = input as Record<string, unknown>;
      const header = { ...party(values, 'customer'), ...pick(values, ['externalDocumentNumber', 'currencyCode', ...dateFields]) };
      return createDocument(client, values.companyId as string, document, header, values.lines as LineInput[], SALES_LINE_FIELDS);
    },
  });
}

/** Changes for everyday sales and bookkeeping work. Never: chart of accounts, bank accounts, users, settings, money. */
const CHANGES: ToolDefinition[] = [
  changeTool({
    name: 'create_customer',
    title: 'Create customer (Business Central)',
    description: 'A new customer. No bank details.',
    inputShape: { companyId: companyIdSchema, ...customerShape, displayName: text(100, 'Name.') },
    summary: 'Created customer.',
    upstream: [{ access: 'write', method: 'POST', path: '/companies({companyId})/customers' }],
    handler: async (client, input) => createRecord(client, input.companyId as string, 'customers', pick(input, CUSTOMER_FIELDS)),
  }),
  changeTool({
    name: 'update_customer',
    title: 'Update customer (Business Central)',
    description: 'Change fields of a customer. Only the fields given change. No bank details.',
    inputShape: { companyId: companyIdSchema, customerId: guidSchema.describe('Customer id (GUID).'), ...customerShape },
    summary: 'Updated customer.',
    upstream: [{ access: 'write', method: 'PATCH', path: '/companies({companyId})/customers({customerId})' }],
    handler: async (client, input) => updateRecord(client, input.companyId as string, 'customers', input.customerId as string, pick(input, CUSTOMER_FIELDS)),
  }),
  changeTool({
    name: 'create_vendor',
    title: 'Create vendor (Business Central)',
    description: 'A new vendor. No bank accounts: those are never set through this server.',
    inputShape: { companyId: companyIdSchema, ...vendorShape, displayName: text(100, 'Name.') },
    summary: 'Created vendor.',
    upstream: [{ access: 'write', method: 'POST', path: '/companies({companyId})/vendors' }],
    handler: async (client, input) => createRecord(client, input.companyId as string, 'vendors', pick(input, VENDOR_FIELDS)),
  }),
  changeTool({
    name: 'update_vendor',
    title: 'Update vendor (Business Central)',
    description: 'Change fields of a vendor. Only the fields given change. No bank accounts.',
    inputShape: { companyId: companyIdSchema, vendorId: guidSchema.describe('Vendor id (GUID).'), ...vendorShape },
    summary: 'Updated vendor.',
    upstream: [{ access: 'write', method: 'PATCH', path: '/companies({companyId})/vendors({vendorId})' }],
    handler: async (client, input) => updateRecord(client, input.companyId as string, 'vendors', input.vendorId as string, pick(input, VENDOR_FIELDS)),
  }),
  changeTool({
    name: 'create_item',
    title: 'Create item (Business Central)',
    description: 'A new item.',
    inputShape: { companyId: companyIdSchema, ...itemShape, displayName: text(100, 'Description.') },
    summary: 'Created item.',
    upstream: [{ access: 'write', method: 'POST', path: '/companies({companyId})/items' }],
    handler: async (client, input) => createRecord(client, input.companyId as string, 'items', pick(input, ITEM_FIELDS)),
  }),
  changeTool({
    name: 'update_item',
    title: 'Update item (Business Central)',
    description: 'Change fields of an item. Only the fields given change.',
    inputShape: { companyId: companyIdSchema, itemId: guidSchema.describe('Item id (GUID).'), ...itemShape },
    summary: 'Updated item.',
    upstream: [{ access: 'write', method: 'PATCH', path: '/companies({companyId})/items({itemId})' }],
    handler: async (client, input) => updateRecord(client, input.companyId as string, 'items', input.itemId as string, pick(input, ITEM_FIELDS)),
  }),
  salesCreate(
    'quote',
    { documentDate: dateSchema.optional().describe('Quote date.'), validUntilDate: dateSchema.optional().describe('Valid until.') },
    ['documentDate', 'validUntilDate'],
  ),
  salesCreate(
    'order',
    { orderDate: dateSchema.optional().describe('Order date.'), requestedDeliveryDate: dateSchema.optional().describe('Requested delivery date.') },
    ['orderDate', 'requestedDeliveryDate'],
  ),
  salesCreate(
    'invoice',
    {
      invoiceDate: dateSchema.optional().describe('Invoice date.'),
      postingDate: dateSchema.optional().describe('Posting date.'),
      dueDate: dateSchema.optional().describe('Due date.'),
    },
    ['invoiceDate', 'postingDate', 'dueDate'],
  ),
  changeTool({
    name: 'delete_sales_draft',
    title: 'Delete sales draft (Business Central)',
    description:
      'Delete a sales quote, order or invoice that is still a draft. The status is read right before the delete; anything not in status Draft (sent, released, posted) is refused.',
    inputShape: {
      companyId: companyIdSchema,
      documentType: z.enum(['quote', 'order', 'invoice']).describe('quote, order or invoice.'),
      documentId: guidSchema.describe('Document id (GUID).'),
    },
    summary: 'Deleted sales draft.',
    upstream: [
      { access: 'read', method: 'GET', path: '/companies({companyId})/{salesQuotes|salesOrders|salesInvoices}({documentId})' },
      { access: 'write', method: 'DELETE', path: '/companies({companyId})/{salesQuotes|salesOrders|salesInvoices}({documentId})' },
    ],
    handler: async (client, input) =>
      deleteDraft(client, input.companyId as string, SALES_DOCUMENTS[input.documentType as SalesKind].entity, input.documentId as string),
  }),
  changeTool({
    name: 'post_sales_invoice',
    title: 'Post sales invoice (Business Central)',
    description: 'Post a draft sales invoice. It is not sent; send_sales_invoice does that.',
    inputShape: { companyId: companyIdSchema, invoiceId: guidSchema.describe('Sales invoice id (GUID).') },
    summary: 'Posted sales invoice.',
    upstream: [
      { access: 'write', method: 'POST', path: '/companies({companyId})/salesInvoices({invoiceId})/Microsoft.NAV.post' },
      { access: 'read', method: 'GET', path: '/companies({companyId})/salesInvoices({invoiceId})' },
    ],
    handler: async (client, input) => boundAction(client, input.companyId as string, 'salesInvoices', input.invoiceId as string, 'post'),
  }),
  changeTool({
    name: 'send_sales_invoice',
    title: 'Send sales invoice (Business Central)',
    description: "E-mail a posted sales invoice to the customer with Business Central's own e-mail setup. A draft is refused.",
    inputShape: { companyId: companyIdSchema, invoiceId: guidSchema.describe('Sales invoice id (GUID).') },
    summary: 'Sent sales invoice.',
    upstream: [
      { access: 'read', method: 'GET', path: '/companies({companyId})/salesInvoices({invoiceId})' },
      { access: 'write', method: 'POST', path: '/companies({companyId})/salesInvoices({invoiceId})/Microsoft.NAV.send' },
    ],
    handler: async (client, input) => sendSalesInvoice(client, input.companyId as string, input.invoiceId as string),
  }),
  changeTool({
    name: 'create_purchase_invoice',
    title: 'Create purchase invoice (Business Central)',
    description:
      'A new purchase invoice as a draft, with its lines (and dimensions per line). Nothing is posted or paid. If a line fails, the answer says what was created (incomplete, failure).',
    inputShape: {
      companyId: companyIdSchema,
      vendorId: guidSchema.optional().describe('Vendor id (GUID). Give this or vendorNumber.'),
      vendorNumber: code(20, 'Vendor number. Give this or vendorId.').optional(),
      vendorInvoiceNumber: text(35, "The vendor's invoice number.").optional(),
      invoiceDate: dateSchema.optional().describe('Invoice date.'),
      postingDate: dateSchema.optional().describe('Posting date.'),
      dueDate: dateSchema.optional().describe('Due date.'),
      currencyCode: text(10, "Currency code; empty for the vendor's currency.").optional(),
      lines: linesOf(purchaseLineSchema),
    },
    summary: 'Created purchase invoice.',
    upstream: [
      { access: 'write', method: 'POST', path: '/companies({companyId})/purchaseInvoices' },
      { access: 'write', method: 'POST', path: '/companies({companyId})/purchaseInvoices({documentId})/purchaseInvoiceLines' },
      { access: 'write', method: 'POST', path: '/companies({companyId})/purchaseInvoiceLines({lineId})/dimensionSetLines' },
    ],
    handler: async (client, input) => {
      const values = input as Record<string, unknown>;
      const header = { ...party(values, 'vendor'), ...pick(values, ['vendorInvoiceNumber', 'invoiceDate', 'postingDate', 'dueDate', 'currencyCode']) };
      return createDocument(client, values.companyId as string, PURCHASE_INVOICE, header, values.lines as LineInput[], PURCHASE_LINE_FIELDS);
    },
  }),
  changeTool({
    name: 'post_purchase_invoice',
    title: 'Post purchase invoice (Business Central)',
    description: 'Post a draft purchase invoice. Nothing is paid.',
    inputShape: { companyId: companyIdSchema, invoiceId: guidSchema.describe('Purchase invoice id (GUID).') },
    summary: 'Posted purchase invoice.',
    upstream: [
      { access: 'write', method: 'POST', path: '/companies({companyId})/purchaseInvoices({invoiceId})/Microsoft.NAV.post' },
      { access: 'read', method: 'GET', path: '/companies({companyId})/purchaseInvoices({invoiceId})' },
    ],
    handler: async (client, input) => boundAction(client, input.companyId as string, 'purchaseInvoices', input.invoiceId as string, 'post'),
  }),
  changeTool({
    name: 'delete_purchase_invoice_draft',
    title: 'Delete purchase invoice draft (Business Central)',
    description: 'Delete a purchase invoice that is still a draft. The status is read right before the delete; anything else is refused.',
    inputShape: { companyId: companyIdSchema, documentId: guidSchema.describe('Purchase invoice id (GUID).') },
    summary: 'Deleted purchase invoice draft.',
    upstream: [
      { access: 'read', method: 'GET', path: '/companies({companyId})/purchaseInvoices({documentId})' },
      { access: 'write', method: 'DELETE', path: '/companies({companyId})/purchaseInvoices({documentId})' },
    ],
    handler: async (client, input) => deleteDraft(client, input.companyId as string, 'purchaseInvoices', input.documentId as string),
  }),
  changeTool({
    name: 'add_journal_lines',
    title: 'Add journal lines (Business Central)',
    description: 'Add lines to a general journal batch, with dimensions per line. Nothing is posted; post_journal does that.',
    inputShape: { companyId: companyIdSchema, journalId: journalIdSchema, lines: linesOf(journalLineSchema) },
    summary: 'Added journal lines.',
    upstream: [
      { access: 'write', method: 'POST', path: '/companies({companyId})/journals({journalId})/journalLines' },
      { access: 'write', method: 'POST', path: '/companies({companyId})/journalLines({lineId})/dimensionSetLines' },
    ],
    handler: async (client, input) =>
      addJournalLines(client, input.companyId as string, input.journalId as string, input.lines as LineInput[], JOURNAL_LINE_FIELDS),
  }),
  changeTool({
    name: 'post_journal',
    title: 'Post journal (Business Central)',
    description: 'Post all lines of a general journal batch.',
    inputShape: { companyId: companyIdSchema, journalId: journalIdSchema },
    summary: 'Posted journal.',
    upstream: [{ access: 'write', method: 'POST', path: '/companies({companyId})/journals({journalId})/Microsoft.NAV.post' }],
    handler: async (client, input) => boundAction(client, input.companyId as string, 'journals', input.journalId as string, 'post'),
  }),
  changeTool({
    name: 'register_customer_payment',
    title: 'Register customer payment (Business Central)',
    description:
      'Register a payment received from a customer as a line in a customer payment journal, applied to an invoice when given. It records the payment in the books; it is not posted and moves no money. A person posts the journal in Business Central.',
    inputShape: {
      companyId: companyIdSchema,
      journalId: journalIdSchema,
      customerId: guidSchema.optional().describe('Customer id (GUID). Give this or customerNumber.'),
      customerNumber: code(20, 'Customer number. Give this or customerId.').optional(),
      amount: z.number().finite().positive().max(1e12).describe('The amount received, positive.'),
      postingDate: dateSchema.describe('Posting date.'),
      appliesToInvoiceId: guidSchema.optional().describe('Id (GUID) of the posted sales invoice the payment settles.'),
      appliesToInvoiceNumber: text(20, 'Number of the posted sales invoice the payment settles, instead of its id.').optional(),
      documentNumber: text(20, 'Document number.').optional(),
      externalDocumentNumber: text(35, 'External document number, e.g. the bank reference.').optional(),
      description: text(100, 'Line text.').optional(),
    },
    summary: 'Registered customer payment.',
    upstream: [{ access: 'write', method: 'POST', path: '/companies({companyId})/customerPaymentJournals({journalId})/customerPayments' }],
    handler: async (client, input) => {
      const values = input as Record<string, unknown>;
      return registerCustomerPayment(client, values.companyId as string, values.journalId as string, {
        ...party(values, 'customer'),
        ...pick(values, ['amount', 'postingDate', 'appliesToInvoiceId', 'appliesToInvoiceNumber', 'documentNumber', 'externalDocumentNumber', 'description']),
      });
    },
  }),
  changeTool({
    name: 'attach_document',
    title: 'Attach file (Business Central)',
    description: 'Attach a file (base64, at most 5 MB) to a sales quote, order or invoice, a purchase invoice or a journal.',
    inputShape: {
      companyId: companyIdSchema,
      parentType: z.enum(['Sales Quote', 'Sales Order', 'Sales Invoice', 'Purchase Invoice', 'Journal']).describe('What the file is attached to.'),
      parentId: guidSchema.describe('Id (GUID) of the document or journal.'),
      fileName: z
        .string()
        .trim()
        .min(1)
        .max(250)
        .regex(/^[^\\/:*?"<>|\x00-\x1f]+$/, 'Expected a file name without a path.')
        .describe('File name with extension, e.g. invoice.pdf.'),
      contentBase64: z.string().min(4).max(7_200_000).describe('The file content, base64.'),
    },
    summary: 'Attached file.',
    upstream: [
      { access: 'write', method: 'POST', path: '/companies({companyId})/documentAttachments' },
      { access: 'write', method: 'PATCH', path: '/companies({companyId})/documentAttachments({attachmentId})/attachmentContent' },
    ],
    handler: async (client, input) =>
      attachDocument(client, input.companyId as string, {
        parentType: input.parentType as string,
        parentId: input.parentId as string,
        fileName: input.fileName as string,
        contentBase64: input.contentBase64 as string,
      }),
  }),
];

/**
 * The tool table: the reads, then the changes. Business Central's permission sets on the app in Business Central are
 * the second fence. No tool reads an entity chosen by its input, so none is broad, and no change is destructive.
 */
export const BC_TOOLS: ToolDefinition[] = [...BASE_READS, ...MORE_READS, ...CHANGES];

export function findTool(name: string): ToolDefinition | undefined {
  return BC_TOOLS.find(tool => tool.name === name);
}

/** Validate the tool policy environment. Cheap; runs for every server instance. */
export function validateToolConfig(): void {
  validatePolicyConfig(BC_TOOLS.map(tool => tool.name));
}

/**
 * Startup checks for entry points (transports, gateway): tool policy plus a
 * writable audit log. The audit check is not repeated per HTTP request, so
 * read tools keep working if the log becomes unwritable later; write tools
 * then fail closed when their start record cannot be written.
 */
export function validateStartupConfig(): void {
  validateToolConfig();
  assertAuditLogWritable();
}

/** Tools enabled on this instance (BC_DISABLED_TOOLS removes them entirely). */
export function enabledTools(): ToolDefinition[] {
  return BC_TOOLS.filter(tool => !isToolDisabled(tool.name));
}

export function registerTools(server: McpServer, client: RedactingClient): void {
  validateToolConfig();
  for (const tool of enabledTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: Record<string, unknown>) => {
        try {
          // In a scope with this server's redactor, like a gateway call: audit records and context are redacted.
          const data = await runInCallScope({ redactor: client.redactor }, () => executeTool(tool, client, input));
          // As in the gateway: the data redacted (values and keys) before it is serialised, then the result checked
          // whole as the last step, and withheld when it still holds a piece of the key.
          const result = mcpToolResult(tool, redactDeep(redactDeep(data, client.redactor), client.redactor));
          return leaksSecret(result, client.redactor) ? withheldResult() : result;
        } catch (error) {
          // Central redaction with this instance's secrets: no error text reaches the client unredacted.
          const result = {
            isError: true,
            content: [{ type: 'text' as const, text: formatUnknownError(error, client.redactor) }],
          };
          return leaksSecret(result, client.redactor) ? withheldResult() : result;
        }
      },
    );
  }
}

/** Optional call context supplied by an embedding host. */
export interface CallContext {
  /** Caller identity, recorded in audit events. */
  caller?: string;
  /** Request id to reuse in audit events, for correlation with the host's own log. */
  requestId?: string;
}

function contextString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Redacted before it is cut short: a cut key would no longer match the redactor.
  const trimmed = redactInScope(value).trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Normalise a host-supplied context; malformed values are ignored. */
export function normaliseCallContext(context: unknown): { requestId: string; caller?: string } {
  const value = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
  return {
    requestId: contextString(value.requestId, 200) ?? newRequestId(),
    caller: contextString(value.caller, 320),
  };
}

/**
 * Run one validated tool call through the instance policy and the audit
 * log. Used by both the MCP server and the gateway entry point.
 */
export async function executeTool(
  tool: ToolDefinition,
  client: RedactingClient,
  input: Record<string, unknown>,
  context?: CallContext,
): Promise<unknown> {
  const { requestId, caller } = normaliseCallContext(context);
  const target = auditTarget(input);
  const { redactor } = client;

  const policy = checkToolPolicy(tool.name, tool.annotations.readOnlyHint);
  const inputPolicy = policy.allowed ? checkInputPolicy(tool.name, input) : policy;
  if (!inputPolicy.allowed) {
    await writeAuditEvent(
      { requestId, tool: tool.name, caller, action: 'policy_denied', target, reason: inputPolicy.reason },
      { redactor },
    );
    throw new Error(inputPolicy.reason);
  }

  // Write tools fail closed: no write runs without its start record.
  await writeAuditEvent(
    { requestId, tool: tool.name, caller, action: 'start', target, reason: policy.reason },
    { required: !tool.annotations.readOnlyHint, redactor },
  );
  const startedAt = performance.now();

  try {
    const handlerClient = tool.annotations.readOnlyHint ? readOnlyClient(client, tool.name) : client;
    const result = await tool.handler(handlerClient, input as never);
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'finish',
      target,
      status: 'ok',
      durationMs: Math.round(performance.now() - startedAt),
    }, { redactor });
    return result;
  } catch (error) {
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'error',
      target,
      status: 'error',
      durationMs: Math.round(performance.now() - startedAt),
      error,
    }, { redactor });
    throw error;
  }
}

const MAX_REJECTED_FIELDS = 20;
const MAX_REJECTED_FIELD_LENGTH = 64;

/** Audit a call rejected before execution (unknown tool or invalid input); field names only. */
export async function auditRejectedCall(
  toolName: string,
  input: unknown,
  reason: string,
  context?: unknown,
): Promise<void> {
  const { requestId, caller } = normaliseCallContext(context);
  const fields =
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.keys(input)
          .sort()
          .slice(0, MAX_REJECTED_FIELDS)
          .map(key => redactInScope(key).slice(0, MAX_REJECTED_FIELD_LENGTH))
      : [];
  await writeAuditEvent({
    requestId,
    tool: redactInScope(toolName).slice(0, 100),
    caller,
    action: 'rejected',
    target: { fields },
    reason: redactInScope(reason).slice(0, 200),
  });
}

/** Compact JSON (no pretty-printing): indentation only costs tokens. */
export function compactJson(data: unknown): string {
  return JSON.stringify(data ?? null);
}

function mcpToolResult(tool: ToolDefinition, data: unknown) {
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: compactJson(data) }];
  if (tool.returnsUpstreamContent) {
    content.push({ type: 'text', text: UNTRUSTED_RESULT_NOTE });
  }
  return { content };
}
