import { describe, it, expect } from 'vitest';
import {
  buildHarness,
  resultJson,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
} from '../helpers/tool-harness.js';

/**
 * Coverage for the read-only tools: that each one hits the path the OpenAPI
 * spec documents, forwards parameters under the API's own names, and turns a
 * Conta error into a readable, non-throwing tool result.
 *
 * These are the checks a smoke test against the live API cannot make cheaply —
 * a typo in a path or a param name would otherwise only surface at runtime.
 */

const ORG = 123456;

describe('tool registry', () => {
  it('registers every read tool', () => {
    const harness = buildHarness();
    const names = [...harness.tools.keys()];

    for (const name of READ_TOOL_NAMES) {
      expect(names, `${name} should be registered`).toContain(name);
    }
  });

  it('registers exactly the read and write tools, nothing else', () => {
    // A new tool must be added to one of the two fixture lists, so an
    // unclassified tool — in particular an unnoticed write tool — fails here.
    const harness = buildHarness();
    const names = [...harness.tools.keys()].sort();

    expect(names).toEqual([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort());
  });

  it('sends every read tool as a GET, so none of them can mutate data', async () => {
    for (const name of READ_TOOL_NAMES) {
      const harness = buildHarness({ orgId: ORG });
      const tool = harness.tools.get(name)!;
      // Fill in whatever the tool declares as required, with throwaway values.
      const args: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(tool.schema)) {
        if ((field as { isOptional(): boolean }).isOptional()) continue;
        args[key] = key === 'year' ? 2026 : key.endsWith('Date') ? '2026-01-01' : 1;
      }
      if (name === 'get_allowed_delivery_methods') args.type = 'NORMAL';

      await harness.call(name, args);

      expect(harness.soleCall().method, `${name} must be a GET`).toBe('GET');
    }
  });

  it('gives every tool a non-empty description', () => {
    const harness = buildHarness();
    for (const tool of harness.tools.values()) {
      expect(tool.description.length, `${tool.name} needs a description`).toBeGreaterThan(0);
    }
  });
});

describe('org-independent tools', () => {
  it('ping hits /invoice/ping', async () => {
    const harness = buildHarness({ responses: [{ status: 200, bodyText: '"pong"' }] });

    const result = await harness.call('ping');

    expect(harness.soleUrl().pathname).toBe('/invoice/ping');
    expect(resultJson(result)).toBe('pong');
  });

  it('list_organizations hits /invoice/organizations and needs no org id', async () => {
    const orgs = [{ id: ORG, name: 'Eksempel AS', active: true }];
    const harness = buildHarness({ responses: [{ status: 200, body: orgs }] });

    const result = await harness.call('list_organizations');

    expect(harness.soleUrl().pathname).toBe('/invoice/organizations');
    expect(resultJson(result)).toEqual(orgs);
  });

  it('get_account_settings hits /invoice/account/settings', async () => {
    const harness = buildHarness();
    await harness.call('get_account_settings');
    expect(harness.soleUrl().pathname).toBe('/invoice/account/settings');
  });

  it('search_enhetsregisteret is not org-scoped and forwards the query', async () => {
    const harness = buildHarness();

    await harness.call('search_enhetsregisteret', { q: 'Eksempel', hits: 5 });

    const url = harness.soleUrl();
    expect(url.pathname).toBe('/invoice/enhetsregisteret/search');
    expect(url.searchParams.get('q')).toBe('Eksempel');
    expect(url.searchParams.get('hits')).toBe('5');
  });
});

describe('org id resolution', () => {
  it('uses the client default org when the tool arg is omitted', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('search_customers', {});

    expect(harness.soleUrl().pathname).toBe(`/invoice/organizations/${ORG}/customers`);
  });

  it('lets an explicit opContextOrgId override the default', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('search_customers', { opContextOrgId: 999 });

    expect(harness.soleUrl().pathname).toBe('/invoice/organizations/999/customers');
  });

  it('returns an actionable error instead of calling the API when no org is available', async () => {
    const harness = buildHarness();

    const result = await harness.call('search_customers', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/list_organizations/);
    expect(harness.calls).toHaveLength(0);
  });

  it('never leaks opContextOrgId into the query string', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('search_customers', { opContextOrgId: ORG, q: 'acme' });

    const url = harness.soleUrl();
    expect(url.searchParams.has('opContextOrgId')).toBe(false);
    expect(url.searchParams.get('q')).toBe('acme');
  });
});

describe('customer tools', () => {
  it('search_customers forwards pagination and customerType', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('search_customers', {
      q: 'acme',
      hits: 50,
      page: 2,
      sort: '-name',
      customerType: 'ORGANIZATION',
      modifiedFromDate: '2026-01-01',
    });

    const url = harness.soleUrl();
    expect(url.searchParams.get('q')).toBe('acme');
    expect(url.searchParams.get('hits')).toBe('50');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('sort')).toBe('-name');
    expect(url.searchParams.get('customerType')).toBe('ORGANIZATION');
    expect(url.searchParams.get('modifiedFromDate')).toBe('2026-01-01');
  });

  it('get_customer puts the id in the path, not the query', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('get_customer', { id: 42 });

    const url = harness.soleUrl();
    expect(url.pathname).toBe(`/invoice/organizations/${ORG}/customers/42`);
    expect(url.searchParams.has('id')).toBe(false);
  });
});

