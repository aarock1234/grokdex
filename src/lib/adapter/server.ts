// loopback adapter between grok's responses backend and the chatgpt plan route.
// it holds no credentials: grok's bearer token passes straight through.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';

import type { Logger } from 'pino';

import { API_BASE } from '../chatgpt/tokens.ts';
import { errorMessage } from '../errors.ts';
import { listen, readBody, sendJson } from '../http.ts';
import { ADAPTER_PORT } from './address.ts';
import { adaptRequest, responsesRequestSchema } from './request.ts';
import type { ResponsesRequest } from './request.ts';
import { responseStream } from './stream.ts';

const SERVICE = 'grokdex';
const TAKEOVER_POLL_MS = 1_000;

export type AdapterOptions = {
	logger: Logger;
	sideModel: string;
};

export function createAdapter(options: AdapterOptions): Server {
	return createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

		if (req.method === 'POST' && path === '/v1/responses') {
			proxy(req, res, options).catch((error: unknown) => {
				options.logger.error({ err: error }, 'proxy failed');

				if (res.headersSent) {
					res.destroy();
					return;
				}

				sendJson(res, 500, { error: { message: 'grokdex adapter error' } });
			});
			return;
		}

		if (req.method === 'GET' && (path === '/' || path === '/healthz')) {
			sendJson(res, 200, { service: SERVICE });
			return;
		}

		sendJson(res, 404, { error: { message: `unsupported route ${req.method ?? ''} ${path}` } });
	});
}

// each grok session hosts its own adapter. the first one serves the port; the rest stand by
// and take over when that session ends.
export async function claimPort(server: Server, logger: Logger, signal: AbortSignal): Promise<void> {
	let isStandingBy = false;

	while (!signal.aborted) {
		try {
			await listen(server, ADAPTER_PORT);
			logger.info({ port: ADAPTER_PORT }, 'listening');
			return;
		} catch (error) {
			if (!isPortInUse(error)) {
				throw error;
			}

			if (!isStandingBy) {
				logger.info({ port: ADAPTER_PORT }, 'port in use, standing by');
				isStandingBy = true;
			}

			await setTimeout(TAKEOVER_POLL_MS, undefined, { signal }).catch(() => undefined);
		}
	}
}

async function proxy(req: IncomingMessage, res: ServerResponse, options: AdapterOptions): Promise<void> {
	const parsed = responsesRequestSchema.safeParse(parseJson(await readBody(req)));

	if (!parsed.success) {
		sendJson(res, 400, { error: { message: 'request body is not a responses request' } });
		return;
	}

	const request = adaptRequest(parsed.data, options.sideModel);
	const log = options.logger.child({
		model: request.model,
		session: request.prompt_cache_key,
	});
	const cancel = new AbortController();

	res.on('close', () => cancel.abort());

	let upstream: Response;

	try {
		upstream = await fetch(`${API_BASE}/responses`, {
			method: 'POST',
			// only what the api needs; grok's x-grok-* session headers stay local
			headers: upstreamHeaders(req, request),
			body: JSON.stringify(request),
			signal: cancel.signal,
		});
	} catch (error) {
		if (cancel.signal.aborted) {
			log.info('cancelled before upstream answered');
			return;
		}

		log.warn({ reason: errorMessage(error) }, 'upstream unreachable');
		sendJson(res, 502, { error: { message: `grokdex could not reach ${API_BASE}` } });
		return;
	}

	const startedAt = Date.now();

	log.info({ status: upstream.status }, 'upstream responded');
	res.on('close', () => {
		log.info(
			{
				durationMs: Date.now() - startedAt,
				isComplete: res.writableFinished,
			},
			'response finished'
		);
	});

	relay(upstream, res, log);
}

// the route can omit content-type; with stream forced on, a successful body is always sse.
function relay(upstream: Response, res: ServerResponse, log: Logger): void {
	const contentType = upstream.headers.get('content-type');
	const isEventStream = upstream.ok && (contentType ?? 'text/event-stream').startsWith('text/event-stream');
	const headers: Record<string, string> = {
		'content-type': isEventStream ? 'text/event-stream' : (contentType ?? 'application/json'),
	};
	const requestId = upstream.headers.get('x-request-id');

	if (requestId) {
		headers['x-request-id'] = requestId;
	}

	res.writeHead(upstream.status, headers);

	if (!upstream.body) {
		res.end();
		return;
	}

	const body = isEventStream
		? upstream.body
				.pipeThrough(new TextDecoderStream())
				.pipeThrough(responseStream({ onUsage: usage => log.info(usage, 'usage') }))
				.pipeThrough(new TextEncoderStream())
		: upstream.body;

	Readable.fromWeb(body)
		.on('error', () => res.destroy())
		.pipe(res);
}

// the plan route only reuses its prompt cache when requests carry a session-id header; without it
// every turn pays for the whole history. grok's prompt_cache_key is its stable session id, so a
// resumed session hits the same cache. grok's other x-grok-* headers stay local.
function upstreamHeaders(req: IncomingMessage, request: ResponsesRequest): Record<string, string> {
	const headers: Record<string, string> = {
		authorization: req.headers.authorization ?? '',
		'content-type': 'application/json',
		accept: 'text/event-stream',
	};
	const sessionId = request.prompt_cache_key ?? firstHeader(req.headers['x-grok-session-id']);

	if (sessionId) {
		headers['session-id'] = sessionId;
	}

	return headers;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
	const first = Array.isArray(value) ? value[0] : value;

	return first === '' ? undefined : first;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isPortInUse(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}
