import * as prompt from '@clack/prompts';

import { saveApiKey } from '../lib/api-keys.ts';
import { accessToken } from '../lib/chatgpt/access-token.ts';
import { listPlanModels } from '../lib/chatgpt/models.ts';
import { signIn } from '../lib/chatgpt/sign-in.ts';
import { readCredentials } from '../lib/chatgpt/tokens.ts';
import { paths } from '../lib/config/env.ts';
import { isGrokEffort } from '../lib/grok/config.ts';
import type { Launcher } from '../lib/launcher.ts';
import { listApiModels } from '../lib/openai/models.ts';
import { Provider, modelKey } from '../lib/providers.ts';
import { readSetups, saveSetup } from '../lib/setups.ts';
import type { Model } from '../lib/setups.ts';

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

	const skippedModels = saveSetup(
		{
			provider,
			models,
		},
		options.launcher
	);

	prompt.log.success(`Updated ${paths.grokConfig}`);

	if (skippedModels.length > 0) {
		prompt.log.warn(
			`Left out ${skippedModels.join(', ')}: your Grok config already defines a model with that name.`
		);
	}

	const added = models.map(model => modelKey(provider, model.slug)).filter(key => !skippedModels.includes(key));
	const [firstAdded] = added;

	if (firstAdded === undefined) {
		prompt.outro('No models were added.');
		return;
	}

	prompt.outro(`Start Grok with: grok -m ${firstAdded}`);
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
		const choice = await prompt.select({
			message: 'Which ChatGPT account?',
			options: [
				{
					value: 'saved',
					label: `Keep using ${existing.email || 'your saved account'}`,
				},
				{
					value: 'new',
					label: 'Sign in with a different account',
				},
			],
		});

		if (prompt.isCancel(choice)) {
			return undefined;
		}

		if (choice === 'new') {
			await signInWithSpinner({
				isNewAccount: true,
				signal,
			});
		}
	} else {
		await signInWithSpinner({
			isNewAccount: false,
			signal,
		});
	}

	const spinner = prompt.spinner();

	spinner.start("Loading your plan's models");

	const token = await accessToken({
		isHeadless: false,
		signal,
	});
	const planModels = await listPlanModels(token.access_token, signal);
	const models = planModels.map(model => ({
		...model,
		efforts: model.efforts.filter(effort => isGrokEffort(effort.id)),
	}));

	spinner.stop(`Found ${models.length} models`);

	return models;
}

type SignInWithSpinnerOptions = {
	isNewAccount: boolean;
	signal: AbortSignal;
};

async function signInWithSpinner(options: SignInWithSpinnerOptions): Promise<void> {
	const spinner = prompt.spinner();
	const credentials = await signIn({
		onUrl: url => {
			prompt.log.info(`Your browser should open. If it doesn't, visit:\n${url}`);
			spinner.start('Waiting for you to sign in');
		},
		isNewAccount: options.isNewAccount,
		signal: options.signal,
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
