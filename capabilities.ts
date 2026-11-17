/**
 * Catalog metadata -> pi model fields.
 *
 * The client catalog is the only place Command Code publishes which reasoning
 * efforts a model accepts, whether it takes images, its output cap, its price
 * (including context tiers) and whether ZDR can reach it. Everything here is
 * pure so the mapping can be tested without a network or a pi host.
 *
 * Why a per-model `thinkingLevelMap` matters: pi's OpenAI adapter sends
 * `reasoning_effort` for every level the map does not mark `null`. Command
 * Code rejects levels a model does not list — 14 models in the current catalog
 * reject `medium` — so an unmapped model 400s on a level the picker offered.
 */

import type { ModelCost } from "@earendil-works/pi-ai";
import type { CatalogPricing, RemoteModel } from "./catalog.ts";

/** Every level pi can show, in pi's own order. */
export const THINKING_KEYS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingKey = (typeof THINKING_KEYS)[number];
export type ThinkingMap = Partial<Record<ThinkingKey, string | null>>;

/**
 * Builds pi's level map from the catalog's effort list.
 *
 * `undefined` means the catalog did not report the field at all, so no map is
 * registered and pi keeps its defaults. A `null` or empty list means the model
 * has no selectable effort: every level maps to null, which leaves only `off`
 * in the picker. That distinction matters — pi sends `reasoning_effort` for any
 * level the map leaves unmapped, and these models reject it.
 */
export function thinkingLevelMap(
  efforts: readonly string[] | null | undefined,
): ThinkingMap | undefined {
  if (efforts === undefined) return undefined;
  const levels = efforts ?? [];
  const map: ThinkingMap = {};
  for (const level of THINKING_KEYS) {
    map[level] = levels.includes(level) ? level : null;
  }
  return map;
}

/**
 * Image support. Unknown means text-only: advertising images for a text-only
 * model turns a normal prompt into a 400 from the upstream.
 */
export function supportsImages(m: RemoteModel): boolean {
  const modalities = m.inputModalities ?? m.modalities?.input;
  return Array.isArray(modalities) && modalities.includes("image");
}

/**
 * The output cap. A published cap is clamped by the context window, because pi
 * rejects a model whose maxTokens exceeds its contextWindow.
 */
export function maxTokensFor(m: RemoteModel, fallback: number): number {
  const published = m.maxOutputTokens ?? m.max_output_tokens ?? undefined;
  const context = m.context_length;
  const cap = typeof published === "number" && published > 0 ? published : fallback;
  return typeof context === "number" && context > 0
    ? Math.min(cap, context)
    : cap;
}

/** Reads one flat rate block, accepting both field spellings. */
function ratesFrom(p: CatalogPricing | undefined): ModelCost | undefined {
  if (!p) return undefined;
  const num = (v: number | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

  const input = num(p.inputCost) ?? num(p.input);
  const output = num(p.outputCost) ?? num(p.output);
  // A price needs at least one usable side; a negative one is not a price.
  if (input === undefined && output === undefined) return undefined;

  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(p.cacheReadCost) ?? num(p.cache_read) ?? 0,
    cacheWrite: num(p.cacheWriteCost) ?? num(p.cache_write) ?? 0,
  };
}

function tiersOf(p: CatalogPricing): CatalogPricing["contextTiers"] {
  return p.contextTiers ?? p.context_tiers;
}

/**
 * Catalog price -> pi cost block, including request-size tiers.
 *
 * pi applies a tier when the request's input exceeds `inputTokensAbove`, using
 * the highest matching threshold for the whole request. The catalog lists
 * tiers ascending with an open-ended last entry, so each catalog tier becomes
 * the threshold of the previous one.
 */
export function costFromCatalog(pricing: CatalogPricing | undefined): ModelCost | undefined {
  if (!pricing) return undefined;

  const tiers = tiersOf(pricing);
  if (!Array.isArray(tiers) || tiers.length === 0) return ratesFrom(pricing);

  const base = ratesFrom(tiers[0]?.rates);
  const scaled: NonNullable<ModelCost["tiers"]> = [];
  for (let i = 1; i < tiers.length; i++) {
    const above = tiers[i - 1]?.maxContext;
    const rates = ratesFrom(tiers[i]?.rates);
    // A tier without a threshold or without rates cannot be expressed in pi.
    if (above === undefined || !rates) break;
    scaled.push({ inputTokensAbove: above, ...rates });
  }
  if (!base) return ratesFrom(pricing);
  return scaled.length > 0 ? { ...base, tiers: scaled } : base;
}

const PLAN_LABELS: Record<string, string> = {
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-max": "Max",
  "individual-provider": "Provider",
};

/** Turns a catalog plan id into something a person can act on. */
export function planLabel(minimumPlan: string | null | undefined): string | undefined {
  if (!minimumPlan) return undefined;
  return PLAN_LABELS[minimumPlan] ?? minimumPlan;
}

/**
 * How to say what a model needs, for the plan-gating error.
 *
 * Command Code's docs describe the 9 `individual-provider` models (Claude Opus
 * and Fable, GPT-6 Astra, Fugu Ultra) as "require a Max plan", and add "you can
 * also use them with pay-as-you-go credits through the Provider API". Both
 * routes are real, so the hint names both instead of sending a Max subscriber
 * hunting for a plan they already have.
 */
export function planRequirement(
  minimumPlan: string | null | undefined,
): string | undefined {
  const label = planLabel(minimumPlan);
  if (!label) return undefined;
  if (minimumPlan === "individual-provider") {
    return "the Provider plan (pay-as-you-go) or Max";
  }
  if (minimumPlan === "individual-max") return "Max";
  return `${label} or above`;
}

/** Human label for an API wire, used by status and diagnostics output. */
export function wireLabel(api: string): string {
  switch (api) {
    case "anthropic-messages":
      return "messages";
    case "openai-responses":
      return "responses";
    case "openai-completions":
      return "chat-completions";
    default:
      return api;
  }
}
