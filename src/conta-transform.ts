/**
 * Pure DTO builders for Conta's write endpoints.
 *
 * These exist so the fiddly parts of Conta's request bodies — the line nesting,
 * the required-but-easy-to-forget `discount`, the 1-based `lineNo` — are in one
 * tested place rather than spread across tool handlers. Everything here is a
 * pure function: no client, no I/O, no clock.
 *
 * Field names match docs/conta-external-api.json verbatim.
 */

/**
 * VAT codes for invoice/draft lines.
 * NOTE: products use a *different* enum — see ProductVatCode.
 */
export type InvoiceVatCode =
  | "no.vat"
  | "high"
  | "medium"
  | "low"
  | "zero.rate"
  | "exempted"
  | "export";

/**
 * VAT codes for products. Deliberately distinct from InvoiceVatCode: Conta
 * prefixes these with input./output. Passing "high" here (or "output.high" on
 * an invoice line) is rejected by the API.
 */
export type ProductVatCode =
  | "input.no.vat"
  | "output.high"
  | "output.medium"
  | "output.low"
  | "output.zero.rate"
  | "output.exempted"
  | "output.export";

export const INVOICE_VAT_CODES: readonly InvoiceVatCode[] = [
  "no.vat",
  "high",
  "medium",
  "low",
  "zero.rate",
  "exempted",
  "export",
];

export const PRODUCT_VAT_CODES: readonly ProductVatCode[] = [
  "input.no.vat",
  "output.high",
  "output.medium",
  "output.low",
  "output.zero.rate",
  "output.exempted",
  "output.export",
];

export type InvoiceType = "NORMAL" | "CASH" | "CREDIT";
export type Language = "NO" | "EN";
export type RegistrationSource = "CONTA" | "TIMERABBIT";
export type DeliveryMethodType =
  | "EMAIL"
  | "MAIL"
  | "EHF"
  | "EFAKTURA"
  | "INVOICE_SALE"
  | "DO_NOT_DELIVER"
  | "UNKNOWN"
  | "NONE";

/** One invoice/draft line as accepted from a tool caller. */
export interface InvoiceLineInput {
  description: string;
  price: number;
  vatCode: InvoiceVatCode;
  /** Defaults to 1. */
  quantity?: number;
  /** Percent. Required by the API; defaults to 0. */
  discount?: number;
  productId?: number;
  /** Discount in NOK, as an alternative to a percentage. */
  sumDiscount?: number;
  /** Net sum for the line. Normally left to Conta to compute. */
  sumNet?: number;
  /** 1-based position. Assigned from array order when omitted. */
  lineNo?: number;
}

/** A line as Conta's API expects it. */
export interface InvoiceLineBody {
  description: string;
  price: number;
  vatCode: InvoiceVatCode;
  quantity: number;
  discount: number;
  lineNo: number;
  productId?: number;
  sumDiscount?: number;
  sumNet?: number;
}

/** Drop keys whose value is undefined, so we never send explicit nulls. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k as keyof T] = v as T[keyof T];
  }
  return out;
}

/**
 * Map one caller-supplied line onto Conta's line DTO.
 *
 * `index` is the 0-based array position; lineNo becomes index + 1 unless the
 * caller pinned it explicitly. `discount` and `quantity` are filled in because
 * Conta marks both required on every line, and a caller who says "1 stk, ingen
 * rabatt" should not have to spell that out.
 */
export function transformInvoiceLine(
  line: InvoiceLineInput,
  index: number
): InvoiceLineBody {
  return compact({
    description: line.description,
    price: line.price,
    vatCode: line.vatCode,
    quantity: line.quantity ?? 1,
    discount: line.discount ?? 0,
    lineNo: line.lineNo ?? index + 1,
    productId: line.productId,
    sumDiscount: line.sumDiscount,
    sumNet: line.sumNet,
  });
}

/** Fields shared by the invoice and draft bodies. */
interface InvoiceCommonInput {
  customerId?: number;
  type?: InvoiceType;
  departmentId?: number;
  projectId?: number;
  invoiceLanguage?: Language;
  invoiceCurrency?: string;
  personalMessage?: string;
  customerReference?: string;
  attachmentFileId?: number;
}

