import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';

import { HttpError } from '../errors.ts';
import { requestJson } from '../http.ts';
import { API_BASE } from '../openai/api.ts';

const catalogSchema = z.object({
	models: z.array(
		z.object({
			slug: z.string(),
			display_name: z.string().optional(),
			description: z.string().optional(),
			context_window: z.number().optional(),
			max_context_window: z.number().optional(),
			input_modalities: z.array(z.string()).default([]),
			visibility: z.string().optional(),
			default_reasoning_level: z.string().optional(),
			supported_reasoning_levels: z
				.array(
					z.object({
						effort: z.string(),
						description: z.string().optional(),
					})
				)
				.default([]),
		})
	),
});

export type PlanEffort = {
	id: string;
	description: string | undefined;
};

export type PlanModel = {
	slug: string;
	name: string;
	description: string | undefined;
	contextWindow: number | undefined;
	contextWindowChoices: number[];
	hasVision: boolean;
	efforts: PlanEffort[];
	defaultEffort: string | undefined;
};

type CatalogModel = z.infer<typeof catalogSchema>['models'][number];

// lists the models the signed-in plan offers; hidden catalog entries are skipped.
export async function listPlanModels(token: string, signal?: AbortSignal): Promise<PlanModel[]> {
	// Catalog reads are safe to retry. A temporary gateway failure (including Cloudflare 520)
	// should not force the user to restart sign-in or replace their account's real catalog.
	for (let attempt = 0; ; attempt++) {
		try {
			const { models } = await requestJson(catalogSchema, `${API_BASE}/models`, {
				headers: {
					authorization: `Bearer ${token}`,
					accept: 'application/json',
				},
				signal,
			});

			return models.filter(model => model.visibility === 'list').map(toPlanModel);
		} catch (error) {
			if (!(error instanceof HttpError) || error.status < 500 || error.status > 599) {
				throw error;
			}
			if (attempt >= 3) {
				throw new HttpError(
					error.status,
					'The plan model catalog is temporarily unavailable after 4 attempts. Try grokdex setup again shortly.'
				);
			}

			await delay(500 * 2 ** attempt, undefined, { signal });
		}
	}
}

function toPlanModel(model: CatalogModel): PlanModel {
	return {
		slug: model.slug,
		name: model.display_name ?? model.slug,
		description: model.description,
		contextWindow: model.max_context_window ?? model.context_window,
		contextWindowChoices: contextWindowChoices(model),
		hasVision: model.input_modalities.includes('image'),
		efforts: model.supported_reasoning_levels.map(level => ({
			id: level.effort,
			description: level.description,
		})),
		defaultEffort: model.default_reasoning_level,
	};
}

// context_window is openai's conservative default and max_context_window the ceiling codex lets
// users raise it to. grok defaults to the ceiling and keeps the lighter default as a choice.
function contextWindowChoices(model: CatalogModel): number[] {
	const windows = [model.context_window, model.max_context_window].filter(window => window !== undefined);

	return [...new Set(windows)].sort((a, b) => a - b);
}
