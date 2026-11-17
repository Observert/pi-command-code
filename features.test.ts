import { test } from "node:test";
import assert from "node:assert/strict";

import {
  THINKING_KEYS,
  costFromCatalog,
  maxTokensFor,
  planLabel,
  planRequirement,
  supportsImages,
  thinkingLevelMap,
} from "./capabilities.ts";
import { cacheIsStale, mergeViews, readCache, writeCache } from "./catalog.ts";
import {
  applyRouting,
  isWire,
  readRouting,
  writeRouting,
} from "./routing.ts";
import { formatQuota } from "./quota.ts";
import {
  formatDiagnostics,
  formatStatus,
  parseEndpointArgs,
} from "./commands.ts";
import { PEAK_FACTOR, isPeak, peakFactor, scaleCost } from "./peak.ts";
import { keyFromAuthFile } from "./auth.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Capabilities: the 400s and the truncated answers live here.
// ---------------------------------------------------------------------------

test("every catalog effort list becomes an explicit pi level map", () => {
  // A model that rejects `medium` must not offer it, or pi sends it and 400s.
  const glm = thinkingLevelMap(["low", "high", "max"]);
  assert.equal(glm?.medium, null);
  assert.equal(glm?.low, "low");
  assert.equal(glm?.max, "max");
  assert.equal(glm?.minimal, null);

  // `off` is a real effort for some families and must map to the string.
  const deepseek = thinkingLevelMap(["off", "high", "max"]);
  assert.equal(deepseek?.off, "off");

  // A model that lists no `off` keeps thinking on: null tells pi to send
  // nothing, which is what these upstreams accept.
  assert.equal(thinkingLevelMap(["low"])?.off, null);
});

test("an unpublished effort list disables level selection, not reasoning", () => {
  // null = "the catalog published nothing for this model". All levels null
  // leaves only `off`, so no reasoning_effort is ever sent.
  const none = thinkingLevelMap(null);
  assert.ok(none, "a published null still registers a map");
  for (const level of THINKING_KEYS) {
    assert.equal(none[level], null, `${level} must be unmapped`);
  }

  // Absent = the catalog did not report the field; pi keeps its defaults.
  assert.equal(thinkingLevelMap(undefined), undefined);
});

