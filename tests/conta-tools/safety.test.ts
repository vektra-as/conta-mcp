import { describe, it, expect } from 'vitest';
import {
  buildHarness,
  resultJson,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
} from '../helpers/tool-harness.js';
import {
  DRY_RUN_RECIPIENTS_NOTE,
  formatResult,
  toolAnnotations,
  toolPolicyFromEnv,
} from '../../src/conta-tools.js';
import { ContaClient, assertSafeBaseUrl } from '../../src/conta-client.js';

/**
 * Guards that matter once the server is in other people's hands: read-only
 * mode, opt-in deletes, tool annotations, dry runs that cannot reach the
 * customer, response caps, https-only base URLs and request timeouts.
 */

const ORG = 123456;
const LINE = { description: 'Rådgivning', price: 1200, vatCode: 'high' };
const RECIPIENTS = [{ type: 'EMAIL', emailAddress: 'kunde@example.no' }];

describe('tool policy', () => {
  it('registers only read tools in read-only mode', () => {
    const harness = buildHarness({ policy: { readOnly: true, allowDelete: true } });
    expect([...harness.tools.keys()].sort()).toEqual([...READ_TOOL_NAMES].sort());
  });

  it('leaves delete_payment out unless deletes are allowed', () => {
    const harness = buildHarness({ policy: {} });
    expect(harness.tools.has('delete_payment')).toBe(false);
    for (const name of WRITE_TOOL_NAMES.filter((n) => n !== 'delete_payment')) {
      expect(harness.tools.has(name)).toBe(true);
    }
  });

  it('reads the policy from env', () => {
    expect(toolPolicyFromEnv({})).toEqual({
      readOnly: true,
      allowDelete: false,
      maxResponseChars: undefined,
    });
    expect(
      toolPolicyFromEnv({
        CONTA_READ_ONLY: 'true',
        CONTA_ALLOW_DELETE: '1',
        CONTA_MAX_RESPONSE_CHARS: '5000',
      }),
    ).toEqual({ readOnly: true, allowDelete: true, maxResponseChars: 5000 });
    expect(toolPolicyFromEnv({ CONTA_READ_ONLY: 'false' }).readOnly).toBe(false);
    expect(toolPolicyFromEnv({ CONTA_READ_ONLY: 'nei' }).readOnly).toBe(false);
    expect(toolPolicyFromEnv({ CONTA_READ_ONLY: '' }).readOnly).toBe(true);
  });

  it('refuses an unrecognised flag value instead of picking a mode', () => {
    expect(() => toolPolicyFromEnv({ CONTA_READ_ONLY: 'on' })).toThrow(/CONTA_READ_ONLY/);
    expect(() => toolPolicyFromEnv({ CONTA_ALLOW_DELETE: 'treu' })).toThrow(/CONTA_ALLOW_DELETE/);
  });

  it('rejects a nonsensical CONTA_MAX_RESPONSE_CHARS', () => {
    expect(() => toolPolicyFromEnv({ CONTA_MAX_RESPONSE_CHARS: '10' })).toThrow(
      /CONTA_MAX_RESPONSE_CHARS/,
    );
  });
});

describe('tool annotations', () => {
  it('marks every read tool read-only', () => {
    const harness = buildHarness();
    for (const name of READ_TOOL_NAMES) {
      expect(harness.tools.get(name)!.annotations.readOnlyHint).toBe(true);
    }
  });

  it('marks every write tool as not read-only, and deletes as destructive', () => {
    const harness = buildHarness();
    for (const name of WRITE_TOOL_NAMES) {
      expect(harness.tools.get(name)!.annotations.readOnlyHint).toBe(false);
    }
    expect(toolAnnotations('delete_payment').destructiveHint).toBe(true);
    expect(toolAnnotations('update_customer').destructiveHint).toBe(true);
    expect(toolAnnotations('create_invoice').destructiveHint).toBe(false);
  });
});

