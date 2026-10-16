import { z } from 'zod';

import { parseJsonOrUndefined } from '../json.ts';
import { isGrokEvent } from './grok-events.ts';

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

// everything one stream remembers between chunks.
type StreamState = {
	buffer: string;
	items: unknown[];
	onUsage: ResponseStreamOptions['onUsage'];
};

const TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete']);

// passes the plan route's sse stream through to grok, fixing its terminal output and reporting usage.
export function responseStream(options: ResponseStreamOptions): TransformStream<string, string> {
	const state: StreamState = {
		buffer: '',
		items: [],
		onUsage: options.onUsage,
	};

	return new TransformStream({
		transform(chunk, controller) {
			// normalize after joining, so a \r\n split across chunks still becomes \n
			state.buffer = `${state.buffer}${chunk}`.replaceAll('\r\n', '\n');

			let end = state.buffer.indexOf('\n\n');

			while (end !== -1) {
				controller.enqueue(`${processBlock(state.buffer.slice(0, end), state)}\n\n`);
				state.buffer = state.buffer.slice(end + 2);
				end = state.buffer.indexOf('\n\n');
			}
		},
		flush(controller) {
			if (state.buffer) {
				controller.enqueue(processBlock(state.buffer, state));
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

	const raw = parseJsonOrUndefined(dataLine.slice('data: '.length));
	const event = streamEventSchema.safeParse(raw).data;

	if (!event) {
		return block;
	}

	// grok rejects unknown event types, including response.metadata and keepalive. comments
	// preserve keepalive traffic without sending unsupported events to its deserializer.
	if (!isGrokEvent(event.type)) {
		return `: ${event.type}`;
	}

	if (event.type === 'response.output_item.done' && event.output_index !== undefined) {
		state.items[event.output_index] = event.item;
		return block;
	}

	if (!TERMINAL_EVENTS.has(event.type) || !event.response) {
		return block;
	}

	reportUsage(event.response.usage, state.onUsage);

	if (event.response.output.length > 0) {
		return block;
	}

	// a replacer function, so `$` sequences in model output are never treated as patterns
	return block.replace(dataLine, () => `data: ${JSON.stringify(backfillOutput(raw, state.items))}`);
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

function reportUsage(usage: z.infer<typeof usageSchema> | undefined, onUsage: StreamState['onUsage']): void {
	if (!usage) {
		return;
	}

	onUsage({
		inputTokens: usage.input_tokens,
		cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
		outputTokens: usage.output_tokens,
	});
}
