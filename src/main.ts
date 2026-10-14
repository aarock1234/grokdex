#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { mcp } from './commands/mcp.ts';
import { remove } from './commands/remove.ts';
import { setup } from './commands/setup.ts';
import { status } from './commands/status.ts';
import { token } from './commands/token.ts';
import { AppError, UsageError, errorMessage } from './lib/errors.ts';
import { resolveLauncher } from './lib/launcher.ts';
import { VERSION } from './lib/version.ts';

const Command = {
	SETUP: 'setup',
	STATUS: 'status',
	REMOVE: 'remove',
	TOKEN: 'token',
	MCP: 'mcp',
} as const;

const commandSchema = z.enum(Command);

const USAGE = `grokdex ${VERSION}

Usage: grokdex <command>

Commands:
  setup               connect a provider and add its models to Grok
  status              show what is connected
  remove              remove grokdex from Grok's config
  remove --sign-out   also sign out and delete saved credentials

Used by Grok:
  token <provider>    print an access token
  mcp                 host the adapter for a Grok session`;

const parseOptions = {
	allowPositionals: true,
	options: {
		'sign-out': {
			type: 'boolean',
		},
		help: {
			type: 'boolean',
			short: 'h',
		},
		version: {
			type: 'boolean',
			short: 'v',
		},
	},
	strict: true,
} as const;

async function run(signal: AbortSignal): Promise<void> {
	const { values, positionals } = parseArgs(parseOptions);
	const [commandArg, argument] = positionals;

	if (values.version) {
		console.log(VERSION);
		return;
	}

	if (values.help || commandArg === undefined) {
		console.log(USAGE);
		return;
	}

	const parsed = commandSchema.safeParse(commandArg);

	if (!parsed.success) {
		throw new UsageError(`unknown command: ${commandArg}\n\n${USAGE}`);
	}

	const command = parsed.data;

	switch (command) {
		case Command.SETUP:
			return setup({
				launcher: resolveLauncher(import.meta.url, VERSION),
				signal,
			});
		case Command.STATUS:
			return status();
		case Command.REMOVE:
			return remove({
				shouldSignOut: values['sign-out'] ?? false,
				signal,
			});
		case Command.TOKEN:
			return token(argument, signal);
		case Command.MCP:
			return mcp(VERSION, signal);
		default: {
			const exhaustive: never = command;
			throw new Error(`unhandled command: ${String(exhaustive)}`);
		}
	}
}

const controller = new AbortController();

process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

run(controller.signal).catch((error: unknown) => {
	console.error(error instanceof AppError ? error.message : `error: ${errorMessage(error)}`);
	process.exitCode = 1;
});
