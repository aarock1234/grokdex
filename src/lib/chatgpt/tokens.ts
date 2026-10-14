// token endpoint and stored credentials for sign in with chatgpt plan usage:
// https://developers.openai.com/siwc/token-sharing-open-source

import { z } from 'zod';

import { NotSignedInError, SignInError } from '../errors.ts';
import { requestJson, requestOk } from '../http.ts';
import { readStored, removeStored, writeStored } from '../store.ts';

export const ISSUER = 'https://auth.openai.com';
export const API_BASE = 'https://api.openai.com/v1';

const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const CREDENTIALS_FILE = 'chatgpt.json';

const credentialsSchema = z.object({
	email: z.string(),
	subject: z.string(),
	clientId: z.string(),
	hostId: z.string(),
	idToken: z.string(),
	accessToken: z.string(),
	refreshToken: z.string(),
	expiresAt: z.number(),
	earliestRefreshAt: z.number().optional(),
	scopes: z.array(z.string()),
	savedAt: z.iso.datetime(),
});

export type Credentials = z.infer<typeof credentialsSchema>;

// the identity half of a credential record, which survives token refreshes.
export type Identity = Pick<Credentials, 'email' | 'subject' | 'clientId' | 'hostId' | 'idToken' | 'refreshToken'>;

const tokenResponseSchema = z.object({
	access_token: z.string(),
	refresh_token: z.string().optional(),
	id_token: z.string().optional(),
	expires_in: z.number(),
	scope: z.string().default(''),
	earliest_refresh_at: z.union([z.number(), z.string()]).optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

const discoverySchema = z.object({
	jwks_uri: z.url(),
	revocation_endpoint: z.url().optional(),
});

export type Discovery = z.infer<typeof discoverySchema>;

export function readCredentials(): Credentials | undefined {
	return readStored(CREDENTIALS_FILE, credentialsSchema);
}

// stores a token response, refusing one that lacks the chatgpt plan scope.
export function saveCredentials(tokens: TokenResponse, identity: Identity): Credentials {
	const scopes = tokens.scope.split(/\s+/).filter(Boolean).sort();

	if (!scopes.includes(PLAN_SCOPE)) {
		throw new SignInError(`chatgpt plan usage was not granted (scopes: ${scopes.join(' ') || 'none'})`);
	}

	const credentials: Credentials = {
		...identity,
		idToken: tokens.id_token ?? identity.idToken,
		refreshToken: tokens.refresh_token ?? identity.refreshToken,
		accessToken: tokens.access_token,
		expiresAt: nowSeconds() + tokens.expires_in,
		earliestRefreshAt: toEpochSeconds(tokens.earliest_refresh_at),
		scopes,
		savedAt: new Date().toISOString(),
	};

	writeStored(CREDENTIALS_FILE, credentials);

	return credentials;
}

export function requestTokens(form: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
	return requestJson(tokenResponseSchema, TOKEN_URL, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'application/json',
		},
		body: new URLSearchParams(form),
		signal,
	});
}

export async function refreshCredentials(credentials: Credentials, signal?: AbortSignal): Promise<Credentials> {
	const tokens = await requestTokens(
		{
			grant_type: 'refresh_token',
			client_id: credentials.clientId,
			refresh_token: credentials.refreshToken,
			resource: API_BASE,
		},
		signal
	);

	return saveCredentials(tokens, credentials);
}

export function discover(signal?: AbortSignal): Promise<Discovery> {
	return requestJson(discoverySchema, `${ISSUER}/.well-known/openid-configuration`, { signal });
}

// revokes the refresh token, then forgets the credentials; the host id stays with this machine.
export async function signOut(signal?: AbortSignal): Promise<void> {
	const credentials = readCredentials();

	if (!credentials) {
		throw new NotSignedInError('chatgpt');
	}

	const { revocation_endpoint: revocationEndpoint } = await discover(signal);

	if (revocationEndpoint) {
		await requestOk(revocationEndpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				token: credentials.refreshToken,
				token_type_hint: 'refresh_token',
				client_id: credentials.clientId,
			}),
			signal,
		});
	}

	removeStored(CREDENTIALS_FILE);
}

export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function toEpochSeconds(value: number | string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value === 'number') {
		return value > 1e12 ? Math.floor(value / 1000) : value;
	}

	const parsed = Date.parse(value);

	return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}
