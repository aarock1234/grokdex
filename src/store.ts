import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 30_000;

export const dataDir =
  process.env.GROKDEX_HOME ?? join(process.env.LOCALAPPDATA ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "grokdex");

export class UserError extends Error {}

export function ensureDataDir(): void {
  if (existsSync(dataDir)) return;
  mkdirSync(dataDir, { recursive: true });
  restrictToCurrentUser(dataDir);
}

// Owner-only access: 0700 on Unix, an owner-only ACL on Windows that files inside inherit.
function restrictToCurrentUser(path: string): void {
  if (process.platform !== "win32") {
    chmodSync(path, 0o700);
    return;
  }
  const user = process.env.USERNAME;
  if (!user) return;
  spawnSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { stdio: "ignore", windowsHide: true });
}

export function readJson<T>(name: string): T | undefined {
  const path = join(dataDir, name);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(name: string, value: unknown): void {
  ensureDataDir();
  const path = join(dataDir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function removeJson(name: string): void {
  rmSync(join(dataDir, name), { force: true });
}

// Serializes a critical section across processes, e.g. two Grok sessions refreshing a rotating token.
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  ensureDataDir();
  const lock = join(dataDir, `${name}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (isStale(lock)) rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}.lock`);
      else await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function isStale(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}
