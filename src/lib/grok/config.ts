// grok rewrites config.toml in its own format and drops comments, so grokdex owns its entries by
// name, never by position in the file: mcp_servers.grokdex, auth_provider and model_providers
// entries named grokdex-*, and models whose model_provider is one of those.

import type { Launcher } from '../launcher.ts';
import { PROVIDERS, modelKey } from '../providers.ts';
import type { Model, Setup } from '../setups.ts';
import { isTable } from './config-file.ts';
import type { TomlTable } from './config-file.ts';

const OWNED_PREFIX = 'grokdex';

// the reasoning efforts grok's responses backend can send, with their picker labels. catalogs also
// list ultra, which is not an api value: codex sends max for it and adds client-side delegation.
const EFFORT_LABELS: Readonly<Record<string, string>> = {
	none: 'None',
	minimal: 'Minimal',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra high',
	max: 'Max',
};

// codex compacts at 90% of the context window; grok's default is 85%. a percentage, rather than a
// token count, keeps compaction right for whichever window is picked with `/model <name> <window>`.
const COMPACT_PERCENT = 90;

export function isGrokEffort(id: string): boolean {
	return Object.hasOwn(EFFORT_LABELS, id);
}

// replaces every grokdex entry with the ones these setups need; everything else is kept as is.
export function withGrokdexEntries(config: TomlTable, setups: readonly Setup[], launcher: Launcher): TomlTable {
	const next = withoutGrokdexEntries(config);

	if (setups.some(setup => PROVIDERS[setup.provider].isAdapterNeeded)) {
		addEntry(next, 'mcp_servers', OWNED_PREFIX, commandEntry(launcher, ['mcp']));
	}

	for (const setup of setups) {
		addSetup(next, setup, launcher);
	}

	return next;
}

export function withoutGrokdexEntries(config: TomlTable): TomlTable {
	const next = { ...config };

	keepEntries(next, 'mcp_servers', name => name !== OWNED_PREFIX);
	keepEntries(next, 'auth_provider', name => !isOwnedName(name));
	keepEntries(next, 'model_providers', name => !isOwnedName(name));
	keepEntries(next, 'model', (_name, entry) => !isOwnedModel(entry));

	return next;
}

// removes grokdex for good: its entries, plus any [models] setting such as the default model that
// still names one of its models, so grok falls back to its own choice instead of a missing model.
export function withGrokdexRemoved(config: TomlTable): TomlTable {
	const ownedKeys = new Set(ownedModelKeys(config));
	const next = withoutGrokdexEntries(config);
	const settings = next.models;

	if (isTable(settings)) {
		next.models = Object.fromEntries(
			Object.entries(settings).filter(([, value]) => !(typeof value === 'string' && ownedKeys.has(value)))
		);
	}

	return next;
}

function ownedModelKeys(config: TomlTable): string[] {
	const models = config.model;

	if (!isTable(models)) {
		return [];
	}

	return Object.entries(models)
		.filter(([, entry]) => isTable(entry) && isOwnedModel(entry))
		.map(([key]) => key);
}

function addSetup(config: TomlTable, setup: Setup, launcher: Launcher): void {
	const info = PROVIDERS[setup.provider];
	const providerName = `${OWNED_PREFIX}-${setup.provider}`;

	addEntry(config, 'auth_provider', providerName, {
		...commandEntry(launcher, ['token', setup.provider]),
		...(info.tokenTtlSeconds !== undefined && { token_ttl_secs: info.tokenTtlSeconds }),
	});
	addEntry(config, 'model_providers', providerName, {
		base_url: info.baseUrl,
		api_backend: 'responses',
		auth_provider: providerName,
	});

	for (const model of setup.models) {
		addEntry(config, 'model', modelKey(setup.provider, model.slug), modelEntry(setup, model, providerName));
	}
}

// names stay plain in grok's picker and status line; the provider goes in the description column.
function modelEntry(setup: Setup, model: Model, providerName: string): TomlTable {
	const { billingNote } = PROVIDERS[setup.provider];

	return {
		model: model.slug,
		model_provider: providerName,
		name: model.name,
		description: model.description ? `${model.description} ${billingNote}` : billingNote,
		...contextEntry(model),
		// without this grok treats the model as text only and describes images with its own model
		...(model.hasVision && { vision: true }),
		...(model.efforts.length > 0 && { reasoning_efforts: model.efforts.map(effort => effortEntry(effort, model)) }),
	};
}

function contextEntry(model: Model): TomlTable {
	if (!model.contextWindow) {
		return {};
	}

	const choices = model.contextWindowChoices ?? [];

	return {
		context_window: model.contextWindow,
		auto_compact_threshold_percent: COMPACT_PERCENT,
		...(choices.length > 1 && { context_windows: choices }),
	};
}

function effortEntry(effort: Model['efforts'][number], model: Model): TomlTable {
	return {
		id: effort.id,
		value: effort.id,
		label: EFFORT_LABELS[effort.id] ?? effort.id,
		...(effort.description && { description: effort.description }),
		...(effort.id === model.defaultEffort && { default: true }),
	};
}

function commandEntry(launcher: Launcher, args: readonly string[]): TomlTable {
	return {
		command: launcher.command,
		args: [...launcher.args, ...args],
	};
}

function isOwnedName(name: string): boolean {
	return name === OWNED_PREFIX || name.startsWith(`${OWNED_PREFIX}-`);
}

function isOwnedModel(entry: TomlTable): boolean {
	return typeof entry.model_provider === 'string' && isOwnedName(entry.model_provider);
}

function addEntry(config: TomlTable, section: string, name: string, entry: TomlTable): void {
	const existing = config[section];

	config[section] = {
		...(isTable(existing) ? existing : {}),
		[name]: entry,
	};
}

// keeps the entries of a section that pass the filter, dropping the section once it is empty.
function keepEntries(
	config: TomlTable,
	section: string,
	shouldKeep: (name: string, entry: TomlTable) => boolean
): void {
	const existing = config[section];

	if (!isTable(existing)) {
		return;
	}

	const kept = Object.entries(existing).filter(([name, entry]) => !isTable(entry) || shouldKeep(name, entry));

	if (kept.length === 0) {
		delete config[section];
		return;
	}

	config[section] = Object.fromEntries(kept);
}
