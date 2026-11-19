import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import {
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
import { getEntity, listCompanies, listEntity, type Entity } from '../businesscentral/items.js';
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

type ToolAnnotations = typeof READ_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS;

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

/**
 * The tool table. Every tool reads; Business Central's permission sets on the
 * app in Business Central (D365 READ) are the second fence. No tool reads an
 * entity chosen by its input, so none is broad. Vendor bank accounts, employees
 * and payroll are not read.
 */
export const BC_TOOLS: ToolDefinition[] = [
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
    handler: async (client, input) => getEntity(client, 'customers', input.companyId as string, input.customerId as string, 'customerFinancialDetails'),
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
