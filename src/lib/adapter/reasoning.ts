// reasoning items carry encrypted content that only the provider that produced them can read. after
// a mid-session switch from a grok model, grok replays xai's reasoning to openai, which rejects the
// whole request. openai names the item it rejected, so learn those ids and drop them from then on.

import { z } from 'zod';

import { parseJsonOrUndefined } from '../json.ts';
import type { ResponsesRequest } from './request.ts';

const REJECTED_CODE = 'invalid_encrypted_content';
// the item id only appears in the message: "The encrypted content for item rs_... could not be verified."
const REJECTED_ITEM = /item (\S+) could not be verified/;

const errorSchema = z.object({
	error: z.object({
		code: z.string().nullable(),
		message: z.string(),
	}),
});

export const Rejection = {
	// the rejected item is known and remembered for later requests
	ITEM: 'item',
	// openai rejected some reasoning but did not name it, so drop all of it from this request
	UNKNOWN_ITEM: 'unknown-item',
} as const;

export type Rejection = (typeof Rejection)[keyof typeof Rejection];

export class RejectedReasoning {
	private readonly ids = new Set<string>();

	// reads an error body from openai; returns how to retry, or undefined when it is some other error.
	learnFrom(errorBody: string): Rejection | undefined {
		const error = errorSchema.safeParse(parseJsonOrUndefined(errorBody)).data?.error;

		if (error?.code !== REJECTED_CODE) {
			return undefined;
		}

		const id = REJECTED_ITEM.exec(error.message)?.[1];

		if (!id) {
			return Rejection.UNKNOWN_ITEM;
		}

		this.ids.add(id);

		return Rejection.ITEM;
	}

	// drops every reasoning item openai has rejected before.
	strip(request: ResponsesRequest): ResponsesRequest {
		return withoutReasoning(request, item => typeof item.id === 'string' && this.ids.has(item.id));
	}
}

export function withoutAllReasoning(request: ResponsesRequest): ResponsesRequest {
	return withoutReasoning(request, () => true);
}

type InputItem = Exclude<ResponsesRequest['input'], string | undefined>[number];

function withoutReasoning(request: ResponsesRequest, shouldDrop: (item: InputItem) => boolean): ResponsesRequest {
	if (!Array.isArray(request.input)) {
		return request;
	}

	return {
		...request,
		input: request.input.filter(item => !(item.type === 'reasoning' && shouldDrop(item))),
	};
}