export interface BuildInvoiceInput extends InvoiceCommonInput {
  /** Required for a real invoice (unlike a draft). */
  customerId: number;
  invoiceLines: InvoiceLineInput[];
  invoiceDate?: string;
  invoiceDueDate?: string;
  invoiceNo?: number;
  kid?: string;
  orgReference?: string;
  showDiscount?: boolean;
  deliveryDate?: string;
  ehfOrderReference?: string;
  invoiceRecipients?: InvoiceRecipientInput[];
}

export interface InvoiceRecipientInput {
  type: DeliveryMethodType;
  emailAddress?: string;
  emailSubject?: string;
  emailContent?: string;
  name?: string;
  ehfRecipient?: string;
  includeInvoiceAttachment?: boolean;
  mailAddressLine1?: string;
  mailAddressPostcode?: string;
  mailAddressCity?: string;
  mailAddressCountryCode?: string;
}

/**
 * Build the POST /invoices body. Lines land under `invoiceLines`.
 * Throws when there are no lines — Conta would otherwise create an empty
 * invoice, which is never what the caller meant.
 */
export function buildInvoiceBody(
  input: BuildInvoiceInput
): Record<string, unknown> {
  if (input.invoiceLines.length === 0) {
    throw new Error("invoiceLines is empty — an invoice needs at least one line");
  }
  return compact({
    customerId: input.customerId,
    invoiceLines: input.invoiceLines.map(transformInvoiceLine),
    invoiceRecipients: input.invoiceRecipients?.map((r) => compact({ ...r })),
    type: input.type,
    invoiceDate: input.invoiceDate,
    invoiceDueDate: input.invoiceDueDate,
    invoiceNo: input.invoiceNo,
    departmentId: input.departmentId,
    projectId: input.projectId,
    invoiceLanguage: input.invoiceLanguage,
    invoiceCurrency: input.invoiceCurrency,
    personalMessage: input.personalMessage,
    customerReference: input.customerReference,
    attachmentFileId: input.attachmentFileId,
    kid: input.kid,
    orgReference: input.orgReference,
    showDiscount: input.showDiscount,
    deliveryDate: input.deliveryDate,
    ehfOrderReference: input.ehfOrderReference,
  });
}

export interface BuildInvoiceDraftInput extends InvoiceCommonInput {
  invoiceDraftLines: InvoiceLineInput[];
  /** Defaults to "CONTA". Required by the API. */
  registrationSource?: RegistrationSource;
  customerGroupId?: number;
}

/**
 * Build the POST /invoice-drafts body. Differences from a real invoice: lines
 * go under `invoiceDraftLines`, and `registrationSource` is required.
 *
 * The API additionally requires EXACTLY ONE of customerId / customerGroupId —
 * the OpenAPI spec marks both optional, and supplying both is rejected with the
 * same misleading "kunde eller kundegruppe mangler" message as supplying
 * neither. We check locally so the caller gets an accurate message.
 */
export function buildInvoiceDraftBody(
  input: BuildInvoiceDraftInput
): Record<string, unknown> {
  const hasCustomer = input.customerId !== undefined;
  const hasGroup = input.customerGroupId !== undefined;
  if (hasCustomer === hasGroup) {
    throw new Error(
      hasCustomer
        ? "pass either customerId or customerGroupId, not both"
        : "customerId or customerGroupId is required on an invoice draft"
    );
  }
  return compact({
    registrationSource: input.registrationSource ?? "CONTA",
    invoiceDraftLines: input.invoiceDraftLines.map(transformInvoiceLine),
    customerId: input.customerId,
    customerGroupId: input.customerGroupId,
    type: input.type,
    departmentId: input.departmentId,
    projectId: input.projectId,
    invoiceLanguage: input.invoiceLanguage,
    invoiceCurrency: input.invoiceCurrency,
    personalMessage: input.personalMessage,
    customerReference: input.customerReference,
    attachmentFileId: input.attachmentFileId,
  });
}

export interface BuildPaymentInput {
  amount: number;
  date: string;
  bankAccountId: number;
  description?: string;
  departmentId?: number;
  projectId?: number;
  returnPaymentDate?: string;
}

/**
 * Build the POST /invoices/{invoiceId}/payments body.
 *
 * The spec declares no required fields, but a payment without an amount, a date
 * and a bank account cannot be booked, so we reject those locally.
 *
 * `amount` must be positive: the API enforces a currency minimum of 0.01 and
 * rejects negatives outright ("currency.min"). A returned payment is expressed
 * with `returnPaymentDate`, not with a negative amount.
 */
