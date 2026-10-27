# pi-command-code

[Command Code](https://commandcode.ai) Provider API for the [Pi coding agent](https://pi.dev).

One provider, the whole Command Code catalog — Claude, GPT, Gemini, DeepSeek, Kimi, GLM, Qwen, Grok, MiniMax, Muse Spark and more — fetched live at startup. New models appear automatically, with no package update.

## Install

```bash
pi install npm:pi-command-code
```

Get an API key from [Command Code Studio](https://commandcode.ai/studio/), then export it:

```bash
export COMMANDCODE_API_KEY=your_key_here
```

Add that to your shell profile to persist it. On Windows, use `setx COMMANDCODE_API_KEY "your_key_here"` (or your shell's equivalent). Pi reads the variable at startup.

> **Plan requirement:** the Provider API needs a plan with API access — the [Provider plan](https://commandcode.ai/provider) ($15/mo pay-as-you-go) or GOAT / Pro / Max / Team. The $1 **Go** plan cannot use the API.

## Usage

```bash
pi --provider command-code --model claude-sonnet-5-5
pi --provider command-code --model deepseek/deepseek-v4.1-flash
```

Or make it your default in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "command-code",
  "defaultModel": "claude-sonnet-5-5"
}
```

Browse what's available:

```bash
pi --list-models | grep command-code
```

## Configuration

Every setting is an environment variable, so it works identically on macOS, Linux and Windows.

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMMANDCODE_API_KEY` | — | **Required.** Your Command Code API key. |
| `COMMANDCODE_ZDR` | off | Set to `1` to enforce zero data retention on every request. |
| `COMMANDCODE_ZDR_SKIP` | — | Comma-separated model ids to hide while ZDR is on. |
| `COMMANDCODE_MAX_TOKENS` | `32768` | Max output tokens per request. Raise it if responses truncate. |
| `COMMANDCODE_RATES` | — | Override bundled per-model rates (USD per million tokens). See [Cost tracking](#cost-tracking). |
| `COMMANDCODE_TIMEOUT_MS` | `15000` | Startup catalog/credential timeout. |
| `COMMANDCODE_API_BASE_URL` | `https://api.commandcode.ai` | Point at a gateway, proxy, or self-hosted deployment. |

## How it routes

Command Code exposes two endpoints, and each takes its own native request shape:

| Models | Endpoint | Shape |
| --- | --- | --- |
| `claude-*` | `/provider/v1/messages` | Anthropic Messages |
| everything else | `/provider/v1/chat/completions` | OpenAI Chat Completions |

Sending a Claude model to `/chat/completions` (or the reverse) is a hard `400 unsupported_model`, so this package picks the API per model by id prefix.

**The subtle part**, and the reason this needed its own package: pi's two SDKs append *different* paths to `baseUrl`.

```text
OpenAI SDK    -> <baseUrl>/chat/completions
Anthropic SDK -> <baseUrl>/v1/messages
```

So a single provider-level `baseUrl` cannot serve both. Pairing the OpenAI baseUrl with an Anthropic model yields `/provider/v1/v1/messages` → `404`. This package sets `baseUrl` per model to match each SDK's expectation.

## Zero data retention (ZDR)

Enforce zero data retention — every request routes only through upstreams that store nothing and never train on your prompts:

```bash
export COMMANDCODE_ZDR=1
```

Accepts `1`, `true`, `yes`, or `on`.

### Why it's opt-in, and how it fails

ZDR is a **hard** guarantee, not a preference. If a model has no ZDR-capable upstream, Command Code **fails the request** with `422 cmd_zdr_no_providers` rather than quietly routing somewhere that retains data. That's the correct behavior — but it means a model that lacks coverage will fail the moment you pick it.

**This package ships no hardcoded ZDR blocklist.** ZDR coverage grows as Command Code signs new upstream agreements, so a baked-in list would go stale and hide models that work fine. Instead:

- The error is detected and explained in plain language when it happens.
- If you want to hide known-bad models up front, list them yourself:

```bash
export COMMANDCODE_ZDR_SKIP="meta/muse-spark-1.3,Qwen/Qwen3.8-Flash"
```

Those models are then excluded from the catalog and the count is reported at startup.

**ZDR costs more.** Routing is restricted to ZDR-capable upstreams with capacity, which is not always the cheapest one serving a model. Command Code passes through exactly what it's charged, with no markup. See your [Usage](https://commandcode.ai/usage) page for real per-request pricing.

## Cost tracking

Cost tracking works out of the box for **all 94 models**. Rates are bundled from Command Code's published pricing table, so pi shows real dollar figures on every response.

### Why rates are bundled rather than fetched

**Command Code does not report cost through its API.** Verified directly, not assumed:

| Where cost might live | What it actually contains |
| --- | --- |
| `GET /provider/v1/models` | only `id, object, created, owned_by, name, context_length` |
| Response **headers** | no billing headers at all |
| OpenAI-shaped body | `id, object, created, model, choices, usage, system_fingerprint` |
| Anthropic-shaped body | `model, id, type, role, content, ..., usage` |
| Streaming final chunk | token usage only |
| `/pricing`, `/costs`, `/usage` | `404` |

Token counts **are** returned and are detailed — input, output, cached, reasoning and cache-creation tokens. pi does not read cost from providers anyway; it computes it locally as `rate_per_million × tokens ÷ 1,000,000` from the `cost` block registered per model. So cost works if rates are known, and Command Code publishes them in its [docs pricing table](https://commandcode.ai/docs/resources/pricing-limits) — just not over the API.

### Keeping rates fresh

Rates move (deals, free tiers, DeepSeek hourly peak/off-peak). The bundled table is generated and checked in, so you can refresh it any time.

From a checkout of this package:

```bash
node scripts/refresh-rates.mjs          # regenerate rates.ts
node scripts/refresh-rates.mjs --check  # CI: fail if stale
```

The script ships in the tarball, so you can also run it against an installed copy:

```bash
node node_modules/pi-command-code/scripts/refresh-rates.mjs
```

The script reads Command Code's pricing table, maps display names onto live API model ids, warns about any model with no pricing row, and rewrites `rates.ts` for review. Discounted rows (rendered as `$0.60$0.30`) resolve to the **current** price, not the struck-through one. If one id has two pricing rows (a free-tier row and the paid one sharing a display name), the paid row wins — a `$0` entry would silently report a paid model as free.

### Overriding rates

Enterprise or ZDR rates can differ from list price. Override any model — or set a blanket fallback with `*`:

```bash
export COMMANDCODE_RATES="claude-sonnet-5-5=2,10,0.1,2.5;*=1,2,0.1,1.25"
```

Format: entries separated by `;` (or newlines), each `modelId=input,output[,cacheRead[,cacheWrite]]`, in **USD per million tokens**. `;` separates entries because `,` separates the rates within one.

Precedence: **your overrides** → **bundled list rates** → **zero**. A model with no known rate reports `$0` rather than a fabricated number, and startup names it:

```text
[command-code] 1 model(s) have no published rate and will report $0 (tokens still exact): vendor/new-model
```

Malformed entries are skipped rather than thrown, so a typo can never stop pi from starting.

One caveat: these are published list rates. A given request can cost slightly less, because Command Code routes open-source models across multiple upstreams and bills the mean per-provider price. Your [Usage](https://commandcode.ai/usage) page remains the source of truth, especially under ZDR where pass-through rates can differ.

## Errors you might see

This package turns bare status codes into actionable messages.

| Upstream error | What it means |
| --- | --- |
| `401 UNAUTHORIZED` | `COMMANDCODE_API_KEY` is missing or invalid. |
| `403 MODEL_NOT_IN_PLAN` | The model isn't in your plan. Upgrade, or use a different model. |
| `403 upgrade_required` | Your plan has no API access — the Go plan can't use the Provider API. |
| `422 cmd_zdr_no_providers` | The model has no ZDR upstream; unset `COMMANDCODE_ZDR` or skip the model. |
| `400 unsupported_model` | Should never occur — this package routes shapes correctly. Please report it. |

Note that `/provider/v1/models` is a **public** endpoint: it returns HTTP 200 even with no key or a bad key. So a successful catalog fetch does not prove your credentials work. This package therefore verifies the key with a real (cheap) request at startup and warns early rather than letting every request fail later.

## Compatibility

- **OS:** macOS, Linux, Windows. Pure ESM and global `fetch` — no native modules, no shell commands, no filesystem paths, no path separators.
- **Node:** 18 or newer (pi's own minimum). `engines` is set accordingly.
- **Models:** the catalog is discovered at runtime, so this package does not need updating when Command Code adds models.

## Notes and limitations

- **Cost is a published list rate, not a billed amount.** Bundled for all 94 models; override with `COMMANDCODE_RATES`. See [Cost tracking](#cost-tracking).
- **`maxTokens` is `32768` by default.** The catalog does not report output caps and pi requires a value, so this is a conservative floor. Raise it with `COMMANDCODE_MAX_TOKENS`.
- **Every model registers as reasoning.** Claude takes extended thinking through `compat.forceAdaptiveThinking`; every other family is OpenAI-compatible and sets `compat.supportsReasoningEffort`, so pi sends `reasoning_effort`. Verified against the live API: all families accept `reasoning_effort: "max"` with HTTP 200 — models that do not think ignore it rather than rejecting it.
- **Thinking levels above `high` need an override.** No `thinkingLevelMap` is registered, so pi clamps `xhigh` and `max` to `high` for the OpenAI-shaped families. To send the full range, add a `modelOverrides` entry in `~/.pi/agent/models.json` with a `thinkingLevelMap` for that model id.
- **Claude thinking uses the adaptive shape.** Claude 5.x and 4.7+ reject `thinking.type: "enabled"`, so those models set `compat.forceAdaptiveThinking`. `claude-haiku-4-5-20251001` is the one model that rejects adaptive and keeps the legacy shape. A future model with different requirements would need a code change, not just a catalog refresh.
- **Text and images only.** Command Code's schema rejects audio, file and document parts. Some catalog models are text-only and will error upstream if sent images.
- If the catalog fetch fails, the extension logs a warning and registers nothing rather than blocking pi startup. Fix the cause and `/reload`.

## Development

```bash
npm install
npm test        # 25 tests
npm run typecheck
```

Tests cover the routing rules that make this package work (Claude → Anthropic shape, everything else → OpenAI shape, the two baseUrls staying distinct, the `/v1/v1` regression), the per-family thinking shape, cross-platform config parsing, ZDR opt-in handling, cost-rate parsing and precedence, and plan-error classification.

## License

MIT
