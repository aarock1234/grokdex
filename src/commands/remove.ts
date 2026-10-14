import { rmSync } from 'node:fs';

import { readCredentials, signOut } from '../lib/chatgpt/tokens.ts';
import { paths } from '../lib/config/env.ts';
import { clearSetups } from '../lib/setups.ts';

export type RemoveOptions = {
	shouldSignOut: boolean;
	signal: AbortSignal;
};

// removes grokdex from grok's config; signing out also revokes access and deletes saved credentials.
export async function remove(options: RemoveOptions): Promise<void> {
	const isConfigChanged = clearSetups();

	console.log(isConfigChanged ? `removed grokdex from ${paths.grokConfig}` : 'grokdex was not in your grok config');

	if (!options.shouldSignOut) {
		return;
	}

	if (readCredentials()) {
		await signOut(options.signal);
	}

	rmSync(paths.dataDir, {
		recursive: true,
		force: true,
	});
	console.log(`signed out and deleted ${paths.dataDir}`);
}
