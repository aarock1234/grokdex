import * as prompt from '@clack/prompts';

import { saveApiKey } from '../lib/api-keys.ts';
import { accessToken } from '../lib/chatgpt/access-token.ts';
import { listPlanModels } from '../lib/chatgpt/models.ts';
import { signIn } from '../lib/chatgpt/sign-in.ts';
import { readCredentials } from '../lib/chatgpt/tokens.ts';
import { paths } from '../lib/config/env.ts';
import type { Launcher } from '../lib/launcher.ts';
import { listApiModels } from '../lib/openai/models.ts';
import { Provider, modelKey } from '../lib/providers.ts';
import { readSetups, saveSetup } from '../lib/setups.ts';
import type { Model } from '../lib/setups.ts';

// efforts grok's responses backend can send. the catalog also lists ultra, which is not an api value:
// codex sends max for it and adds its own client-side delegation.
const GROK_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export type SetupOptions = {
	launcher: Launcher;
	signal: AbortSignal;
};

// connects a provider, lets the user pick models, and writes them to grok's config.
export async function setup(options: SetupOptions): Promise<void> {
	prompt.intro('grokdex');

	const provider = await prompt.select<Provider>({
		message: 'How do you want to connect?',
		options: [
			{
				value: Provider.CHATGPT,
				label: 'ChatGPT plan',
				hint: 'Plus, Pro or Business, includes Codex',
			},
			{
				value: Provider.OPENAI,
				label: 'OpenAI API key',
				hint: 'billed per token',
			},
		],
	});

	if (prompt.isCancel(provider)) {
		prompt.cancel('Nothing changed.');
		return;
	}

	const available = await connect(provider, options.signal);

	if (!available) {
		prompt.cancel('Nothing changed.');
		return;
	}

	const models = await pickModels(provider, available);

	if (!models) {
		prompt.cancel('Nothing changed.');
		return;
	}

	saveSetup(
		{
			provider,
			models,
		},
		options.launcher
	);

	prompt.log.success(`Updated ${paths.grokConfig}`);
	prompt.outro(`Start Grok with: grok -m ${modelKey(provider, models[0]?.slug ?? '')}`);
}

function connect(provider: Provider, signal: AbortSignal): Promise<Model[] | undefined> {
	switch (provider) {
		case Provider.CHATGPT:
			return connectChatGpt(signal);
		case Provider.OPENAI:
			return connectOpenAi(signal);
		default: {
			const exhaustive: never = provider;
			throw new Error(`unhandled provider: ${String(exhaustive)}`);
		}
	}
}

async function connectChatGpt(signal: AbortSignal): Promise<Model[] | undefined> {
	const existing = readCredentials();

	if (existing) {
		const shouldReuse = await prompt.confirm({ message: `Use ${existing.email || 'your saved account'}?` });

		if (prompt.isCancel(shouldReuse)) {
			return undefined;
		}

		if (!shouldReuse) {
			await signInWithSpinner(signal);
		}
	} else {
		await signInWithSpinner(signal);
	}

	const spinner = prompt.spinner();

	spinner.start("Loading your plan's models");

	const token = await accessToken({
		isHeadless: false,
		signal,
	});
	const planModels = await listPlanModels(token.access_token, signal);
	const models = planModels.map(model => ({
		slug: model.slug,
		name: model.name,
		description: model.description,
		contextWindow: model.contextWindow,
		efforts: model.efforts.filter(effort => GROK_EFFORTS.has(effort.id)),
		defaultEffort: model.defaultEffort,
	}));

	spinner.stop(`Found ${models.length} models`);

	return models;
}

async function signInWithSpinner(signal: AbortSignal): Promise<void> {
	const spinner = prompt.spinner();
	const credentials = await signIn({
		onUrl: url => {
			prompt.log.info(`Your browser should open. If it doesn't, visit:\n${url}`);
			spinner.start('Waiting for you to sign in');
		},
		signal,
	});

	spinner.stop(`Signed in as ${credentials.email}`);
}

async function connectOpenAi(signal: AbortSignal): Promise<Model[] | undefined> {
	const apiKey = await prompt.password({
		message: 'OpenAI API key',
		validate: value => (value?.startsWith('sk-') ? undefined : 'Keys start with sk-'),
	});

	if (prompt.isCancel(apiKey)) {
		return undefined;
	}

	const spinner = prompt.spinner();

	spinner.start('Checking the key');

	const ids = await listApiModels(apiKey, signal);

	spinner.stop(`Found ${ids.length} models`);
	saveApiKey(Provider.OPENAI, apiKey);

	return ids.map(id => ({
		slug: id,
		name: id,
		efforts: [],
	}));
}

// preselects the models chosen last time, or every model on a first setup.
async function pickModels(provider: Provider, available: readonly Model[]): Promise<Model[] | undefined> {
	const previous = readSetups().find(setup => setup.provider === provider);
	const previousSlugs = new Set(previous?.models.map(model => model.slug));
	const initialValues = available
		.filter(model => previousSlugs.size === 0 || previousSlugs.has(model.slug))
		.map(model => model.slug);

	const picked = await prompt.multiselect({
		message: 'Which models should Grok offer?',
		options: available.map(model => ({
			value: model.slug,
			label: model.name,
			hint: model.description,
		})),
		initialValues,
		required: true,
	});

	if (prompt.isCancel(picked)) {
		return undefined;
	}

	return available.filter(model => picked.includes(model.slug));
}
