import { ConfigError, readEnvBoolean, readEnvList } from '../config-env.js';

/**
 * Server-side guards that apply to every tool call, whether it arrives over
 * MCP or through the embeddable gateway entry point.
 *
 * - Write tools are opt-in per instance (EXAMPLE_ENABLE_WRITES=true).
 * - EXAMPLE_DISABLED_TOOLS turns individual tools off; they are not even
 *   registered.
 *
 * Add instance allowlists (e.g. of account or project ids) to
 * checkInputPolicy. Any client-side permission model sits on top of these;
 * the environment decides what the server will ever do.
 */

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export const TOOL_PREFIX = 'example_';

export function writesEnabled(): boolean {
  return readEnvBoolean('EXAMPLE_ENABLE_WRITES', false);
}

/** Tool names are accepted with or without the prefix, case-insensitively. */
export function canonicalToolName(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.startsWith(TOOL_PREFIX) ? lower : `${TOOL_PREFIX}${lower}`;
}

function disabledTools(): Set<string> {
  return new Set(readEnvList('EXAMPLE_DISABLED_TOOLS').map(canonicalToolName));
}

export function isToolDisabled(toolName: string): boolean {
  return disabledTools().has(canonicalToolName(toolName));
}

/**
 * Validate the policy environment once at startup: boolean switches must be
 * valid and EXAMPLE_DISABLED_TOOLS may only name known tools, so a typo
 * cannot silently leave a tool enabled.
 */
export function validatePolicyConfig(knownTools: readonly string[]): void {
  writesEnabled();
  const known = new Set(knownTools);
  const unknown = [...disabledTools()].filter(name => !known.has(name));
  if (unknown.length > 0) {
    throw new ConfigError(`EXAMPLE_DISABLED_TOOLS names unknown tools: ${unknown.join(', ')}`);
  }
}

export function checkToolPolicy(toolName: string, readOnly: boolean): PolicyDecision {
  if (isToolDisabled(toolName)) {
    return { allowed: false, reason: `tool is disabled on this instance (EXAMPLE_DISABLED_TOOLS): ${toolName}` };
  }
  if (readOnly) {
    return { allowed: true, reason: 'read-only tool' };
  }
  if (!writesEnabled()) {
    return {
      allowed: false,
      reason:
        `write tool is disabled on this instance: ${toolName}. ` +
        'Set EXAMPLE_ENABLE_WRITES=true in the server environment to allow write tools.',
    };
  }
  return { allowed: true, reason: 'write tool (writes enabled on this instance)' };
}

/** Input-dependent checks (allowlists on ids in the input). None by default. */
export function checkInputPolicy(_toolName: string, _input: Record<string, unknown>): PolicyDecision {
  return { allowed: true, reason: 'no input restrictions configured' };
}
