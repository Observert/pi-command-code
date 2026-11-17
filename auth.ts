/**
 * API key resolution.
 *
 * pi's stored credential (`/login command-code`) wins, then the env vars this
 * package has always read, then the auth files the Command Code CLI and
 * compatible hosts already write. Reading those files is what lets someone who
 * is logged into the `cmd` CLI use pi without pasting the key twice.
 *
 * Resolution is per request, so a rotated key in the environment or a rewritten
 * auth file is picked up without restarting pi.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ApiKeyAuth } from "@earendil-works/pi-ai";

/**
 * Env vars consulted, in order, when no key is stored by `/login`. Ours first,
 * then the two names the Command Code CLI and its docs use.
 */
export const API_KEY_ENV_VARS = [
  "COMMANDCODE_API_KEY",
  "CMD_API_KEY",
  "COMMAND_CODE_API_KEY",
] as const;

/**
 * Auth files read after the env vars, in order. `.commandcode` is the CLI's
 * own file; the other two are host credential stores that older versions and
 * Oh My Pi write.
 */
export function authFilePaths(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const home = homedir();
  const piDir = (env.PI_CODING_AGENT_DIR ?? "").trim() || join(home, ".pi", "agent");
  return [
    join(home, ".commandcode", "auth.json"),
    join(piDir, "auth.json"),
    join(home, ".omp", "agent", "auth.json"),
  ];
}

/**
 * Pulls a key out of an auth file body. Three shapes are in the wild:
 *
 *   { "apiKey": "user_..." }
 *   { "command-code": { "type": "api", "key": "user_..." } }
 *   { "commandcode": "user_..." }
 *
 * Returns undefined for anything else, so an unrelated file is never mistaken
 * for a credential.
 */
export function keyFromAuthFile(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;

  const direct = record.apiKey;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  for (const id of ["command-code", "commandcode"]) {
    const entry = record[id];
    if (typeof entry === "string" && entry.trim()) return entry.trim();
    if (entry && typeof entry === "object") {
      const key = (entry as Record<string, unknown>).key;
      if (typeof key === "string" && key.trim()) return key.trim();
    }
  }
  return undefined;
}

/** First key found across the auth files, with where it came from. */
export function keyFromAuthFiles(
  paths: string[] = authFilePaths(),
): { key: string; path: string } | undefined {
  for (const path of paths) {
    let body: unknown;
    try {
      body = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // missing or unreadable: try the next one
    }
    const key = keyFromAuthFile(body);
    if (key) return { key, path };
  }
  return undefined;
}

/**
 * The provider's apiKey auth: interactive `/login`, plus ambient resolution
 * from env vars and auth files.
 */
export function commandCodeAuth(
  envVars: readonly string[] = API_KEY_ENV_VARS,
): ApiKeyAuth {
  return {
    name: "Command Code API key",
    login: async (interaction) => {
      interaction.signal.throwIfAborted();
      const key = await interaction.prompt({
        type: "secret",
        message: "Enter Command Code API key",
      });
      interaction.signal.throwIfAborted();
      return { type: "api_key", key };
    },
    resolve: async ({ ctx, credential, signal }) => {
      signal.throwIfAborted();
      if (credential?.key) {
        return {
          auth: { apiKey: credential.key },
          env: credential.env,
          source: "stored credential",
        };
      }
      for (const envVar of envVars) {
        const value = await ctx.env(envVar);
        signal.throwIfAborted();
        if (value) return { auth: { apiKey: value }, source: envVar };
      }
      const found = keyFromAuthFiles();
      if (found) {
        return { auth: { apiKey: found.key }, source: found.path };
      }
      return undefined;
    },
  };
}
