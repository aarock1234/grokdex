import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { parse, stringify } from 'smol-toml';

import { paths } from '../config/env.ts';
import { AppError, errorMessage } from '../errors.ts';

export type TomlTable = Record<string, unknown>;

// toml dates parse to Date objects, which are values rather than tables.
export function isTable(value: unknown): value is TomlTable {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

// parses grok's config, applies a structural update, and writes it back atomically, keeping the
// previous file as config.toml.bak. comments and formatting are not preserved; grok's own settings
// writer reformats the file the same way.
export function updateGrokConfig(update: (config: TomlTable) => TomlTable): boolean {
	const current = existsSync(paths.grokConfig) ? readFileSync(paths.grokConfig, 'utf8') : '';
	const config = parseConfig(current);
	const next = stringify(update(config));

	if (next === stringify(config)) {
		return false;
	}

	if (current) {
		writeFileSync(`${paths.grokConfig}.bak`, current);
	}

	const temporary = `${paths.grokConfig}.${process.pid}.tmp`;

	writeFileSync(temporary, `${next}\n`);
	renameSync(temporary, paths.grokConfig);

	return true;
}

function parseConfig(text: string): TomlTable {
	try {
		return parse(text);
	} catch (error) {
		throw new AppError(`could not read ${paths.grokConfig}: ${errorMessage(error)}`, 'GROK_CONFIG_INVALID', {
			cause: error,
		});
	}
}
