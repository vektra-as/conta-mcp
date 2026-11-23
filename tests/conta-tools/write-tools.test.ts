import { describe, it, expect } from 'vitest';
import { buildHarness, WRITE_TOOL_NAMES } from '../helpers/tool-harness.js';

/**
 * Coverage for the write tools. The two things that must never regress:
 *   1. `dryRun: true` reaches the wire as the conta-force-rollback header, and
 *      its absence means the header is not sent at all.
 *   2. Each tool POSTs/PUTs/DELETEs to the documented path with a body built by
 *      the transforms (lines nested under the right key, required defaults in).
 */

const ORG = 123456;

const LINE = { description: 'Rådgivning', price: 1200, vatCode: 'high' };

const CUSTOMER = {
  name: 'Acme AS',
  customerType: 'ORGANIZATION',
  customerAddressLine1: 'Storgata 1',
  customerAddressPostcode: '0155',
  customerAddressCity: 'Oslo',
};

/** Every write tool, with a minimal valid argument set. */
const WRITE_TOOLS: [string, Record<string, unknown>][] = [
  ['create_customer', CUSTOMER],
  ['update_customer', { id: 5, ...CUSTOMER }],
  ['create_invoice_draft', { invoiceDraftLines: [LINE], customerId: 7 }],
  ['create_invoice', { customerId: 7, invoiceLines: [LINE] }],
  ['create_credit_note', { id: 9 }],
  [
    'register_invoice_payment',
    { invoiceId: 9, amount: 1500, date: '2026-07-30', bankAccountId: 3 },
  ],
  ['delete_payment', { id: 11 }],
  [
    'create_product',
    { name: 'Time', bookkeepingAccountNo: '3000', vatCode: 'output.high' },
  ],
  ['create_project', { name: 'Nytt prosjekt' }],
];

describe('write tool registry', () => {
  it('registers every steg-6 write tool', () => {
    const harness = buildHarness({ orgId: ORG });
    for (const [name] of WRITE_TOOLS) {
      expect(harness.tools.has(name), `${name} should be registered`).toBe(true);
    }
  });

  it('exercises every known write tool in this file', () => {
    // Guards against adding a write tool to the fixture list without giving it
    // dryRun coverage below.
    expect(WRITE_TOOLS.map(([name]) => name).sort()).toEqual([...WRITE_TOOL_NAMES].sort());
  });

  it('exposes dryRun on every write tool', () => {
    const harness = buildHarness({ orgId: ORG });
    for (const [name] of WRITE_TOOLS) {
      expect(harness.tools.get(name)!.schema, `${name} needs dryRun`).toHaveProperty(
        'dryRun',
      );
    }
  });

  it('does not expose dryRun on read tools', () => {
    const harness = buildHarness({ orgId: ORG });
    for (const name of ['search_invoices', 'get_invoice', 'profit_and_loss_report']) {
      expect(harness.tools.get(name)!.schema).not.toHaveProperty('dryRun');
    }
  });
});

describe('dryRun header plumbing', () => {
  it.each(WRITE_TOOLS)(
    '%s sends conta-force-rollback when dryRun is true',
    async (name, args) => {
      const harness = buildHarness({ orgId: ORG });

      await harness.call(name, { ...args, dryRun: true });

      expect(harness.soleCall().headers['conta-force-rollback']).toBe('true');
    },
  );

  it.each(WRITE_TOOLS)('%s omits the header when dryRun is absent', async (name, args) => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call(name, args);

    expect(harness.soleCall().headers['conta-force-rollback']).toBeUndefined();
  });

  it.each(WRITE_TOOLS)('%s omits the header when dryRun is false', async (name, args) => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call(name, { ...args, dryRun: false });

    expect(harness.soleCall().headers['conta-force-rollback']).toBeUndefined();
  });

  it('never leaks dryRun into the query string or the request body', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('create_invoice', {
      customerId: 7,
      invoiceLines: [LINE],
      dryRun: true,
    });

    const call = harness.soleCall();
    expect(new URL(call.url).searchParams.has('dryRun')).toBe(false);
    expect(JSON.parse(call.body!)).not.toHaveProperty('dryRun');
  });
});

