/**
 * Error body of the upstream API. Adjust to the vendor's documented error
 * model; every field is optional and read defensively.
 */
export interface UpstreamErrorPayload {
  message?: string;
  error?: string;
  code?: string | number;
  details?: unknown;
}

/** Maximum length of any single piece of text taken from a response body. */
export const MAX_ERROR_TEXT = 500;
/** Configured secrets shorter than this are not redacted by value (too likely to hit normal text). */
const MIN_SECRET_LENGTH = 8;

const SECRET_PATTERNS: RegExp[] = [
  /x-api-key:\s*[^,\s}]+/gi,
  /authorization:\s*(bearer\s+)?[^,\s}]+/gi,
  /(apiKey|EXAMPLE_API_KEY|api_key|access_token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

/** Redact `<name>: <value>` for this header name (case-insensitive) in error text. */
export function registerSecretHeader(name: string): void {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(String.raw`${escaped}:\s*[^,\s}]+`, 'gi');
  if (!SECRET_PATTERNS.some(existing => existing.source === pattern.source)) {
    SECRET_PATTERNS.push(pattern);
  }
}

const registeredSecrets = new Set<string>();

/** Redact this exact value (and its URL-encoded form) wherever it appears in error text. */
export function registerSecret(value: string | undefined): void {
  if (!value || value.length < MIN_SECRET_LENGTH) {
    return;
  }
  registeredSecrets.add(value);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    registeredSecrets.add(encoded);
  }
}

/**
 * Actionable guidance per HTTP status. Replace or extend with the vendor's
 * documented error codes.
 */
const STATUS_HINTS: Record<number, string> = {
  401: 'The API key was rejected (invalid or expired). The server operator must renew EXAMPLE_API_KEY.',
  403: 'The API key has no access to this resource. Retrying will not help.',
  404: 'The object was not found, or the API key has no access to it. Check the ids.',
  429: 'The upstream API is throttling requests. Wait and retry later.',
};

export class ExampleHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload?: UpstreamErrorPayload | unknown;
  readonly retryAfter?: string;
  readonly errorCode?: string;

  constructor(input: { status: number; url: string; payload?: UpstreamErrorPayload | unknown; retryAfter?: string }) {
    super(formatHttpError(input));
    this.name = 'ExampleHttpError';
    this.status = input.status;
    this.url = redactSecrets(describeUrl(input.url));
    this.payload =
      typeof input.payload === 'string' ? truncate(redactSecrets(input.payload)) : redactDeep(input.payload);
    this.retryAfter = input.retryAfter;
    const code = asErrorPayload(input.payload)?.code;
    this.errorCode =
      typeof code === 'string' || typeof code === 'number' ? truncate(redactSecrets(String(code)), 64) : undefined;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }
  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  let result = value;
  for (const secret of registeredSecrets) {
    result = result.split(secret).join('[REDACTED]');
  }
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    result,
  );
}

/** Origin and path of a URL, without query string or fragment (which may carry signatures). */
export function describeUrl(url: string | URL): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/** Copy of a JSON-like value with every string passed through redactSecrets. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (typeof value !== 'object' || value === null || depth > 20) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [redactSecrets(key), redactDeep(entry, depth + 1)]),
  );
}

/** IMF-fixdate, the HTTP date format used by Retry-After. */
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a Retry-After header (delay in seconds or an HTTP date) into
 * milliseconds from `now`. Returns undefined when absent, malformed, zero or
 * in the past, so callers fall back to their own backoff.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return ms > 0 && Number.isSafeInteger(ms) ? ms : undefined;
  }
  if (!HTTP_DATE.test(trimmed)) {
    return undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date) || date <= now) {
    return undefined;
  }
  return date - now;
}

export function truncate(value: string, max: number = MAX_ERROR_TEXT): string {
  return value.length > max ? `${value.slice(0, max)}… [truncated, ${value.length} chars]` : value;
}

function formatHttpError(input: { status: number; url: string; payload?: unknown; retryAfter?: string }): string {
  const payload = asErrorPayload(input.payload);
  const details = [text(payload?.code), text(payload?.error), text(payload?.message)].filter(Boolean);
  if (details.length === 0) {
    // Redact before truncating so a secret cut at the boundary cannot leak a prefix.
    if (payload !== undefined) {
      details.push(truncate(redactSecrets(JSON.stringify(payload))));
    } else if (typeof input.payload === 'string' && input.payload.trim()) {
      details.push(truncate(redactSecrets(input.payload.trim())));
    }
  }

  const parts = [
    `Example API request failed with HTTP ${input.status}`,
    ...details,
    Object.hasOwn(STATUS_HINTS, input.status) ? STATUS_HINTS[input.status] : undefined,
    formatRetryAfter(input.retryAfter),
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function formatRetryAfter(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const ms = parseRetryAfterMs(value);
  return ms === undefined ? undefined : `retry-after=${Math.ceil(ms / 1000)}s`;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  return truncate(redactSecrets(value.trim()));
}

function asErrorPayload(value: unknown): UpstreamErrorPayload | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UpstreamErrorPayload)
    : undefined;
}
