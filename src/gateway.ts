import { z } from 'zod/v4';
import { UNTRUSTED_CONTENT_NOTE } from './example/annotations.js';
import { ExampleClient, type ExampleClientOptions } from './example/client.js';
import { isToolDisabled, TOOL_PREFIX } from './example/policy.js';
import { formatUnknownError } from './errors.js';
import {
  auditRejectedCall,
  EXAMPLE_TOOLS,
  executeTool,
  findTool,
  validateToolConfig,
  type CallContext,
  type ToolDefinition,
} from './tools/example.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Tool definitions, input validation,
 * instance policy and audit are shared with the MCP server in
 * src/tools/example.ts.
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

export interface ExampleGatewayOptions extends ExampleClientOptions {}

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

/** All tools, as gateway definitions (names without the prefix). */
export const exampleGatewayTools: GatewayToolDefinition[] = EXAMPLE_TOOLS.map(tool => ({
  name: stripPrefix(tool.name),
  title: tool.title,
  description: tool.description,
  riskLevel: tool.annotations.readOnlyHint ? 'read' : tool.annotations.destructiveHint ? 'destructive' : 'write',
  enabledByDefault: tool.annotations.readOnlyHint,
  inputSchema: toGatewayJsonSchema(tool),
}));

export function createExampleGateway(options: ExampleGatewayOptions = {}) {
  validateToolConfig();
  const client = new ExampleClient(options);

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
          return errorResult(reason);
        }

        const parsed = tool.inputSchema.safeParse(input ?? {});
        if (!parsed.success) {
          const reason = `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`;
          await auditRejectedCall(tool.name, input, 'invalid input', context);
          return errorResult(reason);
        }

        const data = await executeTool(tool, client, parsed.data as Record<string, unknown>, context ?? undefined);
        const text = tool.returnsUpstreamContent ? `${tool.summary} ${UNTRUSTED_CONTENT_NOTE}` : tool.summary;
        return jsonResult(text, data);
      } catch (error) {
        return errorResult(formatUnknownError(error));
      }
    },
  };
}

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
