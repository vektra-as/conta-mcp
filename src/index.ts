#!/usr/bin/env node
/**
 * Conta MCP Server — stdio entry. Tool definitions live in conta-tools.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { ContaClient } from "./conta-client.js";
import { registerAllTools, toolPolicyFromEnv } from "./conta-tools.js";
import { loadContaEnvFile } from "./env-file.js";

const require = createRequire(import.meta.url);
const { version: MCP_VERSION } = require("../package.json") as { version: string };

// Key file first, so ContaClient and the tool policy see its values. Logs names and paths, never values.
const envFile = loadContaEnvFile();
for (const warning of envFile.warnings) console.error(`Warning: ${warning}`);
if (envFile.loaded) console.error(`Loaded ${envFile.applied.join(", ") || "no new settings"} from ${envFile.path}`);

const client = new ContaClient();
const server = new McpServer({
  name: "conta",
  version: MCP_VERSION,
});

const policy = toolPolicyFromEnv();
registerAllTools(server, client, policy);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP transport — all logging must go to stderr.
  const mode = policy.readOnly ? "read-only" : policy.allowDelete ? "read-write + delete" : "read-write";
  console.error(`Conta MCP server ${MCP_VERSION} running on stdio (${mode})`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