export function buildPaymentBody(
  input: BuildPaymentInput
): Record<string, unknown> {
  if (!Number.isFinite(input.amount) || input.amount < 0.01) {
    throw new Error("amount must be a positive number of at least 0.01");
  }
  return compact({
    amount: input.amount,
    date: input.date,
    bankAccountId: input.bankAccountId,
    description: input.description,
    departmentId: input.departmentId,
    projectId: input.projectId,
    returnPaymentDate: input.returnPaymentDate,
  });
}

export interface BuildCreditNoteInput {
  creditNoteDate?: string;
  removePaymentsIfExist?: boolean;
  invoiceRecipients?: InvoiceRecipientInput[];
}

/** Build the POST /invoices/{id}/credit-note body (full credit note). */
export function buildCreditNoteBody(
  input: BuildCreditNoteInput
): Record<string, unknown> {
  return compact({
    creditNoteDate: input.creditNoteDate,
    removePaymentsIfExist: input.removePaymentsIfExist,
    invoiceRecipients: input.invoiceRecipients?.map((r) => compact({ ...r })),
  });
}

export interface CustomerContactInput {
  name?: string;
  emailAddress?: string;
  phoneNo?: string;
  title?: string;
}

export interface BuildCustomerInput {
  name: string;
  customerType: "INDIVIDUAL" | "ORGANIZATION";
  customerAddressLine1: string;
  customerAddressPostcode: string;
  customerAddressCity: string;
  customerAddressLine2?: string;
  customerAddressCountry?: string;
  orgNo?: string;
  phoneNo?: string;
  emailAddress?: string;
  dateOfBirth?: string;
  daysUntilPaymentReminder?: number;
  defaultInvoiceDiscount?: number;
  invoiceDeliveryMethod?: DeliveryMethodType;
  ehfRecipientOrgNo?: string;
  isActive?: boolean;
  contacts?: CustomerContactInput[];
}

/**
 * Build the customer body for POST /customers and PUT /customers/{id}.
 * The five address/name/type fields Conta marks required are non-optional in
 * the input type, so a missing one is a compile-time and schema-time error
 * rather than a 400.
 */
export function buildCustomerBody(
  input: BuildCustomerInput
): Record<string, unknown> {
  return compact({
    name: input.name,
    customerType: input.customerType,
    customerAddressLine1: input.customerAddressLine1,
    customerAddressPostcode: input.customerAddressPostcode,
    customerAddressCity: input.customerAddressCity,
    customerAddressLine2: input.customerAddressLine2,
    customerAddressCountry: input.customerAddressCountry,
    orgNo: input.orgNo,
    phoneNo: input.phoneNo,
    emailAddress: input.emailAddress,
    dateOfBirth: input.dateOfBirth,
    daysUntilPaymentReminder: input.daysUntilPaymentReminder,
    defaultInvoiceDiscount: input.defaultInvoiceDiscount,
    invoiceDeliveryMethod: input.invoiceDeliveryMethod,
    ehfRecipientOrgNo: input.ehfRecipientOrgNo,
    isActive: input.isActive,
    contacts: input.contacts?.map((c) => compact({ ...c })),
  });
}

export interface BuildProductInput {
  name: string;
  bookkeepingAccountNo: string;
  vatCode: ProductVatCode;
  price?: number;
  productNo?: string;
  isActive?: boolean;
}

/** Build the POST /products body. Note the product-specific VAT code enum. */
export function buildProductBody(
  input: BuildProductInput
): Record<string, unknown> {
  return compact({
    name: input.name,
    bookkeepingAccountNo: input.bookkeepingAccountNo,
    vatCode: input.vatCode,
    price: input.price,
    productNo: input.productNo,
    isActive: input.isActive,
  });
}

export interface BuildProjectInput {
  name: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  customerId?: number;
  isHidden?: boolean;
}

/** Build the POST /projects body. */
export function buildProjectBody(
  input: BuildProjectInput
): Record<string, unknown> {
  return compact({
    name: input.name,
    description: input.description,
    startDate: input.startDate,
    endDate: input.endDate,
    customerId: input.customerId,
    isHidden: input.isHidden,
  });
}
