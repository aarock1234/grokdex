// Loopback adapter between Grok's Responses backend and the ChatGPT plan route. It fixes the few things
// Grok sends or expects that the route doesn't support, and holds no credentials: Grok's bearer token
// passes straight through.

import { appendFileSync, existsSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { API_BASE } from "./chatgpt.ts";
import { listen, readBody, sendJson } from "./http.ts";
import { dataDir } from "./store.ts";

export const ADAPTER_PORT = 18456;

const SERVICE = "grokdex";
const TAKEOVER_POLL_MS = 1_000;
// Grok's side calls (titles, recaps) name a Grok model; send them to a light plan model instead.
const SIDE_CALL_MODEL = process.env.GROKDEX_SIDE_MODEL ?? "gpt-6-luna";
// Fields the plan route rejects, per OpenAI's preview limitations.
const UNSUPPORTED_FIELDS = [
  "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt",
  "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id",
];
const logFile = join(dataDir, "adapter.log");

type InputItem = { role?: string; [key: string]: unknown };
export type ResponsesRequest = { model: string; input?: InputItem[] | string; [key: string]: unknown };
type StreamEvent = { type?: string; output_index?: number; item?: unknown; response?: { output?: unknown[] } };

// Grok sends `role: "system"` items and, on side calls, sampling fields. The plan route rejects both.
export function adaptRequest(body: ResponsesRequest): ResponsesRequest {
  const adapted: ResponsesRequest = { ...body, store: false, stream: true };
  for (const field of UNSUPPORTED_FIELDS) delete adapted[field];
  if (Array.isArray(adapted.input)) {
    adapted.input = adapted.input.map((item) => (item.role === "system" ? { ...item, role: "developer" } : item));
  }
  if (adapted.model.startsWith("grok-")) adapted.model = SIDE_CALL_MODEL;
  return adapted;
}

// The plan route streams items through `response.output_item.done` but ends with `output: []` because
// nothing is stored. Grok treats that final `output` as the whole answer, sees nothing, and retries
// forever, so rebuild it from the items the stream already delivered.
export function backfillTerminalOutput(): TransformStream<string, string> {
  const items: unknown[] = [];
  let buffer = "";
  const rewrite = (block: string): string => {
    const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) return block;
    let event: StreamEvent;
    try {
      event = JSON.parse(dataLine.slice("data: ".length)) as StreamEvent;
    } catch {
      return block;
    }
    if (event.type === "response.output_item.done" && event.output_index !== undefined) {
      items[event.output_index] = event.item;
      return block;
    }
    const terminal = event.type === "response.completed" || event.type === "response.incomplete";
    if (!terminal || !event.response || (event.response.output?.length ?? 0) > 0) return block;
    event.response.output = items.filter((item) => item !== undefined);
    return block.replace(dataLine, `data: ${JSON.stringify(event)}`);
  };
  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk.replaceAll("\r\n", "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        controller.enqueue(`${rewrite(buffer.slice(0, end))}\n\n`);
        buffer = buffer.slice(end + 2);
      }
    },
    flush(controller) {
      if (buffer) controller.enqueue(rewrite(buffer));
    },
  });
}

export function createAdapter(): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "POST" && path === "/v1/responses") {
      proxy(req, res).catch((err: Error) => {
        log(`proxy error: ${err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: { message: "grokdex adapter error" } });
        else res.destroy();
      });
      return;
    }
    if (req.method === "GET" && (path === "/" || path === "/healthz")) return sendJson(res, 200, { service: SERVICE });
    sendJson(res, 404, { error: { message: `unsupported route ${req.method} ${path}` } });
  });
}

// Every Grok session runs its own adapter host. The first one serves the port; the others stand by
// and take over when that session ends.
export async function claimPort(server: Server): Promise<void> {
  let standingBy = false;
  for (;;) {
    try {
      await listen(server, ADAPTER_PORT);
      log(`listening on 127.0.0.1:${ADAPTER_PORT} (pid ${process.pid})`);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      if (!standingBy) log(`port ${ADAPTER_PORT} in use, standing by (pid ${process.pid})`);
      standingBy = true;
      await new Promise((r) => setTimeout(r, TAKEOVER_POLL_MS));
    }
  }
}

async function proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: ResponsesRequest;
  try {
    body = adaptRequest(JSON.parse(await readBody(req)) as ResponsesRequest);
  } catch {
    return sendJson(res, 400, { error: { message: "request body is not valid json" } });
  }
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE}/responses`, {
      method: "POST",
      // Only what the API needs; Grok's x-grok-* session headers stay local.
      headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) return log(`${body.model}: cancelled before upstream answered`);
    log(`upstream unreachable: ${(err as Error).message}`);
    return sendJson(res, 502, { error: { message: `grokdex could not reach ${API_BASE}` } });
  }
  const started = Date.now();
  log(`${body.model}: upstream ${upstream.status}`);
  res.on("close", () => log(`${body.model}: done in ${Date.now() - started}ms (${res.writableFinished ? "complete" : "aborted"})`));

  // The route can omit Content-Type; with `stream: true` forced, a 2xx body is always SSE.
  const isEventStream = upstream.ok && (upstream.headers.get("content-type") ?? "text/event-stream").startsWith("text/event-stream");
  const headers: Record<string, string> = {
    "content-type": isEventStream ? "text/event-stream" : (upstream.headers.get("content-type") ?? "application/json"),
  };
  const requestId = upstream.headers.get("x-request-id");
  if (requestId) headers["x-request-id"] = requestId;
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return void res.end();
  const stream = isEventStream
    ? upstream.body.pipeThrough(new TextDecoderStream()).pipeThrough(backfillTerminalOutput()).pipeThrough(new TextEncoderStream())
    : upstream.body;
  Readable.fromWeb(stream).on("error", () => res.destroy()).pipe(res);
}

// One line per request, never request or response content.
function log(message: string): void {
  try {
    if (existsSync(logFile) && statSync(logFile).size > 1_000_000) rmSync(logFile);
    appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must never break the request path
  }
}
