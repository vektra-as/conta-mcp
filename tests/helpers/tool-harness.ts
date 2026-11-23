/**
 * Harness for exercising registered MCP tools without standing up a transport.
 *
 * `registerAllTools` only needs an object with `registerTool()`,
 * `registerPrompt()` and `registerResource()`, so we capture
 * the registrations into a map and let tests invoke a handler by name and read
 * back what the client actually put on the wire.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ContaClient } from '../../src/conta-client.js';
import { registerAllTools, type ToolPolicy } from '../../src/conta-tools.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { mockFetch, mockSleep, type MockResponseSpec, type FetchCall } from './mock-fetch.js';

export interface CapturedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface CapturedPrompt {
  name: string;
  description: string;
  handler: () => { messages: { role: string; content: { type: string; text: string } }[] };
}

export interface CapturedResource {
  name: string;
  uri: string;
  handler: () => { contents: { uri: string; mimeType: string; text: string }[] };
}

export interface ToolHarness {
  tools: Map<string, CapturedTool>;
  prompts: Map<string, CapturedPrompt>;
  resources: Map<string, CapturedResource>;
  calls: FetchCall[];
  /** Invoke a tool by name; throws if it was never registered. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** The single fetch call a tool made. Throws unless exactly one was made. */
  soleCall(): FetchCall;
  /** Parsed URL of the sole fetch call. */
  soleUrl(): URL;
}

export interface HarnessOptions {
  /** Responses handed back in order. Defaults to one empty 200. */
  responses?: MockResponseSpec[];
  /** Default org id baked into the client (mirrors CONTA_ORG_ID). */
  orgId?: number;
  /** Tool policy. Defaults to every tool registered, delete included. */
  policy?: ToolPolicy;
}

export function buildHarness(options: HarnessOptions = {}): ToolHarness {
  const fetchHandle = mockFetch(options.responses ?? [{ status: 200, body: {} }]);
  const client = new ContaClient({
    apiKey: 'harness-key',
    orgId: options.orgId,
    fetch: fetchHandle.fetch,
    sleep: mockSleep().sleep,
  });

  const tools = new Map<string, CapturedTool>();
  const prompts = new Map<string, CapturedPrompt>();
  const resources = new Map<string, CapturedResource>();
  const fakeServer = {
    registerTool(
      name: string,
      config: {
        description: string;
        inputSchema: Record<string, unknown>;
        annotations: ToolAnnotations;
      },
      handler: CapturedTool['handler'],
    ) {
      tools.set(name, {
        name,
        description: config.description,
        schema: config.inputSchema,
        annotations: config.annotations,
        handler,
      });
    },
    registerPrompt(
      name: string,
      config: { description: string },
      handler: CapturedPrompt['handler'],
    ) {
      prompts.set(name, { name, description: config.description, handler });
    },
    registerResource(
      name: string,
      uri: string,
      _config: unknown,
      handler: CapturedResource['handler'],
    ) {
      resources.set(name, { name, uri, handler });
    },
  };

  registerAllTools(
    fakeServer as unknown as McpServer,
    client,
    options.policy ?? { allowDelete: true },
  );

  return {
    tools,
    prompts,
    resources,
    calls: fetchHandle.calls,
    async call(name, args = {}) {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(
          `tool "${name}" is not registered; known: ${[...tools.keys()].join(', ')}`,
        );
      }
      return tool.handler(args);
    },
    soleCall() {
      if (fetchHandle.calls.length !== 1) {
        throw new Error(`expected exactly 1 fetch call, got ${fetchHandle.calls.length}`);
      }
      return fetchHandle.calls[0];
    },
    soleUrl() {
      return new URL(this.soleCall().url);
    },
  };
}

/** Parse the JSON payload a tool returned in its single text content block. */
export function resultJson(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

/**
 * The expected tool inventory, split by whether a tool can change data.
 * Kept here so the read and write test files assert against one source and a
 * new tool cannot be added without landing in exactly one of these lists.
 */
export const READ_TOOL_NAMES = [
  'balance_report',
  'get_account_settings',
  'get_allowed_delivery_methods',
  'get_customer',
  'get_invoice',
  'get_invoice_draft',
  'get_invoice_payments',
  'get_product',
  'get_project',
  'get_unpaid_invoices',
  'income_expenses_key_figures',
  'list_organizations',
  'open_accounts_receivable',
  'ping',
  'profit_and_loss_report',
  'search_bank_accounts',
  'search_customers',
  'search_enhetsregisteret',
  'search_invoice_drafts',
  'search_invoice_payments',
  'search_invoices',
  'search_products',
  'search_projects',
  'trial_balance',
] as const;

export const WRITE_TOOL_NAMES = [
  'create_credit_note',
  'create_customer',
  'create_invoice',
  'create_invoice_draft',
  'create_product',
  'create_project',
  'delete_payment',
  'register_invoice_payment',
  'update_customer',
] as const;
