import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { text } from 'node:stream/consumers';

import type { z } from 'zod';

import { HttpError } from './errors.ts';

const DEFAULT_TIMEOUT_MS = 20_000;
const ERROR_BODY_LIMIT = 300;

export type RequestOptions = {
	method?: string;
	headers?: RequestInit['headers'];
	body?: RequestInit['body'];
	signal?: AbortSignal;
	timeoutMs?: number;
};

// fetches and validates a json response; owns the deadline and the response body.
export async function requestJson<Schema extends z.ZodType>(
	schema: Schema,
	url: string,
	options: RequestOptions = {}
): Promise<z.output<Schema>> {
	const response = await request(url, options);
	const data: unknown = await response.json();

	return schema.parse(data);
}

// sends a request whose successful response has no body worth reading.
export async function requestOk(url: string, options: RequestOptions = {}): Promise<void> {
	const response = await request(url, options);

	await response.body?.cancel();
}

async function request(url: string, options: RequestOptions): Promise<Response> {
	const deadline = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

	const response = await fetch(url, {
		method: options.method ?? 'GET',
		headers: options.headers,
		body: options.body,
		signal,
		redirect: 'error',
	});

	if (!response.ok) {
		const body = await response.text();

		throw new HttpError(response.status, body.slice(0, ERROR_BODY_LIMIT));
	}

	return response;
}

// listens on loopback only and resolves with the bound port.
export function listen(server: Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => {
			server.off('error', reject);

			const address = server.address();

			resolve(typeof address === 'object' && address ? address.port : port);
		});
	});
}

export function readBody(req: IncomingMessage): Promise<string> {
	return text(req);
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}
