import { claimPort, createAdapter } from '../lib/adapter/server.ts';
import { env } from '../lib/config/env.ts';
import { createFileLogger } from '../lib/log.ts';
import { serveMcp } from '../lib/mcp/server.ts';

// hosts the adapter for as long as grok keeps this mcp server's session open.
export async function mcp(version: string, signal: AbortSignal): Promise<void> {
	const logger = createFileLogger('adapter');
	const server = createAdapter({
		logger,
		sideModel: env.GROKDEX_SIDE_MODEL,
	});
	const stop = new AbortController();
	const combined = AbortSignal.any([signal, stop.signal]);
	const claiming = claimPort(server, logger, combined);

	try {
		await serveMcp(version);
	} finally {
		stop.abort();
		server.closeAllConnections();
		server.close();
		await claiming;
		logger.info('session ended');
		logger.flush();
	}
}
