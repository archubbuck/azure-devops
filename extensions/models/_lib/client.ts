import { z } from "npm:zod@4";

/** Global arguments shared by every Azure DevOps behavior type. */
export const GlobalArgsSchema = z.object({
  organization: z.string().optional().describe(
    "Azure DevOps organization name (e.g. 'my-org'). Builds https://dev.azure.com/my-org. Ignored when baseUrl is set.",
  ),
  baseUrl: z.string().url().optional().describe(
    "Full collection URL. Use for legacy 'https://my-org.visualstudio.com' or Server/on-prem 'https://ado.example.com/tfs/DefaultCollection'. Overrides organization.",
  ),
  project: z.string().optional().describe(
    "Default project name or ID (e.g. 'my-project'). Can be overridden per method.",
  ),
  apiVersion: z.string().default("7.2").describe(
    "REST api-version. Defaults to 7.2. Use e.g. '7.1' or '6.0' for older Server releases. A value containing '-preview' is used verbatim for every call.",
  ),
  token: z.string().meta({ sensitive: true }).describe(
    'Personal access token or Entra ID bearer token. Supply via a vault reference: ${{ vault.get("ado", "TOKEN") }}',
  ),
  authType: z.enum(["pat", "bearer"]).default("pat").describe(
    "'pat' sends HTTP Basic with the PAT; 'bearer' sends an Entra ID access token.",
  ),
  maxRetries: z.number().int().min(0).max(10).default(4).describe(
    "Retries for HTTP 429/5xx and network errors, with exponential backoff.",
  ),
  retryBaseMs: z.number().int().min(0).default(500).describe(
    "Base delay in milliseconds for retry backoff.",
  ),
});
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Error carrying the HTTP status and the message Azure DevOps returned. */
export class AdoError extends Error {
  constructor(
    message: string,
    public status: number,
    public url: string,
  ) {
    super(message);
    this.name = "AdoError";
  }
}

/** Per-request options for AdoClient calls. */
export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  /** Project override; falls back to the global project. Pass null for org-level calls. */
  project?: string | null;
  /** Host override, e.g. "https://vsrm.dev.azure.com/my-org" for Release APIs. */
  baseUrl?: string;
  /** Endpoint is preview-only; value is the preview revision, e.g. 1. */
  preview?: number;
  contentType?: string;
  /** Extra request headers, e.g. If-Match for wiki page updates. */
  headers?: Record<string, string>;
  /** Return the raw text body instead of parsing JSON. */
  text?: boolean;
}

/** Parsed response data plus paging and ETag metadata. */
export interface AdoResponse<T> {
  data: T;
  continuationToken?: string;
  etag?: string;
}

/** A page of list results with an optional token for the next page. */
export interface ListResult<T> {
  count: number;
  items: T[];
  nextPageToken?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves the organization base URL from baseUrl or organization. */
export function resolveBaseUrl(g: GlobalArgs): string {
  if (g.baseUrl) return g.baseUrl.replace(/\/+$/, "");
  if (g.organization) {
    return `https://dev.azure.com/${encodeURIComponent(g.organization)}`;
  }
  throw new Error(
    "Set either 'organization' or 'baseUrl' in global arguments.",
  );
}

/**
 * Base URL for APIs hosted on a separate service host: "vsrm" (Release),
 * "feeds" (Artifacts) or "vssps" (Graph/identities). Works for dev.azure.com
 * and legacy visualstudio.com; on-prem Server URLs are returned unchanged.
 */
export function serviceBaseUrl(
  g: GlobalArgs,
  service: "vsrm" | "feeds" | "vssps",
): string {
  const base = resolveBaseUrl(g);
  const u = new URL(base);
  if (u.hostname === "dev.azure.com") {
    return `${u.protocol}//${service}.dev.azure.com${u.pathname}`;
  }
  if (u.hostname.endsWith(".visualstudio.com")) {
    const org = u.hostname.slice(0, -".visualstudio.com".length);
    return `${u.protocol}//${org}.${service}.visualstudio.com${u.pathname}`;
  }
  return base;
}

/** Returns the api-version query value, adding a preview suffix when needed. */
export function resolveApiVersion(g: GlobalArgs, preview?: number): string {
  const v = g.apiVersion || "7.2";
  if (v.includes("-preview")) return v;
  return preview !== undefined ? `${v}-preview.${preview}` : v;
}

/** HTTP client for the Azure DevOps REST API with auth, retry and paging. */
export class AdoClient {
  /** Set once the server reports 7.x is only available as "-preview". */
  private forcePreview = false;

