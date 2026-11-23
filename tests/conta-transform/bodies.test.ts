import { describe, it, expect } from 'vitest';
import {
  buildPaymentBody,
  buildCreditNoteBody,
  buildCustomerBody,
  buildProductBody,
  buildProjectBody,
  INVOICE_VAT_CODES,
  PRODUCT_VAT_CODES,
} from '../../src/conta-transform.js';

describe('buildPaymentBody', () => {
  const base = { amount: 1500, date: '2026-07-30', bankAccountId: 42 };

  it('builds the payment DTO with the API field names', () => {
    expect(buildPaymentBody(base)).toEqual({
      amount: 1500,
      date: '2026-07-30',
      bankAccountId: 42,
    });
  });

  it('forwards the optional bookkeeping fields', () => {
    const body = buildPaymentBody({
      ...base,
      description: 'Delbetaling',
      departmentId: 3,
      projectId: 9,
      returnPaymentDate: '2026-08-01',
    });

    expect(body.description).toBe('Delbetaling');
    expect(body.departmentId).toBe(3);
    expect(body.projectId).toBe(9);
    expect(body.returnPaymentDate).toBe('2026-08-01');
  });

  it('rejects a zero amount — the spec allows it but it books nothing', () => {
    expect(() => buildPaymentBody({ ...base, amount: 0 })).toThrow(/positive/);
  });

  it('rejects a non-finite amount', () => {
    expect(() => buildPaymentBody({ ...base, amount: Number.NaN })).toThrow(/positive/);
    expect(() => buildPaymentBody({ ...base, amount: Infinity })).toThrow(/positive/);
  });

  it('rejects a negative amount — verified against the API, which enforces min 0.01', () => {
    // A returned payment is expressed with returnPaymentDate, not a negative
    // amount: the API rejects those with "currency.min".
    expect(() => buildPaymentBody({ ...base, amount: -500 })).toThrow(/positive/);
  });

  it('rejects an amount below the 0.01 currency minimum', () => {
    expect(() => buildPaymentBody({ ...base, amount: 0.005 })).toThrow(/0.01/);
    expect(buildPaymentBody({ ...base, amount: 0.01 }).amount).toBe(0.01);
  });

  it('expresses a returned payment with returnPaymentDate', () => {
    const body = buildPaymentBody({ ...base, returnPaymentDate: '2026-08-01' });

    expect(body.amount).toBe(1500);
    expect(body.returnPaymentDate).toBe('2026-08-01');
  });

  it('omits keys the caller left out', () => {
    expect(Object.keys(buildPaymentBody(base)).sort()).toEqual([
      'amount',
      'bankAccountId',
      'date',
    ]);
  });
});

describe('buildCreditNoteBody', () => {
  it('returns an empty body when nothing is specified — Conta then uses defaults', () => {
    expect(buildCreditNoteBody({})).toEqual({});
  });

  it('forwards creditNoteDate and removePaymentsIfExist', () => {
    expect(
      buildCreditNoteBody({ creditNoteDate: '2026-07-30', removePaymentsIfExist: true }),
    ).toEqual({ creditNoteDate: '2026-07-30', removePaymentsIfExist: true });
  });

  it('keeps removePaymentsIfExist=false rather than dropping it as falsy', () => {
    const body = buildCreditNoteBody({ removePaymentsIfExist: false });

    expect('removePaymentsIfExist' in body).toBe(true);
    expect(body.removePaymentsIfExist).toBe(false);
  });

  it('carries recipients for sending the credit note', () => {
    const body = buildCreditNoteBody({
      invoiceRecipients: [{ type: 'EMAIL', emailAddress: 'kunde@example.no' }],
    });

    expect(body.invoiceRecipients).toEqual([
      { type: 'EMAIL', emailAddress: 'kunde@example.no' },
    ]);
  });
});

