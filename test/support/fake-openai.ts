// a stand-in for the chatgpt plan route, built from its behavior as measured against the live api:
// the same rejections and error bodies, no content-type on streams, sequence numbers on every event,
// and an empty terminal output. it scripts replies so tests can drive grok through a conversation.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { text } from 'node:stream/consumers';

import { z } from 'zod';

export const FAKE_TOKEN = 'grokdex-test-token';
export const FAKE_REPLY = 'fake plan route says hi';
export const TOOL_TRIGGER = 'run the grokdex tool check';
export const TOOL_MARKER = 'grokdex-tool-ok';

// top-level request fields verified as accepted by the live plan route. anything else grok starts
// sending fails the run, so it gets checked against the real api before anyone relies on it.
const VERIFIED_FIELDS = new Set([
	'include',
	'input',
	'max_output_tokens',
	'model',
	'parallel_tool_calls',
	'prompt_cache_key',
	'reasoning',
	'store',
	'stream',
	'tool_choice',
	'tools',
]);

const catalog = readFileSync(new URL('../fixtures/catalog.json', import.meta.url), 'utf8');

const inputItemSchema = z.looseObject({
	type: z.string().optional(),
	role: z.string().optional(),
	content: z.unknown().optional(),
	output: z.unknown().optional(),
	encrypted_content: z.string().optional(),
});

const toolSchema = z.looseObject({
	name: z.string().optional(),
	parameters: z
		.looseObject({
			properties: z.record(z.string(), z.looseObject({ type: z.unknown().optional() })).optional(),
			required: z.array(z.string()).optional(),
		})
		.optional(),
});

const requestSchema = z.looseObject({
	model: z.string(),
	input: z.array(inputItemSchema).default([]),
	store: z.unknown().optional(),
	stream: z.unknown().optional(),
	tools: z.array(toolSchema).default([]),
	tool_choice: z.unknown().optional(),
	prompt_cache_key: z.string().optional(),
});

type ResponsesRequest = z.infer<typeof requestSchema>;
type Tool = z.infer<typeof toolSchema>;

export type RecordedRequest = {
	model: string;
	sessionId: string | undefined;
	promptCacheKey: string | undefined;
	fields: string[];
	body: ResponsesRequest;
};

type Reply = { kind: 'text'; text: string } | { kind: 'call'; name: string; arguments: Record<string, unknown> };

export class FakeOpenAi {
	readonly requests: RecordedRequest[] = [];
	readonly rejections: string[] = [];
	private readonly server: Server = createServer((req, res) => {
		this.handle(req, res).catch((error: unknown) => {
			res.writeHead(500).end(String(error));
		});
	});

	async start(): Promise<string> {
		await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));

		const address = this.server.address();

		if (typeof address !== 'object' || address === null) {
			throw new Error('fake openai did not bind a port');
		}

		return `http://127.0.0.1:${address.port}/v1`;
	}

	async stop(): Promise<void> {
		this.server.closeAllConnections();
		await new Promise<void>(resolve => this.server.close(() => resolve()));
	}

	reset(): void {
		this.requests.length = 0;
		this.rejections.length = 0;
	}

	// requests for the model a test chose, leaving out grok's side calls such as titles
	requestsFor(model: string): RecordedRequest[] {
		return this.requests.filter(request => request.model === model);
	}

	// the main conversation: requests sharing the cache key of the first one that carries grok's tools.
	// grok's side calls, such as turn summaries, use the same model under their own cache keys.
	conversation(model: string): RecordedRequest[] {
		const requests = this.requestsFor(model);
		const first = requests.find(request => request.body.tools.length > 0);

		if (!first) {
			return [];
		}

		return requests.filter(request => request.promptCacheKey === first.promptCacheKey);
	}

	// one line per recorded request, for readable assertion failures
	describe(): string {
		return this.requests
			.map(request => {
				const toolChoice = JSON.stringify(request.body.tool_choice ?? null);

				return `${request.model} key=${request.promptCacheKey ?? '-'} session=${request.sessionId ?? '-'} tools=${request.body.tools.length} tool_choice=${toolChoice} items=${request.body.input.length}`;
			})
			.join('\n');
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
			sendJson(res, 401, { error: { message: 'invalid token' } });
			return;
		}

		if (req.method === 'GET' && req.url === '/v1/models') {
			res.writeHead(200, { 'content-type': 'application/json' }).end(catalog);
			return;
		}

		if (req.method !== 'POST' || req.url !== '/v1/responses') {
			sendJson(res, 404, { error: { message: `no route ${req.method ?? ''} ${req.url ?? ''}` } });
			return;
		}

		const raw: unknown = JSON.parse(await text(req));
		const body = requestSchema.parse(raw);
		const rejection = rejectionFor(raw, body);

		if (rejection) {
			this.rejections.push(rejection.reason);
			sendJson(res, 400, rejection.body);
			return;
		}

		this.requests.push({
			model: body.model,
			sessionId: firstHeader(req.headers['session-id']),
			promptCacheKey: body.prompt_cache_key,
			fields: Object.keys(raw as object),
			body,
		});
		streamReply(res, body.model, scriptReply(body));
	}
}

type Rejection = {
	reason: string;
	body: unknown;
};

