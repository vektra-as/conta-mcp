/**
 * Conta API Client
 * Handles authentication and HTTP requests to the Conta REST API
 * (https://api.gateway.conta.no, OpenAPI 3.0.3 — se docs/conta-external-api.json).
 *
 * Standalone MCP: pass no constructor args — reads CONTA_* env vars.
 * Programmatic use: pass ContaClientOptions (matches multi-tenant host apps).
 *
 * Auth is a single static header (`apiKey`) — there is no session/token exchange,
 * so unlike the Tripletex client there is no 401 refresh path.
 */

const PROD_BASE = "https://api.gateway.conta.no";

/** `conta-language` header. The spec's enumLanguageEnum only allows NO and EN. */
export type ContaLanguage = "NO" | "EN";

export interface ContaClientOptions {
  /** API key sent verbatim as the `apiKey` header on every request. */
  apiKey: string;
  /** Default organization id used by tools when the caller omits opContextOrgId. */
  orgId?: number;
  baseUrl?: string;
  /** Value for the `conta-language` header. Default "NO". */
  language?: ContaLanguage;
  /** Max retries on 429. Default 3. */
  maxRetries?: number;
  /** Initial backoff in ms when no rate-limit header present. Default 1000. */
  initialBackoffMs?: number;
  /** Abort a request that takes longer than this, in ms. Default 30000. */
  timeoutMs?: number;
  /** Override fetch (for tests or custom transports). Default globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Override sleep (for tests). Default setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
}

/** Per-request knobs that map onto Conta's control headers. */
export interface ContaRequestOptions {
  /**
   * Sends `conta-force-rollback: true`, which makes Conta roll the transaction
   * back after the request. Exposed as `dryRun` on every write tool.
   */
  dryRun?: boolean;
  /**
   * Sends `conta-force-readonly: true`. Needed for the read endpoints that take
   * a JSON body and therefore have to be issued as POST.
   */
  forceReadonly?: boolean;
  /** Per-request override of the `conta-language` header. */
  language?: ContaLanguage;
}

export class ContaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly bodyText: string
  ) {
    super(message);
    this.name = "ContaApiError";
  }
}

export class ContaRateLimitError extends ContaApiError {
  constructor(
    message: string,
    status: number,
    bodyText: string,
    public readonly retryAfterMs: number
  ) {
    super(message, status, bodyText);
    this.name = "ContaRateLimitError";
  }
}

/**
 * Rate limits are not documented in the Conta spec, so treat 429 defensively:
 * honour `Retry-After` (seconds) when present and numeric, otherwise back off
 * linearly from initialBackoffMs.
 */
export function computeBackoffMs(
  attempt: number,
  headers: Headers,
  initialBackoffMs: number
): number {
  const retryAfter = headers.get("Retry-After");
  if (retryAfter !== null && retryAfter.trim() !== "" && !Number.isNaN(Number(retryAfter))) {
    return Math.max(0, Number(retryAfter) * 1000);
  }
  return initialBackoffMs * (attempt + 1);
}

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The API key travels in a header, so the base URL must be https. Plain http
 * is only accepted for localhost (local mocks / proxies during development).
 */
export function assertSafeBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`CONTA_BASE_URL is not a valid URL: "${baseUrl}"`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(
      `CONTA_BASE_URL must use https:// (http is only allowed for localhost), got "${baseUrl}"`
    );
  }
}

/** Serialize a query param value the way the Conta API expects. */
function toQueryValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export type QueryScalar = string | number | boolean;
export type QueryParams = Record<
  string,
  QueryScalar | QueryScalar[] | undefined | null
>;

