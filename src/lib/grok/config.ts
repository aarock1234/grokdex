// grokdex owns one marked block in grok's config.toml and never touches the rest of the file.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { paths } from '../config/env.ts';
import type { Launcher } from '../launcher.ts';
import { PROVIDERS, modelKey } from '../providers.ts';
import type { Model, Setup } from '../setups.ts';

const BLOCK_BEGIN = '# >>> grokdex >>>';
const BLOCK_END = '# <<< grokdex <<<';
const BLOCK_PATTERN = new RegExp(`\\n*${BLOCK_BEGIN}[\\s\\S]*?${BLOCK_END}\\n?`);

export function renderBlock(setups: readonly Setup[], launcher: Launcher): string {
	const sections = [
		[BLOCK_BEGIN, '# Managed by grokdex. Change it with `grokdex setup`, remove it with `grokdex remove`.'],
	];

	if (setups.some(setup => PROVIDERS[setup.provider].isAdapterNeeded)) {
		sections.push(['[mcp_servers.grokdex]', ...renderCommand(launcher, ['mcp'])]);
	}

	for (const setup of setups) {
		sections.push(...renderSetup(setup, launcher));
	}

	return [...sections.map(lines => lines.join('\n')), BLOCK_END].join('\n\n');
}

export function upsertBlock(config: string, block: string): string {
	if (BLOCK_PATTERN.test(config)) {
		return config.replace(BLOCK_PATTERN, `\n\n${block}\n`);
	}

	if (!config.trim()) {
		return `${block}\n`;
	}

	return `${config.trimEnd()}\n\n${block}\n`;
}

export function removeBlock(config: string): string {
	return config.replace(BLOCK_PATTERN, '\n');
}

// rewrites grok's config atomically and keeps the previous version as config.toml.bak.
export function updateGrokConfig(update: (config: string) => string): boolean {
	const current = existsSync(paths.grokConfig) ? readFileSync(paths.grokConfig, 'utf8') : '';
	const next = update(current);

	if (next === current) {
		return false;
	}

	if (current) {
		writeFileSync(`${paths.grokConfig}.bak`, current);
	}

	const temporary = `${paths.grokConfig}.${process.pid}.tmp`;

	writeFileSync(temporary, next);
	renameSync(temporary, paths.grokConfig);

	return true;
}

function renderSetup(setup: Setup, launcher: Launcher): string[][] {
	const info = PROVIDERS[setup.provider];
	const name = `grokdex-${setup.provider}`;
	const authProvider = [`[auth_provider.${name}]`, ...renderCommand(launcher, ['token', setup.provider])];

	if (info.tokenTtlSeconds !== undefined) {
		authProvider.push(`token_ttl_secs = ${info.tokenTtlSeconds}`);
	}

	const modelProvider = [
		`[model_providers.${name}]`,
		`base_url = ${toml(info.baseUrl)}`,
		'api_backend = "responses"',
		`auth_provider = ${toml(name)}`,
	];

	return [authProvider, modelProvider, ...setup.models.map(model => renderModel(setup, model, name))];
}

function renderModel(setup: Setup, model: Model, providerName: string): string[] {
	const lines = [
		`[model.${toml(modelKey(setup.provider, model.slug))}]`,
		`model = ${toml(model.slug)}`,
		`model_provider = ${toml(providerName)}`,
		`name = ${toml(`${model.name} (${PROVIDERS[setup.provider].label})`)}`,
	];

	if (model.description) {
		lines.push(`description = ${toml(model.description)}`);
	}

	if (model.contextWindow) {
		lines.push(`context_window = ${model.contextWindow}`);
	}

	if (model.efforts.length > 0) {
		lines.push(`reasoning_efforts = [${model.efforts.map(effort => renderEffort(effort, model)).join(', ')}]`);
	}

	return lines;
}

const EFFORT_LABELS: Readonly<Record<string, string>> = {
	none: 'None',
	minimal: 'Minimal',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra high',
	max: 'Max',
};

function renderEffort(effort: Model['efforts'][number], model: Model): string {
	const fields = [
		`id = ${toml(effort.id)}`,
		`value = ${toml(effort.id)}`,
		`label = ${toml(EFFORT_LABELS[effort.id] ?? effort.id)}`,
	];

	if (effort.description) {
		fields.push(`description = ${toml(effort.description)}`);
	}

	if (effort.id === model.defaultEffort) {
		fields.push('default = true');
	}

	return `{ ${fields.join(', ')} }`;
}

function renderCommand(launcher: Launcher, args: readonly string[]): string[] {
	return [`command = ${toml(launcher.command)}`, `args = [${[...launcher.args, ...args].map(toml).join(', ')}]`];
}

// json strings are valid toml basic strings, escapes included.
function toml(value: string): string {
	return JSON.stringify(value);
}
