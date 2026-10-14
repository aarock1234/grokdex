import { z } from 'zod';

import { AppError, HttpError } from '../errors.ts';
import { requestJson } from '../http.ts';
import { API_BASE } from './api.ts';

const modelListSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
		})
	),
});

const CHAT_MODEL = /^(gpt-|o\d)/;
// the api also lists audio, image, embedding and moderation models that grok cannot use
const NON_CHAT_MODEL = /audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation/;

// lists the chat models an api key can use; also proves the key works.
export async function listApiModels(apiKey: string, signal?: AbortSignal): Promise<string[]> {
	try {
		const { data } = await requestJson(modelListSchema, `${API_BASE}/models`, {
			headers: {
				authorization: `Bearer ${apiKey}`,
			},
			signal,
		});

		return data
			.map(model => model.id)
			.filter(id => CHAT_MODEL.test(id) && !NON_CHAT_MODEL.test(id))
			.sort();
	} catch (error) {
		if (error instanceof HttpError && error.status === 401) {
			throw new AppError('that api key was rejected', 'INVALID_API_KEY', { cause: error });
		}

		throw error;
	}
}
