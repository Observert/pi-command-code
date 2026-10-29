# pi-command-code

[Command Code](https://commandcode.ai) Provider API for the [Pi coding agent](https://pi.dev).

One provider, the whole Command Code catalog — Claude, GPT, Gemini, DeepSeek, Kimi, GLM, Qwen, Grok, MiniMax, Muse Spark and more — fetched live at startup. New models appear automatically, with no package update.

## Features

- **The whole catalog, nothing hardcoded.** 94 models today, discovered from `/provider/v1/models` at startup.
- **Native pi provider.** `/login command-code` stores the key in pi's credential store; `COMMANDCODE_API_KEY`, `CMD_API_KEY` and `COMMAND_CODE_API_KEY` work as env fallbacks.
- **The right wire per model.** Catalog-driven routing to Anthropic Messages, OpenAI Responses or Chat Completions, with the per-model `baseUrl` each SDK expects.
- **Thinking levels everywhere.** Every model registers as a reasoner, and Claude's adaptive-vs-legacy thinking shapes are handled per model.
- **Cost tracking that works.** Bundled list rates for the whole catalog (94 models today), `COMMANDCODE_RATES` overrides and a `*` fallback.
- **Zero data retention on request.** Opt-in header, a skip list for models without ZDR coverage, and no stale hardcoded blocklist.
- **Plain-language errors.** `401`, plan gating and ZDR gaps are named, not passed through as bare status codes; catalog failures surface at session start.
- **No native dependencies.** Pure ESM and global `fetch`; macOS, Linux and Windows on Node 18+.

## Install

```bash
pi install npm:pi-command-code
```

Get a key from [Command Code Studio](https://commandcode.ai/studio/), then store it once:

```text
pi
/login command-code      # paste the key; pi keeps it in ~/.pi/agent/auth.json
```

That is the recommended path. pi owns the credential, so it is not tied to any shell's environment, and the Command Code CLI rotating its own stored key no longer breaks this provider — a fresh `/login` is enough.

If you would rather use the environment, export a key before starting pi. Any of these works; the first one set wins:

```bash
export COMMANDCODE_API_KEY=your_key_here   # this package's name
export CMD_API_KEY=your_key_here           # the Command Code CLI's name
export COMMAND_CODE_API_KEY=your_key_here
```

On Windows, use `setx COMMANDCODE_API_KEY "your_key_here"` (or your shell's equivalent).

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
pi --list-models command-code     # ids, context window, max out, thinking, images
```

## Thinking levels

Every model in the catalog registers as a reasoner, so pi offers thinking levels across the whole catalog, not just Claude:

```bash
pi --provider command-code --model claude-sonnet-5:high
pi --provider command-code --model gpt-6-astra:medium
```

Use pi's levels (`minimal` … `max`); `off` is always available. A catalog that reports `reasoning: false` for a model removes them. Without a `thinkingLevelMap`, pi clamps `xhigh` and `max` to `high` for the OpenAI-shaped families — see [Notes and limitations](#notes-and-limitations) to send the full range.

Claude needs one exception handled in code: Claude 5.x and 4.7+ reject `thinking.type: "enabled"` and require the adaptive shape, while `claude-haiku-4-5-20251001` rejects adaptive and needs the legacy one. This package sets `compat.forceAdaptiveThinking` per model, so both work with no config flag and no family allowlist.

## Configuration

Settings are environment variables, or `/login` for the key, so they work identically on macOS, Linux and Windows.

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMMANDCODE_API_KEY` | — | API key when you are not using `/login`. `CMD_API_KEY` and `COMMAND_CODE_API_KEY` are accepted too. |
| `COMMANDCODE_ZDR` | off | Set to `1` to enforce zero data retention on every request. |
| `COMMANDCODE_ZDR_SKIP` | — | Comma-separated model ids to hide while ZDR is on. |
| `COMMANDCODE_MAX_TOKENS` | `32768` | Max output tokens per request. Raise it if responses truncate. |
| `COMMANDCODE_RATES` | — | Override bundled per-model rates (USD per million tokens). See [Cost tracking](#cost-tracking). |
| `COMMANDCODE_TIMEOUT_MS` | `15000` | Catalog fetch timeout at load. |
| `COMMANDCODE_API_BASE_URL` | `https://api.commandcode.ai` | Point at a gateway, proxy, or self-hosted deployment. |

## How it routes

Command Code exposes three endpoints, and each takes its own native request shape. Every model answers on exactly one of them, and the wrong route is a hard `400`.

The catalog reports `supported_endpoints` per model, and this package pins each model to the API that serves it:

| Catalog route | pi API | Models |
| --- | --- | --- |
| `/messages` | `anthropic-messages` | Claude |
| `/responses` | `openai-responses` | GPT |
| `/chat/completions` | `openai-completions` | everything else |

Routing from the catalog rather than from the model id means a model that moves, or a new family outside the `claude-`/`gpt-` prefixes, keeps working without a release. The id prefix is only the fallback for a catalog that omits the field.

**The subtle part**, and the reason this needed its own package: pi's SDKs append *different* paths to `baseUrl`.

```text
OpenAI SDK    -> <baseUrl>/chat/completions  (and /responses)
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

Cost tracking works out of the box for **all 94 models**. Rates are bundled from Command Code's published pricing table, so pi shows real dollar figures on every response. Free-tier models record `$0` by design, and startup names any model the table has no row for.

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

DeepSeek models are billed peak/off-peak. The bundled figures are the **off-peak** price the pricing page shows (~17h/day), so a request during 01:00–04:00 or 06:00–10:00 UTC on a weekday costs roughly double what pi reports. Weekends are off-peak all day.

## Errors you might see

This package turns bare status codes into actionable messages.

| Upstream error | What it means |
| --- | --- |
| `401 UNAUTHORIZED` | The key is missing, rotated or revoked. Run `/login command-code`, or export a current key. |
| `403 MODEL_NOT_IN_PLAN` | The model isn't in your plan. Upgrade, or use a different model. |
| `403 upgrade_required` | Your plan has no API access — the Go plan can't use the Provider API. |
| `422 cmd_zdr_no_providers` | The model has no ZDR upstream; unset `COMMANDCODE_ZDR` or skip the model. |
| `400 unsupported_model` | Should never occur — this package routes shapes correctly. Please report it. |

**Catalog loads but every request `401`s?** That is a stale key, not a network problem: `/provider/v1/models` is public and returns 200 even with a dead credential, so the model list populates while nothing can run. The usual cause is a key copied into a shell before the Command Code CLI rotated its own. Fix it with `/login command-code`.

This package checks pi's auth status and verifies the key with a real (cheap) request at session start, so a bad key is caught before your first prompt, and a `401` mid-session is rewritten with the fix above.

## Compatibility

- **pi:** 0.86 or newer. Registration uses the native `Provider` API (`createProvider` from `@earendil-works/pi-ai`), which is what gives `/login` and stored credentials.
- **OS:** macOS, Linux, Windows. Pure ESM and global `fetch` — no native modules, no shell commands, no filesystem paths, no path separators.
- **Node:** 18 or newer (pi's own minimum). `engines` is set accordingly.
- **Models:** the catalog is discovered at runtime, so this package does not need updating when Command Code adds models.

## Notes and limitations

- **Cost is a published list rate, not a billed amount.** Bundled for all 94 models; override with `COMMANDCODE_RATES`. If the API ever returns per-model `pricing`, that value wins over both. See [Cost tracking](#cost-tracking).
- **`maxTokens` is `32768` by default.** The catalog does not report output caps today, so this is a conservative floor; `max_output_tokens` is honoured as soon as the API sends it. Raise the floor with `COMMANDCODE_MAX_TOKENS`. Context window comes from the catalog's `context_length` (200K fallback).
- **Every model registers as reasoning**, which is what enables thinking levels; a catalog `reasoning: false` overrides it. Non-Claude families set `compat.supportsReasoningEffort`, so pi actually sends `reasoning_effort` — without it the thinking UI would be a lie. A catalog that omits it keeps the default. See [Thinking levels](#thinking-levels).
- **Thinking levels above `high` need an override.** No `thinkingLevelMap` is registered, so pi clamps `xhigh` and `max` to `high` for the OpenAI-shaped families. To send the full range, add a `modelOverrides` entry in `~/.pi/agent/models.json` with a `thinkingLevelMap` for that model id.
- **Claude thinking uses the adaptive shape.** Claude 5.x and 4.7+ reject `thinking.type: "enabled"`, so every Claude model except `claude-haiku-4-5-20251001` sets `compat.forceAdaptiveThinking`. That rules out a family allowlist: `claude-haiku-5-5` also rejects the legacy shape, while the 4.5 haiku rejects adaptive.
- **Text and images.** Image input is enabled by default and narrowed by the catalog's `modalities` when it is reported; every family accepted an image when probed.
- If the catalog fetch fails, the provider registers nothing and says so at session start rather than blocking pi startup. Fix the cause and `/reload`.

## Development

```bash
npm install
npm test        # 31 tests
npm run typecheck
```

Tests cover the routing rules that make this package work (catalog endpoints before id prefix, the three API shapes, the two baseUrls staying distinct, the `/v1/v1` regression), registration with native auth, cross-platform config parsing, ZDR opt-in handling, cost-rate parsing and precedence (including catalog pricing winning), and error classification.

## License

MIT
