import { afterEach, expect, it, vi } from 'vitest';

import { listPlanModels } from '../src/lib/chatgpt/models.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

function catalog(): Response {
	return Response.json({
		models: [
			{ slug: 'plan-model', display_name: 'My plan model', visibility: 'list' },
			{ slug: 'hidden-model', visibility: 'hidden' },
		],
	});
}

it('loads the real plan catalog after a temporary Cloudflare 520', async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValueOnce(new Response('<!DOCTYPE html>Cloudflare error', { status: 520 }))
		.mockResolvedValueOnce(catalog());
	vi.stubGlobal('fetch', fetch);

	expect(await listPlanModels('plan-token')).toMatchObject([{ slug: 'plan-model', name: 'My plan model' }]);
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: 'Bearer plan-token' });
});

it('bounds retries and reports persistent server failure without dumping HTML', async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockImplementation(() => Promise.resolve(new Response('<!DOCTYPE html>Cloudflare error', { status: 520 })));
	vi.stubGlobal('fetch', fetch);

	await expect(listPlanModels('plan-token')).rejects.toThrow('temporarily unavailable after 4 attempts');
	expect(fetch).toHaveBeenCalledTimes(4);
});

it('does not retry rejected credentials', async () => {
	const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('unauthorized', { status: 401 }));
	vi.stubGlobal('fetch', fetch);

	await expect(listPlanModels('plan-token')).rejects.toThrow('http 401');
	expect(fetch).toHaveBeenCalledTimes(1);
});

it('stops retrying when setup is cancelled during backoff', async () => {
	const controller = new AbortController();
	const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
		controller.abort();
		return Promise.resolve(new Response('gateway failure', { status: 520 }));
	});
	vi.stubGlobal('fetch', fetch);

	await expect(listPlanModels('plan-token', controller.signal)).rejects.toThrow();
	expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not retry an invalid catalog or invent models', async () => {
	const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ data: [] }));
	vi.stubGlobal('fetch', fetch);

	await expect(listPlanModels('plan-token')).rejects.toThrow();
	expect(fetch).toHaveBeenCalledTimes(1);
});
