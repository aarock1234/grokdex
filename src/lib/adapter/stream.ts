import { z } from 'zod';

const streamEventSchema = z.looseObject({
	type: z.string(),
	output_index: z.number().optional(),
	item: z.unknown().optional(),
	response: z
		.looseObject({
			output: z.array(z.unknown()).default([]),
		})
		.optional(),
});

type StreamEvent = z.infer<typeof streamEventSchema>;

const TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete']);

// the plan route streams each item through response.output_item.done but ends with an empty
// output because nothing is stored. grok treats that final output as the whole answer, sees
// nothing and retries forever, so rebuild it from the items the stream already delivered.
export function backfillTerminalOutput(): TransformStream<string, string> {
	const items: unknown[] = [];
	let buffer = '';

	return new TransformStream({
		transform(chunk, controller) {
			buffer += chunk.replaceAll('\r\n', '\n');

			let end = buffer.indexOf('\n\n');

			while (end !== -1) {
				controller.enqueue(`${rewriteBlock(buffer.slice(0, end), items)}\n\n`);
				buffer = buffer.slice(end + 2);
				end = buffer.indexOf('\n\n');
			}
		},
		flush(controller) {
			if (buffer) {
				controller.enqueue(rewriteBlock(buffer, items));
			}
		},
	});
}

// records streamed items and fills an empty terminal output; every other block passes through as is.
function rewriteBlock(block: string, items: unknown[]): string {
	const dataLine = block.split('\n').find(line => line.startsWith('data: '));

	if (!dataLine) {
		return block;
	}

	const event = parseEvent(dataLine.slice('data: '.length));

	if (!event) {
		return block;
	}

	if (event.type === 'response.output_item.done' && event.output_index !== undefined) {
		items[event.output_index] = event.item;
		return block;
	}

	const isEmptyTerminal = TERMINAL_EVENTS.has(event.type) && event.response?.output.length === 0;

	if (!isEmptyTerminal || !event.response) {
		return block;
	}

	const backfilled = {
		...event,
		response: {
			...event.response,
			output: items.filter(item => item !== undefined),
		},
	};

	return block.replace(dataLine, `data: ${JSON.stringify(backfilled)}`);
}

function parseEvent(json: string): StreamEvent | undefined {
	try {
		return streamEventSchema.safeParse(JSON.parse(json)).data;
	} catch {
		return undefined;
	}
}
