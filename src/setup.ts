import * as p from "@clack/prompts";
import { account, signIn } from "./chatgpt.ts";
import { grokConfigFile, renderBlock, updateGrokConfig, upsertBlock, type Launcher, type Setup } from "./grok-config.ts";
import { PROVIDERS, chatgptModels, openaiModels, storeApiKey, type Model, type ProviderId } from "./providers.ts";
import { readJson, writeJson } from "./store.ts";

const SETUPS = "setup.json";

export function savedSetups(): Setup[] {
  return readJson<Setup[]>(SETUPS) ?? [];
}

export function saveSetups(setups: Setup[], launcher: Launcher): boolean {
  writeJson(SETUPS, setups);
  return updateGrokConfig((config) => upsertBlock(config, renderBlock(setups, launcher)));
}

export async function setup(launcher: Launcher): Promise<void> {
  p.intro("grokdex");

  const provider = await p.select<ProviderId>({
    message: "How do you want to connect?",
    options: [
      { value: "chatgpt", label: "ChatGPT plan", hint: "Plus, Pro or Business, includes Codex" },
      { value: "openai", label: "OpenAI API key", hint: "billed per token" },
    ],
  });
  if (p.isCancel(provider)) return void p.cancel("Nothing changed.");

  const available = provider === "chatgpt" ? await connectChatGPT() : await connectOpenAI();
  if (!available) return void p.cancel("Nothing changed.");

  const previous = new Set(savedSetups().find((s) => s.provider === provider)?.models.map((m) => m.slug));
  const picked = await p.multiselect({
    message: "Which models should Grok offer?",
    options: available.map((m) => ({ value: m.slug, label: m.name, hint: m.description })),
    initialValues: available.filter((m) => previous.size === 0 || previous.has(m.slug)).map((m) => m.slug),
    required: true,
  });
  if (p.isCancel(picked)) return void p.cancel("Nothing changed.");

  const models = available.filter((m) => picked.includes(m.slug));
  saveSetups([...savedSetups().filter((s) => s.provider !== provider), { provider, models }], launcher);
  p.log.success(`Updated ${grokConfigFile}`);

  const first = PROVIDERS[provider].modelKey(models[0]!.slug);
  p.outro(`Start Grok with: grok -m ${first}`);
}

async function connectChatGPT(): Promise<Model[] | undefined> {
  const existing = account();
  const reuse = existing && (await p.confirm({ message: `Use ${existing.email || "your saved account"}?` }));
  if (p.isCancel(reuse)) return undefined;

  if (!reuse) {
    const spin = p.spinner();
    await signIn((url) => {
      p.log.info(`Your browser should open. If it doesn't, visit:\n${url}`);
      spin.start("Waiting for you to sign in");
    });
    spin.stop(`Signed in as ${account()?.email}`);
  }

  const spin = p.spinner();
  spin.start("Loading your plan's models");
  const models = await chatgptModels();
  spin.stop(`Found ${models.length} models`);
  return models;
}

async function connectOpenAI(): Promise<Model[] | undefined> {
  const key = await p.password({
    message: "OpenAI API key",
    validate: (value) => (value?.startsWith("sk-") ? undefined : "Keys start with sk-"),
  });
  if (p.isCancel(key)) return undefined;

  const spin = p.spinner();
  spin.start("Checking the key");
  const models = await openaiModels(key);
  spin.stop(`Found ${models.length} models`);
  storeApiKey("openai", key);
  return models;
}