describe('customer write tools', () => {
  it('create_customer POSTs the customer body', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('create_customer', { ...CUSTOMER, orgNo: '999888777' });

    const call = harness.soleCall();
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe(`/invoice/organizations/${ORG}/customers`);
    expect(JSON.parse(call.body!)).toEqual({ ...CUSTOMER, orgNo: '999888777' });
  });

  it('update_customer PUTs to the id path and keeps id out of the body', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('update_customer', { id: 5, ...CUSTOMER });

    const call = harness.soleCall();
    expect(call.method).toBe('PUT');
    expect(new URL(call.url).pathname).toBe(`/invoice/organizations/${ORG}/customers/5`);
    expect(JSON.parse(call.body!)).not.toHaveProperty('id');
  });
});

describe('invoice write tools', () => {
  it('create_invoice_draft nests lines under invoiceDraftLines with defaults applied', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('create_invoice_draft', { invoiceDraftLines: [LINE], customerId: 7 });

    const call = harness.soleCall();
    expect(new URL(call.url).pathname).toBe(
      `/invoice/organizations/${ORG}/invoice-drafts`,
    );
    const body = JSON.parse(call.body!);
    expect(body.registrationSource).toBe('CONTA');
    expect(body.invoiceDraftLines).toEqual([
      { description: 'Rådgivning', price: 1200, vatCode: 'high', quantity: 1, discount: 0, lineNo: 1 },
    ]);
    expect(body).not.toHaveProperty('invoiceLines');
  });

  it('create_invoice_draft rejects a missing customer without calling the API', async () => {
    const harness = buildHarness({ orgId: ORG });

    const result = await harness.call('create_invoice_draft', {
      invoiceDraftLines: [LINE],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/customerId or customerGroupId is required/);
    expect(harness.calls).toHaveLength(0);
  });

  it('create_invoice_draft rejects customerId and customerGroupId together', async () => {
    const harness = buildHarness({ orgId: ORG });

    const result = await harness.call('create_invoice_draft', {
      invoiceDraftLines: [LINE],
      customerId: 7,
      customerGroupId: 3,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not both/);
    expect(harness.calls).toHaveLength(0);
  });

  it('create_invoice nests lines under invoiceLines and numbers them', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('create_invoice', {
      customerId: 7,
      invoiceLines: [LINE, { description: 'Reise', price: 500, vatCode: 'low' }],
    });

    const call = harness.soleCall();
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe(`/invoice/organizations/${ORG}/invoices`);
    const body = JSON.parse(call.body!);
    expect(body.customerId).toBe(7);
    expect(body.invoiceLines.map((l: { lineNo: number }) => l.lineNo)).toEqual([1, 2]);
    expect(body).not.toHaveProperty('invoiceDraftLines');
  });

  it('create_invoice forwards invoiceRecipients for delivery', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('create_invoice', {
      customerId: 7,
      invoiceLines: [LINE],
      invoiceRecipients: [{ type: 'EMAIL', emailAddress: 'kunde@example.no' }],
    });

    expect(JSON.parse(harness.soleCall().body!).invoiceRecipients).toEqual([
      { type: 'EMAIL', emailAddress: 'kunde@example.no' },
    ]);
  });

  it('create_invoice reports the empty-lines error without calling the API', async () => {
    const harness = buildHarness({ orgId: ORG });

    const result = await harness.call('create_invoice', {
      customerId: 7,
      invoiceLines: [],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/at least one line/);
    expect(harness.calls).toHaveLength(0);
  });

  it('create_credit_note POSTs to the credit-note subpath', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('create_credit_note', {
      id: 9,
      creditNoteDate: '2026-07-30',
      removePaymentsIfExist: true,
    });

    const call = harness.soleCall();
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe(
      `/invoice/organizations/${ORG}/invoices/9/credit-note`,
    );
    expect(JSON.parse(call.body!)).toEqual({
      creditNoteDate: '2026-07-30',
      removePaymentsIfExist: true,
    });
  });
});

