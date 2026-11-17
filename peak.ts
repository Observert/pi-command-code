/**
 * DeepSeek peak-hour pricing.
 *
 * Command Code publishes one rate for these models and doubles it during two
 * weekday windows. The catalog only reports the off-peak rate, which is why pi
 * used to under-report every peak request by 2x.
 *
 * The windows, from https://commandcode.ai/docs/resources/pricing-limits:
 * 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday. Weekends are off-peak all
 * day. The models are the five ids the pricing page flags with a peak price;
 * a prefix rule would wrongly double V4.1 Flash Ultrafast, which has none.
 *
 * pi computes cost from the registered `model.cost` block, which cannot vary
 * per request. So the factor is applied to the finished message's usage
 * instead: same accounting, correct number. Set COMMANDCODE_PEAK_PRICING=0 to
 * report the flat off-peak rate again.
 */

import type {
  AssistantMessageEventStream,
  ProviderStreams,
} from "@earendil-works/pi-ai";

/** Ids with a published peak rate. */
export const PEAK_MODELS: ReadonlySet<string> = new Set([
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4.1-flash-fast",
]);

/** Peak is exactly double the published off-peak rate. */
export const PEAK_FACTOR = 2;

/** Half-open UTC hour ranges that bill at the peak rate. */
export const PEAK_WINDOWS_UTC: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
];

/** True inside a weekday peak window. Saturdays and Sundays never are. */
export function isPeak(now: Date = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  return PEAK_WINDOWS_UTC.some(([from, to]) => hour >= from && hour < to);
}

/**
 * Cost multiplier for one request. 1 unless the model is peak-priced, the
 * request lands in a window, and the override is not disabled.
 */
export function peakFactor(
  modelId: string,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): number {
  if ((env.COMMANDCODE_PEAK_PRICING ?? "").trim() === "0") return 1;
  if (!PEAK_MODELS.has(modelId)) return 1;
  return isPeak(now) ? PEAK_FACTOR : 1;
}

interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface CostBearingMessage {
  usage?: { cost?: CostRates };
}

/**
 * Multiplies the reported cost. Replaces the cost object rather than mutating
 * it, and swallows a rejection: pi may freeze the message, and a failed
 * adjustment must never break a completed response.
 */
export function scaleCost(message: CostBearingMessage, factor: number): void {
  const usage = message.usage;
  const cost = usage?.cost;
  if (!usage || !cost || factor === 1) return;
  const input = cost.input * factor;
  const output = cost.output * factor;
  const cacheRead = cost.cacheRead * factor;
  const cacheWrite = cost.cacheWrite * factor;
  const scaled: CostRates = {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
  try {
    usage.cost = scaled;
  } catch {
    // Frozen message: the request still succeeds with the flat rate.
  }
}

/** Applies the factor once, when the host reads the finished message. */
function decorate(
  inner: AssistantMessageEventStream,
  factor: number,
): AssistantMessageEventStream {
  if (factor === 1) return inner;
  const settle = inner.result.bind(inner);
  let applied = false;
  inner.result = async () => {
    const message = await settle();
    if (!applied) {
      applied = true;
      scaleCost(message, factor);
    }
    return message;
  };
  return inner;
}

/**
 * Wraps the provider's streams so a finished DeepSeek peak request reports its
 * true cost. Everything except the final usage is passed through untouched.
 */
export function withPeakPricing(
  streams: ProviderStreams,
  now: () => Date = () => new Date(),
): ProviderStreams {
  return {
    ...streams,
    stream: (model, context, options) =>
      decorate(streams.stream(model, context, options), peakFactor(model.id, now())),
    streamSimple: (model, context, options) =>
      decorate(streams.streamSimple(model, context, options), peakFactor(model.id, now())),
  };
}
