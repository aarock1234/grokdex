import { z } from 'zod';

import { readApiKey } from '../lib/api-keys.ts';
import { accessToken } from '../lib/chatgpt/access-token.ts';
import type { AccessToken } from '../lib/chatgpt/access-token.ts';
import { env } from '../lib/config/env.ts';
import { UsageError } from '../lib/errors.ts';
import { Provider } from '../lib/providers.ts';

const providerSchema = z.enum(Provider);

// grok's auth_provider command: prints a token as json on stdout.
export async function token(providerArg: string | undefined, signal: AbortSignal): Promise<void> {
	const parsed = providerSchema.safeParse(providerArg);

	if (!parsed.success) {
		throw new UsageError(`unknown provider: ${providerArg ?? '(none)'}`);
	}

	const result = await tokenFor(parsed.data, signal);

	process.stdout.write(JSON.stringify(result));
}

async function tokenFor(provider: Provider, signal: AbortSignal): Promise<AccessToken | { access_token: string }> {
	switch (provider) {
		case Provider.CHATGPT:
			return accessToken({
				isHeadless: env.GROK_AUTH_EXPIRED,
				signal,
			});
		case Provider.OPENAI:
			return { access_token: readApiKey(Provider.OPENAI) };
		default: {
			const exhaustive: never = provider;
			throw new Error(`unhandled provider: ${String(exhaustive)}`);
		}
	}
}
