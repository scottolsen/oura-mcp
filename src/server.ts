import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OuraClient } from "./client.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "oura-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(client: OuraClient, timeZone?: string, now?: () => Date): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, { client, timeZone, now });
  return server;
}
