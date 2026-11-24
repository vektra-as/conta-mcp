/**
 * Loads CONTA_* settings from a key file outside the client config, so the API key never has to live in
 * claude_desktop_config.json, ~/.claude.json, shell history or a chat.
 *
 * Path: CONTA_ENV_FILE, else ~/.config/conta-mcp/.env. The file is optional. Variables already set in the
 * environment win over the file. Only CONTA_* keys are applied.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

export function defaultEnvFilePath(home: string = homedir()): string {
  return join(home, ".config", "conta-mcp", ".env");
}

export interface EnvFileResult {
  path: string;
  loaded: boolean;
  /** Names of the variables taken from the file (never values). */
  applied: string[];
  warnings: string[];
}

export function loadContaEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  options: { home?: string; platform?: NodeJS.Platform } = {},
): EnvFileResult {
  const explicit = env.CONTA_ENV_FILE?.trim();
  const path = explicit || defaultEnvFilePath(options.home);
  const result: EnvFileResult = { path, loaded: false, applied: [], warnings: [] };

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !explicit) return result;
    throw new Error(`Could not read CONTA_ENV_FILE ${path} (${code ?? "unknown error"})`);
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      result.warnings.push(
        `${path} can be read by other users (mode ${mode.toString(8)}). Run: chmod 600 "${path}"`,
      );
    }
  }

  const parsed = parseEnv(content);
  for (const [name, value] of Object.entries(parsed)) {
    if (!name.startsWith("CONTA_") || name === "CONTA_ENV_FILE") continue;
    if (value === undefined || value === "") continue;
    if (env[name] !== undefined && env[name] !== "") continue;
    env[name] = value;
    result.applied.push(name);
  }
  result.loaded = true;
  return result;
}
