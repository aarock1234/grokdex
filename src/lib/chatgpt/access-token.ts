import { HttpError, NotSignedInError } from '../errors.ts';
import { withLock } from '../lock.ts';
import { signIn } from './sign-in.ts';
import { nowSeconds, readCredentials, refreshCredentials } from './tokens.ts';
import type { Credentials } from './tokens.ts';

const REFRESH_MARGIN_SECONDS = 300;
const RECENT_REFRESH_SECONDS = 60;

export type AccessToken = {
	access_token: string;
	expires_in: number;
};

export type AccessTokenOptions = {
	// grok's silent refresh: never prompt, and never hand back the token grok already holds.
	isHeadless: boolean;
	signal?: AbortSignal;
};

// returns a usable token in grok's auth_provider format, refreshing or signing in when needed.
export async function accessToken(options: AccessTokenOptions): Promise<AccessToken> {
	const credentials = (await currentCredentials(options)) ?? (await interactiveSignIn(options));

	return {
		access_token: credentials.accessToken,
		expires_in: Math.max(credentials.expiresAt - nowSeconds(), 0),
	};
}

async function currentCredentials(options: AccessTokenOptions): Promise<Credentials | undefined> {
	if (!readCredentials()) {
		return undefined;
	}

	return withLock('chatgpt-refresh', async () => {
		// another grok session may have refreshed while this one waited for the lock
		const credentials = readCredentials();

		if (!credentials) {
			return undefined;
		}

		if (!shouldRefresh(credentials, options.isHeadless)) {
			return credentials;
		}

		try {
			return await refreshCredentials(credentials, options.signal);
		} catch (error) {
			// only a rejected grant means signing in again; cancellation and network failures propagate
			if (isRejectedGrant(error)) {
				return undefined;
			}

			throw error;
		}
	});
}

function isRejectedGrant(error: unknown): boolean {
	return error instanceof HttpError && (error.status === 400 || error.status === 401);
}

function shouldRefresh(credentials: Credentials, isHeadless: boolean): boolean {
	const now = nowSeconds();
	const isExpiring = credentials.expiresAt - now <= REFRESH_MARGIN_SECONDS;
	const isTooEarly = credentials.earliestRefreshAt !== undefined && now < credentials.earliestRefreshAt;
	const wasJustRefreshed = now - Date.parse(credentials.savedAt) / 1000 < RECENT_REFRESH_SECONDS;

	if (isExpiring) {
		return true;
	}

	return isHeadless && !isTooEarly && !wasJustRefreshed;
}

// grok shows this command's stderr during an interactive sign-in, so the url goes there.
async function interactiveSignIn(options: AccessTokenOptions): Promise<Credentials> {
	if (options.isHeadless) {
		throw new NotSignedInError('chatgpt');
	}

	return signIn({
		onUrl: url => console.error(`sign in with chatgpt: ${url}`),
		signal: options.signal,
	});
}
