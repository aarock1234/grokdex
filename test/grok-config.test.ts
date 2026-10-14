import assert from "node:assert/strict";
import { test } from "node:test";
import { removeBlock, renderBlock, upsertBlock, type Setup } from "../src/grok-config.ts";

const launcher = { command: "npx", args: ["-y", "grokdex@0.1.0"] };
const chatgpt: Setup = {
  provider: "chatgpt",
  models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", contextWindow: 500_000, efforts: ["low", "high"], defaultEffort: "low" }],
};

test("renderBlock wires the token helper, adapter host and models", () => {
  const block = renderBlock([chatgpt], launcher);
  assert.match(block, /\[mcp_servers\.grokdex\]\ncommand = "npx"\nargs = \["-y", "grokdex@0\.1\.0", "mcp"\]/);
  assert.match(block, /\[auth_provider\.grokdex-chatgpt\]\ncommand = "npx"\nargs = \["-y", "grokdex@0\.1\.0", "token", "chatgpt"\]/);
  assert.match(block, /base_url = "http:\/\/127\.0\.0\.1:18456\/v1"/);
  assert.match(block, /\[model\."gpt-6\.1-sol"\]/);
  assert.match(block, /\{ id = "low", value = "low", default = true \}/);
});

test("renderBlock skips the adapter host when no provider needs it", () => {
  const block = renderBlock([{ provider: "openai", models: [{ slug: "gpt-5", name: "gpt-5", efforts: [] }] }], launcher);
  assert.doesNotMatch(block, /mcp_servers/);
  assert.match(block, /\[model\."openai\/gpt-5"\]/);
  assert.match(block, /base_url = "https:\/\/api\.openai\.com\/v1"/);
});

test("upsertBlock appends once, replaces in place, and removeBlock restores the rest", () => {
  const original = '[models]\ndefault = "grok-4.7"\n';
  const once = upsertBlock(original, renderBlock([chatgpt], launcher));
  const twice = upsertBlock(once, renderBlock([chatgpt], launcher));
  assert.equal(twice, once);
  assert.ok(once.startsWith(original));
  assert.equal(removeBlock(once).trim(), original.trim());
});

test("paths with backslashes and quotes stay valid TOML strings", () => {
  const block = renderBlock([chatgpt], { command: 'C:\\node "x"\\node.exe', args: [] });
  assert.match(block, /command = "C:\\\\node \\"x\\"\\\\node\.exe"/);
});
