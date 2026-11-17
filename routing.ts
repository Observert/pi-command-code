/**
 * Persistent per-model endpoint overrides.
 *
 * Routing normally follows the catalog's `supported_endpoints`, which is right
 * for every model today. An override exists for the case the catalog gets it
 * wrong for one model, or for pinning a model to a wire you know works.
 *
 * Choices live in their own file next to the catalog cache, not in the cache
 * itself: the cache is regenerated on every refresh and would erase them. A
 * malformed file is ignored with a visible warning, so routing degrades to the
 * catalog instead of breaking startup.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentDir } from "./catalog.ts";

export const WIRES = [
  "auto",
  "chat-completions",
  "responses",
  "messages",
] as const;

export type Wire = (typeof WIRES)[number];

/** Model id -> wire. `auto` means "no override". */
export type Routing = Record<string, Wire>;

export function routingPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = (env.COMMANDCODE_ROUTING_FILE ?? "").trim();
  return explicit || join(agentDir(env), "commandcode-routing.json");
}

export function isWire(value: string): value is Wire {
  return (WIRES as readonly string[]).includes(value);
}

/**
 * Reads the override file. Missing is normal (no overrides). Unparseable or
 * wrongly shaped values are dropped per entry rather than failing the whole
 * file, and the reason is returned so the caller can warn once.
 */
export function readRouting(path: string): { routing: Routing; warning?: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { routing: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      routing: {},
      warning: `${path} is not valid JSON; using the catalog's routing until you rerun /commandcode-endpoint.`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      routing: {},
      warning: `${path} must be a JSON object of model id to wire; ignoring it.`,
    };
  }

  const routing: Routing = {};
  const dropped: string[] = [];
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && isWire(value) && value !== "auto") {
      routing[id] = value;
    } else if (value !== "auto") {
      dropped.push(id);
    }
  }

  return {
    routing,
    warning:
      dropped.length > 0
        ? `${path}: ignoring invalid wire for ${dropped.join(", ")}.`
        : undefined,
  };
}

/** Rewrites the override file atomically, keeping it private. */
export function writeRouting(path: string, routing: Routing): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(routing, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Records one choice. `auto` removes the override, which is also the repair
 * path for a malformed file: the next successful write replaces it.
 */
export function applyRouting(
  routing: Routing,
  modelId: string,
  wire: Wire,
): Routing {
  const next = { ...routing };
  if (wire === "auto") delete next[modelId];
  else next[modelId] = wire;
  return next;
}