describe('invoice tools', () => {
  it('search_invoices forwards the status filter and customer filter', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('search_invoices', { type: 'OVERDUE', customerId: 7, invoiceNo: 1001 });

    const url = harness.soleUrl();
    expect(url.pathname).toBe(`/invoice/organizations/${ORG}/invoices`);
    expect(url.searchParams.get('type')).toBe('OVERDUE');
    expect(url.searchParams.get('customerId')).toBe('7');
    expect(url.searchParams.get('invoiceNo')).toBe('1001');
  });

  it('search_invoices repeats kraviaInvoiceStatuses as form/explode query params', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('search_invoices', { kraviaInvoiceStatuses: ['ACTIVE', 'CLOSED'] });

    expect(harness.soleUrl().searchParams.getAll('kraviaInvoiceStatuses')).toEqual([
      'ACTIVE',
      'CLOSED',
    ]);
  });

  it('get_invoice reads a single invoice by id', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('get_invoice', { id: 5 });

    expect(harness.soleUrl().pathname).toBe(`/invoice/organizations/${ORG}/invoices/5`);
  });

  it('search_invoice_drafts and get_invoice_draft use the invoice-drafts paths', async () => {
    const search = buildHarness({ orgId: ORG });
    await search.call('search_invoice_drafts', { q: 'utkast' });
    expect(search.soleUrl().pathname).toBe(`/invoice/organizations/${ORG}/invoice-drafts`);

    const read = buildHarness({ orgId: ORG });
    await read.call('get_invoice_draft', { id: 12 });
    expect(read.soleUrl().pathname).toBe(`/invoice/organizations/${ORG}/invoice-drafts/12`);
  });

  it('get_unpaid_invoices hits the unpaid dashboard endpoint', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('get_unpaid_invoices', {});

    expect(harness.soleUrl().pathname).toBe(`/invoice/organizations/${ORG}/invoices/unpaid`);
  });

  it('get_allowed_delivery_methods forwards the planned-invoice fields', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('get_allowed_delivery_methods', {
      customerId: 7,
      invoiceDueDate: '2026-08-15',
      sumRemaining: 1250.5,
      type: 'NORMAL',
      invoiceCurrency: 'NOK',
    });

    const url = harness.soleUrl();
    expect(url.pathname).toBe(
      `/invoice/organizations/${ORG}/invoices/allowed-delivery-methods`,
    );
    expect(url.searchParams.get('customerId')).toBe('7');
    expect(url.searchParams.get('invoiceDueDate')).toBe('2026-08-15');
    expect(url.searchParams.get('sumRemaining')).toBe('1250.5');
    expect(url.searchParams.get('type')).toBe('NORMAL');
  });

  it('declares customerId and type as required on get_allowed_delivery_methods', () => {
    // The OpenAPI spec says optional; the live API returns 400 without them.
    const harness = buildHarness({ orgId: ORG });
    const schema = harness.tools.get('get_allowed_delivery_methods')!.schema;
    const isOptional = (key: string) =>
      (schema[key] as { isOptional(): boolean }).isOptional();

    expect(isOptional('customerId')).toBe(false);
    expect(isOptional('type')).toBe(false);
    expect(isOptional('id')).toBe(true);
  });
});

describe('payment tools', () => {
  it('search_invoice_payments hits the org-wide invoice-payments path', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('search_invoice_payments', { fromDate: '2026-01-01' });

    const url = harness.soleUrl();
    expect(url.pathname).toBe(`/invoice/organizations/${ORG}/invoice-payments`);
    expect(url.searchParams.get('fromDate')).toBe('2026-01-01');
  });

  it('get_invoice_payments nests under the invoice id', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('get_invoice_payments', { id: 88 });

    expect(harness.soleUrl().pathname).toBe(
      `/invoice/organizations/${ORG}/invoices/88/payments`,
    );
  });
});

describe('product and project tools', () => {
  it('search_products and get_product use the products paths', async () => {
    const search = buildHarness({ orgId: ORG });
    await search.call('search_products', { q: 'time' });
    expect(search.soleUrl().pathname).toBe(`/invoice/organizations/${ORG}/products`);

    const read = buildHarness({ orgId: ORG });
    await read.call('get_product', { id: 3 });
    expect(read.soleUrl().pathname).toBe(`/invoice/organizations/${ORG}/products/3`);
  });

  it('search_projects forwards onlyActive as a boolean string', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('search_projects', { onlyActive: true });

    const url = harness.soleUrl();
    expect(url.pathname).toBe(`/invoice/organizations/${ORG}/projects`);
    expect(url.searchParams.get('onlyActive')).toBe('true');
  });

  it('get_project reads a single project by id', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('get_project', { id: 9 });

    expect(harness.soleUrl().pathname).toBe(`/invoice/organizations/${ORG}/projects/9`);
  });
});