describe('buildCustomerBody', () => {
  const base = {
    name: 'Acme AS',
    customerType: 'ORGANIZATION' as const,
    customerAddressLine1: 'Storgata 1',
    customerAddressPostcode: '0155',
    customerAddressCity: 'Oslo',
  };

  it('includes all five fields Conta marks required', () => {
    expect(buildCustomerBody(base)).toEqual(base);
  });

  it('forwards the optional identification and contact fields', () => {
    const body = buildCustomerBody({
      ...base,
      orgNo: '999888777',
      emailAddress: 'post@acme.no',
      phoneNo: '99988777',
      invoiceDeliveryMethod: 'EHF',
      ehfRecipientOrgNo: '999888777',
      daysUntilPaymentReminder: 14,
    });

    expect(body.orgNo).toBe('999888777');
    expect(body.emailAddress).toBe('post@acme.no');
    expect(body.invoiceDeliveryMethod).toBe('EHF');
    expect(body.daysUntilPaymentReminder).toBe(14);
  });

  it('nests contacts and strips their undefined keys', () => {
    const body = buildCustomerBody({
      ...base,
      contacts: [{ name: 'Kari Nordmann', emailAddress: 'kari@acme.no', phoneNo: undefined }],
    });

    expect(body.contacts).toEqual([
      { name: 'Kari Nordmann', emailAddress: 'kari@acme.no' },
    ]);
  });

  it('keeps isActive=false rather than dropping it', () => {
    const body = buildCustomerBody({ ...base, isActive: false });

    expect(body.isActive).toBe(false);
  });

  it('keeps a zero defaultInvoiceDiscount', () => {
    expect(buildCustomerBody({ ...base, defaultInvoiceDiscount: 0 }).defaultInvoiceDiscount).toBe(0);
  });
});

describe('buildProductBody', () => {
  it('builds the product DTO with its required trio', () => {
    expect(
      buildProductBody({
        name: 'Rådgivningstime',
        bookkeepingAccountNo: '3000',
        vatCode: 'output.high',
      }),
    ).toEqual({
      name: 'Rådgivningstime',
      bookkeepingAccountNo: '3000',
      vatCode: 'output.high',
    });
  });

  it('forwards price, productNo and isActive', () => {
    const body = buildProductBody({
      name: 'Time',
      bookkeepingAccountNo: '3000',
      vatCode: 'output.high',
      price: 1200,
      productNo: 'T-1',
      isActive: true,
    });

    expect(body.price).toBe(1200);
    expect(body.productNo).toBe('T-1');
    expect(body.isActive).toBe(true);
  });

  it('keeps a zero price (a free line item is legitimate)', () => {
    expect(
      buildProductBody({
        name: 'Gratis',
        bookkeepingAccountNo: '3000',
        vatCode: 'output.zero.rate',
        price: 0,
      }).price,
    ).toBe(0);
  });
});

describe('VAT code enums', () => {
  it('keeps product and invoice-line VAT codes disjoint', () => {
    // A real trap in the Conta API: invoice lines take "high", products take
    // "output.high". Mixing them up is a 400 that reads like a mystery.
    const overlap = INVOICE_VAT_CODES.filter((c) =>
      (PRODUCT_VAT_CODES as readonly string[]).includes(c),
    );

    expect(overlap).toEqual([]);
  });

  it('prefixes every product VAT code with input. or output.', () => {
    for (const code of PRODUCT_VAT_CODES) {
      expect(code).toMatch(/^(input|output)\./);
    }
  });

  it('leaves every invoice-line VAT code unprefixed', () => {
    for (const code of INVOICE_VAT_CODES) {
      expect(code).not.toMatch(/^(input|output)\./);
    }
  });
});

describe('buildProjectBody', () => {
  it('builds the project DTO from just a name', () => {
    expect(buildProjectBody({ name: 'Nytt prosjekt' })).toEqual({ name: 'Nytt prosjekt' });
  });

  it('forwards dates, customer and isHidden', () => {
    const body = buildProjectBody({
      name: 'Prosjekt',
      description: 'Beskrivelse',
      startDate: '2026-08-01',
      endDate: '2026-12-31',
      customerId: 7,
      isHidden: false,
    });

    expect(body).toEqual({
      name: 'Prosjekt',
      description: 'Beskrivelse',
      startDate: '2026-08-01',
      endDate: '2026-12-31',
      customerId: 7,
      isHidden: false,
    });
  });
});