// the plan route's rejections, with the error bodies it actually returns.
function rejectionFor(raw: unknown, body: ResponsesRequest): Rejection | undefined {
	const unverified = Object.keys(raw as object).filter(field => !VERIFIED_FIELDS.has(field));

	if (unverified.length > 0) {
		return {
			reason: `unverified fields: ${unverified.join(', ')}`,
			body: { detail: `Unsupported parameter: ${unverified[0] ?? ''}` },
		};
	}

	if (body.store !== false) {
		return {
			reason: 'store was not false',
			body: { detail: 'Store must be set to false' },
		};
	}

	if (body.input.some(item => item.role === 'system')) {
		return {
			reason: 'system message',
			body: { detail: 'System messages are not allowed' },
		};
	}

	const foreign = body.input.find(item => item.type === 'reasoning' && !item.encrypted_content?.startsWith('gAAAAA'));

	if (foreign) {
		return {
			reason: 'foreign encrypted reasoning',
			body: {
				error: {
					message: 'The encrypted content for item rs_x could not be verified.',
					type: 'invalid_request_error',
					param: null,
					code: 'invalid_encrypted_content',
				},
			},
		};
	}

	return undefined;
}

// picks the next turn: a forced tool call (grok's titles), the result of a tool the test asked for,
// a call to grok's terminal tool when the prompt asks for it, or a plain reply.
function scriptReply(body: ResponsesRequest): Reply {
	const forced = z.object({ type: z.literal('function'), name: z.string() }).safeParse(body.tool_choice).data;

	if (forced) {
		return callTool(body.tools, forced.name, {});
	}

	const toolOutput = body.input.find(item => item.type === 'function_call_output');

	if (toolOutput) {
		return {
			kind: 'text',
			text: `tool said: ${JSON.stringify(toolOutput.output)}`,
		};
	}

	if (JSON.stringify(body.input).includes(TOOL_TRIGGER)) {
		return callTool(body.tools, 'run_terminal_command', { command: `echo ${TOOL_MARKER}` });
	}

	return {
		kind: 'text',
		text: FAKE_REPLY,
	};
}

// fills every required argument of the tool's own schema, so the call stays valid as grok's tools change.
function callTool(tools: Tool[], name: string, given: Record<string, unknown>): Reply {
	const tool = tools.find(candidate => candidate.name === name);

	if (!tool) {
		const offered = tools.map(candidate => candidate.name).join(', ');

		return {
			kind: 'text',
			text: `grok no longer offers ${name}; it offers: ${offered}`,
		};
	}

	const properties = tool.parameters?.properties ?? {};
	const filled = Object.fromEntries(
		(tool.parameters?.required ?? []).map(key => [key, given[key] ?? placeholderFor(properties[key]?.type)])
	);

	return {
		kind: 'call',
		name,
		arguments: {
			...filled,
			...given,
		},
	};
}

function placeholderFor(type: unknown): unknown {
	if (type === 'number' || type === 'integer') {
		return 30_000;
	}

	if (type === 'boolean') {
		return false;
	}

	if (type === 'array') {
		return [];
	}

	if (type === 'object') {
		return {};
	}

	return 'grokdex test';
}

// streams a reply the way the plan route does: no content-type header, a sequence number on every
// event, items delivered through output_item.done, and an empty output on response.completed.
function streamReply(res: ServerResponse, model: string, reply: Reply): void {
	let sequence = 0;
	const send = (event: Record<string, unknown>): void => {
		res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence })}\n\n`);
		sequence += 1;
	};
	const response = {
		id: `resp_${Date.now()}`,
		object: 'response',
		model,
		created_at: Math.floor(Date.now() / 1000),
		status: 'completed',
		output: [],
		usage: {
			input_tokens: 100,
			output_tokens: 10,
			total_tokens: 110,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens_details: { reasoning_tokens: 0 },
		},
	};
	const item = itemFor(reply);

	res.writeHead(200);
	send({ type: 'response.created', response: { ...response, status: 'in_progress' } });
	// the plan route sends these while the model thinks; they are not standard responses events
	send({ type: 'keepalive' });
	send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } });

	for (const event of deltaEvents(reply)) {
		send(event);
	}

	send({ type: 'response.output_item.done', output_index: 0, item });
	send({ type: 'response.completed', response });
	res.end();
}

// the incremental events the real route sends before an item is done
function deltaEvents(reply: Reply): Record<string, unknown>[] {
	if (reply.kind === 'call') {
		const args = JSON.stringify(reply.arguments);

		return [
			{ type: 'response.function_call_arguments.delta', item_id: 'fc_test', output_index: 0, delta: args },
			{ type: 'response.function_call_arguments.done', item_id: 'fc_test', output_index: 0, arguments: args },
		];
	}

	return [
		{
			type: 'response.output_text.delta',
			item_id: 'msg_test',
			output_index: 0,
			content_index: 0,
			delta: reply.text,
		},
		{ type: 'response.output_text.done', item_id: 'msg_test', output_index: 0, content_index: 0, text: reply.text },
	];
}

function itemFor(reply: Reply): Record<string, unknown> {
	if (reply.kind === 'call') {
		return {
			type: 'function_call',
			id: 'fc_test',
			call_id: `call_${Date.now()}`,
			name: reply.name,
			arguments: JSON.stringify(reply.arguments),
			status: 'completed',
		};
	}

	return {
		type: 'message',
		id: 'msg_test',
		role: 'assistant',
		status: 'completed',
		content: [
			{
				type: 'output_text',
				text: reply.text,
				annotations: [],
			},
		],
	};
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}
