import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
		// each test starts the real grok cli, which takes a few seconds and shares one fake upstream
		fileParallelism: false,
		testTimeout: 180_000,
		hookTimeout: 180_000,
	},
});
