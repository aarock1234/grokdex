import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { paths } from './config/env.ts';
import { ensureDataDir } from './store.ts';

const WAIT_MS = 15_000;
const POLL_MS = 200;
const STALE_MS = 30_000;

// serializes work across processes, such as two grok sessions refreshing the same rotating token.
export async function withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
	ensureDataDir();

	const lock = join(paths.dataDir, `${name}.lock`);
	const deadline = Date.now() + WAIT_MS;

	while (!tryAcquire(lock)) {
		if (isStale(lock)) {
			rmSync(lock, { recursive: true, force: true });
			continue;
		}

		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${name} lock`);
		}

		await setTimeout(POLL_MS);
	}

	try {
		return await operation();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

// mkdir is atomic on every platform, so the directory itself is the lock.
function tryAcquire(lock: string): boolean {
	try {
		mkdirSync(lock);
		return true;
	} catch {
		return false;
	}
}

function isStale(lock: string): boolean {
	try {
		return Date.now() - statSync(lock).mtimeMs > STALE_MS;
	} catch {
		return false;
	}
}
