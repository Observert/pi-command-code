/**
 * Status, diagnostics and endpoint-command text.
 *
 * Everything here is a pure function of state the extension already holds, so
 * the output can be tested without a host. index.ts does the IO and the
 * host wiring.
 */

import { WIRES, type Wire } from "./routing.ts";
import { wireLabel } from "./capabilities.ts";

export interface LastRequest {
  model: string;
  api: string;
  at: number;
  /** "ok", the stop reason, or the classified error code. */
  outcome: string;
  httpStatus?: number;
  /** Milliseconds from request start to the finished message. */
  latencyMs?: number;
}

export interface CatalogState {
  provider: string;
  packageVersion: string;
  source: "network" | "cache";
  catalogVersion?: string;
  modelCount: number;
  fetchedAt: number;
  cacheFile: string;
  refreshAfterMs: number;
  /** Set when the newest network refresh failed. */
  warning?: string;
  zdr: boolean;
  /** Number of models hidden because the catalog reports no ZDR path. */
  zdrHidden: number;
  overrideCount: number;
  auth: "configured" | "missing";
  authSource?: string;
  unpriced: number;
  /** Count of models per wire, e.g. { messages: 12, "chat-completions": 89 }. */
  wires: Record<string, number>;
  lastRequest?: LastRequest;
}

const ago = (from: number, now = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

export const stamp = (at: number): string =>
  `${new Date(at).toISOString().slice(0, 19).replace("T", " ")}Z`;

/** `/commandcode-status`: what the picker is showing and why. */
export function formatStatus(state: CatalogState, now = Date.now()): string[] {
  const lines = [
    `${state.provider} · pi-command-code ${state.packageVersion}`,
    `Models: ${state.modelCount} (${state.source}, catalog ${
      state.catalogVersion ? state.catalogVersion.slice(0, 12) : "unknown"
    }, fetched ${ago(state.fetchedAt, now)})`,
    `Wires: ${Object.entries(state.wires)
      .map(([api, count]) => `${wireLabel(api)} ${count}`)
      .join(", ")}`,
    `Auth: ${state.auth}${state.authSource ? ` (${state.authSource})` : ""}`,
    `ZDR: ${state.zdr ? `on, ${state.zdrHidden} model(s) hidden` : "off"}`,
    `Endpoint overrides: ${state.overrideCount}`,
    `Cache: ${state.cacheFile} (refresh every ${Math.round(state.refreshAfterMs / 60000)}m)`,
  ];
  if (state.unpriced > 0) {
    lines.push(`Unpriced models reporting $0: ${state.unpriced}`);
  }
  if (state.lastRequest) {
    const r = state.lastRequest;
    lines.push(
      `Last request: ${r.model} via ${wireLabel(r.api)} · ${r.outcome}` +
        (r.httpStatus ? ` · HTTP ${r.httpStatus}` : "") +
        (r.latencyMs !== undefined ? ` · ${r.latencyMs}ms` : "") +
        ` · ${ago(r.at, now)}`,
    );
  } else {
    lines.push("Last request: none this session");
  }
  if (state.warning) lines.push(`Warning: ${state.warning}`);
  return lines;
}

export interface DiagnosticsInput {
  state: CatalogState;
  nodeVersion: string;
  platform: string;
  /** Provider API base actually in use. */
  apiBase: string;
  /** Models whose price came from the bundled table rather than the catalog. */
  bundledPriced: number;
  /** Models whose price came from COMMANDCODE_RATES. */
  overridden: number;
  /** Duplicate-ish guards: hidden by ZDR skip list. */
  skipListed: number;
  peakPricing: boolean;
}

/**
 * `/commandcode-diagnostics`: a support report safe to paste in public.
 * No prompts, no credentials, no file paths beyond the cache location the user
 * already configured.
 */
export function formatDiagnostics(
  input: DiagnosticsInput,
  now = Date.now(),
): string[] {
  const s = input.state;
  const lines = [
    "Command Code diagnostics",
    `plugin: pi-command-code ${s.packageVersion}`,
    `host: node ${input.nodeVersion} · ${input.platform}`,
    `api base: ${input.apiBase}`,
    `catalog: ${s.source} · ${s.catalogVersion ?? "no version"} · ${s.modelCount} models · fetched ${stamp(s.fetchedAt)} (${ago(s.fetchedAt, now)})`,
    `catalog cache: ${s.cacheFile}`,
    `wires: ${Object.entries(s.wires)
      .map(([api, count]) => `${wireLabel(api)}=${count}`)
      .join(" ")}`,
    `pricing: catalog ${s.modelCount - input.bundledPriced - input.overridden - s.unpriced}, ` +
      `overrides ${input.overridden}, bundled ${input.bundledPriced}, unpriced ${s.unpriced}`,
    `peak pricing: ${input.peakPricing ? "on" : "off"}`,
    `zdr: ${s.zdr ? "on" : "off"} · hidden ${s.zdrHidden} · skip-listed ${input.skipListed}`,
    `endpoint overrides: ${s.overrideCount}`,
    `auth: ${s.auth}`,
  ];
  if (s.lastRequest) {
    const r = s.lastRequest;
    lines.push(
      `last request: ${r.model} · ${wireLabel(r.api)} · ${r.outcome}` +
        (r.httpStatus ? ` · HTTP ${r.httpStatus}` : "") +
        (r.latencyMs !== undefined ? ` · ${r.latencyMs}ms` : "") +
        ` · ${stamp(r.at)}`,
    );
  }
  if (s.warning) lines.push(`warning: ${s.warning}`);
  return lines;
}

export type EndpointChoice =
  | { ok: true; modelId: string; wire: Wire }
  | { ok: false; message: string };

/**
 * Parses `/commandcode-endpoint <model-id> <wire>`. The model id may contain
 * slashes and colons, so the wire is the last whitespace-separated token.
 */
export function parseEndpointArgs(args: string): EndpointChoice {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return {
      ok: false,
      message:
        `usage: /commandcode-endpoint <model-id> <${WIRES.join("|")}>. ` +
        "Model ids are the exact catalog ids, without the command-code/ prefix.",
    };
  }
  const wire = tokens.at(-1) ?? "";
  const modelId = tokens.slice(0, -1).join(" ");
  if (!(WIRES as readonly string[]).includes(wire)) {
    return {
      ok: false,
      message: `unknown wire "${wire}". Pick one of: ${WIRES.join(", ")}.`,
    };
  }
  return { ok: true, modelId, wire: wire as Wire };
}