test("the level map covers exactly pi's levels", () => {
  const map = thinkingLevelMap(["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(Object.keys(map ?? {}), [...THINKING_KEYS]);
});

test("images follow the catalog instead of a blanket default", () => {
  assert.equal(supportsImages({ id: "a", inputModalities: ["text", "image"] }), true);
  assert.equal(supportsImages({ id: "b", inputModalities: ["text"] }), false);
  // Legacy nested shape, and unknown models: text-only.
  assert.equal(supportsImages({ id: "c", modalities: { input: ["text", "image"] } }), true);
  assert.equal(supportsImages({ id: "d" }), false);
});

test("maxTokens uses the published cap, clamped by the context window", () => {
  // 8 known models publish a cap well above the old 32k floor.
  assert.equal(maxTokensFor({ id: "a", maxOutputTokens: 131072 }, 32768), 131072);
  assert.equal(maxTokensFor({ id: "b", max_output_tokens: 262144 }, 32768), 262144);
  // A cap above the context window would make pi reject the model.
  assert.equal(
    maxTokensFor({ id: "c", maxOutputTokens: 262144, context_length: 200000 }, 32768),
    200000,
  );
  // Null means "not published".
  assert.equal(maxTokensFor({ id: "d", maxOutputTokens: null }, 32768), 32768);
  assert.equal(maxTokensFor({ id: "e" }, 12345), 12345);
});

test("catalog pricing maps to a pi cost block, including tiers", () => {
  assert.deepEqual(
    costFromCatalog({ inputCost: 2, outputCost: 10, cacheReadCost: 0.1, cacheWriteCost: 2.5 }),
    { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  );

  // Request-size tiers: base rates are the smallest tier, and each later tier
  // becomes the threshold of the one before it.
  const tiered = costFromCatalog({
    inputCost: 0.1,
    outputCost: 0.5,
    cacheReadCost: 0.01,
    cacheWriteCost: 0.125,
    contextTiers: [
      { maxContext: 100000, rates: { inputCost: 0.1, outputCost: 0.5, cacheReadCost: 0.01, cacheWriteCost: 0.125 } },
      { rates: { inputCost: 0.5, outputCost: 2.5, cacheReadCost: 0.05, cacheWriteCost: 0.625 } },
    ],
  });
  assert.deepEqual(tiered, {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
  });

  // A tier chain pi cannot express (missing threshold) stops at the last
  // expressible tier instead of inventing one.
  const partial = costFromCatalog({
    contextTiers: [
      { rates: { inputCost: 1, outputCost: 1 } },
      { rates: { inputCost: 2, outputCost: 2 } },
    ],
  });
  assert.deepEqual(partial, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
});

test("plan ids become something a person can act on", () => {
  assert.equal(planLabel("individual-goat"), "GOAT");
  assert.equal(planLabel("individual-provider"), "Provider");
  assert.equal(planLabel("some-new-tier"), "some-new-tier");
  assert.equal(planLabel(null), undefined);
});

test("the plan hint names both routes for the Max-or-Provider models", () => {
  assert.equal(planRequirement("individual-go"), "Go or above");
  assert.equal(planRequirement("individual-pro"), "Pro or above");
  assert.equal(planRequirement("individual-max"), "Max");
  // Docs: "Claude Opus and Fable require a Max plan. You can also use them with
  // pay-as-you-go credits through the Provider API."
  assert.equal(
    planRequirement("individual-provider"),
    "the Provider plan (pay-as-you-go) or Max",
  );
  assert.equal(planRequirement(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Catalog: merging and the offline cache.
// ---------------------------------------------------------------------------

test("the two catalog views merge per model, never replacing needed fields", () => {
  const merged = mergeViews(
    [{ id: "claude-fable-5-2", supported_endpoints: ["/messages"], context_length: 1_000_000 }],
    [
      {
        id: "claude-fable-5-2",
        inputModalities: ["text", "image"],
        reasoningEfforts: ["low", "max"],
        maxOutputTokens: 131072,
        pricing: { inputCost: 8, outputCost: 40 },
        zdr: false,
      },
      { id: "new-model", inputModalities: ["text"] },
    ],
  );

  const claude = merged.find((m) => m.id === "claude-fable-5-2");
  assert.deepEqual(claude?.supported_endpoints, ["/messages"], "routing survives");
  assert.deepEqual(claude?.reasoningEfforts, ["low", "max"], "capabilities arrive");
  assert.equal(claude?.context_length, 1_000_000);
  assert.equal(merged.find((m) => m.id === "new-model")?.inputModalities?.[0], "text");
});

test("catalog-hidden models are never registered", () => {
  const merged = mergeViews(
    [{ id: "visible" }, { id: "stealth-crouton" }],
    [{ id: "visible" }, { id: "stealth-crouton", hidden: true }],
  );
  assert.deepEqual(merged.map((m) => m.id), ["visible"]);
});

test("the catalog cache round-trips and tolerates junk", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-cache-"));
  const file = join(dir, "catalog.json");
  try {
    const catalog = {
      catalogVersion: "abc",
      refreshAfterMs: 900_000,
      fetchedAt: 1_700_000_000_000,
      models: [{ id: "deepseek/deepseek-v4-flash", supported_endpoints: ["/chat/completions"] }],
    };
    writeCache(file, catalog);
    assert.deepEqual(readCache(file), catalog);

    // A truncated or empty cache is treated as absent, not as "no models".
    writeCache(file, { fetchedAt: 1, models: [] });
    assert.equal(readCache(file), undefined);
    assert.equal(readCache(join(dir, "missing.json")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the cache goes stale on the server's refresh hint", () => {
  const now = 1_700_000_000_000;
  assert.equal(cacheIsStale({ fetchedAt: now - 60_000, models: [] }, now), false);
  assert.equal(cacheIsStale({ fetchedAt: now - 1_000_000, models: [] }, now), true);
  // No hint from the server: fall back to the documented 15 minutes.
  assert.equal(
    cacheIsStale({ fetchedAt: now - 16 * 60 * 1000, models: [] }, now),
    true,
  );
});

// ---------------------------------------------------------------------------
// Routing overrides.
// ---------------------------------------------------------------------------

test("routing overrides persist, and malformed files are ignored loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-routing-"));
  const file = join(dir, "routing.json");
  try {
    assert.deepEqual(readRouting(file), { routing: {} });

    writeRouting(file, { "zai-org/GLM-5.3": "chat-completions" });
    assert.deepEqual(readRouting(file).routing, { "zai-org/GLM-5.3": "chat-completions" });

    // Invalid entries are dropped individually, not by failing the file.
    writeRouting(file, { good: "responses", bad: "carrier-pigeon" } as never);
    const read = readRouting(file);
    assert.deepEqual(read.routing, { good: "responses" });
    assert.match(read.warning ?? "", /bad/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto removes an override instead of storing it", () => {
  const start = { "a/model": "responses" as const };
  assert.deepEqual(applyRouting(start, "a/model", "auto"), {});
  assert.deepEqual(applyRouting(start, "b/model", "messages"), {
    "a/model": "responses",
    "b/model": "messages",
  });
});

test("the wire names are exactly the ones the command documents", () => {
  assert.equal(isWire("auto"), true);
  assert.equal(isWire("messages"), true);
  assert.equal(isWire("openai"), false);
});

test("endpoint args split on the last token so model ids keep their slashes", () => {
  assert.deepEqual(parseEndpointArgs("zai-org/GLM-5.3 chat-completions"), {
    ok: true,
    modelId: "zai-org/GLM-5.3",
    wire: "chat-completions",
  });
  assert.deepEqual(parseEndpointArgs("Qwen/Qwen4-Max responses"), {
    ok: true,
    modelId: "Qwen/Qwen4-Max",
    wire: "responses",
  });

  const bad = parseEndpointArgs("zai-org/GLM-5.3 telepathy");
  assert.equal(bad.ok, false);
  assert.match(bad.ok === false ? bad.message : "", /unknown wire/);
  assert.equal(parseEndpointArgs("").ok, false);
});

// ---------------------------------------------------------------------------
// Peak pricing.
// ---------------------------------------------------------------------------

test("peak windows are the published weekday UTC hours", () => {
  // 2026-11-16 is a Monday.
  const at = (hour: number, day = 16) =>
    new Date(Date.UTC(2026, 10, day, hour, 30)).getTime();

  assert.equal(isPeak(new Date(at(0))), false);
  assert.equal(isPeak(new Date(at(1))), true);
  assert.equal(isPeak(new Date(at(3))), true);
  assert.equal(isPeak(new Date(at(4))), false); // half-open: 04:00 is off-peak
  assert.equal(isPeak(new Date(at(6))), true);
  assert.equal(isPeak(new Date(at(9))), true);
  assert.equal(isPeak(new Date(at(10))), false);
  assert.equal(isPeak(new Date(at(2, 21))), false, "Saturday is off-peak");
  assert.equal(isPeak(new Date(at(2, 22))), false, "Sunday is off-peak");
});

test("only the five peak-priced models double, and only in a window", () => {
  const peak = new Date(Date.UTC(2026, 10, 16, 2, 0));
  const off = new Date(Date.UTC(2026, 10, 16, 12, 0));

  assert.equal(peakFactor("deepseek/deepseek-v4-flash", peak, {}), PEAK_FACTOR);
  assert.equal(peakFactor("deepseek/deepseek-v4-flash", off, {}), 1);
  // V4.1 Flash Ultrafast has no published peak rate; a prefix rule would
  // wrongly double it.
  assert.equal(peakFactor("deepseek/deepseek-v4.1-flash-ultrafast", peak, {}), 1);
  assert.equal(peakFactor("claude-sonnet-5-5", peak, {}), 1);
  // Escape hatch for anyone who wants the flat published rate.
  assert.equal(
    peakFactor("deepseek/deepseek-v4-flash", peak, { COMMANDCODE_PEAK_PRICING: "0" }),
    1,
  );
});

test("scaling cost keeps the total consistent and never throws on a frozen message", () => {
  const message = {
    usage: { cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25, total: 3.75 } },
  };
  scaleCost(message, 2);
  assert.deepEqual(message.usage.cost, {
    input: 2,
    output: 4,
    cacheRead: 1,
    cacheWrite: 0.5,
    total: 7.5,
  });

  const frozen = Object.freeze({
    usage: Object.freeze({ cost: Object.freeze({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }) }),
  });
  assert.doesNotThrow(() => scaleCost(frozen, 2));

  // Nothing to scale: no usage yet, or a neutral factor.
  assert.doesNotThrow(() => scaleCost({}, 2));
  assert.doesNotThrow(() => scaleCost(message, 1));
});

// ---------------------------------------------------------------------------
// Auth files.
// ---------------------------------------------------------------------------

test("every auth file shape in the wild yields the key", () => {
  assert.equal(keyFromAuthFile({ apiKey: "user_1" }), "user_1");
  assert.equal(
    keyFromAuthFile({ "command-code": { type: "api", key: "user_2" } }),
    "user_2",
  );
  assert.equal(keyFromAuthFile({ commandcode: "user_3" }), "user_3");
  assert.equal(keyFromAuthFile({ somethingElse: "nope" }), undefined);
  assert.equal(keyFromAuthFile(null), undefined);
  assert.equal(keyFromAuthFile({ apiKey: "   " }), undefined);
});

// ---------------------------------------------------------------------------
// Command output.
// ---------------------------------------------------------------------------

const state = {
  provider: "Command Code",
  packageVersion: "1.3.0",
  source: "network" as const,
  catalogVersion: "747dde904f9c5258e1af",
  modelCount: 101,
  fetchedAt: 1_700_000_000_000,
  cacheFile: "/tmp/catalog.json",
  refreshAfterMs: 900_000,
  zdr: false,
  zdrHidden: 0,
  overrideCount: 1,
  auth: "configured" as const,
  unpriced: 3,
  wires: { messages: 12, "openai-responses": 0, "openai-completions": 89 },
};

test("status reports source, counts and the last request", () => {
  const lines = formatStatus(
    {
      ...state,
      lastRequest: {
        model: "deepseek/deepseek-v4-flash",
        api: "openai-completions",
        at: 1_700_000_060_000,
        outcome: "stop",
        latencyMs: 900,
      },
    },
    1_700_000_120_000,
  ).join("\n");

  assert.match(lines, /Models: 101 \(network, catalog 747dde904f9c/);
  assert.match(lines, /chat-completions 89/);
  assert.match(lines, /ZDR: off/);
  assert.match(lines, /Last request: deepseek\/deepseek-v4-flash via chat-completions · stop · 900ms/);
});

test("status says so when nothing has run yet", () => {
  assert.match(formatStatus(state, 1_700_000_060_000).join("\n"), /Last request: none/);
});

test("diagnostics stay free of credentials and prompts", () => {
  const lines = formatDiagnostics({
    state,
    nodeVersion: "v24.0.0",
    platform: "darwin/arm64",
    apiBase: "https://api.commandcode.ai",
    bundledPriced: 3,
    overridden: 0,
    skipListed: 0,
    peakPricing: true,
  }).join("\n");

  assert.match(lines, /pi-command-code 1\.3\.0/);
  assert.match(lines, /pricing: catalog 95, overrides 0, bundled 3, unpriced 3/);
  assert.doesNotMatch(lines, /user_/);
});

test("quota output reports missing sections instead of zeros", () => {
  const lines = formatQuota({
    login: "acme",
    keyName: "laptop",
    plan: "individual-goat",
    planStatus: "active",
    monthlyCredits: 5,
    purchasedCredits: 2,
    freeCredits: 0.5,
    remainingCredits: 7.5,
    windows: [{ window: "5-hour", used: 40, cap: 100, resetAt: "2026-11-16T14:00:00Z" }],
    totalCost: 1.25,
    totalCount: 12,
    totalTokens: 9000,
    unavailable: ["usage (HTTP 404)"],
  }).join("\n");

  assert.match(lines, /Account: acme · key laptop/);
  assert.match(lines, /Credits: \$7\.50 remaining/);
  assert.match(lines, /5-hour window: 40% used/);
  assert.match(lines, /Unavailable: usage \(HTTP 404\)/);
});
