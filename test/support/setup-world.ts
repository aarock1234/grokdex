// runs in a child process with a test world's environment, because grokdex reads its environment once
// at startup. does what `grokdex setup` does after its prompts: fetch the plan's models and write them.

import { accessToken } from '../../src/lib/chatgpt/access-token.ts';
import { listPlanModels } from '../../src/lib/chatgpt/models.ts';
import { isGrokEffort } from '../../src/lib/grok/config.ts';
import { resolveLauncher } from '../../src/lib/launcher.ts';
import { Provider } from '../../src/lib/providers.ts';
import { saveSetup } from '../../src/lib/setups.ts';
import { VERSION } from '../../src/lib/version.ts';

const entry = new URL('../../src/main.ts', import.meta.url).href;
const token = await accessToken({ isHeadless: false });
const models = await listPlanModels(token.access_token);

saveSetup(
	{
		provider: Provider.CHATGPT,
		models: models.map(model => ({
			...model,
			efforts: model.efforts.filter(effort => isGrokEffort(effort.id)),
		})),
	},
	resolveLauncher(entry, VERSION)
);
