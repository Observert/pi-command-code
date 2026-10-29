import { test } from "node:test";
import assert from "node:assert/strict";

import activate from "./index.ts";

import {
  API_KEY_ENV_VARS,
  BUNDLED_RATES,
  DEFAULT_MAX_TOKENS,
  NO_COST,
  ZDR_HEADER,
  anthropicBaseUrl,
  classifyProviderError,
  isAnthropicModel,
  openaiBaseUrl,
  parseRateOverrides,
  positiveIntFromEnv,
  resolveCost,
  toModel,
  apiForModel,
  costFromPricing,
  zdrEnabled,
  zdrSkipList,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Routing: the reason this package exists.
// ---------------------------------------------------------------------------

test("claude models route to the Anthropic messages endpoint", () => {
  const cfg = toModel(
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    DEFAULT_MAX_TOKENS,
  );
  assert.equal(cfg.api, "anthropic-messages");
  assert.equal(cfg.baseUrl, anthropicBaseUrl());
  // Anthropic SDK appends /v1/messages
  assert.equal(
    `${cfg.baseUrl}/v1/messages`,
    "https://api.commandcode.ai/provider/v1/messages",
  );
});

test("claude models use adaptive thinking, except the 4.5 haiku", () => {
  const adaptive = (m: ReturnType<typeof toModel>) =>
    (m.compat as { forceAdaptiveThinking?: boolean } | undefined)
      ?.forceAdaptiveThinking;

  for (const id of [
    "claude-sonnet-5-5",
    "claude-opus-5",
    "claude-opus-4-7",
    "claude-fable-5",
    "claude-sonnet-4-6",
    // Verified live: the 5.5 haiku rejects thinking.type=enabled (400) and
    // accepts adaptive. A family allowlist has to include it.
    "claude-haiku-5-5",
    "claude-opus-4-8",
  ]) {
    assert.equal(adaptive(toModel({ id }, DEFAULT_MAX_TOKENS)), true,
      `${id} needs adaptive thinking`);
  }

  const legacy = toModel(
    { id: "claude-haiku-4-5-20251001" },
    DEFAULT_MAX_TOKENS,
  );
  assert.equal(legacy.compat, undefined, "4.5 haiku rejects adaptive thinking");

  // Non-Claude models get the OpenAI flags instead of the adaptive shape:
  // effort support so pi actually sends reasoning_effort, plus the conservative
  // role and max-token fields this gateway accepts.
  assert.deepEqual(
    toModel({ id: "deepseek/deepseek-v4-pro" }, DEFAULT_MAX_TOKENS).compat,
    {
      supportsReasoningEffort: true,
      thinkingFormat: "openai",
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    },
  );
});

test("every family registers as reasoning, with the matching compat", () => {
  // compat is a per-API union on Model<Api>, so read the two fields we care
  // about through one narrow view.
  type Compat = {
    forceAdaptiveThinking?: boolean;
    supportsReasoningEffort?: boolean;
  };
  const compatOf = (id: string): Compat | undefined =>
    toModel({ id }, DEFAULT_MAX_TOKENS).compat as Compat | undefined;

  for (const id of [
    "claude-sonnet-5-5",
    "claude-haiku-4-5-20251001",
    "gpt-6-astra",
    "gpt-5.4",
    "google/gemini-4-argon",
    "deepseek/deepseek-v4.1-flash",
    "moonshotai/Kimi-K3.1-Pro",
    "z-ai/glm-5.3-flashx",
    "minimax/minimax-m3.1-flash",
    "xai/grok-4.7",
    "mistral/mistral-large-4",
    "Qwen/Qwen3.8-Max",
    "nvidia/nemotron-3.5-super-vl",
    "stealth/glyph-cluster:free",
    "some/unknown-model",
  ]) {
    const cfg = toModel({ id }, DEFAULT_MAX_TOKENS);
    const compat = compatOf(id);
    assert.equal(cfg.reasoning, true, `${id} should register as reasoning`);
    if (isAnthropicModel(id)) {
      assert.equal(
        compat?.supportsReasoningEffort,
        undefined,
        `${id} must not send OpenAI reasoning_effort`,
      );
    } else {
      assert.equal(
        compat?.supportsReasoningEffort,
        true,
        `${id} needs supportsReasoningEffort or pi sends no effort`,
      );
      assert.equal(
        compat?.forceAdaptiveThinking,
        undefined,
        `${id} is not an Anthropic model`,
      );
    }
  }
});

test("non-claude models route to the OpenAI chat completions endpoint", () => {
  for (const id of [
    "deepseek/deepseek-v4-flash",
    "gpt-5.6-sol",
    "google/gemini-3.8-flash",
    "moonshotai/Kimi-K3",
    "xai/grok-4.6",
    "meta/muse-spark-1.3",
  ]) {
    const cfg = toModel({ id }, DEFAULT_MAX_TOKENS);
    assert.equal(
      cfg.api,
      "openai-completions",
      `${id} should use openai-completions`,
    );
    assert.equal(
      cfg.baseUrl,
      openaiBaseUrl(),
      `${id} should use the OpenAI baseUrl`,
    );
    // OpenAI SDK appends /chat/completions
    assert.equal(
      `${cfg.baseUrl}/chat/completions`,
      "https://api.commandcode.ai/provider/v1/chat/completions",
    );
  }
});

test("the two baseUrls differ and neither doubles up the /v1 segment", () => {
  assert.notEqual(openaiBaseUrl(), anthropicBaseUrl());

  // Regression guard. The Anthropic SDK appends /v1/messages to baseUrl. Pairing
  // it with the OpenAI baseUrl (which already ends in /v1) produced
  // /provider/v1/v1/messages -> 404. Only the OpenAI baseUrl has that /v1 tail.
  assert.ok(
    `${openaiBaseUrl()}/v1/messages`.includes("/v1/v1/"),
    "documents the failure mode: OpenAI baseUrl must not be used for Anthropic",
  );
  assert.ok(
    !`${anthropicBaseUrl()}/v1/messages`.includes("/v1/v1/"),
    "the Anthropic baseUrl must not double the /v1 segment",
  );
});

test("only the claude- prefix is treated as Anthropic", () => {
  assert.equal(isAnthropicModel("claude-opus-5"), true);
  assert.equal(isAnthropicModel("claude-haiku-4-5-20251001"), true);
  // Guard against over-eager matching: needs the literal "claude-" prefix.
  assert.equal(isAnthropicModel("claudecode-thing"), false);
  assert.equal(isAnthropicModel("gpt-5.4-mini"), false);
  assert.equal(isAnthropicModel("deepseek/deepseek-v4-flash"), false);
});

test("routing follows the catalog before the id prefix", () => {
  // Claude answers on /messages only.
  assert.equal(
    apiForModel({ id: "claude-sonnet-5", supported_endpoints: ["/messages"] }),
    "anthropic-messages",
  );
  // GPT answers on both; /responses is the richer one, so it wins.
  assert.equal(
    apiForModel({
      id: "gpt-6-astra",
      supported_endpoints: ["/chat/completions", "/responses"],
    }),
    "openai-responses",
  );
  // A non-gpt model that only speaks /responses still reaches that route.
  assert.equal(
    apiForModel({ id: "brand/new", supported_endpoints: ["/responses"] }),
    "openai-responses",
  );
  assert.equal(
    apiForModel({
      id: "moonshotai/Kimi-K3",
      supported_endpoints: ["/chat/completions"],
    }),
    "openai-completions",
  );

  // No catalog metadata: the id prefix is the fallback, so a brand-new family
  // still lands somewhere sensible.
  assert.equal(apiForModel({ id: "claude-sonnet-6" }), "anthropic-messages");
  assert.equal(apiForModel({ id: "brand/new" }), "openai-completions");
  assert.equal(
    apiForModel({ id: "claude-x", supported_endpoints: [] }),
    "anthropic-messages",
  );

  // The route decides the baseUrl, and the baseUrls differ on purpose.
  const responses = toModel(
    { id: "gpt-6-astra", supported_endpoints: ["/responses"] },
    DEFAULT_MAX_TOKENS,
  );
  assert.equal(responses.api, "openai-responses");
  assert.equal(responses.baseUrl, openaiBaseUrl());
});

test("catalog pricing and caps win when the API reports them", () => {
  const priced = toModel(
    {
      id: "claude-sonnet-4-6",
      pricing: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
      max_output_tokens: 128000,
      modalities: { input: ["text"] },
      reasoning: false,
    },
    DEFAULT_MAX_TOKENS,
  );
  // Catalog price beats the bundled table for the same model.
  assert.deepEqual(priced.cost, {
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite: 0.2,
  });
  assert.equal(priced.maxTokens, 128000);
  assert.deepEqual(priced.input, ["text"]);
  // An explicit reasoning:false from the catalog is respected.
  assert.equal(priced.reasoning, false);

  // Partial or empty pricing must not fabricate a cost.
  assert.deepEqual(costFromPricing({ input: 1, output: 2 }), {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(costFromPricing({}), undefined);
  assert.equal(costFromPricing({ input: -5 }), undefined);
  assert.deepEqual(costFromPricing({ input: -5, output: 1 }), {
    input: 0,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
  });

  // Without catalog metadata the caller's maxTokens still applies.
  assert.equal(
    toModel({ id: "brand/new" }, 8192).maxTokens,
    8192,
  );
});

test("zdr rides on each model, not the provider", () => {
  assert.deepEqual(
    toModel({ id: "claude-sonnet-5" }, DEFAULT_MAX_TOKENS, new Map(), true)
      .headers,
    ZDR_HEADER,
  );
  assert.equal(
    toModel({ id: "claude-sonnet-5" }, DEFAULT_MAX_TOKENS).headers,
    undefined,
  );
});

test("the extension registers native auth and every API shape", async () => {
  type RegisteredProvider = {
    id: string;
    auth: { apiKey?: { login?: unknown; resolve?: unknown } };
    streamSimple?: unknown;
    getModels(): readonly { id: string; api: string; baseUrl: string }[];
  };
  type Pi = Parameters<typeof activate>[0];

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "claude-sonnet-5", supported_endpoints: ["/messages"] },
          {
            id: "gpt-6-astra",
            supported_endpoints: ["/chat/completions", "/responses"],
          },
          {
            id: "deepseek/deepseek-v4-flash",
            supported_endpoints: ["/chat/completions"],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    let provider: RegisteredProvider | null = null;
    const handlers = new Map<string, unknown>();
    const pi = {
      registerProvider: (p: RegisteredProvider) => {
        provider = p;
      },
      on: (name: string, handler: unknown) => {
        handlers.set(name, handler);
        return () => {};
      },
    } as unknown as Pi;

    await activate(pi);

    const registered = provider as RegisteredProvider | null;
    assert.ok(registered, "provider was registered");
    assert.equal(registered.id, "command-code");
    // Login is what makes /login command-code (stored credentials) possible.
    assert.equal(typeof registered.auth.apiKey?.login, "function");
    assert.equal(typeof registered.auth.apiKey?.resolve, "function");
    assert.equal(typeof registered.streamSimple, "function");

    // One provider spanning three wire shapes: each model picked its route
    // from the catalog, and the baseUrl follows the route.
    const models = registered.getModels();
    assert.deepEqual(
      models.map((m) => `${m.id} -> ${m.api} @ ${m.baseUrl}`).sort(),
      [
        `claude-sonnet-5 -> anthropic-messages @ ${anthropicBaseUrl()}`,
        `deepseek/deepseek-v4-flash -> openai-completions @ ${openaiBaseUrl()}`,
        `gpt-6-astra -> openai-responses @ ${openaiBaseUrl()}`,
      ].sort(),
    );
    assert.ok(handlers.has("session_start"));
    assert.ok(handlers.has("message_end"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the key is read from our env var and both CLI spellings", () => {
  assert.deepEqual([...API_KEY_ENV_VARS], [
    "COMMANDCODE_API_KEY",
    "CMD_API_KEY",
    "COMMAND_CODE_API_KEY",
  ]);
});

test("catalog metadata maps through with sane fallbacks", () => {
  const withLen = toModel(
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 1000000 },
    DEFAULT_MAX_TOKENS,
  );
  assert.equal(withLen.contextWindow, 1000000);
  assert.equal(withLen.name, "Claude Sonnet 5");
  assert.equal(withLen.reasoning, true);

  const bare = toModel({ id: "some/model" }, DEFAULT_MAX_TOKENS);
  assert.equal(bare.name, "some/model"); // name falls back to id
  assert.ok(bare.contextWindow > 0);
  assert.equal(bare.maxTokens, DEFAULT_MAX_TOKENS);
  // Reasoners by default: pi only offers thinking levels when this is true,
  // and every family in the catalog accepts reasoning_effort.
  assert.equal(bare.reasoning, true);
});

test("maxTokens is injectable so users can raise it", () => {
  const cfg = toModel({ id: "some/model" }, 12345);
  assert.equal(cfg.maxTokens, 12345);
});

// ---------------------------------------------------------------------------
// Cross-platform / config parsing.
// ---------------------------------------------------------------------------

test("positiveIntFromEnv parses, rejects junk, and falls back", () => {
  assert.equal(positiveIntFromEnv(undefined, 42), 42);
  assert.equal(positiveIntFromEnv("", 42), 42);
  assert.equal(positiveIntFromEnv("  ", 42), 42);
  assert.equal(positiveIntFromEnv("abc", 42), 42);
  assert.equal(positiveIntFromEnv("0", 42), 42);
  assert.equal(positiveIntFromEnv("-5", 42), 42);
  assert.equal(positiveIntFromEnv("1000", 42), 1000);
  assert.equal(positiveIntFromEnv(" 2000 ", 42), 2000);
  // Windows-style env values occasionally carry surrounding quotes.
  assert.equal(positiveIntFromEnv('"3000"', 42), 42);
});

// ---------------------------------------------------------------------------
// ZDR: opt-in, with a user-supplied skip list rather than a hardcoded one.
// ---------------------------------------------------------------------------

test("zdr is off unless explicitly opted in", () => {
  assert.equal(zdrEnabled({}), false);
  assert.equal(zdrEnabled({ COMMANDCODE_ZDR: "" }), false);
  assert.equal(zdrEnabled({ COMMANDCODE_ZDR: "0" }), false);
  assert.equal(zdrEnabled({ COMMANDCODE_ZDR: "false" }), false);
  assert.equal(zdrEnabled({ COMMANDCODE_ZDR: "nonsense" }), false);
});

test("zdr accepts the truthy spellings people actually use", () => {
  for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
    assert.equal(
      zdrEnabled({ COMMANDCODE_ZDR: v }),
      true,
      `${JSON.stringify(v)} should enable`,
    );
  }
});

test("the zdr header is the documented one", () => {
  assert.deepEqual(ZDR_HEADER, { "x-cmd-zdr": "1" });
});

test("the zdr skip list is empty by default and never hardcoded", () => {
  // A stale built-in list would hide models that gained ZDR coverage.
  assert.equal(zdrSkipList({}).size, 0);
  assert.equal(zdrSkipList({ COMMANDCODE_ZDR_SKIP: "" }).size, 0);
  assert.equal(zdrSkipList({ COMMANDCODE_ZDR_SKIP: " , , " }).size, 0);
});

test("the zdr skip list parses comma-separated model ids", () => {
  const set = zdrSkipList({
    COMMANDCODE_ZDR_SKIP:
      "meta/muse-spark-1.3, Qwen/Qwen3.8-Flash ,deepseek/deepseek-v4-flash",
  });
  assert.equal(set.size, 3);
  assert.ok(set.has("meta/muse-spark-1.3"));
  assert.ok(set.has("Qwen/Qwen3.8-Flash"));
  assert.ok(set.has("deepseek/deepseek-v4-flash"));
});

// ---------------------------------------------------------------------------
// Cost: the API returns no pricing, so it is opt-in via COMMANDCODE_RATES.
// ---------------------------------------------------------------------------

test("bundled list rates ship for the whole catalog", () => {
  // Generated from Command Code's published pricing table.
  assert.ok(
    BUNDLED_RATES.size > 50,
    "expected a substantial bundled rate table",
  );
  assert.deepEqual(BUNDLED_RATES.get("claude-sonnet-4-6"), {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  });
  // Free-tier models are legitimately $0, not missing. Checked as a category
  // rather than by id: free promos come and go with the catalog.
  const freeRows = [...BUNDLED_RATES.values()].filter(
    (r) => r.input === 0 && r.output === 0,
  );
  assert.ok(freeRows.length > 0, "expected a free tier to record $0, not vanish");
});

test("unknown models still cost zero rather than a guess", () => {
  const cfg = toModel(
    { id: "definitely/not-a-real-model" },
    DEFAULT_MAX_TOKENS,
  );
  assert.deepEqual(cfg.cost, NO_COST);
});

test("a model with no published rate reports zero, not a fabricated number", () => {
  // Guard: NO_COST stays the fallback so an unpriced model never shows fake cost.
  assert.deepEqual(resolveCost("unknown", new Map()), NO_COST);
});

test("rate overrides parse from the documented env format", () => {
  const m = parseRateOverrides(
    "deepseek/deepseek-v4-flash=0.15,0.6,0.003;claude-sonnet-4-6=3,15,0.3,3.75",
  );
  assert.equal(m.size, 2);
  assert.deepEqual(m.get("deepseek/deepseek-v4-flash"), {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.003,
    cacheWrite: 0,
  });
  assert.deepEqual(m.get("claude-sonnet-4-6"), {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  });
});

test("rate overrides tolerate whitespace and newlines", () => {
  // Spaces around the id, '=' and each rate are all fine.
  const m = parseRateOverrides("  a model = 1 , 2 , 3 , 4 ");
  assert.deepEqual(m.get("a model"), {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
  });

  // Multi-line env values are common in CI config.
  const multi = parseRateOverrides("one=1,2\ntwo=3,4,5,6");
  assert.equal(multi.size, 2);
  assert.equal(multi.get("two")?.cacheWrite, 6);
});

test("model ids containing slashes and colons survive parsing", () => {
  const m = parseRateOverrides("meituan/LongCat-2.0:free=0,0,0,0");
  assert.ok(m.has("meituan/LongCat-2.0:free"));
});

test("malformed rate entries are ignored, never thrown", () => {
  // A typo must not be able to stop pi from starting.
  assert.equal(parseRateOverrides(undefined).size, 0);
  assert.equal(parseRateOverrides("").size, 0);
  assert.equal(parseRateOverrides("no-equals-sign").size, 0);
  assert.equal(parseRateOverrides("=1,2").size, 0); // missing id
  assert.equal(parseRateOverrides("model=").size, 0); // missing rates
  assert.equal(parseRateOverrides("model=abc").size, 0);
  assert.equal(parseRateOverrides("model=1").size, 0); // needs input AND output
  // Negative rates are not physical.
  assert.equal(parseRateOverrides("model=-1,-2").size, 0);
  // A valid entry alongside junk still lands.
  assert.equal(parseRateOverrides("junk;ok=1,2").size, 1);
});

test("resolveCost precedence: override > bundled > zero", () => {
  // Bundled rate applies when there is no override.
  assert.equal(resolveCost("claude-sonnet-4-6", new Map()).input, 3);

  // An explicit override wins over the bundled rate.
  const exact = parseRateOverrides("claude-sonnet-4-6=99,99,99,99");
  assert.equal(resolveCost("claude-sonnet-4-6", exact).input, 99);

  // '*' beats the bundled rate for models without their own entry...
  const star = parseRateOverrides("*=7,8,9,10");
  assert.equal(resolveCost("claude-sonnet-4-6", star).input, 7);
  assert.equal(resolveCost("some/unknown", star).input, 7);

  // ...and an exact override still beats '*'.
  const both = parseRateOverrides("claude-sonnet-4-6=1,2,3,4;*=7,8,9,10");
  assert.equal(resolveCost("claude-sonnet-4-6", both).input, 1);
  assert.equal(resolveCost("other", both).input, 7);

  // Unknown model with nothing set falls back to zero, never a guess.
  assert.deepEqual(resolveCost("nope", new Map()), NO_COST);
});

test("COMMANDCODE_RATES overrides the bundled table", () => {
  const costs = parseRateOverrides("claude-sonnet-4-6=1.5,7.5,0.15,1.875");
  const cfg = toModel(
    { id: "claude-sonnet-4-6" },
    DEFAULT_MAX_TOKENS,
    costs,
  );
  assert.deepEqual(cfg.cost, {
    input: 1.5,
    output: 7.5,
    cacheRead: 0.15,
    cacheWrite: 1.875,
  });

  // A model with a bundled rate but no override keeps the bundled rate.
  const other = toModel({ id: "gpt-5.6-sol" }, DEFAULT_MAX_TOKENS, costs);
  assert.ok(other.cost.input > 0, "bundled rate should still apply");
});

// ---------------------------------------------------------------------------
// Plan gating: must be explained, not left as a bare 403.
// ---------------------------------------------------------------------------

test("plan errors are classified into actionable messages", () => {
  const notInPlan = classifyProviderError(
    "MODEL_NOT_IN_PLAN: Claude Opus 5 available in Provider and above plans",
  );
  assert.equal(notInPlan?.code, "MODEL_NOT_IN_PLAN");
  assert.match(notInPlan!.message, /plan/i);

  const noApi = classifyProviderError("upgrade_required");
  assert.equal(noApi?.code, "upgrade_required");
  // The Go plan has no API access; the hint should say so.
  assert.match(noApi!.message, /Go plan/);

  const zdrGap = classifyProviderError("cmd_zdr_no_providers");
  assert.equal(zdrGap?.code, "cmd_zdr_no_providers");
  assert.match(zdrGap!.message, /ZDR/);
});

test("a rejected key is named, not passed through raw", () => {
  // The gateway body is just "Invalid 'Authorization' header or token."
  const auth = classifyProviderError(
    `401 {"type":"error","error":{"type":"authentication_error","message":"Invalid 'Authorization' header or token."}}`,
  );
  assert.equal(auth?.code, "UNAUTHORIZED");
  assert.match(auth!.message, /\/login command-code/);
  // Points at the real cause: a key copied into a shell goes stale.
  assert.match(auth!.message, /stale/);
});

test("unrelated errors are left untouched", () => {
  assert.equal(classifyProviderError(undefined), null);
  assert.equal(classifyProviderError(""), null);
  assert.equal(classifyProviderError("rate limit exceeded"), null);
  assert.equal(classifyProviderError("context_length_exceeded"), null);
  assert.equal(classifyProviderError("Connection reset by peer"), null);
});
