import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import pino from 'pino';
import type { Logger } from 'pino';

import { paths } from './config/env.ts';
import { ensureDataDir } from './store.ts';

const MAX_LOG_BYTES = 1_000_000;

// the adapter logs to a file because stdout belongs to the mcp protocol.
export function createFileLogger(name: string): Logger {
	ensureDataDir();

	const file = join(paths.dataDir, `${name}.log`);

	if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
		rmSync(file);
	}

	return pino(
		{
			name,
			level: 'info',
		},
		pino.destination({
			dest: file,
			append: true,
			sync: false,
		})
	);
}
