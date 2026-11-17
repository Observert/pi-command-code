/**
 * Account and quota reporting.
 *
 * This is the one deliberate exception to "the Provider API only": the numbers
 * a user asks for (credits, plan, usage windows) are not exposed by
 * `/provider/v1`. They come from the same read-only account endpoints the
 * `cmd` CLI's own `/usage` command calls, authenticated with the same key:
 *
 *   GET /alpha/whoami
 *   GET /alpha/billing/credits?orgId=...
 *   GET /alpha/billing/subscriptions?orgId=...
 *   GET /alpha/usage/summary?orgId=...&since=...
 *
 * These are undocumented, GET-only account reads. They never generate text,
 * and their success says nothing about Provider API entitlement. Schemas may
 * change at any time, so every field is read defensively and a section that
 * cannot be read is reported as unavailable instead of shown as zero.
 */

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads an object-valued field, or undefined when it is not an object. */
const child = (v: unknown, key: string): Json | undefined => {
  const value = isRecord(v) ? v[key] : undefined;
  return isRecord(value) ? value : undefined;
};

const strField = (v: unknown, key: string): string | undefined => {
  const value = isRecord(v) ? v[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const numField = (v: unknown, key: string): number | undefined => {
  const value = isRecord(v) ? v[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export interface QuotaWindow {
  window: "5-hour" | "weekly";
  used: number;
  cap: number;
  resetAt?: string;
}

export interface QuotaReport {
  login?: string;
  orgId?: string;
  keyName?: string;
  plan?: string;
  planStatus?: string;
  periodStart?: string;
  periodEnd?: string;
  monthlyCredits?: number;
  purchasedCredits?: number;
  freeCredits?: number;
  remainingCredits?: number;
  windows: QuotaWindow[];
  totalCost?: number;
  totalCount?: number;
  totalTokens?: number;
  /** Sections the endpoints did not return, with the reason. */
  unavailable: string[];
}

export interface QuotaInput {
  apiKey: string;
  /** API root without the `/provider/v1` suffix, e.g. https://api.commandcode.ai */
  apiRoot: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Reads the four endpoints and flattens them into one report. */
export async function fetchQuota(input: QuotaInput): Promise<QuotaReport> {
  const report: QuotaReport = { windows: [], unavailable: [] };
  const call = input.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const headers = {
    accept: "application/json",
    Authorization: `Bearer ${input.apiKey}`,
  };

  const get = async (path: string): Promise<unknown> => {
    const res = await call(`${input.apiRoot}${path}`, {
      method: "GET",
      headers,
      signal,
    });
    if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`);
    return res.json();
  };

  const section = async <T>(name: string, run: () => Promise<T | undefined>) => {
    try {
      const value = await run();
      if (value === undefined) report.unavailable.push(name);
      return value;
    } catch (err) {
      report.unavailable.push(
        `${name} (${err instanceof Error ? err.message : String(err)})`,
      );
      return undefined;
    }
  };

  const login = await section("account", async () => {
    const body = await get("/alpha/whoami");
    const org = child(body, "org");
    const user = child(body, "user");
    const who =
      strField(org, "login") ??
      strField(user, "userName") ??
      strField(user, "name");
    if (!who) return undefined;
    report.login = who;
    report.orgId = strField(org, "id");
    report.keyName = strField(user, "keyName") ?? strField(user, "displayName");
    return who;
  });
  if (!login) return report;

  const orgQuery = report.orgId ? `?orgId=${encodeURIComponent(report.orgId)}` : "";

  await section("credits", async () => {
    const body = await get(`/alpha/billing/credits${orgQuery}`);
    const credits = child(body, "credits");
    const monthly = numField(credits, "monthlyCredits");
    const purchased = numField(credits, "purchasedCredits");
    const free = numField(credits, "freeCredits");
    if (monthly === undefined && purchased === undefined && free === undefined) {
      return undefined;
    }
    report.monthlyCredits = monthly ?? 0;
    report.purchasedCredits = purchased ?? 0;
    report.freeCredits = free ?? 0;
    report.remainingCredits =
      report.monthlyCredits + report.purchasedCredits + report.freeCredits;

    for (const [window, key] of [
      ["5-hour", "fiveHour"],
      ["weekly", "weekly"],
    ] as const) {
      const entry = child(body, key);
      const used = numField(entry, "used");
      const cap = numField(entry, "cap");
      if (used === undefined || cap === undefined || (used === 0 && cap === 0)) continue;
      report.windows.push({ window, used, cap, resetAt: strField(entry, "resetAt") });
    }
    return report.remainingCredits;
  });

  await section("plan", async () => {
    const body = await get(`/alpha/billing/subscriptions${orgQuery}`);
    const data = child(body, "data");
    const plan = strField(data, "planId");
    const status = strField(data, "status");
    if (!plan && !status) return undefined;
    report.plan = plan;
    report.planStatus = status;
    report.periodStart = strField(data, "currentPeriodStart");
    report.periodEnd = strField(data, "currentPeriodEnd");
    return plan ?? status;
  });

  await section("usage", async () => {
    const since = report.periodStart
      ? `since=${encodeURIComponent(report.periodStart)}`
      : "";
    const query = [orgQuery.replace(/^\?/, ""), since].filter(Boolean).join("&");
    const body = await get(`/alpha/usage/summary${query ? `?${query}` : ""}`);
    const cost = numField(body, "totalCost");
    const count = numField(body, "totalCount");
    if (cost === undefined && count === undefined) return undefined;
    report.totalCost = cost;
    report.totalCount = count;
    report.totalTokens = numField(body, "totalTokens") ?? numField(body, "tokens");
    return cost;
  });

  return report;
}

const money = (v: number | undefined): string =>
  v === undefined ? "?" : `$${v.toFixed(v < 1 ? 4 : 2)}`;

const stamp = (v: string | undefined): string => {
  if (!v) return "?";
  const date = new Date(v);
  return Number.isNaN(date.getTime())
    ? v
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

/** Plain text so it reads the same in pi and in hosts without rich output. */
export function formatQuota(report: QuotaReport): string[] {
  const lines = ["Command Code quota"];

  lines.push(
    `Account: ${report.login ?? "unknown account"}` +
      (report.keyName ? ` · key ${report.keyName}` : ""),
  );

  if (report.plan || report.planStatus) {
    lines.push(
      `Plan: ${report.plan ?? "?"}${report.planStatus ? ` (${report.planStatus})` : ""}`,
    );
  }
  if (report.periodStart || report.periodEnd) {
    lines.push(`Period: ${stamp(report.periodStart)} -> ${stamp(report.periodEnd)}`);
  }

  if (report.remainingCredits !== undefined) {
    lines.push(
      `Credits: ${money(report.remainingCredits)} remaining (monthly ${money(report.monthlyCredits)}, ` +
        `purchased ${money(report.purchasedCredits)}, free ${money(report.freeCredits)})`,
    );
  }

  for (const w of report.windows) {
    const pct = w.cap > 0 ? Math.round((w.used / w.cap) * 100) : 0;
    lines.push(
      `${w.window} window: ${pct}% used (${w.used}/${w.cap})` +
        (w.resetAt ? `, resets ${stamp(w.resetAt)}` : ""),
    );
  }

  if (report.totalCost !== undefined || report.totalCount !== undefined) {
    lines.push(
      `Usage this period: ${money(report.totalCost)} · ${report.totalCount ?? "?"} requests` +
        (report.totalTokens !== undefined ? ` · ${report.totalTokens} tokens` : ""),
    );
  }

  if (report.unavailable.length > 0) {
    lines.push(`Unavailable: ${report.unavailable.join("; ")}`);
  }
  return lines;
}
