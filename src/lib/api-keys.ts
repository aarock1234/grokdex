import { z } from 'zod';

import { NotSignedInError } from './errors.ts';
import { Provider } from './providers.ts';
import { readStored, writeStored } from './store.ts';

const API_KEYS_FILE = 'api-keys.json';

const apiKeysSchema = z.partialRecord(z.enum(Provider), z.string());

export function saveApiKey(provider: Provider, apiKey: string): void {
	writeStored(API_KEYS_FILE, {
		...readStored(API_KEYS_FILE, apiKeysSchema),
		[provider]: apiKey,
	});
}

export function readApiKey(provider: Provider): string {
	const apiKey = readStored(API_KEYS_FILE, apiKeysSchema)?.[provider];

	if (!apiKey) {
		throw new NotSignedInError(provider);
	}

	return apiKey;
}
