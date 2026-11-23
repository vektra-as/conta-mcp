import { describe, it, expect } from 'vitest';
import {
  transformInvoiceLine,
  buildInvoiceBody,
  buildInvoiceDraftBody,
  type InvoiceLineInput,
} from '../../src/conta-transform.js';

/**
 * The line nesting is the part of Conta's invoice body most likely to go wrong:
 * `discount` is required on every line, `lineNo` is 1-based, and drafts use a
 * different array key than real invoices. These tests pin all three.
 */

const LINE: InvoiceLineInput = {
  description: 'Rådgivning',
  price: 1200,
  vatCode: 'high',
};

describe('transformInvoiceLine', () => {
  it('fills in the API-required discount and quantity defaults', () => {
    const out = transformInvoiceLine(LINE, 0);

    // Conta marks both required on every line; a caller saying "1 stk, ingen
    // rabatt" should not have to spell that out.
    expect(out.discount).toBe(0);
    expect(out.quantity).toBe(1);
  });

  it('assigns a 1-based lineNo from the array index', () => {
    expect(transformInvoiceLine(LINE, 0).lineNo).toBe(1);
    expect(transformInvoiceLine(LINE, 1).lineNo).toBe(2);
    expect(transformInvoiceLine(LINE, 7).lineNo).toBe(8);
  });

  it('honours an explicitly pinned lineNo over the array position', () => {
    expect(transformInvoiceLine({ ...LINE, lineNo: 99 }, 0).lineNo).toBe(99);
  });

  it('keeps a caller-supplied zero quantity instead of defaulting it to 1', () => {
    // 0 is falsy but meaningful, so ?? must be used rather than ||.
    expect(transformInvoiceLine({ ...LINE, quantity: 0 }, 0).quantity).toBe(0);
  });

  it('keeps an explicit zero discount and a real discount alike', () => {
    expect(transformInvoiceLine({ ...LINE, discount: 0 }, 0).discount).toBe(0);
    expect(transformInvoiceLine({ ...LINE, discount: 25 }, 0).discount).toBe(25);
  });

  it('passes through the optional fields when supplied', () => {
    const out = transformInvoiceLine(
      { ...LINE, productId: 5, sumDiscount: 100, sumNet: 1100 },
      0,
    );

    expect(out.productId).toBe(5);
    expect(out.sumDiscount).toBe(100);
    expect(out.sumNet).toBe(1100);
  });

  it('omits optional fields entirely rather than sending undefined keys', () => {
    const out = transformInvoiceLine(LINE, 0);

    expect(Object.keys(out).sort()).toEqual(
      ['description', 'discount', 'lineNo', 'price', 'quantity', 'vatCode'].sort(),
    );
    expect('productId' in out).toBe(false);
    expect('sumNet' in out).toBe(false);
  });

  it("does not compute sumNet — totals are Conta's job", () => {
    const out = transformInvoiceLine({ ...LINE, quantity: 3, discount: 10 }, 0);
    expect('sumNet' in out).toBe(false);
  });

  it('is pure — it does not mutate its input', () => {
    const input: InvoiceLineInput = { ...LINE };
    const snapshot = JSON.stringify(input);

    transformInvoiceLine(input, 3);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('buildInvoiceBody', () => {
  it('nests lines under invoiceLines and numbers them in order', () => {
    const body = buildInvoiceBody({
      customerId: 1001,
      invoiceLines: [
        { description: 'Første', price: 100, vatCode: 'high' },
        { description: 'Andre', price: 200, vatCode: 'low' },
      ],
    });

    expect(body.customerId).toBe(1001);
    const lines = body.invoiceLines as { description: string; lineNo: number }[];
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(lines.map((l) => l.description)).toEqual(['Første', 'Andre']);
    // Drafts use invoiceDraftLines; a real invoice must not.
    expect('invoiceDraftLines' in body).toBe(false);
  });

  it('throws rather than creating an empty invoice', () => {
    expect(() => buildInvoiceBody({ customerId: 1, invoiceLines: [] })).toThrow(
      /at least one line/,
    );
  });

  it('forwards the optional header fields it is given', () => {
    const body = buildInvoiceBody({
      customerId: 1,
      invoiceLines: [LINE],
      invoiceDate: '2026-07-30',
      invoiceDueDate: '2026-08-29',
      type: 'NORMAL',
      invoiceLanguage: 'NO',
      invoiceCurrency: 'NOK',
      customerReference: 'PO-42',
      personalMessage: 'Takk for oppdraget',
      kid: '1234567890',
      projectId: 9,
    });

    expect(body.invoiceDate).toBe('2026-07-30');
    expect(body.invoiceDueDate).toBe('2026-08-29');
    expect(body.type).toBe('NORMAL');
    expect(body.invoiceLanguage).toBe('NO');
    expect(body.customerReference).toBe('PO-42');
    expect(body.kid).toBe('1234567890');
    expect(body.projectId).toBe(9);
  });

  it('omits every header field the caller left out', () => {
    const body = buildInvoiceBody({ customerId: 1, invoiceLines: [LINE] });

    expect(Object.keys(body).sort()).toEqual(['customerId', 'invoiceLines']);
  });

  it('carries invoiceRecipients through for delivery', () => {
    const body = buildInvoiceBody({
      customerId: 1,
      invoiceLines: [LINE],
      invoiceRecipients: [
        { type: 'EMAIL', emailAddress: 'kunde@example.no', emailSubject: 'Faktura' },
      ],
    });

    expect(body.invoiceRecipients).toEqual([
      { type: 'EMAIL', emailAddress: 'kunde@example.no', emailSubject: 'Faktura' },
    ]);
  });

  it('strips undefined keys out of a recipient', () => {
    const body = buildInvoiceBody({
      customerId: 1,
      invoiceLines: [LINE],
      invoiceRecipients: [{ type: 'MAIL', emailAddress: undefined }],
    });

    expect(body.invoiceRecipients).toEqual([{ type: 'MAIL' }]);
  });
});

describe('buildInvoiceDraftBody', () => {
  it('nests lines under invoiceDraftLines, not invoiceLines', () => {
    const body = buildInvoiceDraftBody({
      invoiceDraftLines: [LINE],
      customerId: 7,
    });

    expect('invoiceDraftLines' in body).toBe(true);
    expect('invoiceLines' in body).toBe(false);
  });

  it('defaults registrationSource to CONTA because the API requires it', () => {
    expect(buildInvoiceDraftBody({ invoiceDraftLines: [LINE], customerId: 7 }).registrationSource).toBe(
      'CONTA',
    );
  });

  it('lets the caller override registrationSource', () => {
    const body = buildInvoiceDraftBody({
      invoiceDraftLines: [LINE],
      customerId: 7,
      registrationSource: 'TIMERABBIT',
    });

    expect(body.registrationSource).toBe('TIMERABBIT');
  });

  it('accepts an empty line list — a draft may legitimately start blank', () => {
    const body = buildInvoiceDraftBody({ invoiceDraftLines: [], customerId: 7 });

    expect(body.invoiceDraftLines).toEqual([]);
  });

  describe('customerId / customerGroupId is exactly-one', () => {
    // Verified against the live API: the spec marks both optional, but the
    // endpoint rejects neither-and-both alike, with the same message.
    it('accepts customerId alone', () => {
      const body = buildInvoiceDraftBody({ invoiceDraftLines: [LINE], customerId: 7 });

      expect(body.customerId).toBe(7);
      expect('customerGroupId' in body).toBe(false);
    });

    it('accepts customerGroupId alone', () => {
      const body = buildInvoiceDraftBody({
        invoiceDraftLines: [LINE],
        customerGroupId: 3,
      });

      expect(body.customerGroupId).toBe(3);
      expect('customerId' in body).toBe(false);
    });

    it('throws when neither is given', () => {
      expect(() => buildInvoiceDraftBody({ invoiceDraftLines: [LINE] })).toThrow(
        /customerId or customerGroupId is required/,
      );
    });

    it('throws when both are given, which the API also rejects', () => {
      expect(() =>
        buildInvoiceDraftBody({
          invoiceDraftLines: [LINE],
          customerId: 7,
          customerGroupId: 3,
        }),
      ).toThrow(/not both/);
    });
  });

  it('applies the same line transform as a real invoice', () => {
    const draft = buildInvoiceDraftBody({ invoiceDraftLines: [LINE], customerId: 7 });
    const invoice = buildInvoiceBody({ customerId: 1, invoiceLines: [LINE] });

    expect(draft.invoiceDraftLines).toEqual(invoice.invoiceLines);
  });
});
