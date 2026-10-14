import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptRequest, backfillTerminalOutput } from "../src/adapter.ts";

test("adaptRequest maps system to developer and drops unsupported fields", () => {
  const adapted = adaptRequest({
    model: "gpt-6.1-sol",
    input: [
      { type: "message", role: "system", content: "rules" },
      { type: "message", role: "user", content: "hi" },
    ],
    temperature: 1,
    max_output_tokens: 100,
    store: true,
  });
  assert.deepEqual(adapted.input, [
    { type: "message", role: "developer", content: "rules" },
    { type: "message", role: "user", content: "hi" },
  ]);
  assert.equal(adapted.temperature, undefined);
  assert.equal(adapted.max_output_tokens, undefined);
  assert.equal(adapted.store, false);
  assert.equal(adapted.stream, true);
});

test("adaptRequest routes grok side calls to the side model", () => {
  assert.equal(adaptRequest({ model: "grok-4.6" }).model, "gpt-6-luna");
  assert.equal(adaptRequest({ model: "gpt-6-astra" }).model, "gpt-6-astra");
});

async function transform(chunks: string[]): Promise<string> {
  const source = ReadableStream.from(chunks).pipeThrough(backfillTerminalOutput());
  let out = "";
  for await (const chunk of source) out += chunk;
  return out;
}

const sse = (event: object): string => `event: x\ndata: ${JSON.stringify(event)}\n\n`;
const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "42" }] };

test("backfill fills an empty terminal output from streamed items", async () => {
  const out = await transform([
    sse({ type: "response.output_item.done", output_index: 0, item: message }),
    // split mid-event to exercise buffering
    sse({ type: "response.completed", response: { status: "completed", output: [] } }).slice(0, 20),
    sse({ type: "response.completed", response: { status: "completed", output: [] } }).slice(20),
  ]);
  const completed = out
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output, [message]);
});

test("backfill leaves a non-empty terminal output alone", async () => {
  const done = sse({ type: "response.completed", response: { output: [message] } });
  assert.equal(await transform([done]), done);
});
