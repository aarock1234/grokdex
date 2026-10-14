import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { z } from 'zod';

import { openBrowser } from '../browser.ts';
import { SignInError } from '../errors.ts';
import { listen } from '../http.ts';
import { readStored, writeStored } from '../store.ts';
import { verifyIdToken } from './id-token.ts';
import { API_BASE } from '../openai/api.ts';
import { ISSUER, readCredentials, requestTokens, saveCredentials } from './tokens.ts';
import type { Credentials } from './tokens.ts';

const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const AGENT_NAME = 'Grok Build';
const PREFERRED_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
// grok gives an interactive sign-in 300 seconds
const SIGN_IN_TIMEOUT_MS = 280_000;
const HOST_FILE = 'host.json';

const hostSchema = z.object({
	hostId: z.string(),
});

type Callback = {
	code: string;
	clientId: string | undefined;
};

type PkcePair = {
	verifier: string;
	challenge: string;
};

export type SignInOptions = {
	onUrl: (url: string) => void;
	// registers a new client so the user can pick another account; otherwise the saved account is
	// reauthorized, whose id token hint makes openai skip account selection
	isNewAccount?: boolean;
	signal?: AbortSignal;
};

// runs the browser sign-in: registers this host on first use, reuses the saved client after that.
// a successful sign-in to a new account replaces the saved one.
export async function signIn(options: SignInOptions): Promise<Credentials> {
	const existing = options.isNewAccount ? undefined : readCredentials();
	const hostId = readHostId();
	const state = randomToken();
	const nonce = randomToken();
	const pkce = createPkcePair();
	const callback = Promise.withResolvers<Callback>();
	const server = createServer((req, res) => {
		const outcome = handleCallback(new URL(req.url ?? '/', 'http://127.0.0.1'), state);

		res.writeHead(outcome.status, { 'content-type': 'text/html; charset=utf-8' });
		res.end(`<!doctype html><title>grokdex</title><p style="font:16px system-ui;margin:3em">${outcome.page}</p>`);

		if (outcome.error) {
			callback.reject(outcome.error);
		}

		if (outcome.callback) {
			callback.resolve(outcome.callback);
		}
	});

	try {
		const redirectUri = await startCallbackServer(server);
		const authorizeUrl = buildAuthorizeUrl({
			clientId: existing?.clientId,
			hostId,
			redirectUri,
			state,
			nonce,
			challenge: pkce.challenge,
			idTokenHint: existing?.idToken,
			loginHint: existing?.email,
		});

		options.onUrl(authorizeUrl);
		openBrowser(authorizeUrl);

		const result = await waitFor(callback.promise, options.signal);
		const clientId = resolveClientId(existing?.clientId, result.clientId);
		const tokens = await requestTokens(
			{
				grant_type: 'authorization_code',
				client_id: clientId,
				code: result.code,
				code_verifier: pkce.verifier,
				redirect_uri: redirectUri,
				resource: API_BASE,
			},
			options.signal
		);

		if (!tokens.id_token || !tokens.refresh_token) {
			throw new SignInError('token response is missing the id or refresh token');
		}

		const claims = await verifyIdToken(tokens.id_token, {
			clientId,
			nonce,
			signal: options.signal,
		});

		return saveCredentials(tokens, {
			email: claims.email ?? existing?.email ?? '',
			subject: claims.sub,
			clientId,
			hostId,
			idToken: tokens.id_token,
			refreshToken: tokens.refresh_token,
		});
	} finally {
		server.close();
	}
}

type CallbackOutcome = {
	status: number;
	page: string;
	callback?: Callback;
	error?: SignInError;
};

function handleCallback(url: URL, state: string): CallbackOutcome {
	if (url.pathname !== CALLBACK_PATH) {
		return {
			status: 404,
			page: 'Not found.',
		};
	}

	if (url.searchParams.get('state') !== state) {
		return {
			status: 400,
			page: 'Sign-in failed: state mismatch. Close this tab and try again.',
		};
	}

	const error = url.searchParams.get('error');

	if (error) {
		return {
			status: 400,
			page: 'Sign-in was not completed. You can close this tab.',
			error: new SignInError(error === 'access_denied' ? 'sign-in was declined' : `sign-in failed: ${error}`),
		};
	}

	const code = url.searchParams.get('code');

	if (!code) {
		return {
			status: 400,
			page: 'Sign-in failed: missing authorization code.',
		};
	}

	return {
		status: 200,
		page: 'Signed in with ChatGPT. You can close this tab.',
		callback: {
			code,
			clientId: url.searchParams.get('client_id') ?? undefined,
		},
	};
}

// the redirect's scheme, host and path must stay fixed between sign-ins; only the port may change.
async function startCallbackServer(server: Server): Promise<string> {
	let port: number;

	try {
		port = await listen(server, PREFERRED_PORT);
	} catch {
		port = await listen(server, 0);
	}

	return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

type AuthorizeParams = {
	clientId: string | undefined;
	hostId: string;
	redirectUri: string;
	state: string;
	nonce: string;
	challenge: string;
	idTokenHint: string | undefined;
	loginHint: string | undefined;
};

// a first sign-in registers through dynamic_agent_client; later ones reuse the issued client id.
function buildAuthorizeUrl(params: AuthorizeParams): string {
	const query = new URLSearchParams({
		client_id: params.clientId ?? 'dynamic_agent_client',
		ext_agent_host_id: params.hostId,
		response_type: 'code',
		redirect_uri: params.redirectUri,
		scope: SCOPES,
		resource: API_BASE,
		state: params.state,
		nonce: params.nonce,
		code_challenge: params.challenge,
		code_challenge_method: 'S256',
	});

	if (params.idTokenHint) {
		query.set('id_token_hint', params.idTokenHint);
	}

	if (params.loginHint) {
		query.set('login_hint', params.loginHint);
	}

	if (!params.clientId) {
		query.set('agent_name_hint', AGENT_NAME);
	}

	return `${AUTHORIZE_URL}?${query.toString()}`;
}

function resolveClientId(saved: string | undefined, returned: string | undefined): string {
	if (saved && returned && returned !== saved) {
		throw new SignInError(
			'sign-in returned a different client id; run `grokdex remove --sign-out` and set up again'
		);
	}

	const clientId = saved ?? returned;

	if (!clientId) {
		throw new SignInError('registration incomplete: the callback did not include a client id');
	}

	return clientId;
}

async function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	// an abort that already happened fires no event, so check it before listening
	signal?.throwIfAborted();

	const deadline = AbortSignal.timeout(SIGN_IN_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => {
		const isCancelled = signal?.aborted ?? false;

		aborted.reject(isCancelled ? signal?.reason : new SignInError('timed out waiting for the browser sign-in'));
	};

	combined.addEventListener('abort', onAbort, { once: true });

	try {
		return await Promise.race([promise, aborted.promise]);
	} finally {
		combined.removeEventListener('abort', onAbort);
	}
}

// the host id identifies this machine to openai and must stay stable across sign-ins.
function readHostId(): string {
	const saved = readStored(HOST_FILE, hostSchema);

	if (saved) {
		return saved.hostId;
	}

	const hostId = `urn:uuid:${randomUUID()}`;

	writeStored(HOST_FILE, { hostId });

	return hostId;
}

function createPkcePair(): PkcePair {
	const verifier = randomBytes(64).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');

	return {
		verifier,
		challenge,
	};
}

function randomToken(): string {
	return randomBytes(32).toString('base64url');
}
