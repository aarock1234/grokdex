// an isolated world for one test: its own grok home, grokdex data and adapter port, with fake
// credentials that only the fake plan route accepts. nothing touches a real account or config.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FAKE_TOKEN } from './fake-openai.ts';

const GROK_TIMEOUT_MS = 150_000;
const SETUP_SCRIPT = fileURLToPath(new URL('./setup-world.ts', import.meta.url));

export type World = {
	root: string;
	grokHome: string;
	workDir: string;
	env: NodeJS.ProcessEnv;
};

export type RunResult = {
	exitCode: number | null;
	output: string;
};

export async function createWorld(openAiBaseUrl: string): Promise<World> {
	const root = mkdtempSync(join(tmpdir(), 'grokdex-test-'));
	const grokHome = join(root, 'grok');
	const grokdexHome = join(root, 'grokdex');
	const workDir = join(root, 'work');

	for (const directory of [grokHome, grokdexHome, workDir]) {
		mkdirSync(directory, { recursive: true });
	}

	writeFakeCredentials(grokdexHome);

	return {
		root,
		grokHome,
		workDir,
		env: {
			...process.env,
			GROK_HOME: grokHome,
			GROKDEX_HOME: grokdexHome,
			GROKDEX_OPENAI_BASE_URL: openAiBaseUrl,
			GROKDEX_ADAPTER_PORT: String(await freePort()),
		},
	};
}

export function destroyWorld(world: World): void {
	rmSync(world.root, {
		recursive: true,
		force: true,
	});
}

// runs grokdex's setup without its prompts: the plan's models from the fake catalog, written to
// this world's grok config exactly as `grokdex setup` would.
export async function setupGrokdex(world: World): Promise<void> {
	const result = await run(process.execPath, [SETUP_SCRIPT], world);

	if (result.exitCode !== 0) {
		throw new Error(`grokdex setup failed:\n${result.output}`);
	}
}

export function runGrok(world: World, args: string[]): Promise<RunResult> {
	return run(process.env.GROK_BIN ?? 'grok', args, world);
}

export function readGrokConfig(world: World): string {
	return readFileSync(join(world.grokHome, 'config.toml'), 'utf8');
}

function run(command: string, args: string[], world: World): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: world.workDir,
			env: world.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: GROK_TIMEOUT_MS,
			windowsHide: true,
		});
		let output = '';

		child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
		child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
		child.on('error', reject);
		child.on('close', exitCode => {
			resolve({
				exitCode,
				output,
			});
		});
	});
}

// a far-off expiry and a fresh save time, so grokdex hands the token out without refreshing it.
function writeFakeCredentials(grokdexHome: string): void {
	const credentials = {
		email: 'ci@example.com',
		subject: 'ci',
		clientId: 'fake-client',
		hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
		idToken: 'fake-id-token',
		accessToken: FAKE_TOKEN,
		refreshToken: 'fake-refresh-token',
		expiresAt: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600,
		scopes: ['chatgpt.tokens.use.direct', 'email', 'offline_access', 'openid', 'profile', 'resource.invoke'],
		savedAt: new Date().toISOString(),
	};

	writeFileSync(join(grokdexHome, 'chatgpt.json'), JSON.stringify(credentials));
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();

		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address !== null ? address.port : 0;

			server.close(() => resolve(port));
		});
	});
}
