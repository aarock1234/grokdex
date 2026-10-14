import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import { expect, it } from 'vitest';

import { createWorld, destroyWorld, readGrokConfig, setupGrokdex } from './support/world.ts';
import { FAKE_TOKEN } from './support/fake-openai.ts';

it('fetches a plan catalog over HTTP after 520 and writes the discovered models to Grok config', async () => {
	let requests = 0;
	const catalog = readFileSync(new URL('./fixtures/catalog.json', import.meta.url), 'utf8');
	const server = createServer((req, res) => {
		expect(req.url).toBe('/v1/models');
		expect(req.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
		requests++;
		if (requests === 1) {
			res.writeHead(520, { 'content-type': 'text/html' }).end('<!DOCTYPE html>gateway failure');
		} else {
			res.writeHead(200, { 'content-type': 'application/json' }).end(catalog);
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (typeof address !== 'object' || address === null) throw new Error('No test server address');
	const world = await createWorld(`http://127.0.0.1:${address.port}/v1`);
	try {
		await setupGrokdex(world);
		expect(requests).toBe(2);
		const config = readGrokConfig(world);
		for (const slug of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']) {
			expect(config).toContain(slug);
		}
	} finally {
		destroyWorld(world);
		await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
	}
});
