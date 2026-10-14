import { readCredentials } from '../lib/chatgpt/tokens.ts';
import { paths } from '../lib/config/env.ts';
import { PROVIDERS, Provider, modelKey } from '../lib/providers.ts';
import { readSetups } from '../lib/setups.ts';

export function status(): void {
	const setups = readSetups();

	if (setups.length === 0) {
		console.log('nothing connected (run: grokdex setup)');
		return;
	}

	for (const setup of setups) {
		const account = setup.provider === Provider.CHATGPT ? ` as ${readCredentials()?.email ?? 'unknown'}` : '';

		console.log(`${PROVIDERS[setup.provider].label}${account}`);

		for (const model of setup.models) {
			console.log(`  ${modelKey(setup.provider, model.slug)}`);
		}
	}

	console.log(`\nconfig: ${paths.grokConfig}`);
	console.log(`data:   ${paths.dataDir}`);
}