export class ContaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly language: ContaLanguage;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  /** Default org id from options/env. Tools fall back to this when none is given. */
  readonly defaultOrgId: number | undefined;

  constructor(options?: ContaClientOptions) {
    const resolved = options ?? ContaClient.optionsFromEnv();
    if (!resolved.apiKey) {
      throw new Error("Missing Conta API key (set CONTA_API_KEY)");
    }
    this.apiKey = resolved.apiKey;
    this.defaultOrgId = resolved.orgId;
    this.baseUrl = (resolved.baseUrl ?? PROD_BASE).replace(/\/+$/, "");
    assertSafeBaseUrl(this.baseUrl);
    this.language = resolved.language ?? "NO";
    this.maxRetries = resolved.maxRetries ?? 3;
    this.initialBackoffMs = resolved.initialBackoffMs ?? 1000;
    this.timeoutMs = resolved.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error(`timeoutMs must be a positive number, got ${this.timeoutMs}`);
    }
    this.fetchImpl = resolved.fetch ?? globalThis.fetch;
    this.sleepImpl =
      resolved.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Read CONTA_* env vars into an options bag. Throws if the key is missing. */
  private static optionsFromEnv(): ContaClientOptions {
    const apiKey = process.env.CONTA_API_KEY;
    if (!apiKey) {
      throw new Error("Missing CONTA_API_KEY env var");
    }
    const rawOrgId = process.env.CONTA_ORG_ID;
    let orgId: number | undefined;
    if (rawOrgId !== undefined && rawOrgId !== "") {
      const parsed = Number(rawOrgId);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`CONTA_ORG_ID must be a positive integer, got "${rawOrgId}"`);
      }
      orgId = parsed;
    }
    const rawLanguage = process.env.CONTA_LANGUAGE;
    let language: ContaLanguage | undefined;
    if (rawLanguage !== undefined && rawLanguage !== "") {
      const upper = rawLanguage.toUpperCase();
      if (upper !== "NO" && upper !== "EN") {
        throw new Error(`CONTA_LANGUAGE must be NO or EN, got "${rawLanguage}"`);
      }
      language = upper;
    }
    const rawTimeout = process.env.CONTA_TIMEOUT_MS;
    let timeoutMs: number | undefined;
    if (rawTimeout !== undefined && rawTimeout !== "") {
      const parsed = Number(rawTimeout);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`CONTA_TIMEOUT_MS must be a positive integer, got "${rawTimeout}"`);
      }
      timeoutMs = parsed;
    }
    return {
      apiKey,
      orgId,
      language,
      timeoutMs,
      baseUrl: process.env.CONTA_BASE_URL || undefined,
    };
  }

  /**
   * Resolve the org id for a call: explicit argument wins, then the client
   * default. Throws a message the LLM can act on when neither is available.
   */
  resolveOrgId(opContextOrgId?: number): number {
    const orgId = opContextOrgId ?? this.defaultOrgId;
    if (orgId === undefined) {
      throw new Error(
        "No organization id available — pass opContextOrgId, or set CONTA_ORG_ID. Use list_organizations to find valid ids."
      );
    }
    return orgId;
  }

  private buildHeaders(
    contentType: string | undefined,
    options: ContaRequestOptions | undefined
  ): Record<string, string> {
    const headers: Record<string, string> = {
      apiKey: this.apiKey,
      Accept: "application/json",
      "conta-language": options?.language ?? this.language,
    };
    if (contentType) headers["Content-Type"] = contentType;
    // Only send the control headers when enabled — Conta treats their presence
    // as meaningful, so an explicit "false" is noise we don't want on the wire.
    if (options?.dryRun) headers["conta-force-rollback"] = "true";
    if (options?.forceReadonly) headers["conta-force-readonly"] = "true";
    return headers;
  }

  private buildUrl(path: string, params?: QueryParams): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          // The spec sets no `style`/`explode`, so OpenAPI's query default
          // applies: form/explode=true, i.e. one repeated key per item.
          for (const item of v) {
            if (item === undefined || item === null) continue;
            url.searchParams.append(k, toQueryValue(item));
          }
          continue;
        }
        url.searchParams.set(k, toQueryValue(v));
      }
    }
    return url.toString();
  }

  /** A fresh abort signal per attempt, so a retry gets its own full timeout. */
  private timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }

  /**
   * Retries on 429 apply to every method, including POST. That assumes Conta
   * rejects a rate-limited request before processing it, which is what a 429
   * means; a request that was processed never comes back as 429.
   */
  private async fetchWithRetry(
    method: string,
    path: string,
    buildRequest: () => Promise<Response>
  ): Promise<Response> {
    let attempt = 0;

    for (;;) {
      let res: Response;
      try {
        res = await buildRequest();
      } catch (e) {
        if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
          const base = `Conta ${method} ${path} timed out after ${this.timeoutMs} ms (set CONTA_TIMEOUT_MS to change).`;
          // A write that timed out may still have been carried out by Conta.
          // Retrying blindly can create a second invoice or payment.
          throw new Error(
            method === "GET"
              ? base
              : `${base} The request may still have been carried out by Conta. Do NOT retry until you have checked whether it was saved (for example with search_invoices, search_invoice_drafts, get_invoice_payments or search_customers).`
          );
        }
        throw e;
      }

      if (res.status === 429) {
        const backoffMs = computeBackoffMs(attempt, res.headers, this.initialBackoffMs);
        if (attempt >= this.maxRetries) {
          const text = await res.text();
          throw new ContaRateLimitError(
            `Conta ${method} ${path} rate limited (429) after ${attempt} retries`,
            429,
            text,
            backoffMs
          );
        }
        await this.sleepImpl(backoffMs);
        attempt++;
        continue;
      }

      return res;
    }
  }

  /** Parse a response, throwing ContaApiError on any non-2xx status. */
  private async parseResponse(
    method: string,
    path: string,
    res: Response
  ): Promise<unknown> {
    const text = await res.text();
    if (!res.ok) {
      // bodyText carries Conta's own error payload verbatim so the LLM can
      // self-correct. The API key is never included in the message.
      throw new ContaApiError(`Conta ${method} ${path} (${res.status})`, res.status, text);
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async request(
    method: string,
    path: string,
    params?: QueryParams,
    body?: unknown,
    options?: ContaRequestOptions
  ): Promise<unknown> {
    const res = await this.fetchWithRetry(method, path, async () =>
      this.fetchImpl(this.buildUrl(path, params), {
        method,
        headers: this.buildHeaders(
          body !== undefined ? "application/json" : undefined,
          options
        ),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: this.timeoutSignal(),
      })
    );

    return this.parseResponse(method, path, res);
  }

  async get(path: string, params?: QueryParams, options?: ContaRequestOptions) {
    return this.request("GET", path, params, undefined, options);
  }

  async post(
    path: string,
    body: unknown,
    params?: QueryParams,
    options?: ContaRequestOptions
  ) {
    return this.request("POST", path, params, body, options);
  }

  async put(
    path: string,
    body: unknown,
    params?: QueryParams,
    options?: ContaRequestOptions
  ) {
    return this.request("PUT", path, params, body, options);
  }

  async patch(
    path: string,
    body: unknown,
    params?: QueryParams,
    options?: ContaRequestOptions
  ) {
    return this.request("PATCH", path, params, body, options);
  }

  async delete(path: string, params?: QueryParams, options?: ContaRequestOptions) {
    return this.request("DELETE", path, params, undefined, options);
  }

  /**
   * POST multipart/form-data (bilagsinnboks / vedlegg). Does not set
   * Content-Type; fetch sets the boundary automatically.
   */
  async postMultipart(
    path: string,
    formData: FormData,
    params?: QueryParams,
    options?: ContaRequestOptions
  ): Promise<unknown> {
    const res = await this.fetchWithRetry("POST", path, async () =>
      this.fetchImpl(this.buildUrl(path, params), {
        method: "POST",
        headers: this.buildHeaders(undefined, options),
        body: formData,
        signal: this.timeoutSignal(),
      })
    );

    return this.parseResponse("POST", path, res);
  }
}