describe('report tools', () => {
  it('profit_and_loss_report uses the accounting domain, not the invoice domain', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('profit_and_loss_report', {
      startDate: '2026-01-01',
      endDate: '2026-06-30',
    });

    const url = harness.soleUrl();
    expect(url.pathname).toBe(
      `/accounting/organizations/${ORG}/reports/profit-and-loss-report`,
    );
    expect(url.searchParams.get('startDate')).toBe('2026-01-01');
    expect(url.searchParams.get('endDate')).toBe('2026-06-30');
  });

  it('balance_report repeats array params rather than joining them with commas', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('balance_report', {
      detailedCategories: ['ASSETS', 'EQUITY'],
      bookkeepingAccountNos: ['1500', '2400'],
    });

    const url = harness.soleUrl();
    expect(url.pathname).toBe(`/accounting/organizations/${ORG}/reports/balance-report`);
    expect(url.searchParams.getAll('detailedCategories')).toEqual(['ASSETS', 'EQUITY']);
    expect(url.searchParams.getAll('bookkeepingAccountNos')).toEqual(['1500', '2400']);
  });

  it('trial_balance forwards the account range', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('trial_balance', {
      startBookkeepingAccountNo: '3000',
      endBookkeepingAccountNo: '3999',
    });

    const url = harness.soleUrl();
    expect(url.pathname).toBe(`/accounting/organizations/${ORG}/reports/trial-balance`);
    expect(url.searchParams.get('startBookkeepingAccountNo')).toBe('3000');
    expect(url.searchParams.get('endBookkeepingAccountNo')).toBe('3999');
  });

  it('open_accounts_receivable hits the accounts-receivable/open path', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('open_accounts_receivable', {
      endDate: '2026-12-31',
      customerId: 7,
      roundToTwoDecimals: true,
    });

    const url = harness.soleUrl();
    expect(url.pathname).toBe(
      `/accounting/organizations/${ORG}/reports/accounts-receivable/open`,
    );
    expect(url.searchParams.get('endDate')).toBe('2026-12-31');
    expect(url.searchParams.get('customerId')).toBe('7');
    expect(url.searchParams.get('roundToTwoDecimals')).toBe('true');
  });

  it('declares endDate as required on open_accounts_receivable', () => {
    // The OpenAPI spec says optional; the live API returns 400 without it.
    const harness = buildHarness({ orgId: ORG });
    const schema = harness.tools.get('open_accounts_receivable')!.schema;

    expect((schema.endDate as { isOptional(): boolean }).isOptional()).toBe(false);
    expect((schema.startDate as { isOptional(): boolean }).isOptional()).toBe(true);
  });

  it('income_expenses_key_figures puts the year in the path', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('income_expenses_key_figures', { year: 2026 });

    const url = harness.soleUrl();
    expect(url.pathname).toBe(`/accounting/organizations/${ORG}/income-and-expenses/2026`);
    expect(url.searchParams.has('year')).toBe(false);
  });
});

describe('parameter hygiene', () => {
  it('omits undefined and empty-string params instead of sending blanks', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('search_customers', { q: '', sort: undefined, page: 0 });

    const url = harness.soleUrl();
    expect(url.searchParams.has('q')).toBe(false);
    expect(url.searchParams.has('sort')).toBe(false);
    // page=0 is meaningful (first page) and must survive the empty-value filter.
    expect(url.searchParams.get('page')).toBe('0');
  });

  it('drops empty arrays rather than sending a bare key', async () => {
    const harness = buildHarness({ orgId: ORG });

    await harness.call('balance_report', { detailedCategories: [] });

    expect(harness.soleUrl().searchParams.has('detailedCategories')).toBe(false);
  });

});

describe('error surfacing', () => {
  it("returns Conta's JSON error body as a readable result rather than throwing", async () => {
    const harness = buildHarness({
      orgId: ORG,
      responses: [
        {
          status: 422,
          bodyText: JSON.stringify({ message: 'Invalid date', field: 'startDate' }),
        },
      ],
    });

    const result = await harness.call('profit_and_loss_report', { startDate: 'i går' });

    expect(result.isError).toBe(true);
    expect(resultJson(result)).toEqual({
      httpStatus: 422,
      contaResponse: { message: 'Invalid date', field: 'startDate' },
    });
  });

  it('keeps a non-JSON error body as a raw string', async () => {
    const harness = buildHarness({
      orgId: ORG,
      responses: [{ status: 500, bodyText: 'Internal Server Error' }],
    });

    const result = await harness.call('get_invoice', { id: 1 });

    expect(result.isError).toBe(true);
    expect(resultJson(result)).toEqual({
      httpStatus: 500,
      contaResponse: 'Internal Server Error',
    });
  });

  it('does not leak the API key into an error result', async () => {
    const harness = buildHarness({
      orgId: ORG,
      responses: [{ status: 403, bodyText: 'forbidden' }],
    });

    const result = await harness.call('list_organizations');

    expect(result.content[0].text).not.toContain('harness-key');
  });
});
