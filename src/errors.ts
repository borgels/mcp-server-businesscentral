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

/** Matches `<name>: <value>`, `<name>=<value>` and `"<name>": "<value>"` for one header (case-insensitive). */
function headerPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`["']?${escaped}["']?\s*[:=]\s*["']?[^"',\s}]+`, 'gi');
}

/** Patterns that are always applied: credential-shaped key/value pairs. They hold no secret values. */
const BASE_PATTERNS: readonly RegExp[] = [
  headerPattern('x-api-key'),
  // Any scheme word (Bearer, Basic, Token, ...) followed by the credentials.
  /["']?authorization["']?\s*[:=]\s*["']?(?:[a-z][\w-]*\s+)?[^"',\s}]+/gi,
  /(apiKey|EXAMPLE_API_KEY|api_key|access_token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

/**
 * Redacts the secrets of one client, and so of one gateway or server
 * instance: exact secret values, and the values of named credential headers.
 * Each instance owns its redactor, so a host that runs several tenants in
 * one process never mixes their keys, and a tenant's key is released with
 * its instance. There is no process-wide registry.
 */
export class SecretRedactor {
  private readonly secrets = new Set<string>();
  private readonly patterns: RegExp[] = [...BASE_PATTERNS];

  /** Redact this exact value (and its URL-encoded form). Values shorter than 8 characters are ignored. */
  addSecret(value: string | undefined): this {
    if (!value || value.length < MIN_SECRET_LENGTH) {
      return this;
    }
    this.secrets.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) {
      this.secrets.add(encoded);
    }
    return this;
  }

  /** Redact the value of this header wherever it appears as `<name>: <value>` or `<name>=<value>`. */
  addHeader(name: string): this {
    const pattern = headerPattern(name);
    if (!this.patterns.some(existing => existing.source === pattern.source)) {
      this.patterns.push(pattern);
    }
    return this;
  }

  /** Whether this exact value is one of this instance's secrets. */
  hasSecret(value: string): boolean {
    return this.secrets.has(value);
  }

  redact(value: string): string {
    let result = value;
    for (const secret of this.secrets) {
      result = result.split(secret).join('[REDACTED]');
    }
    return applyPatterns(result, this.patterns);
  }
}

function applyPatterns(value: string, patterns: readonly RegExp[]): string {
  return patterns.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        // Split at the first separator only: the value may itself contain `:` or `=`.
        const [, key = 'secret', separator = ':'] = /^(.*?)\s*([:=])/.exec(match) ?? [];
        return `${key.trim()}${separator} [REDACTED]`;
      }),
    value,
  );
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

  constructor(input: {
    status: number;
    url: string;
    payload?: UpstreamErrorPayload | unknown;
    retryAfter?: string;
    /** Redactor of the client that made the request. */
    redactor?: SecretRedactor;
  }) {
    const redact = (value: string) => redactSecrets(value, input.redactor);
    super(formatHttpError(input, redact));
    this.name = 'ExampleHttpError';
    this.status = input.status;
    this.url = redact(describeUrl(input.url));
    this.payload =
      typeof input.payload === 'string' ? truncate(redact(input.payload)) : redactDeep(input.payload, input.redactor);
    this.retryAfter = input.retryAfter;
    const code = asErrorPayload(input.payload)?.code;
    this.errorCode =
      typeof code === 'string' || typeof code === 'number' ? truncate(redact(String(code)), 64) : undefined;
  }
}

export function formatUnknownError(error: unknown, redactor?: SecretRedactor): string {
  if (error instanceof Error) {
    return redactSecrets(error.message, redactor);
  }
  return redactSecrets(String(error), redactor);
}

/**
 * Redact with an instance's redactor. Without one, only the credential-shaped
 * patterns are applied: no secret values are known outside an instance.
 */
export function redactSecrets(value: string, redactor?: SecretRedactor): string {
  return redactor ? redactor.redact(value) : applyPatterns(value, BASE_PATTERNS);
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
export function redactDeep(value: unknown, redactor?: SecretRedactor, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value, redactor);
  }
  if (typeof value !== 'object' || value === null || depth > 20) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, redactor, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      redactSecrets(key, redactor),
      redactDeep(entry, redactor, depth + 1),
    ]),
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

function formatHttpError(
  input: { status: number; url: string; payload?: unknown; retryAfter?: string },
  redact: (value: string) => string,
): string {
  const payload = asErrorPayload(input.payload);
  const text = (value: unknown) => detailText(value, redact);
  const details = [text(payload?.code), text(payload?.error), text(payload?.message)].filter(Boolean);
  if (details.length === 0) {
    // Redact before truncating so a secret cut at the boundary cannot leak a prefix.
    if (payload !== undefined) {
      details.push(truncate(redact(JSON.stringify(payload))));
    } else if (typeof input.payload === 'string' && input.payload.trim()) {
      details.push(truncate(redact(input.payload.trim())));
    }
  }

  const parts = [
    `Example API request failed with HTTP ${input.status}`,
    ...details,
    Object.hasOwn(STATUS_HINTS, input.status) ? STATUS_HINTS[input.status] : undefined,
    formatRetryAfter(input.retryAfter),
  ].filter(Boolean);

  return redact(parts.join(' | '));
}

function formatRetryAfter(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const ms = parseRetryAfterMs(value);
  return ms === undefined ? undefined : `retry-after=${Math.ceil(ms / 1000)}s`;
}

function detailText(value: unknown, redact: (value: string) => string): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  return truncate(redact(value.trim()));
}

function asErrorPayload(value: unknown): UpstreamErrorPayload | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UpstreamErrorPayload)
    : undefined;
}
