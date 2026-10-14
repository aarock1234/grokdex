import { z } from 'zod';

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
	const { models } = await requestJson(catalogSchema, `${API_BASE}/models`, {
		headers: {
			authorization: `Bearer ${token}`,
		},
		signal,
	});

	return models.filter(model => model.visibility === 'list').map(toPlanModel);
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
