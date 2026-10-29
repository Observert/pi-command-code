import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
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

/**
 * Command Code Provider API for pi.
 *
 * Command Code exposes two endpoints, each taking its own native request shape:
 *   - /provider/v1/chat/completions  (OpenAI shape)    -> non-Claude models
 *   - /provider/v1/messages          (Anthropic shape) -> Claude models
 *
 * Sending a Claude model to /chat/completions (or a non-Claude model to
 * /messages) is a hard 400 with code `unsupported_model`, so the API type is
 * chosen per model by id prefix.
 *
 * Why baseUrl is set per model rather than once on the provider: both pi SDKs
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
 *
 * Everything here is plain ESM + global fetch, so it runs unchanged on macOS,
 * Linux and Windows under any Node >= 18 (pi's minimum). No native modules, no
 * shell commands, no filesystem paths, no platform-specific separators.
 */

export const PROVIDER_ID = "command-code";
export const PROVIDER_NAME = "Command Code";

/**
 * Env vars consulted, in order, when no key is stored by `/login`. Ours first,
 * then the two names the Command Code CLI and its docs use.
 */
export const API_KEY_ENV_VARS = [
  "COMMANDCODE_API_KEY",
  "CMD_API_KEY",
  "COMMAND_CODE_API_KEY",
] as const;

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
 * Qwen, xAI, Meta, ...) goes through OpenAI Chat Completions.
 */
export const isAnthropicModel = (id: string) => id.startsWith("claude-");

/**
 * Claude 5.x and 4.7+ reject `thinking.type: "enabled"` and require the
 * adaptive shape. The 4.5 haiku is the exception: it rejects "adaptive".
 * pi only sends adaptive when the model sets `compat.forceAdaptiveThinking`.
 */
export const needsLegacyThinking = (id: string) =>
  id === "claude-haiku-4-5-20251001";

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
 */
export function apiForModel(m: RemoteModel): Api {
  const endpoints = m.supported_endpoints ?? [];
  if (endpoints.includes("/messages")) return "anthropic-messages";
  if (endpoints.includes("/responses") && m.id.startsWith("gpt-")) {
    return "openai-responses";
  }
  if (endpoints.includes("/chat/completions")) return "openai-completions";
  if (endpoints.includes("/responses")) return "openai-responses";
  return isAnthropicModel(m.id) ? "anthropic-messages" : "openai-completions";
}

