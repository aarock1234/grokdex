// reasoning items carry encrypted content that only the provider that produced them can read. after
// a mid-session switch from a grok model, grok replays xai's reasoning to openai, which rejects the
// whole request. adaptForeignReasoning rewrites those items up front, keeping their readable thinking;
// RejectedReasoning is the safety net that learns from openai's rejection if one ever gets through.

import { z } from 'zod';

import { parseJsonOrUndefined } from '../json.ts';
import type { ResponsesRequest } from './request.ts';

// openai's encrypted reasoning is a fernet token: url-safe base64 whose first byte is the version
// marker 0x80, so it always starts with "gAAAAA". xai's is standard base64 with no such header.
const FERNET_VERSION = 0x80;
const URL_SAFE_BASE64 = /^[A-Za-z0-9_-]+=*$/;

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

// rewrites reasoning openai could not have produced. its encrypted part is unreadable to openai, and a
// reasoning item without one is ignored, so the readable thinking becomes an assistant message in the
// same place, which the model does take into account. an item with no readable thinking is dropped.
export function adaptForeignReasoning(request: ResponsesRequest): ResponsesRequest {
	if (!Array.isArray(request.input)) {
		return request;
	}

	return {
		...request,
		input: request.input.flatMap(item => (isForeignReasoning(item) ? thinkingAsMessage(item) : [item])),
	};
}

function isForeignReasoning(item: InputItem): boolean {
	return item.type === 'reasoning' && !isOpenAiEncryptedContent(item.encrypted_content);
}

function thinkingAsMessage(item: InputItem): InputItem[] {
	const thinking = (item.summary ?? [])
		.map(part => part.text ?? '')
		.filter(Boolean)
		.join('\n\n');

	if (!thinking) {
		return [];
	}

	return [
		{
			type: 'message',
			role: 'assistant',
			content: thinking,
		},
	];
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

function isOpenAiEncryptedContent(content: string | undefined): boolean {
	if (!content || !URL_SAFE_BASE64.test(content)) {
		return false;
	}

	return Buffer.from(content, 'base64url')[0] === FERNET_VERSION;
}
