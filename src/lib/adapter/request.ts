import { z } from 'zod';

// fields the plan route rejects, per openai's preview limitations.
const UNSUPPORTED_FIELDS = [
	'background',
	'conversation',
	'max_output_tokens',
	'max_tool_calls',
	'metadata',
	'moderation',
	'multi_agent',
	'previous_response_id',
	'prompt',
	'prompt_cache_retention',
	'safety_identifier',
	'temperature',
	'top_logprobs',
	'top_p',
	'truncation',
	'user',
] as const;

const inputItemSchema = z.looseObject({
	role: z.string().optional(),
});

// grok's request is forwarded untouched apart from the fields adaptRequest rewrites.
export const responsesRequestSchema = z.looseObject({
	model: z.string(),
	input: z.union([z.string(), z.array(inputItemSchema)]).optional(),
});

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

// grok sends system messages and, on side calls, sampling fields and grok model names;
// the plan route rejects all three.
export function adaptRequest(request: ResponsesRequest, sideModel: string): ResponsesRequest {
	const adapted: ResponsesRequest = {
		...request,
		store: false,
		stream: true,
	};

	for (const field of UNSUPPORTED_FIELDS) {
		delete adapted[field];
	}

	if (Array.isArray(adapted.input)) {
		adapted.input = adapted.input.map(item => (item.role === 'system' ? { ...item, role: 'developer' } : item));
	}

	if (adapted.model.startsWith('grok-')) {
		adapted.model = sideModel;
	}

	return adapted;
}
