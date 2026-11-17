import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createProvider,
  type Api,
  type Model,
  type ModelCost,
} from "@earendil-works/pi-ai";
// pi resolves bundled pi-ai subpaths by name for installed extensions, and
// /compat re-exports the same lazy API factories the built-in providers use.
// The /api/*.lazy subpaths are not in that map, so importing them directly
// fails from an npm install.
import {
  anthropicMessagesApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";

import { RATE_CARDS } from "./rates.ts";
import {
  cacheIsStale,
  cachePath,
  fetchCatalog,
  readCache,
  writeCache,
  type Catalog,
  type RemoteModel,
} from "./catalog.ts";
import {
  costFromCatalog,
  maxTokensFor,
  planRequirement,
  supportsImages,
  thinkingLevelMap,
  wireLabel,
} from "./capabilities.ts";
import { commandCodeAuth } from "./auth.ts";
import {
  applyRouting,
  readRouting,
  routingPath,
  writeRouting,
  type Routing,
  type Wire,
} from "./routing.ts";
import { fetchQuota, formatQuota } from "./quota.ts";
import {
  formatDiagnostics,
  formatStatus,
  parseEndpointArgs,
  type CatalogState,
  type LastRequest,
} from "./commands.ts";
import { withPeakPricing } from "./peak.ts";

/**
 * Command Code Provider API for pi.
 *
 * Command Code exposes three endpoints, each taking its own request shape:
 *   - /provider/v1/chat/completions  (OpenAI shape)    -> most models
 *   - /provider/v1/responses         (OpenAI Responses) -> models that ask for it
 *   - /provider/v1/messages          (Anthropic shape) -> Claude models
 *
 * Sending a model to the wrong wire is a hard 400, so the API type is chosen
 * per model from the catalog's `supported_endpoints`, with the id prefix only
 * as the fallback for a catalog that omits the field.
 *
 * Why baseUrl is set per model rather than once on the provider: the two SDKs
 * append their own path to baseUrl, and they disagree.
 *
 *   OpenAI SDK    -> <baseUrl>/chat/completions
 *   Anthropic SDK -> <baseUrl>/v1/messages
 *
 * Command Code serves /provider/v1/chat/completions and /provider/v1/messages,
 * so the two shapes need different baseUrls:
 *
 *   OpenAI:    https://api.commandcode.ai/provider/v1  -> .../provider/v1/chat/completions
 *   Anthropic: https://api.commandcode.ai/provider     -> .../provider/v1/messages
 *
 * Using the OpenAI baseUrl for both yields .../provider/v1/v1/messages -> 404.
 */

export const PROVIDER_ID = "command-code";
export const PROVIDER_NAME = "Command Code";
export const PACKAGE_VERSION = "1.3.0";

export { API_KEY_ENV_VARS } from "./auth.ts";
export type { RemoteModel } from "./catalog.ts";

/** API root, overridable for gateways and on-prem deployments. */
const API_ROOT = (
  process.env.COMMANDCODE_API_BASE_URL ?? "https://api.commandcode.ai"
)
  .trim()
  .replace(/\/+$/, "");

export const openaiBaseUrl = () => `${API_ROOT}/provider/v1`;
export const anthropicBaseUrl = () => `${API_ROOT}/provider`;
export const MODELS_URL = `${openaiBaseUrl()}/models`;

/**
 * Claude is served through the Anthropic Messages endpoint; every other model
 * family in the catalog (OpenAI, Google, DeepSeek, Moonshot, Z.ai, MiniMax,
 * Qwen, xAI, Meta, ...) goes through an OpenAI-shaped endpoint.
 */
export const isAnthropicModel = (id: string) => id.startsWith("claude-");

/**
 * Claude 5.x and 4.7+ reject `thinking.type: "enabled"` and require the
 * adaptive shape. The 4.5 haiku is the exception: it rejects "adaptive".
 * pi only sends adaptive when the model sets `compat.forceAdaptiveThinking`.
 */
export const needsLegacyThinking = (id: string) =>
  id === "claude-haiku-4-5-20251001";

/** Maps a routing override onto the API type that serves it. */
function apiForWire(wire: Wire): Api | undefined {
  switch (wire) {
    case "messages":
      return "anthropic-messages";
    case "responses":
      return "openai-responses";
    case "chat-completions":
      return "openai-completions";
    default:
      return undefined;
  }
}

/**
 * Which route a model answers on.
 *
 * The catalog reports `supported_endpoints` per model, and the wrong route is a
 * hard 400 (`Model "x" must be called via /provider/v1/messages`). Routing from
 * that field means a model that moves, or a family outside the claude-/gpt-
 * prefixes, keeps working without a release. The id prefix is only the fallback
 * for a catalog that omits the field.
 *
 * Verified against the live API: Claude answers on /messages only, GPT on both
 * /responses and /chat/completions, everything else on /chat/completions.
 *
 * An explicit override from /commandcode-endpoint wins over both.
 */
export function apiForModel(m: RemoteModel, override?: Wire): Api {
  const forced = override && override !== "auto" ? apiForWire(override) : undefined;
  if (forced) return forced;

  const endpoints = m.supported_endpoints ?? [];
  if (endpoints.includes("/messages")) return "anthropic-messages";
  if (endpoints.includes("/responses") && m.id.startsWith("gpt-")) {
    return "openai-responses";
  }
  if (endpoints.includes("/chat/completions")) return "openai-completions";
  if (endpoints.includes("/responses")) return "openai-responses";
  return isAnthropicModel(m.id) ? "anthropic-messages" : "openai-completions";
}

export interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Cost reporting.
 *
 * pi does not read cost from providers: it computes it locally as
 * `rate_per_million * tokens / 1_000_000` from the `cost` block registered per
 * model, against the real token counts the API does return.
 *
 * Sources, highest first:
 *   1. the live catalog's `pricing` (per model, including context tiers)
 *   2. COMMANDCODE_RATES   (your overrides, e.g. enterprise/ZDR rates)
 *   3. the bundled table   (Command Code's published list rates)
 *   4. zero                (unknown model: never invent a number)
 *
 * DeepSeek peak hours are applied per request by peak.ts, not here.
 */
export const NO_COST: CostRates = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/** The bundled Command Code list rates, keyed by model id. */
export const BUNDLED_RATES: Map<string, CostRates> = new Map(RATE_CARDS);

/**
 * Parses per-model rate overrides from COMMANDCODE_RATES.
 *
 * Format: entries separated by `;`, each `modelId=input,output[,cacheRead[,cacheWrite]]`,
 * with rates in USD per million tokens. Example:
 *
 *   COMMANDCODE_RATES="deepseek/deepseek-v4-flash=0.15,0.6,0.003;claude-sonnet-4-6=3,15,0.3,3.75"
 *
 * `;` separates entries rather than `,` because `,` already separates the
 * rates within an entry. A single `,`-only format cannot be parsed
 * unambiguously.
 *
 * `*` sets a fallback for any model without its own entry. Malformed entries
 * are skipped rather than throwing, so a typo can never stop pi from starting.
 */
export function parseRateOverrides(
  value: string | undefined,
): Map<string, CostRates> {
  const out = new Map<string, CostRates>();
  if (!value) return out;

  const num = (s: string): number | undefined => {
    const n = Number.parseFloat(s.trim());
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  // Accept ';' or newline as the entry separator so multi-line env values work.
  for (const entry of value.split(/[;\n]/)) {
    const eq = entry.indexOf("=");
    // An entry needs a model id and at least one rate.
    if (eq < 1) continue;

    const id = entry.slice(0, eq).trim();
    if (!id) continue;

    // Everything after the first '=' is the rate list. Model ids may contain
    // '/' and ':', so only the first '=' is treated as the separator.
    const values = entry
      .slice(eq + 1)
      .split(/[,|\s]+/)
      .filter((s) => s !== "")
      .map(num);

    const [input, output, cacheRead, cacheWrite] = values;
    if (input === undefined || output === undefined) continue;

    out.set(id, {
      input,
      output,
      cacheRead: cacheRead ?? 0,
      cacheWrite: cacheWrite ?? 0,
    });
  }
  return out;
}

/**
 * Resolves the cost block for a model.
 *
 * Precedence: explicit overrides (including `*`) win over the bundled table, so
 * COMMANDCODE_RATES can correct a stale bundled rate or apply your own
 * negotiated rates. Unknown models fall back to zero rather than a guess.
 */
export function resolveCost(
  id: string,
  overrides: Map<string, CostRates> = new Map(),
  bundled: Map<string, CostRates> = BUNDLED_RATES,
): CostRates {
  return overrides.get(id) ?? overrides.get("*") ?? bundled.get(id) ?? NO_COST;
}

/**
 * pi requires a maxTokens value. The catalog publishes one for the models that
 * cap output below their context window; the rest get this floor, which every
 * model in the catalog accepts.
 */
export const DEFAULT_MAX_TOKENS = 32768;

export const DEFAULT_CONTEXT_WINDOW = 200000;

/** Reads a positive integer from env, falling back when unset or invalid. */
export function positiveIntFromEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * ZDR is opt-in via `COMMANDCODE_ZDR=1`. It is deliberately NOT the default:
 * Command Code fails the request outright (422 cmd_zdr_no_providers) rather
 * than falling back to a provider that retains data, so turning it on silently
 * would break whichever models happen to lack ZDR coverage.
 */
export const ZDR_HEADER = { "x-cmd-zdr": "1" };

/**
 * `COMMANDCODE_ZDR=1` turns on zero data retention for every request.
 * Accepts the truthy spellings people actually use; anything else is off.
 */
export function zdrEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = (env.COMMANDCODE_ZDR ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Extra models to hide while ZDR is on, beyond the ones the catalog itself
 * marks as having no ZDR path.
 *
 * Empty by default and never hardcoded: ZDR coverage grows as Command Code
 * signs upstream agreements, and a stale list would hide models that work. A
 * 422 is still detected and explained in plain language; this env var only
 * lets you hide a model up front instead of hitting the error.
 */
export function zdrSkipList(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const raw = (env.COMMANDCODE_ZDR_SKIP ?? "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Reads per-model pricing out of the catalog. Returns undefined when there is
 * no usable price, so the override/bundled table still wins.
 */
export function costFromPricing(
  pricing: NonNullable<RemoteModel["pricing"]>,
): ModelCost | undefined {
  return costFromCatalog(pricing);
}

export interface ModelOptions {
  /** Wire chosen by /commandcode-endpoint, when one is set for this model. */
  wire?: Wire;
}

export function toModel(
  m: RemoteModel,
  maxTokens: number,
  costs: Map<string, CostRates> = new Map(),
  zdr = false,
  options: ModelOptions = {},
): Model<Api> {
  const api = apiForModel(m, options.wire);
  const anthropic = api === "anthropic-messages";
  const compat = compatFor(m.id, api);
  const thinking = thinkingLevelMap(m.reasoningEfforts);
  return {
    id: m.id,
    name: m.name ?? m.id,
    api,
    provider: PROVIDER_ID,
    // Per-model baseUrl: the two SDKs disagree about who appends /v1.
    baseUrl: anthropic ? anthropicBaseUrl() : openaiBaseUrl(),
    // pi only offers thinking levels when this is true. Models the catalog
    // reports no selectable effort for are still reasoners — they just map
    // every level to null below, which leaves `off` alone in the picker.
    reasoning: m.reasoning ?? true,
    ...(thinking ? { thinkingLevelMap: thinking } : {}),
    input: supportsImages(m) ? ["text", "image"] : ["text"],
    // Catalog pricing wins, then COMMANDCODE_RATES, then the bundled table.
    cost: (m.pricing ? costFromCatalog(m.pricing) : undefined) ??
      resolveCost(m.id, costs),
    contextWindow: m.context_length ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: maxTokensFor(m, maxTokens),
    // ZDR rides on the model: that is the field pi merges into each request.
    headers: zdr ? ZDR_HEADER : undefined,
    compat,
  };
}

/**
 * Per-API compatibility overrides. Verified against the live gateway rather
 * than assumed from the endpoint advertising compatibility.
 */
function compatFor(id: string, api: Api) {
  if (api !== "anthropic-messages") {
    return {
      // pi only sends `reasoning_effort` when this is set, so without it the
      // thinking UI would be a lie. Levels a model does not accept are removed
      // by thinkingLevelMap instead.
      supportsReasoningEffort: true,
      thinkingFormat: "openai" as const,
      // Several upstreams behind this route reject the `developer` role pi sends
      // to reasoning models, and the max_completion_tokens field it defaults to.
      // Every upstream accepts `system` and `max_tokens`.
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens" as const,
    };
  }
  // Claude 5.x / 4.7+ reject thinking.type=enabled; the 4.5 haiku is the one
  // model that rejects adaptive instead.
  return needsLegacyThinking(id) ? undefined : { forceAdaptiveThinking: true };
}

/**
 * Fetches the catalog.
 *
 * Note: these endpoints are PUBLIC. They return the full model list with HTTP
 * 200 even when the API key is missing or invalid, so a successful fetch proves
 * nothing about credentials. `verifyApiKey` exists for that reason.
 */
export async function fetchModels(
  signal?: AbortSignal,
  url: string = MODELS_URL,
): Promise<RemoteModel[]> {
  const catalog = await fetchCatalog(url, signal);
  return catalog.models;
}

export type KeyCheck =
  | { ok: true }
  | {
      ok: false;
      kind: "missing" | "rejected" | "unreachable";
      message: string;
    };

/**
 * Distinguishes "no key / bad key" from "network down", because the catalog
 * endpoint cannot. Uses a real (cheap) completions call, which does enforce
 * auth: it returns 401 for a missing or invalid token.
 */
export async function verifyApiKey(
  apiKey: string,
  signal?: AbortSignal,
): Promise<KeyCheck> {
  if (!apiKey.trim()) {
    return {
      ok: false,
      kind: "missing",
      message:
        "no API key. Run /login command-code, or export COMMANDCODE_API_KEY.",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${openaiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 16,
      }),
      signal,
    });
  } catch (err) {
    return {
      ok: false,
      kind: "unreachable",
      message: `Could not reach Command Code: ${err instanceof Error ? err.message : err}`,
    };
  }

  if (res.status === 401 || res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    const code = body?.error?.code ?? "";
    // 403 is also used for plan gating, which is not a credential problem.
    if (code === "MODEL_NOT_IN_PLAN") return { ok: true };
    const detail = body?.error?.message;
    return {
      ok: false,
      kind: "rejected",
      message:
        `the API key was rejected${detail ? ` (${detail})` : ""}. ` +
        "Run /login command-code to store the current key, or export a fresh COMMANDCODE_API_KEY.",
    };
  }

  // Anything else (200, or an unrelated 400/429) means auth itself is fine.
  return { ok: true };
}

interface PlanError {
  code: string;
  message: string;
}

/**
 * Reads a Command Code error payload out of a pi assistant message. pi stores
 * the upstream error text on `errorMessage`; we only need to pattern-match it.
 *
 * `plan` is the catalog's minimum plan for the model that failed, when known,
 * so a plan error can name the tier instead of pointing at the pricing page.
 */
export function classifyProviderError(
  errorMessage: string | undefined,
  hints: { plan?: string } = {},
): PlanError | null {
  if (!errorMessage) return null;
  // 401 from the gateway: the key is missing, rotated or revoked. This is the
  // failure mode worth naming, because the raw body says only "invalid token".
  if (
    /UNAUTHORIZED|Invalid 'Authorization' header or token/i.test(errorMessage)
  ) {
    return {
      code: "UNAUTHORIZED",
      message:
        "Command Code rejected the API key. Run /login command-code to store the current key, or update COMMANDCODE_API_KEY (the Command Code CLI rotates its stored key, so a key copied into your shell can go stale).",
    };
  }
  if (/MODEL_NOT_IN_PLAN/i.test(errorMessage)) {
    return {
      code: "MODEL_NOT_IN_PLAN",
      message:
        `This model is not included in your Command Code plan${
          hints.plan ? ` (it needs ${hints.plan})` : ""
        }. Upgrade at https://commandcode.ai/pricing, or pick another model — the open-source families work on every tier.`,
    };
  }
  if (/upgrade_required/i.test(errorMessage)) {
    return {
      code: "upgrade_required",
      message:
        "Your Command Code plan has no API access. The $1 Go plan cannot use the Provider API; the Provider plan (or GOAT/Pro/Max/Team) can.",
    };
  }
  if (/cmd_zdr_no_providers/i.test(errorMessage)) {
    return {
      code: "cmd_zdr_no_providers",
      message:
        "This model has no ZDR-capable upstream, so it cannot run while COMMANDCODE_ZDR is enabled. Unset it, or skip this model.",
    };
  }
  return null;
}

/** Reads `provider` off any agent message without assuming its shape. */
function providerOf(message: unknown): string | undefined {
  const provider = (message as { provider?: unknown }).provider;
  return typeof provider === "string" ? provider : undefined;
}

/** Everything the commands and the status line read, updated per registration. */
interface Runtime {
  source: "network" | "cache";
  catalog: Catalog;
  warning?: string;
  /** Models after ZDR filtering. */
  models: RemoteModel[];
  zdrHidden: number;
  skipListed: number;
  wires: Record<string, number>;
  unpriced: number;
  bundledPriced: number;
  overridden: number;
  routing: Routing;
  lastRequest?: LastRequest;
  requestStartedAt?: number;
  auth: "configured" | "missing";
}

export default async function (pi: ExtensionAPI) {
  const env = process.env;
  // Respect pi's abort signal so a slow/unreachable network can't hang startup.
  const timeoutMs = positiveIntFromEnv(env.COMMANDCODE_TIMEOUT_MS, 15000);
  const zdr = zdrEnabled(env);
  const skip = zdrSkipList(env);
  const maxTokens = positiveIntFromEnv(env.COMMANDCODE_MAX_TOKENS, DEFAULT_MAX_TOKENS);
  const costs = parseRateOverrides(env.COMMANDCODE_RATES);
  const cacheFile = cachePath(env);
  const routingFile = routingPath(env);

  const loaded = readRouting(routingFile);

  const warn = (
    ctx: { hasUI: boolean; ui: { notify: (m: string, t: "warning") => void } },
    text: string,
  ): void => {
    console.error(`[command-code] ${text}`);
    if (ctx.hasUI) ctx.ui.notify(`Command Code: ${text}`, "warning");
  };

  const notify = (
    ctx: { hasUI: boolean; ui: { notify: (m: string, t: "info") => void } },
    lines: string[],
  ): void => {
    const text = lines.join("\n");
    console.error(`[command-code] ${text.replace(/\n/g, " | ")}`);
    if (ctx.hasUI) ctx.ui.notify(text, "info");
  };

  const runtime: Runtime = {
    source: "network",
    catalog: { fetchedAt: Date.now(), models: [] },
    models: [],
    zdrHidden: 0,
    skipListed: 0,
    wires: {},
    unpriced: 0,
    bundledPriced: 0,
    overridden: 0,
    routing: loaded.routing,
    auth: "missing",
  };

  /** Applies ZDR filtering and registers the models with pi. */
  const register = (catalog: Catalog): void => {
    let models = catalog.models;
    const before = models.length;

    if (zdr) {
      const skipHidden = models.filter((m) => skip.has(m.id));
      runtime.skipListed = skipHidden.length;
      models = models.filter((m) => !skip.has(m.id));
      const noZdr = models.filter((m) => m.zdr === false);
      runtime.zdrHidden = noZdr.length;
      models = models.filter((m) => m.zdr !== false);
    } else {
      runtime.skipListed = 0;
      runtime.zdrHidden = 0;
    }

    if (before !== models.length) {
      console.error(
        `[command-code] ZDR on: hid ${before - models.length} model(s) ` +
          `(${runtime.zdrHidden} without a ZDR upstream, ${runtime.skipListed} from COMMANDCODE_ZDR_SKIP).`,
      );
    }

    const wires: Record<string, number> = {};
    let unpriced = 0;
    let bundledPriced = 0;
    let overridden = 0;
    const built = models.map((m) => {
      const api = apiForModel(m, runtime.routing[m.id]);
      wires[api] = (wires[api] ?? 0) + 1;
      if (!m.pricing && !costs.has(m.id) && !costs.has("*")) unpriced += 1;
      else if (!m.pricing && costs.has(m.id)) overridden += 1;
      else if (!m.pricing) bundledPriced += 1;
      return toModel(m, maxTokens, costs, zdr, { wire: runtime.routing[m.id] });
    });

    runtime.models = models;
    runtime.wires = wires;
    runtime.unpriced = unpriced;
    runtime.bundledPriced = bundledPriced;
    runtime.overridden = overridden;
    runtime.catalog = catalog;

    pi.registerProvider(
      createProvider<Api>({
        id: PROVIDER_ID,
        name: PROVIDER_NAME,
        // Native auth: `pi` then offers `/login command-code`, which stores the
        // key in pi's credential store. Env vars stay as the fallback, resolved
        // per request, and the CLI's own auth file is read last so an existing
        // `cmd` login works without copying the key.
        auth: { apiKey: commandCodeAuth() },
        models: built,
        api: {
          "anthropic-messages": withPeakPricing(anthropicMessagesApi()),
          "openai-completions": withPeakPricing(openAICompletionsApi()),
          "openai-responses": withPeakPricing(openAIResponsesApi()),
        },
      }),
    );

    // Flag any model that would report $0, so a silent cost gap is visible.
    const unpricedIds = models
      .filter((m) => !m.pricing && !costs.has(m.id) && !costs.has("*"))
      .map((m) => m.id);
    if (unpricedIds.length > 0) {
      console.error(
        `[command-code] ${unpricedIds.length} model(s) have no published rate and will report $0 ` +
          `(tokens still exact): ${unpricedIds.join(", ")}`,
      );
    }
  };

  /** Auth is only set on session_start, and commands can run before it. */
  const syncAuth = (ctx: {
    modelRegistry: { getProviderAuthStatus: (id: string) => { configured: boolean } };
  }): void => {
    runtime.auth = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured
      ? "configured"
      : "missing";
  };

  const stateSnapshot = (): CatalogState => ({
    provider: PROVIDER_NAME,
    packageVersion: PACKAGE_VERSION,
    source: runtime.source,
    catalogVersion: runtime.catalog.catalogVersion,
    modelCount: runtime.models.length,
    fetchedAt: runtime.catalog.fetchedAt,
    cacheFile,
    refreshAfterMs: runtime.catalog.refreshAfterMs ?? 15 * 60 * 1000,
    warning: runtime.warning ?? loaded.warning,
    zdr,
    zdrHidden: runtime.zdrHidden,
    overrideCount: Object.keys(runtime.routing).length,
    auth: runtime.auth,
    unpriced: runtime.unpriced,
    wires: runtime.wires,
    lastRequest: runtime.lastRequest,
  });

  /** Network first, cache second. Undefined means nothing usable. */
  const load = async (): Promise<{ catalog: Catalog; source: "network" | "cache"; warning?: string } | undefined> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const catalog = await fetchCatalog(MODELS_URL, controller.signal);
      if (catalog.models.length === 0) throw new Error("the catalog was empty");
      // A cache we cannot write must not throw away a catalog we already have.
      try {
        writeCache(cacheFile, catalog);
      } catch (err) {
        console.error(
          `[command-code] could not write ${cacheFile}: ${err instanceof Error ? err.message : err}. ` +
            "Models are live for this session; the next start will have no cache.",
        );
      }
      return { catalog, source: "network" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const cached = readCache(cacheFile);
      if (!cached) {
        reportCatalogFailure(
          pi,
          `could not load the model list (${reason}) and ${cacheFile} has no usable copy. ` +
            "Check your network, or set COMMANDCODE_API_BASE_URL for a proxy.",
        );
        return undefined;
      }
      return {
        catalog: cached,
        source: "cache",
        warning: `catalog refresh failed (${reason}); using the cache from ${new Date(cached.fetchedAt).toISOString()}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const first = await load();
  if (!first) return;

  runtime.source = first.source;
  runtime.warning = first.warning;
  register(first.catalog);
  if (first.warning) console.error(`[command-code] ${first.warning}`);

  const commandsAvailable = typeof pi.registerCommand === "function";

  if (commandsAvailable) {
    pi.registerCommand("commandcode-refresh", {
      description: "Re-fetch the Command Code model catalog",
      handler: async (_args, ctx) => {
        const fresh = await load();
        if (!fresh) {
          notify(ctx, [
            `Refresh failed; still showing ${runtime.models.length} model(s) from ${runtime.source}.`,
          ]);
          return;
        }
        runtime.source = fresh.source;
        runtime.warning = fresh.warning;
        register(fresh.catalog);
        notify(ctx, formatStatus(stateSnapshot()));
      },
    });

    pi.registerCommand("commandcode-status", {
      description: "Show Command Code catalog, auth and routing state",
      handler: async (_args, ctx) => {
        syncAuth(ctx);
        notify(ctx, formatStatus(stateSnapshot()));
      },
    });

    pi.registerCommand("commandcode-diagnostics", {
      description: "Print a redacted Command Code support report",
      handler: async (_args, ctx) => {
        syncAuth(ctx);
        notify(
          ctx,
          formatDiagnostics({
            state: stateSnapshot(),
            nodeVersion: process.version,
            platform: `${process.platform}/${process.arch}`,
            apiBase: API_ROOT,
            bundledPriced: runtime.bundledPriced,
            overridden: runtime.overridden,
            skipListed: runtime.skipListed,
            peakPricing: (process.env.COMMANDCODE_PEAK_PRICING ?? "").trim() !== "0",
          }),
        );
      },
    });

    pi.registerCommand("commandcode-quota", {
      description: "Show Command Code credits, plan and usage windows",
      handler: async (args, ctx) => {
        const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
        if (!key) {
          warn(
            ctx,
            "no API key. Run /login command-code, or set COMMANDCODE_API_KEY.",
          );
          return;
        }
        if (args.trim() === "json") {
          notify(ctx, ["(json)", JSON.stringify(await fetchQuota({ apiKey: key, apiRoot: API_ROOT }), null, 2)]);
          return;
        }
        const report = await fetchQuota({ apiKey: key, apiRoot: API_ROOT });
        notify(ctx, formatQuota(report));
      },
    });

    pi.registerCommand("commandcode-endpoint", {
      description: "Pin a model to a wire: auto, chat-completions, responses or messages",
      handler: async (args, ctx) => {
        const parsed = parseEndpointArgs(args);
        if (!parsed.ok) {
          notify(ctx, [parsed.message]);
          return;
        }
        const model = runtime.models.find((m) => m.id === parsed.modelId);
        if (!model) {
          notify(ctx, [
            `Unknown model "${parsed.modelId}". Use the exact catalog id without the command-code/ prefix (see /commandcode-status).`,
          ]);
          return;
        }
        if (apiForModel(model, parsed.wire) === "anthropic-messages" && parsed.wire !== "auto") {
          notify(ctx, [
            `${parsed.modelId} answers on the Anthropic messages wire; that is not one of the OpenAI-shaped overrides. Use auto to restore catalog routing.`,
          ]);
          return;
        }
        runtime.routing = applyRouting(runtime.routing, model.id, parsed.wire);
        try {
          writeRouting(routingFile, runtime.routing);
        } catch (err) {
          warn(ctx, `could not write ${routingFile}: ${err instanceof Error ? err.message : err}`);
        }
        register(runtime.catalog);
        notify(ctx, [
          `${parsed.modelId} -> ${parsed.wire === "auto" ? "catalog routing" : parsed.wire}`,
          `Catalog default for this model: ${wireLabel(apiForModel(model))}`,
        ]);
      },
    });
  }

  // The catalog is public, so it proves nothing about credentials. Check once
  // per process, at session start, instead of failing every request with 401.
  // Headless runs have no UI, so the warning also goes to stderr there.
  let authChecked = false;
  pi.on("session_start", async (_event, ctx) => {
    const configured =
      ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured;
    runtime.auth = configured ? "configured" : "missing";

    // A stale cache is refreshed in the background: startup already has models,
    // so the user is never waiting on the network a second time.
    if (cacheIsStale(runtime.catalog)) {
      void (async () => {
        const fresh = await load();
        if (!fresh || fresh.catalog.catalogVersion === runtime.catalog.catalogVersion) return;
        runtime.source = fresh.source;
        runtime.warning = fresh.warning;
        register(fresh.catalog);
        console.error(
          `[command-code] catalog refreshed in the background (${runtime.models.length} models).`,
        );
      })();
    }

    if (authChecked) return;
    authChecked = true;

    if (!configured) {
      warn(
        ctx,
        "no API key. Run /login command-code, or set COMMANDCODE_API_KEY.",
      );
      return;
    }

    const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
    if (!key) return;
    const check = await verifyApiKey(key);
    // An unreachable network is not a credential problem and not worth a
    // warning: the request itself reports it.
    if (!check.ok && check.kind !== "unreachable") {
      warn(ctx, check.message);
    }
  });

  pi.on("message_start", (event) => {
    if (providerOf(event.message) === PROVIDER_ID) {
      runtime.requestStartedAt = Date.now();
    }
  });

  // Turn opaque upstream errors into actionable ones. Plan gating, missing API
  // access and ZDR gaps all surface as bare status codes otherwise.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.provider !== PROVIDER_ID) return;

    const started = runtime.requestStartedAt;
    runtime.requestStartedAt = undefined;
    const hint = classifyProviderError(
      message.stopReason === "error" ? message.errorMessage : undefined,
      { plan: planRequirement(runtime.models.find((m) => m.id === message.model)?.minimumPlan) },
    );

    runtime.lastRequest = {
      model: message.model,
      api: message.api,
      at: Date.now(),
      outcome: message.stopReason === "error" ? (hint?.code ?? "error") : message.stopReason,
      latencyMs: started === undefined ? undefined : Date.now() - started,
    };

    if (message.stopReason !== "error") return;
    if (!hint) return;

    return {
      message: {
        ...message,
        errorMessage: `${message.errorMessage}\n\n[command-code] ${hint.message}`,
      },
    };
  });
}

/** Kept out of the main flow so a startup failure has one path. */
function reportCatalogFailure(pi: ExtensionAPI, reason: string): void {
  console.error(`[command-code] ${reason}`);
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(`Command Code: ${reason}`, "warning");
  });
}
