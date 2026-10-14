import { env } from '../config/env.ts';

export const ADAPTER_PORT = env.GROKDEX_ADAPTER_PORT;

export const ADAPTER_BASE_URL = `http://127.0.0.1:${ADAPTER_PORT}/v1`;
