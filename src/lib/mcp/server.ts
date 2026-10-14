// grok starts stdio mcp servers with every session and stops them when it ends, which is the
// lifetime the adapter needs. this server offers no tools; it only answers the protocol handshake.

import { createInterface } from 'node:readline';

import { z } from 'zod';

const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const METHOD_NOT_FOUND = -32601;

const messageSchema = z.object({
	id: z.union([z.number(), z.string()]).optional(),
	method: z.string(),
	params: z
		.looseObject({
			protocolVersion: z.string().optional(),
		})
		.optional(),
});

type Message = z.infer<typeof messageSchema>;

type RequestId = NonNullable<Message['id']>;

// serves the mcp handshake on stdio and resolves when grok closes stdin.
export function serveMcp(version: string): Promise<void> {
	const closed = Promise.withResolvers<void>();
	const lines = createInterface({ input: process.stdin });

	lines.on('line', line => {
		const message = parseMessage(line);

		if (message?.id === undefined) {
			return;
		}

		respond(message.id, handle(message, version));
	});
	lines.on('close', () => closed.resolve());

	return closed.promise;
}

type Reply = { result: object } | { error: { code: number; message: string } };

function handle(message: Message, version: string): Reply {
	if (message.method === 'initialize') {
		return {
			result: {
				protocolVersion: message.params?.protocolVersion ?? FALLBACK_PROTOCOL_VERSION,
				capabilities: {},
				serverInfo: {
					name: 'grokdex',
					version,
				},
			},
		};
	}

	if (message.method === 'ping') {
		return { result: {} };
	}

	return {
		error: {
			code: METHOD_NOT_FOUND,
			message: `method not found: ${message.method}`,
		},
	};
}

function respond(id: RequestId, reply: Reply): void {
	const envelope = {
		jsonrpc: '2.0',
		id,
		...reply,
	};

	process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function parseMessage(line: string): Message | undefined {
	try {
		return messageSchema.safeParse(JSON.parse(line)).data;
	} catch {
		return undefined;
	}
}
