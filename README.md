# pi-command-code

[Command Code](https://commandcode.ai) Provider API for the [Pi coding agent](https://pi.dev).

One provider, the whole Command Code catalog — Claude, GPT, Gemini, DeepSeek, Kimi, GLM, Qwen, Grok, MiniMax, Muse Spark and more — fetched live at startup. New models appear automatically, with no package update.

## Features

- **The whole catalog, nothing hardcoded.** 101 models today, discovered live from `/provider/v1/models` and its `?view=client` twin at startup.
- **Capabilities read, not guessed.** Per-model `reasoningEfforts`, `inputModalities`, `maxOutputTokens`, `pricing` (including context tiers) and ZDR reach are taken from the same catalog the Command Code CLI reads.
- **Native pi provider.** `/login command-code` stores the key in pi's credential store; `COMMANDCODE_API_KEY`, `CMD_API_KEY` and `COMMAND_CODE_API_KEY` work as env fallbacks, and the CLI's own `~/.commandcode/auth.json` is read last.
- **The right wire per model.** Catalog-driven routing to Anthropic Messages, OpenAI Responses or Chat Completions, with the per-model `baseUrl` each SDK expects — plus persistent per-model overrides.
- **Thinking levels everywhere, exactly where they exist.** Every model registers as a reasoner with a per-model level map, so the picker never offers an effort the model rejects, and `xhigh`/`max` are available where upstream supports them.
- **Cost tracking that works.** Live catalog prices first, bundled list rates as the fallback, `COMMANDCODE_RATES` overrides, request-size tiers, and DeepSeek peak hours applied per request.
- **Survives being offline.** The last catalog is cached, so a network failure at startup still gives you the models you had.
- **Five commands.** `/commandcode-refresh`, `-status`, `-diagnostics`, `-quota`, `-endpoint`.
- **Zero data retention on request.** Opt-in header, and models the catalog marks as having no ZDR upstream are hidden instead of failing.
- **Plain-language errors.** `401`, plan gating (naming the tier the model needs) and ZDR gaps are named, not passed through as bare status codes.
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

Already logged into the Command Code CLI? This provider reads the key from its auth file too, in this order: `~/.commandcode/auth.json`, `<pi agent dir>/auth.json`, `~/.omp/agent/auth.json`. Accepted shapes are `{"apiKey": "user_..."}`, `{"command-code": {"type": "api", "key": "user_..."}}` and `{"commandcode": "user_..."}`. Nothing is copied or rewritten.

> **Plan requirement:** the Provider API needs a plan with API access — the [Provider plan](https://commandcode.ai/provider) ($15/mo + $1.01 processing fee, pay-as-you-go at cost, credits roll over) or GOAT / Pro / Max / Team. The $1 **Go** plan cannot use the API. Claude Opus and Fable need Max on a subscription *or* the Provider plan.

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

## Commands

| Command | What it does |
| --- | --- |
| `/commandcode-refresh` | Re-fetch the catalog, rewrite the cache and re-register models without a reload. A failed refresh keeps the current list. |
| `/commandcode-status` | Catalog source, version, model count, wire breakdown, auth state, ZDR, overrides, last request. |
| `/commandcode-diagnostics` | A redacted support report safe to paste in public: versions, catalog version, pricing coverage, last request outcome. No prompts, no keys. |
| `/commandcode-quota` | Credits, plan, billing period, 5-hour and weekly windows. Add `json` for the raw responses. |
| `/commandcode-endpoint <model-id> <wire>` | Pin one model to `auto`, `chat-completions`, `responses` or `messages`. Choices survive refreshes and restarts. |

`/commandcode-quota` reads Command Code's read-only account endpoints (`/alpha/whoami`, `/alpha/billing/credits`, `/alpha/billing/subscriptions`, `/alpha/usage/summary`) with the key you already stored. They are undocumented and may change; a section that cannot be read is reported as unavailable rather than shown as zero. They never generate text and say nothing about Provider API entitlement.

## Catalog cache and offline behavior

Models come from two public endpoints: `/provider/v1/models` (routing and context) and `/provider/v1/models?view=client` (capabilities, prices, plan, ZDR). Both are fetched at startup and joined by model id.

The result is cached at `<pi agent dir>/command-code-catalog.json` (`~/.pi/agent/` by default). If the network is unreachable, the cached catalog is registered instead, with a warning naming the cache age — pi no longer starts with an empty model list. The cache is refreshed in the background once it is older than the server's `refreshAfterSeconds` hint, so a long session picks up new models on its own.

## Thinking levels

Every model in the catalog registers as a reasoner, so pi offers thinking levels across the whole catalog, not just Claude:

```bash
pi --provider command-code --model claude-sonnet-5-5:high
pi --provider command-code --model gpt-6-astra:max
```

Which levels appear comes from the model's `reasoningEfforts` in the catalog, mapped onto pi's `thinkingLevelMap`:

- A level the model does not list maps to `null`, so the picker never offers it. This matters: pi sends `reasoning_effort` for any level it thinks is supported, and 14 catalog models (`deepseek/*`, `Kimi-K3*`, `zai-org/GLM-5.3`, `sakana/fugu-ultra`, …) reject `medium` with a `400`.
- `xhigh` and `max` appear only when upstream lists them, which is the case for 36 models. No `models.json` override is needed any more.
- A model that lists no `off` gets `off: null`: pi then sends no reasoning field at all when you pick `off`, rather than an effort the upstream rejects.
- A model the catalog reports no efforts for keeps `reasoning: true` but maps every level to `null`, so it can still stream thinking blocks while offering only `off`.

Claude needs one exception handled in code: Claude 5.x and 4.7+ reject `thinking.type: "enabled"` and require the adaptive shape, while `claude-haiku-4-5-20251001` rejects adaptive and needs the legacy one. This package sets `compat.forceAdaptiveThinking` per model, so both work with no config flag and no family allowlist.

## Configuration

Settings are environment variables, or `/login` for the key, so they work identically on macOS, Linux and Windows.

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMMANDCODE_API_KEY` | — | API key when you are not using `/login`. `CMD_API_KEY` and `COMMAND_CODE_API_KEY` are accepted too. |
| `COMMANDCODE_ZDR` | off | Set to `1` to enforce zero data retention on every request. |
| `COMMANDCODE_ZDR_SKIP` | — | Comma-separated model ids to hide while ZDR is on, beyond the ones the catalog already flags. |
| `COMMANDCODE_MAX_TOKENS` | `32768` | Output-token floor for models that publish no cap. A published `maxOutputTokens` wins. |
| `COMMANDCODE_RATES` | — | Override per-model rates (USD per million tokens). See [Cost tracking](#cost-tracking). |
| `COMMANDCODE_PEAK_PRICING` | on | Set to `0` to report DeepSeek's flat off-peak rate at all hours. |
| `COMMANDCODE_TIMEOUT_MS` | `15000` | Catalog fetch timeout at load and on refresh. |
| `COMMANDCODE_API_BASE_URL` | `https://api.commandcode.ai` | Point at a gateway, proxy, or self-hosted deployment. |
| `COMMANDCODE_MODELS_CACHE` | `<agent dir>/command-code-catalog.json` | Where the catalog cache is written. |
| `COMMANDCODE_ROUTING_FILE` | `<agent dir>/commandcode-routing.json` | Where endpoint overrides are stored. |

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

**ZDR is enforced from the catalog.** The catalog marks each model with whether a ZDR-capable upstream exists, and this package hides the ones that do not while ZDR is on (23 of 117 today, including some premium models). No hardcoded blocklist ships, because coverage changes as Command Code signs upstream agreements.

- The error is detected and explained in plain language when it happens.
- If you want to hide more models up front, list them yourself:

```bash
export COMMANDCODE_ZDR_SKIP="meta/muse-spark-1.3,Qwen/Qwen3.8-Flash"
```

Those models are then excluded from the catalog and the count is reported at startup.

**ZDR costs more.** Routing is restricted to ZDR-capable upstreams with capacity, which is not always the cheapest one serving a model. Command Code passes through exactly what it's charged, with no markup. See your [Usage](https://commandcode.ai/usage) page for real per-request pricing.

## Cost tracking

Cost tracking works out of the box for **every visible model** — all 101 today, including this month's releases. Prices come from the live catalog, three models are free by design (`$0`, not unknown), the bundled table covers anything the catalog stops pricing, and startup names any model that would otherwise report `$0` without a price.

### Where the numbers come from

| Source | Wins over | Covers |
| --- | --- | --- |
| Live catalog `pricing` | everything | every visible model, including request-size tiers |
| `COMMANDCODE_RATES` | the bundled table | models the catalog does not price |
| Bundled `rates.ts` | zero | the whole catalog as of generation |
| Zero | — | never invents a number |

Token counts come back in every response and are detailed — input, output, cached, reasoning and cache-creation tokens. pi computes cost locally as `rate_per_million × tokens ÷ 1,000,000` from the registered `cost` block, so the rates are what matter.

The catalog reports 14 models with request-size tiers (a bigger context costs more per token). Those are registered as pi `cost.tiers`, so a long request is charged at the right tier instead of the smallest one.

### Keeping the bundled table fresh

Rates move (deals, free tiers, DeepSeek hourly peak/off-peak). The bundled table is generated and checked in, and it is only the fallback — but keep it current anyway.

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

Precedence: **catalog price** → **your overrides** → **bundled list rates** → **zero**. A model with no known rate reports `$0` rather than a fabricated number, and startup names it:

```text
[command-code] 1 model(s) have no published rate and will report $0 (tokens still exact): vendor/new-model
```

Malformed entries are skipped rather than thrown, so a typo can never stop pi from starting.

One caveat: these are published list rates. A given request can cost slightly less, because Command Code routes open-source models across multiple upstreams and bills the mean per-provider price. Your [Usage](https://commandcode.ai/usage) page remains the source of truth, especially under ZDR where pass-through rates can differ.

DeepSeek peak hours are applied per request, not baked into the rate. Five ids — `deepseek/deepseek-v4-pro`, `-v4-flash`, `-v4-flash-vision-exp`, `-v4.1-flash`, `-v4.1-flash-fast` — bill at **2x** during 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday, and at the published rate the other 17 hours a day plus all weekend. pi's own cost multiply cannot vary by clock, so the finished response's usage is scaled instead: the number you see matches the window. `COMMANDCODE_PEAK_PRICING=0` restores the flat rate.

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

- **pi:** 0.86 or newer. Registration uses the native `Provider` API (`createProvider` from `@earendil-works/pi-ai`), which is what gives `/login` and stored credentials. Verified against pi-ai 1.4. A host too old to know `thinkingLevelMap` or `cost.tiers` ignores those fields and falls back to its own defaults, so nothing breaks — you just lose per-model effort filtering and tiered cost.
- **OS:** macOS, Linux, Windows. Pure ESM and global `fetch` — no native modules, no shell commands, and all paths go through `node:path` so separators never matter.
- **Node:** 18 or newer (pi's own minimum). `engines` is set accordingly.
- **Models:** the catalog is discovered at runtime, so this package does not need updating when Command Code adds models.

## Notes and limitations

- **Cost is a published list rate, not a billed amount.** The catalog's price wins, then `COMMANDCODE_RATES`, then the bundled table. Your [Usage](https://commandcode.ai/usage) page remains authoritative, especially under ZDR where pass-through rates can differ.
- **`maxTokens` follows the catalog.** A published `maxOutputTokens` is used and clamped by the context window; the rest fall back to `COMMANDCODE_MAX_TOKENS` (32768). Eight models publish caps between 131k and 262k, and those were being truncated at 32k before. Context window comes from `context_length` (200K fallback).
- **Every model registers as reasoning**, which is what enables thinking levels; a catalog `reasoning: false` overrides it. Non-Claude families set `compat.supportsReasoningEffort`, so pi actually sends `reasoning_effort` — without it the thinking UI would be a lie. See [Thinking levels](#thinking-levels).
- **Level support is per model.** A model that rejects an effort is not offered it. An unmapped model (one the catalog does not describe) keeps pi's defaults.
- **Costs come from the catalog first**, which is what `/commandcode-diagnostics` reports. `COMMANDCODE_RATES` fills in models the catalog does not price, so negotiated or ZDR rates override the bundled table rather than a live catalog price.
- **Claude thinking uses the adaptive shape.** Claude 5.x and 4.7+ reject `thinking.type: "enabled"`, so every Claude model except `claude-haiku-4-5-20251001` sets `compat.forceAdaptiveThinking`. That rules out a family allowlist: `claude-haiku-5-5` also rejects the legacy shape, while the 4.5 haiku rejects adaptive.
- **1-hour cache writes are costed at the 5-minute rate.** The catalog publishes a separate `cacheWrite1hCost` (2x on Claude), but pi's `cost` block has one `cacheWrite` rate, so the 1h surcharge is not applied. Requests that use 1h retention report slightly low.
- **Decision models are not chat models.** `typesafe/jev` and its pinned `typesafe/jev-1.14.0` are documented by Command Code but are not in `/provider/v1/models` and never stream: they answer on a separate `POST /provider/v1/systemone` endpoint with a state-plus-typed-questions request and return probabilities. This provider registers only what the chat catalog lists, so Jev does not appear in the picker.
- **Text and images follow the catalog.** 21 visible models are text-only and are registered that way, so an image is never sent to a model that will `400` on it. Unknown models default to text-only.
- **A cold start with no network registers nothing.** The cached catalog covers the normal offline case; with no cache at all the provider says so at session start rather than blocking pi startup. Fix the cause and `/commandcode-refresh`.

## Development

```bash
npm install
npm test        # 58 tests
npm run typecheck
```

Tests cover the routing rules that make this package work (catalog endpoints before id prefix, the three API shapes, the two baseUrls staying distinct, the `/v1/v1` regression), capability mapping (effort lists to level maps, published output caps, context tiers, text-only models), catalog merging and the offline cache, endpoint-override persistence, DeepSeek peak windows, auth-file shapes, command output, plan-gating hints, registration with native auth, the package version staying in step with `package.json`, and error classification.

## License

MIT
