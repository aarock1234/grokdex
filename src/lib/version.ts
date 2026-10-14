import { readFileSync } from 'node:fs';

import { z } from 'zod';

const packageSchema = z.object({
	version: z.string(),
});

// package.json sits two levels above both src/lib and dist/lib.
const packageFile = new URL('../../package.json', import.meta.url);

export const VERSION = packageSchema.parse(JSON.parse(readFileSync(packageFile, 'utf8'))).version;
