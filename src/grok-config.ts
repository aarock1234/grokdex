// Grok config lives in ~/.grok/config.toml. grokdex owns one marked block in it and never touches the rest.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDERS, type Model, type ProviderId } from "./providers.ts";

export const grokConfigFile = join(process.env.GROK_HOME ?? join(homedir(), ".grok"), "config.toml");

const BEGIN = "# >>> grokdex >>>";
const END = "# <<< grokdex <<<";
const BLOCK = new RegExp(`\\n*${BEGIN}[\\s\\S]*?${END}\\n?`);

// How Grok should run grokdex: a pinned `npx` for installs from npm, the local file in development.
export type Launcher = { command: string; args: string[] };

export type Setup = { provider: ProviderId; models: Model[] };

// JSON strings are valid TOML basic strings.
const str = (value: string): string => JSON.stringify(value);
const list = (values: string[]): string => `[${values.map(str).join(", ")}]`;

export function renderBlock(setups: Setup[], launcher: Launcher): string {
  const lines = [BEGIN, "# Managed by grokdex. Change it with `grokdex setup`, remove it with `grokdex remove`."];
  const run = (...args: string[]): string[] => [`command = ${str(launcher.command)}`, `args = ${list([...launcher.args, ...args])}`];

  if (setups.some((s) => PROVIDERS[s.provider].usesAdapter)) {
    lines.push("", "[mcp_servers.grokdex]", ...run("mcp"));
  }
  for (const { provider: id, models } of setups) {
    const provider = PROVIDERS[id];
    lines.push("", `[auth_provider.grokdex-${id}]`, ...run("token", id));
    if (provider.tokenTtlSecs) lines.push(`token_ttl_secs = ${provider.tokenTtlSecs}`);
    lines.push(
      "",
      `[model_providers.grokdex-${id}]`,
      `base_url = ${str(provider.baseUrl)}`,
      `api_backend = "responses"`,
      `auth_provider = "grokdex-${id}"`,
    );
    for (const model of models) {
      lines.push(
        "",
        `[model.${str(provider.modelKey(model.slug))}]`,
        `model = ${str(model.slug)}`,
        `model_provider = "grokdex-${id}"`,
        `name = ${str(`${model.name} (${provider.label})`)}`,
      );
      if (model.description) lines.push(`description = ${str(model.description)}`);
      if (model.contextWindow) lines.push(`context_window = ${model.contextWindow}`);
      if (model.efforts.length > 0) {
        const efforts = model.efforts.map((e) => `{ id = ${str(e)}, value = ${str(e)}${e === model.defaultEffort ? ", default = true" : ""} }`);
        lines.push(`reasoning_efforts = [${efforts.join(", ")}]`);
      }
    }
  }
  lines.push(END);
  return lines.join("\n");
}

export function upsertBlock(config: string, block: string): string {
  if (BLOCK.test(config)) return config.replace(BLOCK, `\n\n${block}\n`);
  return config.trim() ? `${config.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

export function removeBlock(config: string): string {
  return config.replace(BLOCK, "\n");
}

// Rewrites the Grok config atomically, keeping the previous version as config.toml.bak.
export function updateGrokConfig(update: (config: string) => string): boolean {
  const current = existsSync(grokConfigFile) ? readFileSync(grokConfigFile, "utf8") : "";
  const next = update(current);
  if (next === current) return false;
  if (current) writeFileSync(`${grokConfigFile}.bak`, current);
  const tmp = `${grokConfigFile}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, grokConfigFile);
  return true;
}
