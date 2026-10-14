import { z } from 'zod';

import { removeBlock, renderBlock, updateGrokConfig, upsertBlock } from './grok/config.ts';
import type { Launcher } from './launcher.ts';
import { Provider } from './providers.ts';
import { readStored, removeStored, writeStored } from './store.ts';

const SETUPS_FILE = 'setups.json';

const modelSchema = z.object({
	slug: z.string(),
	name: z.string(),
	description: z.string().optional(),
	contextWindow: z.number().int().positive().optional(),
	efforts: z.array(
		z.object({
			id: z.string(),
			description: z.string().optional(),
		})
	),
	defaultEffort: z.string().optional(),
});

export type Model = z.infer<typeof modelSchema>;

const setupSchema = z.object({
	provider: z.enum(Provider),
	models: z.array(modelSchema).min(1),
});

export type Setup = z.infer<typeof setupSchema>;

export function readSetups(): Setup[] {
	return readStored(SETUPS_FILE, z.array(setupSchema)) ?? [];
}

// saves one provider's setup, replacing any earlier one, and rewrites grok's config to match.
export function saveSetup(setup: Setup, launcher: Launcher): void {
	const setups = [...readSetups().filter(saved => saved.provider !== setup.provider), setup];

	writeStored(SETUPS_FILE, setups);
	updateGrokConfig(config => upsertBlock(config, renderBlock(setups, launcher)));
}

// removes every setup and grokdex's block from grok's config; reports whether the config changed.
export function clearSetups(): boolean {
	removeStored(SETUPS_FILE);

	return updateGrokConfig(removeBlock);
}