  constructor(private g: GlobalArgs) {
    if (!g.token) throw new Error("A token is required (PAT or bearer).");
  }

  /** The resolved global arguments this client was built with. */
  get globals(): GlobalArgs {
    return this.g;
  }

  private authHeader(): string {
    return this.g.authType === "bearer"
      ? `Bearer ${this.g.token}`
      : `Basic ${btoa(`:${this.g.token}`)}`;
  }

  /** Builds the absolute URL for a path such as "git/repositories". */
  buildUrl(path: string, opts: RequestOptions = {}): string {
    const base = (opts.baseUrl ?? resolveBaseUrl(this.g)).replace(/\/+$/, "");
    const project = opts.project === null
      ? undefined
      : (opts.project ?? this.g.project);
    const prefix = project ? `/${encodeURIComponent(project)}` : "";
    const url = new URL(`${base}${prefix}/_apis/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
    url.searchParams.set(
      "api-version",
      this.forcePreview && !opts.preview &&
        !this.g.apiVersion.includes("-preview")
        ? `${this.g.apiVersion}-preview`
        : resolveApiVersion(this.g, opts.preview),
    );
    return url.toString();
  }

  requireProject(project?: string): string {
    const p = project ?? this.g.project;
    if (!p) {
      throw new Error(
        "A project is required: pass 'project' to the method or set it in global arguments.",
      );
    }
    return p;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<AdoResponse<T>> {
    try {
      return await this.send<T>(method, path, opts);
    } catch (e) {
      // Some 7.x versions only exist as "-preview"; learn that once and retry.
      if (
        e instanceof AdoError && e.status === 400 && !this.forcePreview &&
        !opts.preview && /is under preview/i.test(e.message)
      ) {
        this.forcePreview = true;
        return await this.send<T>(method, path, opts);
      }
      throw e;
    }
  }

  private async send<T = unknown>(
    method: string,
    path: string,
    opts: RequestOptions,
  ): Promise<AdoResponse<T>> {
    const url = this.buildUrl(path, opts);
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: "application/json",
      ...opts.headers,
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = opts.contentType ?? "application/json";
      body = typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
    }
    for (let attempt = 0;; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body });
      } catch (err) {
        if (attempt >= this.g.maxRetries) {
          throw new AdoError(
            `Network error calling ${method} ${redact(url)}: ${
              (err as Error).message
            }`,
            0,
            url,
          );
        }
        await sleep(this.backoff(attempt));
        continue;
      }
      if (res.ok) {
        const continuationToken = res.headers.get("x-ms-continuationtoken") ??
          undefined;
        const etag = res.headers.get("etag") ?? undefined;
        const raw = await res.text();
        if (opts.text) {
          return { data: raw as unknown as T, continuationToken, etag };
        }
        if (!raw) return { data: undefined as T, continuationToken, etag };
        try {
          return { data: JSON.parse(raw) as T, continuationToken, etag };
        } catch {
          throw new AdoError(
            `Expected JSON from ${method} ${
              redact(url)
            } but received a non-JSON body. Check the organization/baseUrl and token.`,
            res.status,
            url,
          );
        }
      }
      const retryable = res.status === 429 ||
        (res.status >= 500 && res.status !== 501);
      if (retryable && attempt < this.g.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await res.body?.cancel();
        await sleep(
          retryAfter > 0 ? retryAfter * 1000 : this.backoff(attempt),
        );
        continue;
      }
      throw new AdoError(
        await describeError(res, method, url),
        res.status,
        url,
      );
    }
  }

  private backoff(attempt: number): number {
    const base = this.g.retryBaseMs * 2 ** attempt;
    return base + Math.floor(Math.random() * (base / 4 + 1));
  }

  get<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("GET", path, opts);
  }
  post<T = unknown>(path: string, body: unknown, opts: RequestOptions = {}) {
    return this.request<T>("POST", path, { ...opts, body });
  }
  patch<T = unknown>(path: string, body: unknown, opts: RequestOptions = {}) {
    return this.request<T>("PATCH", path, { ...opts, body });
  }
  put<T = unknown>(path: string, body: unknown, opts: RequestOptions = {}) {
    return this.request<T>("PUT", path, { ...opts, body });
  }
  delete<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("DELETE", path, opts);
  }

  /**
   * GET a collection, following continuation tokens until exhausted or `limit`
   * items are collected. Handles both `{ value: [] }` and bare-array responses.
   */
  async list<T = unknown>(
    path: string,
    opts: RequestOptions & { limit?: number; maxPages?: number } = {},
  ): Promise<ListResult<T>> {
    const items: T[] = [];
    let token: string | undefined;
    const limit = opts.limit ?? Infinity;
    const maxPages = opts.maxPages ?? 100;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.get<{ value?: T[] } | T[]>(path, {
        ...opts,
        query: { ...opts.query, continuationToken: token },
      });
      const batch = Array.isArray(res.data)
        ? res.data
        : (res.data?.value ?? []);
      items.push(...batch);
      token = res.continuationToken;
      if (!token || items.length >= limit) break;
    }
    const trimmed = items.slice(0, Number.isFinite(limit) ? limit : undefined);
    return { count: trimmed.length, items: trimmed, nextPageToken: token };
  }
}

function redact(url: string): string {
  return url.split("?")[0];
}

async function describeError(
  res: Response,
  method: string,
  url: string,
): Promise<string> {
  const text = await res.text().catch(() => "");
  let message = text.slice(0, 500);
  try {
    const j = JSON.parse(text);
    message = j.message ?? j.value?.Message ?? message;
  } catch { /* non-JSON body: keep raw text */ }
  if (res.status === 401 || res.status === 203) {
    message =
      `${message} (authentication failed: check the token, its scopes and expiry)`;
  }
  return `Azure DevOps ${method} ${
    redact(url)
  } failed with HTTP ${res.status}: ${message || res.statusText}`;
}

/** Throws unless the caller explicitly passed confirm: true. */
export function requireConfirm(confirm: boolean, action: string): void {
  if (confirm !== true) {
    throw new Error(
      `Refusing to ${action}: this is destructive. Re-run with confirm: true.`,
    );
  }
}

/** Makes a string safe as a swamp resource instance name (also valid on Windows). */
export function instanceName(...parts: Array<string | number | undefined>) {
  return parts.filter((p) => p !== undefined && p !== "").join("-")
    // deno-lint-ignore no-control-regex
    .replace(/[<>:"|?*\\/\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "") || "item";
}

/** Schema for list outputs: item count and optional next page token. */
export const ListSchema = z.object({
  count: z.number(),
  items: z.array(z.record(z.string(), z.unknown())),
  nextPageToken: z.string().optional().describe(
    "Present when more pages exist beyond the requested limit.",
  ),
});
/** Optional project argument shared by project-scoped methods. */
export const ProjectArg = z.string().optional().describe(
  "Project name or ID. Defaults to the global project.",
);
/** Confirmation flag required by destructive methods. */
export const ConfirmArg = z.boolean().default(false).describe(
  "Must be true to run this destructive operation.",
);

/** Method execution context supplied by swamp. */
// deno-lint-ignore no-explicit-any
export type Ctx = any;

/** Builds an AdoClient from the context's validated global arguments. */
export function clientFrom(ctx: Ctx): AdoClient {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  ctx.logger?.info("Calling Azure DevOps {baseUrl}", {
    baseUrl: resolveBaseUrl(g),
  });
  return new AdoClient(g);
}

/** Writes one resource and returns the handle list swamp expects. */
export async function emit(
  ctx: Ctx,
  spec: string,
  name: string,
  data: unknown,
) {
  const handle = await ctx.writeResource(spec, name, data);
  ctx.logger?.info("Wrote {spec} {name}", { spec, name });
  return { dataHandles: [handle] };
}
