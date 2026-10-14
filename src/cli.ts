#!/usr/bin/env node
import { readFileSync, rmSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { accessToken, account, signOut } from "./chatgpt.ts";
import { grokConfigFile, removeBlock, updateGrokConfig, type Launcher } from "./grok-config.ts";
import { runMcpServer } from "./mcp.ts";
import { PROVIDERS, apiKey, type ProviderId } from "./providers.ts";
import { savedSetups, setup } from "./setup.ts";
import { UserError, dataDir, removeJson } from "./store.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const USAGE = `grokdex ${version}

Usage: grokdex <command>

Commands:
  setup               connect a provider and add its models to Grok
  status              show what is connected
  remove              remove grokdex from Grok's config
  remove --sign-out   also sign out and delete saved credentials

Used by Grok:
  token <provider>    print an access token
  mcp                 run the adapter for a Grok session`;

// Installed from npm (npx or a global install) Grok runs the same pinned version through npx;
// from a checkout it runs this file directly. On Windows Grok's credential helper doesn't apply
// PATHEXT, so name the npx.cmd shim explicitly.
function launcher(): Launcher {
  const cli = fileURLToPath(import.meta.url);
  if (!cli.includes(`${sep}node_modules${sep}`)) return { command: process.execPath, args: [cli] };
  return { command: process.platform === "win32" ? "npx.cmd" : "npx", args: ["-y", `grokdex@${version}`] };
}

async function token(provider: string | undefined): Promise<void> {
  if (provider === "chatgpt") {
    const headless = process.env.GROK_AUTH_EXPIRED === "1";
    return void process.stdout.write(JSON.stringify(await accessToken(headless)));
  }
  if (provider === "openai") return void process.stdout.write(JSON.stringify({ access_token: apiKey("openai") }));
  throw new UserError(`unknown provider: ${provider ?? "(none)"}`);
}

function status(): void {
  const setups = savedSetups();
  if (setups.length === 0) return console.log("nothing connected (run: grokdex setup)");
  for (const { provider, models } of setups) {
    const who = provider === "chatgpt" ? ` as ${account()?.email ?? "?"}` : "";
    console.log(`${PROVIDERS[provider].label}${who}`);
    for (const m of models) console.log(`  ${PROVIDERS[provider].modelKey(m.slug)}`);
  }
  console.log(`\nconfig: ${grokConfigFile}\ndata:   ${dataDir}`);
}

async function remove(signOutToo: boolean): Promise<void> {
  const changed = updateGrokConfig(removeBlock);
  removeJson("setup.json");
  console.log(changed ? `removed grokdex from ${grokConfigFile}` : "grokdex was not in your Grok config");
  if (!signOutToo) return;
  await signOut();
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`signed out and deleted ${dataDir}`);
}

async function main(args: string[]): Promise<void> {
  const [command, arg] = args;
  switch (command) {
    case "setup":
      return setup(launcher());
    case "status":
      return status();
    case "remove":
      return remove(args.includes("--sign-out"));
    case "token":
      return token(arg as ProviderId | undefined);
    case "mcp":
      return runMcpServer(version);
    case "--version":
    case "-v":
      return console.log(version);
    default:
      console.log(USAGE);
      if (command && command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 2;
  }
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof UserError ? err.message : `error: ${(err as Error).message}`);
  process.exit(1);
}
