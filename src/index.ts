#!/usr/bin/env node
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTokenProvider } from "./auth.js";
import { runAuth } from "./auth-cli.js";
import { OuraClient } from "./client.js";
import { loadConfig } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  // Pick up a .env in the working directory if there is one (Node 20.12+).
  if (existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");
  const config = loadConfig();

  if (process.argv[2] === "auth") {
    await runAuth(config);
    return;
  }

  const client = new OuraClient(createTokenProvider(config));
  const server = createServer(client, config.timeZone);
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol; log to stderr only.
  console.error(`${SERVER_NAME} ${SERVER_VERSION} running on stdio`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
