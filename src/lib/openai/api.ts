import { env } from '../config/env.ts';

// where requests go: openai by default, or a proxy or local stand-in via GROKDEX_OPENAI_BASE_URL.
export const API_BASE = env.GROKDEX_OPENAI_BASE_URL;

// the oauth resource a chatgpt plan token is issued for. it names openai's api and never changes,
// even when requests go somewhere else.
export const OAUTH_RESOURCE = 'https://api.openai.com/v1';
