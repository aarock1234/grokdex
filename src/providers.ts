import { ADAPTER_PORT } from "./adapter.ts";
import { API_BASE, planModels } from "./chatgpt.ts";
import { UserError, readJson, writeJson } from "./store.ts";

export type ProviderId = "chatgpt" | "openai";

export type Model = {
  slug: string;
  name: string;
  description?: string;
  contextWindow?: number;
  efforts: string[];
  defaultEffort?: string;
};

export type Provider = {
  id: ProviderId;
  label: string;
  baseUrl: string;
  // Model keys in Grok; plan models keep their plain slug, others are prefixed to avoid clashes.
  modelKey: (slug: string) => string;
  // Token lifetime Grok should assume; undefined for static API keys.
  tokenTtlSecs?: number;
  usesAdapter: boolean;
};

export const PROVIDERS: Record<ProviderId, Provider> = {
  chatgpt: {
    id: "chatgpt",
    label: "ChatGPT",
    baseUrl: `http://127.0.0.1:${ADAPTER_PORT}/v1`,
    modelKey: (slug) => slug,
    tokenTtlSecs: 3600,
    usesAdapter: true,
  },
  openai: {
    id: "openai",
    label: "OpenAI API",
    baseUrl: API_BASE,
    modelKey: (slug) => `openai/${slug}`,
    usesAdapter: false,
  },
};

// Reasoning efforts Grok's Responses backend can send.
const GROK_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export async function chatgptModels(): Promise<Model[]> {
  return (await planModels()).map((m) => ({ ...m, efforts: m.efforts.filter((e) => GROK_EFFORTS.has(e)) }));
}

const KEYS = "keys.json";
type Keys = Partial<Record<ProviderId, string>>;

export function storeApiKey(id: ProviderId, key: string): void {
  writeJson(KEYS, { ...readJson<Keys>(KEYS), [id]: key });
}

export function apiKey(id: ProviderId): string {
  const key = readJson<Keys>(KEYS)?.[id];
  if (!key) throw new UserError(`no ${id} api key saved (run: grokdex setup)`);
  return key;
}

// Chat and reasoning models only; the API also lists audio, image, embedding and moderation models.
export async function openaiModels(key: string): Promise<Model[]> {
  const res = await fetch(`${API_BASE}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (res.status === 401) throw new UserError("that api key was rejected");
  if (!res.ok) throw new Error(`model list returned ${res.status}`);
  const { data = [] } = (await res.json()) as { data?: { id: string }[] };
  const excluded = /audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation|codex-mini/;
  return data
    .map((m) => m.id)
    .filter((id) => /^(gpt-|o\d)/.test(id) && !excluded.test(id))
    .sort()
    .map((slug) => ({ slug, name: slug, efforts: [] }));
}
