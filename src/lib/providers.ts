import { ADAPTER_BASE_URL } from './adapter/address.ts';
import { API_BASE } from './chatgpt/tokens.ts';

export const Provider = {
	CHATGPT: 'chatgpt',
	OPENAI: 'openai',
} as const;

export type Provider = (typeof Provider)[keyof typeof Provider];

export type ProviderInfo = {
	label: string;
	baseUrl: string;
	// grok model keys; plan models keep their plain slug, others get a prefix so they never clash.
	modelKeyPrefix: string;
	// how long grok should assume a token lives; static api keys have no lifetime.
	tokenTtlSeconds: number | undefined;
	isAdapterNeeded: boolean;
};

export const PROVIDERS: Readonly<Record<Provider, ProviderInfo>> = {
	[Provider.CHATGPT]: {
		label: 'ChatGPT',
		baseUrl: ADAPTER_BASE_URL,
		modelKeyPrefix: '',
		tokenTtlSeconds: 3600,
		isAdapterNeeded: true,
	},
	[Provider.OPENAI]: {
		label: 'OpenAI API',
		baseUrl: API_BASE,
		modelKeyPrefix: 'openai/',
		tokenTtlSeconds: undefined,
		isAdapterNeeded: false,
	},
};

export function modelKey(provider: Provider, slug: string): string {
	return `${PROVIDERS[provider].modelKeyPrefix}${slug}`;
}
