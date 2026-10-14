// Grok starts stdio MCP servers with every session and stops them when it ends, which is exactly the
// lifetime the adapter needs. This server offers no tools; it only hosts the adapter.

import { createInterface } from "node:readline";
import { claimPort, createAdapter } from "./adapter.ts";

const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

type Message = { id?: number | string; method?: string; params?: { protocolVersion?: string } };

export function runMcpServer(version: string): void {
  claimPort(createAdapter()).catch((err: Error) => {
    console.error(`adapter failed: ${err.message}`);
    process.exit(1);
  });

  const reply = (id: number | string, payload: object): void => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`);
  };
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        return;
      }
      if (message.id === undefined) return; // notifications need no reply
      switch (message.method) {
        case "initialize":
          return reply(message.id, {
            result: {
              protocolVersion: message.params?.protocolVersion ?? FALLBACK_PROTOCOL_VERSION,
              capabilities: {},
              serverInfo: { name: "grokdex", version },
            },
          });
        case "ping":
          return reply(message.id, { result: {} });
        default:
          return reply(message.id, { error: { code: -32601, message: `method not found: ${message.method}` } });
      }
    })
    .on("close", () => process.exit(0));
}
