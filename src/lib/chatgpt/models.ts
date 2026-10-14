import { z } from 'zod';

import { requestJson } from '../http.ts';
import { API_BASE } from './tokens.ts';

const catalogSchema = z.object({
	models: z.array(
		z.object({
			slug: z.string(),
			display_name: z.string().optional(),
			description: z.string().optional(),
			context_window: z.number().optional(),
			visibility: z.string().optional(),
			default_reasoning_level: z.string().optional(),
			supported_reasoning_levels: z
				.array(
					z.object({
						effort: z.string(),
					})
				)
				.default([]),
		})
	),
});

export type PlanModel = {
	slug: string;
	name: string;
	description: string | undefined;
	contextWindow: number | undefined;
	efforts: string[];
	defaultEffort: string | undefined;
};

// lists the models the signed-in plan offers; hidden catalog entries are skipped.
export async function listPlanModels(token: string, signal?: AbortSignal): Promise<PlanModel[]> {
	const { models } = await requestJson(catalogSchema, `${API_BASE}/models`, {
		headers: {
			authorization: `Bearer ${token}`,
		},
		signal,
	});

	return models
		.filter(model => model.visibility === 'list')
		.map(model => ({
			slug: model.slug,
			name: model.display_name ?? model.slug,
			description: model.description,
			contextWindow: model.context_window,
			efforts: model.supported_reasoning_levels.map(level => level.effort),
			defaultEffort: model.default_reasoning_level,
		}));
}
