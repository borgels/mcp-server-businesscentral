import { z } from 'zod/v4';
import { UNTRUSTED_CONTENT_NOTE } from './example/annotations.js';
import { ExampleClient, type ExampleClientOptions } from './example/client.js';
import { isToolDisabled, TOOL_PREFIX } from './example/policy.js';
import { ConfigError } from './config-env.js';
import { formatUnknownError, type SecretRedactor } from './errors.js';
import {
  auditRejectedCall,
  EXAMPLE_TOOLS,
  executeTool,
  findTool,
  validateStartupConfig,
  type CallContext,
  type ToolDefinition,
  type UpstreamOperation,
} from './tools/example.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Tool definitions, input validation,
 * instance policy and audit are shared with the MCP server in
 * src/tools/example.ts.
 *
 * Several gateway instances (for example one per tenant) can run in one
 * process. Each instance uses only the credentials passed to
 * createExampleGateway (never EXAMPLE_API_KEY or EXAMPLE_BASE_URL from the
 * environment) and redacts errors with its own secrets only. Instance policy
 * (EXAMPLE_ENABLE_WRITES, EXAMPLE_DISABLED_TOOLS, EXAMPLE_AUDIT_LOG) and
 * limits are still read from the environment and apply to every instance.
 */

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/** One upstream request a tool may make (method and path template relative to the base URL). */
export type GatewayUpstreamOperation = Readonly<UpstreamOperation>;

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  readonly upstream: readonly GatewayUpstreamOperation[];
}

export interface ExampleGatewayOptions extends Omit<ExampleClientOptions, 'apiKey' | 'baseUrl' | 'credentialEnv'> {
  /** API key of this instance. Required; never read from the environment. */
  apiKey: string;
  /** API base URL of this instance. Required; never read from the environment. */
  baseUrl: string;
}

/**
 * JSON Schema for a gateway tool, derived from the tool's zod schema.
 * `format` is dropped: validators such as Ajv reject unknown formats in
 * strict mode unless format plugins are installed, and zod already checks
 * these values when the call runs.
 */
function toGatewayJsonSchema(tool: ToolDefinition): GatewayJsonObject {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.inputSchema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
    },
  }) as Record<string, unknown>;
  return schema as GatewayJsonObject;
}

function stripPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function toGatewayDefinition(tool: ToolDefinition): GatewayToolDefinition {
  return {
    name: stripPrefix(tool.name),
    title: tool.title,
    description: tool.description,
    riskLevel: tool.annotations.readOnlyHint ? 'read' : tool.annotations.destructiveHint ? 'destructive' : 'write',
    enabledByDefault: tool.annotations.readOnlyHint,
    inputSchema: toGatewayJsonSchema(tool),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/** All tools, as gateway definitions (names without the prefix). */
export const exampleGatewayTools: GatewayToolDefinition[] = EXAMPLE_TOOLS.map(toGatewayDefinition);

/**
 * The tool catalog: every tool with its gateway definition and the upstream
 * requests it may make. Generated from the same tool table as the MCP server
 * and `exampleGatewayTools`, and deeply frozen. Hosts can use it to build
 * their own permission model without creating a gateway instance.
 */
export const exampleToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  EXAMPLE_TOOLS.map(tool => ({
    ...toGatewayDefinition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
  })),
);

function requiredCredential(options: ExampleGatewayOptions, name: 'apiKey' | 'baseUrl'): string {
  const value: unknown = (options as Partial<ExampleGatewayOptions> | undefined)?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(
      `createExampleGateway requires options.${name}. Embedded instances do not read credentials from the environment.`,
    );
  }
  return value.trim();
}

/**
 * Create one gateway instance. `apiKey` and `baseUrl` are required and
 * are the only credentials the instance uses; a missing value fails here.
 */
export function createExampleGateway(options: ExampleGatewayOptions) {
  validateStartupConfig();
  const apiKey = requiredCredential(options, 'apiKey');
  const baseUrl = requiredCredential(options, 'baseUrl');
  const client = new ExampleClient({ ...options, apiKey, baseUrl, credentialEnv: {} });
  const redactor: SecretRedactor = client.redactor;

  return {
    /** Tools enabled on this instance (EXAMPLE_DISABLED_TOOLS removes them). */
    tools: exampleGatewayTools.filter(tool => !isToolDisabled(tool.name)),
    async callTool(
      toolName: string,
      input: GatewayJsonObject = {},
      context?: GatewayCallContext,
    ): Promise<GatewayToolResult> {
      try {
        const name = typeof toolName === 'string' ? toolName.trim() : '';
        const tool = name ? findTool(`${TOOL_PREFIX}${stripPrefix(name)}`) : undefined;
        if (!tool) {
          const reason = `Unsupported Example gateway tool: ${String(toolName).slice(0, 100)}`;
          await auditRejectedCall(String(toolName), input, reason, context);
          return errorResult(redactor.redact(reason));
        }

        const parsed = tool.inputSchema.safeParse(input ?? {});
        if (!parsed.success) {
          const reason = `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`;
          await auditRejectedCall(tool.name, input, 'invalid input', context);
          return errorResult(redactor.redact(reason));
        }

        const data = await executeTool(tool, client, parsed.data as Record<string, unknown>, context ?? undefined);
        const text = tool.returnsUpstreamContent ? `${tool.summary} ${UNTRUSTED_CONTENT_NOTE}` : tool.summary;
        return jsonResult(text, data);
      } catch (error) {
        return errorResult(formatUnknownError(error, redactor));
      }
    },
  };
}

/** One gateway instance, as returned by createExampleGateway. */
export type ExampleGateway = ReturnType<typeof createExampleGateway>;

function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(JSON.stringify(structuredContent ?? null)) as GatewayJsonValue,
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