export interface RemoteModel {
  id: string;
  name?: string;
  context_length?: number;
  /** Routes this model answers on. Present in the live catalog today. */
  supported_endpoints?: string[];
  /** Not returned yet; read as soon as the API starts sending them. */
  pricing?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  max_output_tokens?: number;
  modalities?: { input?: string[] };
  reasoning?: boolean;
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
 * Command Code does NOT return cost anywhere in the API. Verified against the
 * live API: `/provider/v1/models` exposes only id/object/created/owned_by/
 * name/context_length, response headers carry no billing fields, and both the
 * OpenAI- and Anthropic-shaped bodies (including the final streaming chunk)
 * report token counts only. There is no pricing endpoint.
 *
 * pi does not read cost from providers either: it computes it locally as
 * `rate_per_million * tokens / 1_000_000` from the `cost` block registered per
 * model, against the real token counts the API does return. So accurate cost
 * tracking needs rates, and Command Code publishes them in its docs rather than
 * over the API — see rates.ts, generated by scripts/refresh-rates.mjs.
 *
 * Precedence, highest first:
 *   1. COMMANDCODE_RATES   (your overrides, e.g. enterprise/ZDR rates)
 *   2. the bundled table   (Command Code's published list rates)
 *   3. zero                (unknown model: never invent a number)
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
 * pi requires a maxTokens value and the catalog does not report output caps.
 * 32k is the conservative floor everything in the catalogue accepts. Override
 * per-install with COMMANDCODE_MAX_TOKENS if you hit truncation.
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
 * Models to hide while ZDR is on. Picking one would fail immediately with a 422,
 * because it has no ZDR-capable upstream yet.
 *
 * Empty by default and never hardcoded: ZDR coverage grows as Command Code signs
 * upstream agreements, and a stale list would hide models that work. A 422 is
 * still detected and explained in plain language; this env var only lets you
 * hide the model up front instead of hitting the error.
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
 * Reads per-model pricing out of the catalog when the API supplies it. Returns
 * undefined when there is no usable price, so the bundled table still wins.
 */
export function costFromPricing(
  pricing: NonNullable<RemoteModel["pricing"]>,
): CostRates | undefined {
  const num = (v: number | undefined): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const input = num(pricing.input);
  const output = num(pricing.output);
  // A price needs at least one usable side; a negative one is not a price.
  if (input === undefined && output === undefined) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(pricing.cache_read) ?? 0,
    cacheWrite: num(pricing.cache_write) ?? 0,
  };
}

export function toModel(
  m: RemoteModel,
  maxTokens: number,
  costs: Map<string, CostRates> = new Map(),
  zdr = false,
): Model<Api> {
  const api = apiForModel(m);
  const anthropic = api === "anthropic-messages";
  // Vision defaults to on: every family in the catalog accepted image input
  // when probed, and the catalog only narrows it once it reports modalities.
  const vision = m.modalities?.input
    ? m.modalities.input.includes("image")
    : true;
  const compat = compatFor(m.id, api);
  return {
    id: m.id,
    name: m.name ?? m.id,
    api,
    provider: PROVIDER_ID,
    // Per-model baseUrl: the two SDKs disagree about who appends /v1.
    baseUrl: anthropic ? anthropicBaseUrl() : openaiBaseUrl(),
    // Every family in the catalog accepts reasoning_effort (verified live), and
    // pi only offers thinking levels when this is true.
    reasoning: m.reasoning ?? true,
    input: vision ? ["text", "image"] : ["text"],
    // Catalog pricing wins, then COMMANDCODE_RATES, then the bundled table.
    cost: (m.pricing ? costFromPricing(m.pricing) : undefined) ??
      resolveCost(m.id, costs),
    contextWindow: m.context_length ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: positiveIntFromEnv(
      m.max_output_tokens === undefined ? undefined : String(m.max_output_tokens),
      maxTokens,
    ),
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
      // thinking UI would be a lie. Every family accepts it; models that do not
      // think ignore it rather than rejecting it.
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
 * Note: this endpoint is PUBLIC. It returns the full model list with HTTP 200
 * even when the API key is missing or invalid, so a successful fetch proves
 * nothing about credentials. `verifyApiKey` exists for that reason.
 */
export async function fetchModels(
  signal?: AbortSignal,
): Promise<RemoteModel[]> {
  // No auth header: the catalog is public, and the key now comes from pi's
  // credential store rather than this process's environment.
  const res = await fetch(`${openaiBaseUrl()}/models`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = (await res.json()) as { data?: RemoteModel[] };
  return payload.data ?? [];
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
 */
export function classifyProviderError(
  errorMessage: string | undefined,
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
        "This model is not included in your Command Code plan. Upgrade at https://commandcode.ai/pricing, or pick another model — OpenRouter/DeepSeek models work on every tier.",
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

export default async function (pi: ExtensionAPI) {
  // Respect pi's abort signal so a slow/unreachable network can't hang startup.
  const timeoutMs = positiveIntFromEnv(
    process.env.COMMANDCODE_TIMEOUT_MS,
    15000,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = controller.signal;

  const zdr = zdrEnabled();

  // A catalog failure must not break pi startup, but it must be visible: the
  // user gets "no models" otherwise, with no clue why.
  const reportCatalogFailure = (
    pi: ExtensionAPI,
    reason: string,
  ): void => {
    console.error(`[command-code] ${reason}`);
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`Command Code: ${reason}`, "warning");
    });
  };

  let models: RemoteModel[];
  try {
    models = await fetchModels(signal);
  } catch (err) {
    reportCatalogFailure(
      pi,
      `could not load the model list (${
        err instanceof Error ? err.message : err
      }). Check your network, or set COMMANDCODE_API_BASE_URL for a proxy.`,
    );
    return;
  } finally {
    clearTimeout(timer);
  }

  if (models.length === 0) {
    reportCatalogFailure(pi, "the model catalog was empty; nothing registered.");
    return;
  }

  if (zdr) {
    const skip = zdrSkipList();
    const before = models.length;
    if (skip.size > 0) {
      models = models.filter((m) => !skip.has(m.id));
    }
    const dropped = before - models.length;
    if (dropped > 0) {
      console.error(
        `[command-code] ZDR on: hid ${dropped} model(s) listed in COMMANDCODE_ZDR_SKIP.`,
      );
    }
  }

  const maxTokens = positiveIntFromEnv(
    process.env.COMMANDCODE_MAX_TOKENS,
    DEFAULT_MAX_TOKENS,
  );

  const costs = parseRateOverrides(process.env.COMMANDCODE_RATES);
  const priced = models.filter(
    (m) => resolveCost(m.id, costs) !== NO_COST,
  ).length;

  if (costs.size > 0) {
    const overridden = models.filter((m) => costs.has(m.id)).length;
    const hasFallback = costs.has("*");
    console.error(
      `[command-code] COMMANDCODE_RATES overrides ${overridden} model(s)` +
        `${hasFallback ? " plus a '*' fallback" : ""}; ` +
        `${priced}/${models.length} model(s) have published rates.`,
    );
  }

  // Flag any model that would report $0, so a silent cost gap is visible.
  const unpriced = models.filter((m) => resolveCost(m.id, costs) === NO_COST);
  if (unpriced.length > 0) {
    console.error(
      `[command-code] ${unpriced.length} model(s) have no published rate and will report $0 ` +
        `(tokens still exact): ${unpriced.map((m) => m.id).join(", ")}`,
    );
  }

  pi.registerProvider(
    createProvider<Api>({
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      // Native auth: `pi` then offers `/login command-code`, which stores the
      // key in pi's credential store instead of relying on this process's
      // environment. Env vars stay as the fallback, resolved per request, so a
      // rotated key is picked up without restarting pi.
      auth: {
        apiKey: envApiKeyAuth("Command Code API key", [
          ...API_KEY_ENV_VARS,
        ]),
      },
      models: models.map((m) => toModel(m, maxTokens, costs, zdr)),
      api: {
        "anthropic-messages": anthropicMessagesApi(),
        "openai-completions": openAICompletionsApi(),
        "openai-responses": openAIResponsesApi(),
      },
    }),
  );

  // The catalog is public, so it proves nothing about credentials. Check once
  // per process, at session start, instead of failing every request with 401.
  // Headless runs have no UI, so the warning also goes to stderr there.
  const warn = (
    ctx: { hasUI: boolean; ui: { notify: (m: string, t: "warning") => void } },
    text: string,
  ): void => {
    console.error(`[command-code] ${text}`);
    if (ctx.hasUI) ctx.ui.notify(`Command Code: ${text}`, "warning");
  };

  let authChecked = false;
  pi.on("session_start", async (_event, ctx) => {
    if (authChecked) return;
    authChecked = true;

    if (!ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured) {
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

  // Turn opaque upstream errors into actionable ones. Plan gating, missing API
  // access and ZDR gaps all surface as bare status codes otherwise.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (
      message.provider !== PROVIDER_ID &&
      (message as { provider?: string }).provider !== PROVIDER_ID
    ) {
      return;
    }

    const hint = classifyProviderError(message.errorMessage);
    if (!hint) return;

    return {
      message: {
        ...message,
        errorMessage: `${message.errorMessage}\n\n[command-code] ${hint.message}`,
      },
    };
  });
}