describe('payment write tools', () => {
  it('register_invoice_payment POSTs under the invoice id', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('register_invoice_payment', {
      invoiceId: 9,
      amount: 1500,
      date: '2026-07-30',
      bankAccountId: 3,
      description: 'Innbetaling',
    });

    const call = harness.soleCall();
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe(
      `/invoice/organizations/${ORG}/invoices/9/payments`,
    );
    const body = JSON.parse(call.body!);
    expect(body).toEqual({
      amount: 1500,
      date: '2026-07-30',
      bankAccountId: 3,
      description: 'Innbetaling',
    });
    // invoiceId belongs in the path, not the payload.
    expect(body).not.toHaveProperty('invoiceId');
  });

  it('register_invoice_payment rejects a zero amount before hitting the API', async () => {
    const harness = buildHarness({ orgId: ORG });

    const result = await harness.call('register_invoice_payment', {
      invoiceId: 9,
      amount: 0,
      date: '2026-07-30',
      bankAccountId: 3,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/positive/);
    expect(harness.calls).toHaveLength(0);
  });

  it('delete_payment DELETEs the payments path with no body', async () => {
    const harness = buildHarness({
      orgId: ORG,
      responses: [{ status: 204, bodyText: '' }],
    });

    await harness.call('delete_payment', { id: 11 });

    const call = harness.soleCall();
    expect(call.method).toBe('DELETE');
    expect(new URL(call.url).pathname).toBe(`/invoice/organizations/${ORG}/payments/11`);
    expect(call.body).toBeUndefined();
  });

  it('delete_payment still honours dryRun so a deletion can be rehearsed', async () => {
    const harness = buildHarness({
      orgId: ORG,
      responses: [{ status: 204, bodyText: '' }],
    });

    await harness.call('delete_payment', { id: 11, dryRun: true });

    expect(harness.soleCall().headers['conta-force-rollback']).toBe('true');
  });
});

describe('product and project write tools', () => {
  it('create_product POSTs the product body with its own VAT enum', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('create_product', {
      name: 'Rådgivningstime',
      bookkeepingAccountNo: '3000',
      vatCode: 'output.high',
      price: 1200,
    });

    const call = harness.soleCall();
    expect(new URL(call.url).pathname).toBe(`/invoice/organizations/${ORG}/products`);
    expect(JSON.parse(call.body!)).toEqual({
      name: 'Rådgivningstime',
      bookkeepingAccountNo: '3000',
      vatCode: 'output.high',
      price: 1200,
    });
  });

  it('keeps the product and invoice-line VAT enums separate in the schemas', () => {
    const harness = buildHarness({ orgId: ORG });
    const productVat = harness.tools.get('create_product')!.schema.vatCode as {
      options: string[];
    };

    // A product must not accept a bare invoice-line code, and vice versa.
    expect(productVat.options).toContain('output.high');
    expect(productVat.options).not.toContain('high');
  });

  it('create_project POSTs the project body', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('create_project', { name: 'Nytt prosjekt', customerId: 7 });

    const call = harness.soleCall();
    expect(new URL(call.url).pathname).toBe(`/invoice/organizations/${ORG}/projects`);
    expect(JSON.parse(call.body!)).toEqual({ name: 'Nytt prosjekt', customerId: 7 });
  });
});

describe('bank accounts lookup', () => {
  it('search_bank_accounts is read-only and filters on allowedForInvoicing', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('search_bank_accounts', { allowedForInvoicing: true });

    const call = harness.soleCall();
    expect(call.method).toBe('GET');
    expect(new URL(call.url).pathname).toBe(
      `/invoice/organizations/${ORG}/bank-accounts`,
    );
    expect(new URL(call.url).searchParams.get('allowedForInvoicing')).toBe('true');
  });
});
