// runs the real, installed grok cli against grokdex and a fake chatgpt plan route. no logins: grok
// gets a fake token from grokdex's credential helper, and only the fake route accepts it.

import { execFileSync } from 'node:child_process';

import { parse } from 'smol-toml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FAKE_REPLY, FakeOpenAi, TOOL_MARKER, TOOL_TRIGGER } from './support/fake-openai.ts';
import { createWorld, destroyWorld, readGrokConfig, runGrok, setupGrokdex } from './support/world.ts';
import type { World } from './support/world.ts';

const MODEL = 'gpt-6.1-sol';
const MODELS = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'];

const fake = new FakeOpenAi();
let baseUrl = '';
let world: World;

function ask(prompt: string, extraArgs: string[] = []): ReturnType<typeof runGrok> {
	return runGrok(world, ['-p', prompt, '-m', MODEL, '--always-approve', ...extraArgs]);
}

describe('grokdex with the latest grok cli', () => {
	beforeAll(async () => {
		const grokVersion = execFileSync(process.env.GROK_BIN ?? 'grok', ['--version'], { encoding: 'utf8' });

		console.log(`testing against ${grokVersion.trim()}`);
		baseUrl = await fake.start();
	});

	afterAll(async () => {
		await fake.stop();
	});

	beforeEach(async () => {
		fake.reset();
		world = await createWorld(baseUrl);
		await setupGrokdex(world);
	});

	afterEach(() => {
		destroyWorld(world);
	});

	it('accepts the config grokdex writes', async () => {
		const result = await runGrok(world, ['models']);

		expect(result.exitCode, result.output).toBe(0);

		for (const model of MODELS) {
			expect(result.output).toContain(model);
		}
	});

	it('completes in a single request despite keepalive, metadata, and unknown response events', async () => {
		const result = await ask('Say hello.');

		expect(result.exitCode, result.output).toBe(0);
		expect(result.output).toContain(FAKE_REPLY);
		// more than one means grok rejected the stream and retried
		expect(fake.conversation(MODEL), fake.describe()).toHaveLength(1);
	});

	it('sends only request fields verified against the live plan route', async () => {
		await ask('Say hello.');

		// a new field here means grok changed what it sends; check it against the real api
		expect(fake.rejections).toEqual([]);
		expect(fake.requests.length).toBeGreaterThan(0);
	});

	it('runs a tool and feeds its output back to the model', async () => {
		const result = await ask(`Please ${TOOL_TRIGGER}.`);
		const requests = fake.requestsFor(MODEL);
		const toolOutputs = requests.flatMap(request =>
			request.body.input.filter(item => item.type === 'function_call_output')
		);

		expect(result.exitCode, result.output).toBe(0);
		expect(JSON.stringify(toolOutputs)).toContain(TOOL_MARKER);
		expect(result.output).toContain(TOOL_MARKER);
	});

	it('keeps one session id across turns and after resuming, so the prompt cache is reused', async () => {
		await ask(`Please ${TOOL_TRIGGER}.`);
		await ask('Say hello again.', ['-c']);

		const conversation = fake.conversation(MODEL);
		const sessionIds = new Set(conversation.map(request => request.sessionId));
		const [sessionId] = sessionIds;

		// the tool turn takes two requests and the resumed turn at least one more
		expect(conversation.length, fake.describe()).toBeGreaterThan(2);
		expect(sessionIds.size, fake.describe()).toBe(1);
		expect(sessionId).toBeTruthy();
		// grokdex's job: every request, side calls included, carries its cache key as the session id
		expect(
			fake.requests.every(request => request.sessionId === request.promptCacheKey),
			fake.describe()
		).toBe(true);
	});

	it('survives grok rewriting its config, without duplicating entries', async () => {
		const added = await runGrok(world, ['mcp', 'add', 'grokdex-test-dummy', '--', 'node', '--version']);

		expect(added.exitCode, added.output).toBe(0);

		await setupGrokdex(world);

		const config = parse(readGrokConfig(world));
		const models = await runGrok(world, ['models']);

		expect(config.mcp_servers).toHaveProperty('grokdex');
		expect(config.mcp_servers).toHaveProperty('grokdex-test-dummy');
		expect(models.exitCode, models.output).toBe(0);
		expect(models.output).toContain(MODEL);
	});
});