describe('dryRun never delivers anything', () => {
  it('create_invoice drops invoiceRecipients on a dry run and says so', async () => {
    const harness = buildHarness({ orgId: ORG, responses: [{ status: 200, body: { id: 1 } }] });
    const result = await harness.call('create_invoice', {
      dryRun: true,
      customerId: 7,
      invoiceLines: [LINE],
      invoiceRecipients: RECIPIENTS,
    });
    expect(JSON.parse(harness.soleCall().body!).invoiceRecipients).toBeUndefined();
    expect(resultJson(result)).toEqual({
      note: DRY_RUN_RECIPIENTS_NOTE,
      contaResponse: { id: 1 },
    });
  });

  it('create_credit_note drops invoiceRecipients on a dry run', async () => {
    const harness = buildHarness({ orgId: ORG });
    await harness.call('create_credit_note', {
      dryRun: true,
      id: 9,
      invoiceRecipients: RECIPIENTS,
    });
    expect(JSON.parse(harness.soleCall().body!).invoiceRecipients).toBeUndefined();
  });

  it('a real run still sends invoiceRecipients and returns the raw response', async () => {
    const harness = buildHarness({ orgId: ORG, responses: [{ status: 200, body: { id: 2 } }] });
    const result = await harness.call('create_invoice', {
      customerId: 7,
      invoiceLines: [LINE],
      invoiceRecipients: RECIPIENTS,
    });
    expect(JSON.parse(harness.soleCall().body!).invoiceRecipients).toEqual(RECIPIENTS);
    expect(resultJson(result)).toEqual({ id: 2 });
  });
});

describe('response size cap', () => {
  it('passes small results through untouched', () => {
    expect(formatResult({ a: 1 }, 1000)).toBe('{"a":1}');
  });

  it('cuts oversized results and tells the model how to page', () => {
    const text = formatResult({ blob: 'x'.repeat(5000) }, 1000);
    expect(text.startsWith('{"blob":"xxx')).toBe(true);
    expect(text).toMatch(/AVKORTET/);
    expect(text.length).toBeLessThan(1300);
  });

  it('applies the policy cap to tool results', async () => {
    const harness = buildHarness({
      orgId: ORG,
      policy: { maxResponseChars: 1000 },
      responses: [{ status: 200, body: { blob: 'x'.repeat(5000) } }],
    });
    const result = await harness.call('search_customers', {});
    expect(result.content[0].text).toMatch(/AVKORTET/);
  });
});

describe('base URL safety', () => {
  it('accepts https and local http', () => {
    expect(() => assertSafeBaseUrl('https://api.gateway.conta.no')).not.toThrow();
    expect(() => assertSafeBaseUrl('http://localhost:8080')).not.toThrow();
    expect(() => assertSafeBaseUrl('http://127.0.0.1:8080')).not.toThrow();
  });

  it('refuses plain http to a remote host, and garbage', () => {
    expect(() => assertSafeBaseUrl('http://api.gateway.conta.no')).toThrow(/https/);
    expect(() => assertSafeBaseUrl('not a url')).toThrow(/valid URL/);
  });

  it('is enforced by the client constructor', () => {
    expect(() => new ContaClient({ apiKey: 'k', baseUrl: 'http://evil.example' })).toThrow(
      /https/,
    );
  });
});

describe('request timeout', () => {
  it('gives every request an abort signal', async () => {
    let seen: AbortSignal | null | undefined;
    const client = new ContaClient({
      apiKey: 'k',
      fetch: async (_url, init) => {
        seen = init?.signal;
        return new Response('{}', { status: 200 });
      },
    });
    await client.get('/invoice/ping');
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it('turns a timeout into a readable error', async () => {
    const client = new ContaClient({
      apiKey: 'k',
      timeoutMs: 5,
      fetch: async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    });
    await expect(client.get('/invoice/ping')).rejects.toThrow(/timed out after 5 ms/);
  });

  it('warns that a timed-out write may have been carried out, but not on reads', async () => {
    const client = new ContaClient({
      apiKey: 'k',
      timeoutMs: 5,
      fetch: async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    });
    await expect(client.post('/invoices', {})).rejects.toThrow(/may still have been carried out/);
    await expect(client.get('/invoice/ping')).rejects.not.toThrow(/carried out/);
  });

  it('rejects a non-positive timeout', () => {
    expect(() => new ContaClient({ apiKey: 'k', timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});
