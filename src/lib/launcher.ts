import { existsSync } from 'node:fs';
import { delimiter, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from './config/env.ts';

// how grok runs grokdex for tokens and for the adapter.
export type Launcher = {
	command: string;
	args: readonly string[];
};

// an install from npm runs the same pinned version through the package runner that installed it;
// a checkout runs its entry file directly with this node.
export function resolveLauncher(entryUrl: string, version: string): Launcher {
	const entry = fileURLToPath(entryUrl);

	if (!entry.includes(`${sep}node_modules${sep}`)) {
		return {
			command: process.execPath,
			args: [entry],
		};
	}

	const isPnpm = env.npm_config_user_agent?.startsWith('pnpm/') ?? false;
	const runner = isPnpm ? 'pnpm' : 'npx';
	const args = isPnpm ? ['dlx', `grokdex@${version}`] : ['-y', `grokdex@${version}`];

	return {
		command: findExecutable(runner) ?? runner,
		args,
	};
}

// grok's credential helper does not apply PATHEXT on windows, so write the runner's full path,
// such as npx.cmd, instead of a bare name.
function findExecutable(name: string): string | undefined {
	const extensions = process.platform === 'win32' ? env.PATHEXT.split(';') : [''];
	const directories = env.PATH.split(delimiter).filter(Boolean);

	for (const directory of directories) {
		for (const extension of extensions) {
			const candidate = join(directory, `${name}${extension.toLowerCase()}`);

			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}

	return undefined;
}
