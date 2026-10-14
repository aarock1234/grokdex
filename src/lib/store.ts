import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { z } from 'zod';

import { env, paths } from './config/env.ts';

// creates the data directory readable only by the current user; files inside inherit that.
export function ensureDataDir(): void {
	if (existsSync(paths.dataDir)) {
		return;
	}

	mkdirSync(paths.dataDir, { recursive: true });
	restrictToCurrentUser(paths.dataDir);
}

export function readStored<Schema extends z.ZodType>(name: string, schema: Schema): z.output<Schema> | undefined {
	const file = join(paths.dataDir, name);

	if (!existsSync(file)) {
		return undefined;
	}

	try {
		const data: unknown = JSON.parse(readFileSync(file, 'utf8'));

		return schema.parse(data);
	} catch (error) {
		throw new Error(`${file} is unreadable; fix or delete it and run grokdex setup`, { cause: error });
	}
}

// writes through a temporary file so a crash never leaves a half-written credential behind.
export function writeStored(name: string, value: unknown): void {
	ensureDataDir();

	const file = join(paths.dataDir, name);
	const temporary = `${file}.${process.pid}.tmp`;

	writeFileSync(temporary, JSON.stringify(value, null, '\t'), { mode: 0o600 });
	renameSync(temporary, file);
}

export function removeStored(name: string): void {
	rmSync(join(paths.dataDir, name), { force: true });
}

function restrictToCurrentUser(directory: string): void {
	if (process.platform !== 'win32') {
		chmodSync(directory, 0o700);
		return;
	}

	const user = env.USERNAME;

	if (!user) {
		return;
	}

	spawnSync('icacls', [directory, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], {
		stdio: 'ignore',
		windowsHide: true,
	});
}
