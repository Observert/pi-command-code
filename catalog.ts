/**
 * The Command Code model catalog: two views of the same 101 models, plus a
 * disk cache so a network failure does not leave pi with no models.
 *
 * `/provider/v1/models` (the documented shape) carries `supported_endpoints`
 * but no capability or price metadata. `/provider/v1/models?view=client`
 * carries everything pi needs — `reasoningEfforts`, `inputModalities`,
 * `maxOutputTokens`, `pricing` with context tiers, `zdr`, `minimumPlan` — but
 * not the endpoints. So the provider fetches both, public and unauthenticated
 * (a successful fetch proves nothing about the key; see verifyApiKey), and
 * joins them by id.
 *
 * Server-rendered docs and a pinned CLI snapshot were the alternative. Both go
 * stale between releases; this view is what the Command Code CLI itself reads.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Pricing as the catalog reports it (USD per million tokens). */
export interface CatalogPricing {
  /** Current client-view field names. */
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  cacheWrite1hCost?: number;
  /**
   * Ascending request-size tiers. Only the last entry may omit `maxContext`,
   * which marks it as the open-ended top tier.
   */
  contextTiers?: Array<{ maxContext?: number; rates: CatalogPricing }>;
  /** Older snake_case names, still accepted so a stale cache keeps working. */
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  context_tiers?: Array<{ maxContext?: number; rates: CatalogPricing }>;
}

/** One model, merged from both catalog views. Every new field is optional. */
export interface RemoteModel {
  id: string;
  name?: string;
  context_length?: number;
  /** Routes this model answers on. Only the documented view reports it. */
  supported_endpoints?: string[];
  pricing?: CatalogPricing;
  /** Input modalities, current camelCase field. */
  inputModalities?: string[] | null;
  /** Output cap, current camelCase field. Null means "not published". */
  maxOutputTokens?: number | null;
  /** Selectable reasoning efforts. Absent = unknown, empty = none. */
  reasoningEfforts?: string[] | null;
  /** False when the upstream has no zero-data-retention path. */
  zdr?: boolean;
  minimumPlan?: string | null;
  /** Catalog-hidden models are not registered at all. */
  hidden?: boolean;
  /** Older snake_case / nested shapes, still accepted. */
  max_output_tokens?: number | null;
  modalities?: { input?: string[] };
  reasoning?: boolean;
}

export interface Catalog {
  /** Version of the client view that produced `models`, when reported. */
  catalogVersion?: string;
  /** How long the catalog stays fresh, in milliseconds. */
  refreshAfterMs?: number;
  /** Wall-clock time of the fetch that produced `models`. */
  fetchedAt: number;
  models: RemoteModel[];
}

export interface CatalogSource {
  catalog: Catalog;
  /** Where `catalog` came from; shown by /commandcode-status. */
  source: "network" | "cache";
  /** Set when a network refresh failed and a cache was used instead. */
  warning?: string;
}

const DEFAULT_REFRESH_MS = 15 * 60 * 1000;

/** `<base>/models`, where `<base>` is the OpenAI-shaped provider root. */
export const MODELS_PATH = "/models";

/**
 * Cache location. `COMMANDCODE_MODELS_CACHE` wins so tests and sandboxes can
 * point it anywhere; otherwise it sits next to pi's own auth file.
 */
export function cachePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = (env.COMMANDCODE_MODELS_CACHE ?? "").trim();
  if (explicit) return explicit;
  return join(agentDir(env), "command-code-catalog.json");
}

export function agentDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const dir = (env.PI_CODING_AGENT_DIR ?? "").trim();
  return dir || join(homedir(), ".pi", "agent");
}

async function fetchView(
  url: string,
  signal?: AbortSignal,
): Promise<{ models: RemoteModel[]; catalogVersion?: string; refreshAfterMs?: number }> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const payload = (await res.json()) as {
    data?: RemoteModel[];
    catalogVersion?: string;
    refreshAfterSeconds?: number;
  };
  return {
    models: payload.data ?? [],
    catalogVersion: payload.catalogVersion,
    refreshAfterMs:
      typeof payload.refreshAfterSeconds === "number" && payload.refreshAfterSeconds > 0
        ? payload.refreshAfterSeconds * 1000
        : undefined,
  };
}

/**
 * Joins the two views. Fields are merged per model, never replaced, so a view
 * that loses a field cannot silently drop capability or routing information.
 */
export function mergeViews(
  documented: RemoteModel[],
  client: RemoteModel[],
): RemoteModel[] {
  const byId = new Map<string, RemoteModel>();
  for (const m of documented) byId.set(m.id, { ...m });
  for (const m of client) {
    const existing = byId.get(m.id);
    byId.set(m.id, existing ? { ...existing, ...m } : { ...m });
  }
  return [...byId.values()].filter((m) => m.hidden !== true);
}

/**
 * Fetches both views and merges them.
 *
 * One view failing still yields a usable catalog: the documented view alone
 * gives routing and context, the client view alone gives capabilities and
 * prices. Both failing is the only hard error.
 */
export async function fetchCatalog(
  modelsUrl: string,
  signal?: AbortSignal,
): Promise<Catalog> {
  const [documented, client] = await Promise.allSettled([
    fetchView(modelsUrl, signal),
    fetchView(`${modelsUrl}?view=client`, signal),
  ]);

  const documentedModels =
    documented.status === "fulfilled" ? documented.value.models : [];
  const clientModels = client.status === "fulfilled" ? client.value.models : [];

  if (documented.status === "rejected" && client.status === "rejected") {
    throw documented.reason;
  }

  return {
    catalogVersion:
      client.status === "fulfilled" ? client.value.catalogVersion : undefined,
    refreshAfterMs:
      client.status === "fulfilled" ? client.value.refreshAfterMs : undefined,
    fetchedAt: Date.now(),
    models: mergeViews(documentedModels, clientModels),
  };
}

/** Reads the cache. Unreadable or malformed caches are treated as absent. */
export function readCache(path: string): Catalog | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Catalog;
    if (!Array.isArray(parsed?.models) || parsed.models.length === 0) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Writes the cache atomically, so a crash mid-write cannot leave a truncated
 * JSON file that would be rejected on the next start.
 */
export function writeCache(path: string, catalog: Catalog): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(catalog));
  renameSync(tmp, path);
}

export const DEFAULT_REFRESH_INTERVAL_MS = DEFAULT_REFRESH_MS;

/** True when a cached catalog is older than the server's refresh hint. */
export function cacheIsStale(
  catalog: Catalog,
  now = Date.now(),
): boolean {
  const interval = catalog.refreshAfterMs ?? DEFAULT_REFRESH_MS;
  return now - catalog.fetchedAt >= interval;
}
