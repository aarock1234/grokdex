import { z } from 'zod';

const usageSchema = z.object({
	input_tokens: z.number(),
	output_tokens: z.number(),
	input_tokens_details: z
		.object({
			cached_tokens: z.number().default(0),
		})
		.optional(),
});

const streamEventSchema = z.looseObject({
	type: z.string(),
	output_index: z.number().optional(),
	item: z.unknown().optional(),
	response: z
		.looseObject({
			output: z.array(z.unknown()).default([]),
			usage: usageSchema.optional(),
		})
		.optional(),
});

// the shape needed to rewrite a terminal event; loose objects with no transforms keep every
// other field exactly as the route sent it.
const terminalEnvelopeSchema = z.looseObject({
	response: z.looseObject({}),
});

export type Usage = {
	inputTokens: number;
	cachedTokens: number;
	outputTokens: number;
};

export type ResponseStreamOptions = {
	onUsage: (usage: Usage) => void;
};

type StreamState = {
	items: unknown[];
	options: ResponseStreamOptions;
};

const TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete']);

// passes the plan route's sse stream through to grok, fixing its terminal output and reporting usage.
export function responseStream(options: ResponseStreamOptions): TransformStream<string, string> {
	const state: StreamState = {
		items: [],
		options,
	};
	let buffer = '';

	return new TransformStream({
		transform(chunk, controller) {
			buffer += chunk.replaceAll('\r\n', '\n');

			let end = buffer.indexOf('\n\n');

			while (end !== -1) {
				controller.enqueue(`${processBlock(buffer.slice(0, end), state)}\n\n`);
				buffer = buffer.slice(end + 2);
				end = buffer.indexOf('\n\n');
			}
		},
		flush(controller) {
			if (buffer) {
				controller.enqueue(processBlock(buffer, state));
			}
		},
	});
}

// records streamed items and handles the terminal event; every other block passes through as is.
function processBlock(block: string, state: StreamState): string {
	const dataLine = block.split('\n').find(line => line.startsWith('data: '));

	if (!dataLine) {
		return block;
	}

	const raw = parseJson(dataLine.slice('data: '.length));
	const event = streamEventSchema.safeParse(raw).data;

	if (!event) {
		return block;
	}

	if (event.type === 'response.output_item.done' && event.output_index !== undefined) {
		state.items[event.output_index] = event.item;
		return block;
	}

	if (!TERMINAL_EVENTS.has(event.type) || !event.response) {
		return block;
	}

	reportUsage(event.response.usage, state.options);

	if (event.response.output.length > 0) {
		return block;
	}

	return block.replace(dataLine, `data: ${JSON.stringify(backfillOutput(raw, state.items))}`);
}

// the plan route streams each item through response.output_item.done but ends with an empty
// output because nothing is stored. grok treats that final output as the whole answer, sees
// nothing and retries forever, so rebuild it from the items the stream already delivered.
// rewrites the original event rather than the parsed one, so fields the schemas don't declare,
// such as usage.output_tokens_details, reach grok untouched.
function backfillOutput(raw: unknown, items: readonly unknown[]): unknown {
	const terminal = terminalEnvelopeSchema.parse(raw);

	return {
		...terminal,
		response: {
			...terminal.response,
			output: items.filter(item => item !== undefined),
		},
	};
}

function reportUsage(usage: z.infer<typeof usageSchema> | undefined, options: ResponseStreamOptions): void {
	if (!usage) {
		return;
	}

	options.onUsage({
		inputTokens: usage.input_tokens,
		cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
		outputTokens: usage.output_tokens,
	});
}

function parseJson(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		return undefined;
	}
}
