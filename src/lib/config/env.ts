import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

const envSchema = z.object({
	GROKDEX_HOME: z.string().min(1).optional(),
	GROKDEX_SIDE_MODEL: z.string().min(1).default('gpt-6-luna'),
	GROKDEX_OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
	GROKDEX_ADAPTER_PORT: z.coerce.number().int().min(1).max(65_535).default(18_456),
	GROK_HOME: z.string().min(1).optional(),
	// grok sets this to 1 for a silent token refresh
	GROK_AUTH_EXPIRED: z
		.string()
		.optional()
		.transform(value => value === '1'),
	LOCALAPPDATA: z.string().min(1).optional(),
	XDG_CONFIG_HOME: z.string().min(1).optional(),
	npm_config_user_agent: z.string().optional(),
	PATH: z.string().default(''),
	PATHEXT: z.string().default('.EXE;.CMD'),
	USERNAME: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

// parses the environment once at startup and reports every invalid variable together.
function parseEnv(): Env {
	const result = envSchema.safeParse(process.env);

	if (result.success) {
		return result.data;
	}

	const issues = result.error.issues.map(issue => ` - ${issue.path.join('.')}: ${issue.message}`);

	throw new Error(['invalid environment variables:', ...issues].join('\n'));
}

export const env = parseEnv();

const configHome = env.LOCALAPPDATA ?? env.XDG_CONFIG_HOME ?? join(homedir(), '.config');

export const paths = {
	dataDir: env.GROKDEX_HOME ?? join(configHome, 'grokdex'),
	grokConfig: join(env.GROK_HOME ?? join(homedir(), '.grok'), 'config.toml'),
};
