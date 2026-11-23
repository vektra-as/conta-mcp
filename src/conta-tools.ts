/**
 * All Conta MCP tool registrations.
 *
 * Every field name in these schemas matches the Conta API's own parameter names
 * verbatim (see docs/conta-external-api.json). That is deliberate: when a call
 * fails, the API's error text refers to names the model already used, so it can
 * self-correct without a translation layer.
 *
 * Every write tool carries a `dryRun` flag. Which tools get registered is
 * controlled by a ToolPolicy (see toolPolicyFromEnv): CONTA_READ_ONLY=true
 * registers only read tools, and delete_payment is only registered when
 * CONTA_ALLOW_DELETE=true.
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ContaApiError, ContaClient, type QueryParams } from "./conta-client.js";
import {
  buildCreditNoteBody,
  buildCustomerBody,
  buildInvoiceBody,
  buildInvoiceDraftBody,
  buildPaymentBody,
  buildProductBody,
  buildProjectBody,
  mergeCustomerUpdate,
  INVOICE_VAT_CODES,
  PRODUCT_VAT_CODES,
  type InvoiceVatCode,
  type ProductVatCode,
} from "./conta-transform.js";
import { registerSkills } from "./skills/registry.js";

/** Default cap on the size of one tool result, in characters. */
export const DEFAULT_MAX_RESPONSE_CHARS = 100_000;

/**
 * Serialise a successful tool result. Very large results (e.g. hits=0 on a big
 * account) are cut so they cannot flood the model's context window.
 */
export function formatResult(data: unknown, maxChars = DEFAULT_MAX_RESPONSE_CHARS): string {
  const text = JSON.stringify(data) ?? "null";
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n\n[AVKORTET: svaret var ${text.length} tegn, viser de første ${maxChars}. ` +
    "Bruk hits/page eller smalere filtre for å hente resten.]"
  );
}

/**
 * Surface Conta's own error payload rather than a generic message, so the model
 * can read the API's validation feedback and retry with corrected arguments.
 */
function formatContaError(e: ContaApiError): string {
  let parsed: unknown = e.bodyText;
  try {
    parsed = JSON.parse(e.bodyText) as unknown;
  } catch {
    /* keep raw string */
  }
  return JSON.stringify({ httpStatus: e.status, contaResponse: parsed }, null, 2);
}

/**
 * Run a tool body, converting ContaApiError into a readable tool result and
 * marking it as an error so the client can distinguish it from success.
 */
async function runTool<T>(fn: () => Promise<T>, maxChars: number) {
  try {
    const data = await fn();
    return { content: [{ type: "text" as const, text: formatResult(data, maxChars) }] };
  } catch (e) {
    if (e instanceof ContaApiError) {
      return {
        content: [{ type: "text" as const, text: formatContaError(e) }],
        isError: true,
      };
    }
    if (e instanceof Error) {
      // Local validation failures (e.g. missing org id) are useful to the model
      // too, and must not crash the transport.
      return {
        content: [{ type: "text" as const, text: e.message }],
        isError: true,
      };
    }
    throw e;
  }
}

/** Drop undefined/null/empty-string entries so we never send blank params. */
function params(obj: QueryParams): QueryParams {
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

// ==================== TOOL POLICY ====================

/** Which tools get registered, and how large a result may be. */
export interface ToolPolicy {
  /**
   * Register only tools that cannot change data. Unset here means false, so
   * programmatic callers opt in explicitly; the env reader defaults to true.
   */
  readOnly?: boolean;
  /**
   * Allow irreversible removals: register delete_payment, and let
   * create_credit_note remove payments (removePaymentsIfExist). Default false.
   */
  allowDelete?: boolean;
  /** Cap on one tool result, in characters. Default DEFAULT_MAX_RESPONSE_CHARS. */
  maxResponseChars?: number;
}

const TRUE_VALUES = ["1", "true", "yes", "ja"];
const FALSE_VALUES = ["0", "false", "no", "nei"];

/**
 * Parse a boolean env flag. Unset or empty gives the default; anything that is
 * not a recognised yes/no is refused, so a typo such as "on" or "treu" stops
 * the server instead of silently choosing a mode.
 */
function envFlag(name: string, value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  const v = value.trim().toLowerCase();
  if (TRUE_VALUES.includes(v)) return true;
  if (FALSE_VALUES.includes(v)) return false;
  throw new Error(
    `${name} must be one of ${[...TRUE_VALUES, ...FALSE_VALUES].join(", ")}, got "${value}"`,
  );
}

/**
 * Read CONTA_READ_ONLY, CONTA_ALLOW_DELETE and CONTA_MAX_RESPONSE_CHARS.
 * Read-only is the default: write tools are only registered with an explicit
 * CONTA_READ_ONLY=false.
 */
export function toolPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ToolPolicy {
  const rawMax = env.CONTA_MAX_RESPONSE_CHARS;
  let maxResponseChars: number | undefined;
  if (rawMax !== undefined && rawMax !== "") {
    const parsed = Number(rawMax);
    if (!Number.isInteger(parsed) || parsed < 1000) {
      throw new Error(`CONTA_MAX_RESPONSE_CHARS must be an integer >= 1000, got "${rawMax}"`);
    }
    maxResponseChars = parsed;
  }
  return {
    readOnly: envFlag("CONTA_READ_ONLY", env.CONTA_READ_ONLY, true),
    allowDelete: envFlag("CONTA_ALLOW_DELETE", env.CONTA_ALLOW_DELETE, false),
    maxResponseChars,
  };
}

/** Tools that change data. Everything not listed here is read-only. */
const WRITE_TOOLS: Record<string, ToolAnnotations> = {
  create_customer: { destructiveHint: false, idempotentHint: false },
  update_customer: { destructiveHint: true, idempotentHint: true },
  create_invoice_draft: { destructiveHint: false, idempotentHint: false },
  create_invoice: { destructiveHint: false, idempotentHint: false },
  // Can remove registered payments (removePaymentsIfExist).
  create_credit_note: { destructiveHint: true, idempotentHint: false },
  register_invoice_payment: { destructiveHint: false, idempotentHint: false },
  delete_payment: { destructiveHint: true, idempotentHint: true },
  create_product: { destructiveHint: false, idempotentHint: false },
  create_project: { destructiveHint: false, idempotentHint: false },
};

/** Tools that are only registered with allowDelete. */
const DELETE_TOOLS = new Set(["delete_payment"]);

/** MCP tool annotations for a tool, so clients can ask before risky calls. */
export function toolAnnotations(name: string): ToolAnnotations {
  const write = WRITE_TOOLS[name];
  if (write) return { readOnlyHint: false, openWorldHint: true, ...write };
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
}

/**
 * When dryRun is set, Conta rolls the database transaction back, but it is not
 * documented whether that also stops an e-mail/EHF/post dispatch. To be safe,
 * delivery recipients are never sent on a dry run.
 */
export const DRY_RUN_RECIPIENTS_NOTE =
  "dryRun: invoiceRecipients ble ikke sendt til Conta, slik at ingenting kan bli levert til kunden. Leveringsmåtene er derfor ikke validert.";

function stripRecipientsOnDryRun<T extends { invoiceRecipients?: unknown[] }>(
  dryRun: boolean | undefined,
  fields: T,
): { fields: T; stripped: boolean } {
  if (!dryRun || !fields.invoiceRecipients || fields.invoiceRecipients.length === 0) {
    return { fields, stripped: false };
  }
  const { invoiceRecipients: _dropped, ...rest } = fields;
  return { fields: rest as T, stripped: true };
}

// ==================== SHARED SCHEMA FRAGMENTS ====================

/** Standard pagination/search params shared by Conta's search endpoints. */
const querySchema = {
  q: z.string().optional().describe("Søketerm. Matches mot alle søkbare felt."),
  hits: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Antall treff per side. Default 20. Sett 0 for å hente alle."),
  page: z.number().int().min(0).optional().describe("Sidenummer. Default 0."),
  sort: z
    .string()
    .optional()
    .describe(
      "Kommaseparert liste med feltnavn, prefikset med + (stigende) eller - (synkende).",
    ),
  fromDate: z.string().optional().describe("YYYY-MM-DD. Filtrerer på createdAt."),
  toDate: z.string().optional().describe("YYYY-MM-DD. Filtrerer på createdAt."),
};

/** Every org-scoped tool takes this; it falls back to CONTA_ORG_ID. */
const orgSchema = {
  opContextOrgId: z
    .number()
    .int()
    .optional()
    .describe(
      "Organisasjons-id. Utelates hvis CONTA_ORG_ID er satt. Bruk list_organizations for gyldige id-er.",
    ),
};

/** Shared date-range filter used by the accounting reports. */
const reportDateSchema = {
  startDate: z.string().optional().describe("YYYY-MM-DD. Fra-dato for perioden."),
  endDate: z.string().optional().describe("YYYY-MM-DD. Til-dato for perioden."),
  departmentId: z.number().int().optional().describe("Filtrer på avdeling."),
  projectId: z.number().int().optional().describe("Filtrer på prosjekt."),
};

const invoiceListFilterType = z
  .enum([
    "PAID",
    "UNPAID",
    "ACTIVE",
    "REPEATING",
    "OVERDUE",
    "PAYMENT_REMINDERS_OVERDUE",
    "FOLLOW_UP",
    "KRAVIA",
  ])
  .describe("Statusfilter for fakturalisten.");

const deliveryMethodType = z.enum([
  "EMAIL",
  "MAIL",
  "EHF",
  "EFAKTURA",
  "INVOICE_SALE",
  "DO_NOT_DELIVER",
  "UNKNOWN",
  "NONE",
]);

/**
 * Present on every write tool. When true, Conta ruller transaksjonen tilbake
 * etter at requesten er validert — svaret viser hva som VILLE blitt lagret.
 *
 * Default er false: en LLM som tror den har lagret noe, men ikke har det, er
 * verre enn en som må be om lov. Bruk dryRun=true for å validere først.
 */
const dryRunSchema = {
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "true = valider mot Conta og rull tilbake (ingenting lagres). Default false = lagrer for ekte.",
    ),
};

/** Zod-schema for one invoice/draft line. Mirrors Conta's line DTO. */
const invoiceLineSchema = z.object({
  description: z.string().describe("Tekst som vises på fakturalinjen. Påkrevd."),
  price: z.number().describe("Pris eks. mva per enhet, i fakturaens valuta. Påkrevd."),
  vatCode: z
    .enum(INVOICE_VAT_CODES as unknown as [InvoiceVatCode, ...InvoiceVatCode[]])
    .describe(
      "Mva-kode for linjen. Påkrevd. MERK: fakturalinjer bruker 'high'/'low' — produkter bruker 'output.high'.",
    ),
  quantity: z.number().optional().describe("Antall enheter. Default 1."),
  discount: z.number().optional().describe("Rabatt i prosent. Default 0."),
  productId: z.number().int().optional().describe("Knytt linjen til et produkt."),
  sumDiscount: z.number().optional().describe("Rabatt i kroner, som alternativ til prosent."),
  lineNo: z
    .number()
    .int()
    .optional()
    .describe("Linjenummer (1-basert). Settes automatisk fra rekkefølgen hvis utelatt."),
});

/** Zod-schema for a delivery recipient on an invoice or credit note. */
const invoiceRecipientSchema = z.object({
  type: deliveryMethodType.describe("Leveringsmåte. Bruk get_allowed_delivery_methods først."),
  emailAddress: z.string().optional(),
  emailSubject: z.string().optional(),
  emailContent: z.string().optional(),
  name: z.string().optional(),
  ehfRecipient: z.string().optional().describe("Organisasjonsnummer for EHF-mottaker."),
  includeInvoiceAttachment: z.boolean().optional(),
  mailAddressLine1: z.string().optional(),
  mailAddressPostcode: z.string().optional(),
  mailAddressCity: z.string().optional(),
  mailAddressCountryCode: z.string().optional().describe("Nøyaktig to tegn, f.eks. NO."),
});

/** Shared customer fields for create_customer and update_customer. */
const customerFieldsSchema = {
  name: z.string().describe("Kundens navn. Påkrevd."),
  customerType: z
    .enum(["INDIVIDUAL", "ORGANIZATION"])
    .describe("Privatperson eller virksomhet. Påkrevd."),
  customerAddressLine1: z.string().describe("Adresse, linje 1. Påkrevd."),
  customerAddressPostcode: z.string().describe("Postnummer. Påkrevd."),
  customerAddressCity: z.string().describe("Poststed. Påkrevd."),
  customerAddressLine2: z.string().optional(),
  customerAddressCountry: z.string().optional(),
  orgNo: z.string().optional().describe("Organisasjonsnummer. Hent fra search_enhetsregisteret."),
  phoneNo: z.string().optional(),
  emailAddress: z.string().optional(),
  dateOfBirth: z.string().optional().describe("YYYY-MM-DD. Kun for privatpersoner."),
  daysUntilPaymentReminder: z
    .number()
    .int()
    .optional()
    .describe("Standard antall dager til forfall for denne kunden."),
  defaultInvoiceDiscount: z.number().optional().describe("Standard rabatt i prosent."),
  invoiceDeliveryMethod: deliveryMethodType.optional(),
  ehfRecipientOrgNo: z.string().optional(),
  isActive: z.boolean().optional(),
  contacts: z
    .array(
      z.object({
        name: z.string().optional(),
        emailAddress: z.string().optional(),
        phoneNo: z.string().optional(),
        title: z.string().optional(),
      }),
    )
    .optional()
    .describe("Kontaktpersoner hos kunden."),
};

export function registerAllTools(
  server: McpServer,
  client: ContaClient,
  policy: ToolPolicy = {},
) {
  registerSkills(server);

  const maxChars = policy.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
  const run = <T>(fn: () => Promise<T>) => runTool(fn, maxChars);

  /**
   * Register one tool with annotations, honouring the policy: write tools are
   * skipped in read-only mode, delete tools unless explicitly allowed.
   */
  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Shape,
    handler: ToolCallback<Shape>,
  ): void => {
    if (policy.readOnly && name in WRITE_TOOLS) return;
    if (DELETE_TOOLS.has(name) && !policy.allowDelete) return;
    server.registerTool(
      name,
      { description, inputSchema, annotations: toolAnnotations(name) },
      handler,
    );
  };

  /** Build an org-scoped path, resolving the org id from args or env. */
  const orgPath = (opContextOrgId: number | undefined, suffix: string): string =>
    `/invoice/organizations/${client.resolveOrgId(opContextOrgId)}${suffix}`;

  const accountingPath = (
    opContextOrgId: number | undefined,
    suffix: string,
  ): string =>
    `/accounting/organizations/${client.resolveOrgId(opContextOrgId)}${suffix}`;

  // ==================== ORG / OPPSETT ====================

  tool(
    "ping",
    "Healthcheck mot Conta-API-et. Bruk denne for å bekrefte at API-nøkkelen når fram før du feilsøker andre kall.",
    {},
    async () => run(() => client.get("/invoice/ping")),
  );

  tool(
    "list_organizations",
    "List organisasjonene API-nøkkelen har tilgang til. Returnerer id, navn, blockedStatus og active. Bruk id-en som opContextOrgId i de andre verktøyene.",
    {},
    async () => run(() => client.get("/invoice/organizations")),
  );

  tool(
    "get_account_settings",
    "Les brukeren og brukerens innstillinger for den innloggede API-nøkkelen.",
    {},
    async () => run(() => client.get("/invoice/account/settings")),
  );

  // ==================== KUNDER ====================

  tool(
    "search_customers",
    "Søk i kunder. Bruk q for fritekstsøk mot navn, org.nr, e-post osv.",
    {
      ...orgSchema,
      ...querySchema,
      customerType: z
        .enum(["INDIVIDUAL", "ORGANIZATION"])
        .optional()
        .describe("Privatperson eller virksomhet."),
      modifiedFromDate: z.string().optional().describe("YYYY-MM-DD."),
      modifiedToDate: z.string().optional().describe("YYYY-MM-DD."),
    },
    async ({ opContextOrgId, ...rest }) =>
      run(() => client.get(orgPath(opContextOrgId, "/customers"), params(rest))),
  );

  tool(
    "get_customer",
    "Hent én kunde med id.",
    {
      ...orgSchema,
      id: z.number().int().describe("Kunde-id."),
    },
    async ({ opContextOrgId, id }) =>
      run(() => client.get(orgPath(opContextOrgId, `/customers/${id}`))),
  );

  tool(
    "search_enhetsregisteret",
    "Søk opp norske virksomheter i Enhetsregisteret på navn eller organisasjonsnummer. Brukes til å fylle ut kundedata før create_customer. Ikke org-scopet.",
    querySchema,
    async (args) =>
      run(() => client.get("/invoice/enhetsregisteret/search", params(args))),
  );

  // ==================== FAKTURA ====================

  tool(
    "search_invoices",
    "Søk i fakturaer. Bruk type for statusfilter (f.eks. UNPAID eller OVERDUE) og customerId for å begrense til én kunde.",
    {
      ...orgSchema,
      ...querySchema,
      type: invoiceListFilterType.optional(),
      customerId: z.number().int().optional(),
      departmentId: z.number().int().optional(),
      projectId: z.number().int().optional(),
      invoiceNo: z.number().int().optional().describe("Eksakt fakturanummer."),
      invoiceCurrency: z.string().optional().describe("Valutakode, f.eks. NOK."),
      isCreatedInOtherSystem: z.boolean().optional(),
      includeCreatedAt: z.boolean().optional(),
      includeCreatedByIp: z.boolean().optional(),
      kraviaInvoiceStatuses: z
        .array(z.enum(["ACTIVE", "WITHDRAWN", "CLOSED"]))
        .optional()
        .describe("Filtrer på Kravia-inkassostatus."),
    },
    async ({ opContextOrgId, ...rest }) =>
      run(() => client.get(orgPath(opContextOrgId, "/invoices"), params(rest))),
  );

  tool(
    "get_invoice",
    "Hent én faktura med id, inkludert fakturalinjer og betalingsstatus.",
    {
      ...orgSchema,
      id: z.number().int().describe("Faktura-id (ikke fakturanummer)."),
    },
    async ({ opContextOrgId, id }) =>
      run(() => client.get(orgPath(opContextOrgId, `/invoices/${id}`))),
  );

  tool(
    "search_invoice_drafts",
    "Søk i fakturakladder. Bruk denne for å finne id-en en kladd har før du henter den med get_invoice_draft.",
    {
      ...orgSchema,
      ...querySchema,
      type: invoiceListFilterType.optional(),
      customerId: z.number().int().optional(),
      departmentId: z.number().int().optional(),
      projectId: z.number().int().optional(),
      invoiceCurrency: z.string().optional(),
      includeCreatedAt: z.boolean().optional(),
      includeCreatedByIp: z.boolean().optional(),
    },
    async ({ opContextOrgId, ...rest }) =>
      run(() =>
        client.get(orgPath(opContextOrgId, "/invoice-drafts"), params(rest)),
      ),
  );

  tool(
    "get_invoice_draft",
    "Hent én fakturakladd med id.",
    {
      ...orgSchema,
      id: z.number().int().describe("Kladd-id."),
    },
    async ({ opContextOrgId, id }) =>
      run(() => client.get(orgPath(opContextOrgId, `/invoice-drafts/${id}`))),
  );

  tool(
    "get_unpaid_invoices",
    "Hent de 3 siste ubetalte fakturaene sammen med nøkkeltall. Merk: dette er et dashbord-endepunkt med fast antall — bruk search_invoices med type=UNPAID for en fullstendig liste.",
    orgSchema,
    async ({ opContextOrgId }) =>
      run(() => client.get(orgPath(opContextOrgId, "/invoices/unpaid"))),
  );

  tool(
    "get_allowed_delivery_methods",
    "Hent tillatte leveringsmåter (f.eks. EMAIL, MAIL, EHF) for en faktura. customerId og type er påkrevd. Oppgi i tillegg id for en eksisterende faktura — det snevrer inn svaret til hva som faktisk er lov for den fakturaen.",
    {
      ...orgSchema,
      // The spec marks all of these optional, but the API returns
      // 400 "customerId mangler" / "type mangler" without them.
      customerId: z.number().int().describe("Kunde-id fakturaen gjelder. Påkrevd."),
      type: z
        .enum(["NORMAL", "CASH", "CREDIT"])
        .describe("Fakturatype. Påkrevd."),
      id: z
        .number()
        .int()
        .optional()
        .describe("Faktura-id, for en eksisterende faktura."),
      invoiceDueDate: z.string().optional().describe("YYYY-MM-DD."),
      sumRemaining: z.number().optional().describe("Restbeløp på fakturaen."),
      invoiceCurrency: z.string().optional().describe("Valutakode, f.eks. NOK."),
    },
    async ({ opContextOrgId, ...rest }) =>
      run(() =>
        client.get(
          orgPath(opContextOrgId, "/invoices/allowed-delivery-methods"),
          params(rest),
        ),
      ),
  );

  // ==================== BETALINGER ====================

  tool(
    "search_invoice_payments",
    "Søk i innbetalinger på tvers av alle fakturaer.",
    { ...orgSchema, ...querySchema },
    async ({ opContextOrgId, ...rest }) =>
      run(() =>
        client.get(orgPath(opContextOrgId, "/invoice-payments"), params(rest)),
      ),
  );

  tool(
    "get_invoice_payments",
    "Hent alle innbetalinger på én bestemt faktura.",
    {
      ...orgSchema,
      id: z.number().int().describe("Faktura-id."),
    },
    async ({ opContextOrgId, id }) =>
      run(() => client.get(orgPath(opContextOrgId, `/invoices/${id}/payments`))),
  );

  // ==================== PRODUKTER ====================

  tool(
    "search_products",
    "Søk i produkter/tjenester.",
    { ...orgSchema, ...querySchema },
    async ({ opContextOrgId, ...rest }) =>
      run(() => client.get(orgPath(opContextOrgId, "/products"), params(rest))),
  );

  tool(
    "get_product",
    "Hent ett produkt med id.",
    {
      ...orgSchema,
      id: z.number().int().describe("Produkt-id."),
    },
    async ({ opContextOrgId, id }) =>
      run(() => client.get(orgPath(opContextOrgId, `/products/${id}`))),
  );

  // ==================== PROSJEKTER ====================

  tool(
    "search_projects",
    "Søk i prosjekter.",
    {
      ...orgSchema,
      ...querySchema,
      onlyActive: z.boolean().optional().describe("Kun aktive prosjekter."),
    },
    async ({ opContextOrgId, ...rest }) =>
      run(() => client.get(orgPath(opContextOrgId, "/projects"), params(rest))),
  );

  tool(
    "get_project",
    "Hent ett prosjekt med id.",
    {
      ...orgSchema,
      id: z.number().int().describe("Prosjekt-id."),
    },
    async ({ opContextOrgId, id }) =>
      run(() => client.get(orgPath(opContextOrgId, `/projects/${id}`))),
  );

  // ==================== RAPPORTER (read-only) ====================

  tool(
    "profit_and_loss_report",
    "Resultatrapport for en periode. Uten startDate/endDate bruker Conta sin egen standardperiode.",
    {
      ...orgSchema,
      ...reportDateSchema,
      bookkeepingAccountNos: z
        .array(z.string())
        .optional()
        .describe("Kontonumre som skal spesifiseres i rapporten."),
      detailedCategories: z
        .array(z.string())
        .optional()
        .describe(
          "Kontokategorier som skal detaljeres, f.eks. SALES_REVENUE, PERSONNEL_COSTS, OPERATING_PROFIT.",
        ),
    },
    async ({ opContextOrgId, ...rest }) =>
      run(() =>
        client.get(
          accountingPath(opContextOrgId, "/reports/profit-and-loss-report"),
          params(rest),
        ),
      ),
  );

  tool(
    "balance_report",
    "Balanserapport for en periode.",
    {
      ...orgSchema,
      ...reportDateSchema,
      bookkeepingAccountNos: z
        .array(z.string())
        .optional()
        .describe("Kontonumre som skal spesifiseres i rapporten."),
      detailedCategories: z
        .array(z.string())
        .optional()
        .describe(
          "Kontokategorier som skal detaljeres, f.eks. ASSETS, EQUITY, SHORT_TERM_LIABILITIES.",
        ),
    },
    async ({ opContextOrgId, ...rest }) =>
      run(() =>
        client.get(
          accountingPath(opContextOrgId, "/reports/balance-report"),
          params(rest),
        ),
      ),
  );

  tool(
    "trial_balance",
    "Saldobalanse for en periode, eventuelt begrenset til et kontointervall.",
    {
      ...orgSchema,
      ...reportDateSchema,
      startBookkeepingAccountNo: z.string().optional().describe("Fra kontonummer."),
      endBookkeepingAccountNo: z.string().optional().describe("Til kontonummer."),
      bookkeepingAccountsToBeIncluded: z
        .array(z.string())
        .optional()
        .describe("Eksplisitt liste med kontonumre som skal med."),
    },
    async ({ opContextOrgId, ...rest }) =>
      run(() =>
        client.get(
          accountingPath(opContextOrgId, "/reports/trial-balance"),
          params(rest),
        ),
      ),
  );

  tool(
    "open_accounts_receivable",
    "Åpne kundefordringer for én eller alle kunder — altså hva som faktisk står ubetalt. endDate er påkrevd.",
    {
      ...orgSchema,
      ...reportDateSchema,
      // The OpenAPI spec marks endDate optional, but the API returns
      // 400 "endDate mangler" without it. Require it here so the model gets
      // told up front instead of round-tripping an error.
      endDate: z.string().describe("YYYY-MM-DD. Påkrevd — fordringer per denne datoen."),
      customerId: z.number().int().optional(),
      customerName: z.string().optional(),
      includeOldTransactions: z.boolean().optional(),
      includeClosedLedgerLines: z.boolean().optional(),
      roundToTwoDecimals: z.boolean().optional(),
      page: z.number().int().min(0).optional(),
      recordsPerPage: z.number().int().min(0).optional(),
    },
    async ({ opContextOrgId, ...rest }) =>
      run(() =>
        client.get(
          accountingPath(opContextOrgId, "/reports/accounts-receivable/open"),
          params(rest),
        ),
      ),
  );

  tool(
    "income_expenses_key_figures",
    "Nøkkeltall for inntekter og kostnader for ett regnskapsår.",
    {
      ...orgSchema,
      year: z.number().int().min(1900).max(2099).describe("Regnskapsår, f.eks. 2026."),
    },
    async ({ opContextOrgId, year }) =>
      run(() =>
        client.get(accountingPath(opContextOrgId, `/income-and-expenses/${year}`)),
      ),
  );

  // ==================== BANKKONTOER (read-only) ====================

  tool(
    "search_bank_accounts",
    "Søk i bankkontoer. Bruk denne for å finne bankAccountId som register_invoice_payment trenger. Filtrer på allowedForInvoicing=true for kontoer som kan brukes til fakturering.",
    {
      ...orgSchema,
      accountNo: z.string().optional().describe("Kontonummer."),
      name: z.string().optional().describe("Kontonavn."),
      bankAccountType: z.enum(["NORMAL", "TAX_DEDUCTION"]).optional(),
      allowedForInvoicing: z.boolean().optional(),
      isArchived: z.boolean().optional(),
    },
    async ({ opContextOrgId, ...rest }) =>
      run(() => client.get(orgPath(opContextOrgId, "/bank-accounts"), params(rest))),
  );

  // ==================== KUNDER (skriv) ====================

  tool(
    "create_customer",
    "Opprett ny kunde. Slå opp virksomheten med search_enhetsregisteret først for å få riktig navn, orgNo og adresse. Sett dryRun=true for å validere uten å lagre.",
    { ...orgSchema, ...dryRunSchema, ...customerFieldsSchema },
    async ({ opContextOrgId, dryRun, ...fields }) =>
      run(() =>
        client.post(
          orgPath(opContextOrgId, "/customers"),
          buildCustomerBody(fields),
          undefined,
          { dryRun },
        ),
      ),
  );

  tool(
    "update_customer",
    "Oppdater en eksisterende kunde. Send bare feltene som skal endres: serveren henter kunden fra Conta og beholder alle andre felt (også adresser og felt dette verktøyet ikke har). contacts erstatter hele kontaktlisten hvis den oppgis.",
    {
      ...orgSchema,
      ...dryRunSchema,
      id: z.number().int().describe("Kunde-id."),
      ...z.object(customerFieldsSchema).partial().shape,
    },
    async ({ opContextOrgId, dryRun, id, ...fields }) =>
      run(async () => {
        const path = orgPath(opContextOrgId, `/customers/${id}`);
        // Conta's PUT replaces the whole customer, so read it first and merge.
        const current = await client.get(path);
        return client.put(path, mergeCustomerUpdate(current, fields), undefined, { dryRun });
      }),
  );

  // ==================== FAKTURA (skriv) ====================

  tool(
    "create_invoice_draft",
    "Opprett en fakturakladd. Kladden lagres uten å sendes, så dette er det trygge steget før create_invoice. Oppgi NØYAKTIG ÉN av customerId eller customerGroupId — begge deler samtidig avvises.",
    {
      ...orgSchema,
      ...dryRunSchema,
      invoiceDraftLines: z
        .array(invoiceLineSchema)
        .describe("Fakturalinjer. Kan være tom på en kladd."),
      customerId: z
        .number()
        .int()
        .optional()
        .describe("Kunde-id. Påkrevd hvis customerGroupId ikke er satt."),
      customerGroupId: z
        .number()
        .int()
        .optional()
        .describe("Kundegruppe-id for masseutsendelse. Alternativ til customerId."),
      type: z.enum(["NORMAL", "CASH", "CREDIT"]).optional(),
      departmentId: z.number().int().optional(),
      projectId: z.number().int().optional(),
      invoiceLanguage: z.enum(["NO", "EN"]).optional(),
      invoiceCurrency: z.string().optional().describe("Valutakode. Default NOK."),
      personalMessage: z.string().optional().describe("Melding som vises på PDF-en."),
      customerReference: z.string().optional().describe("Kundens referanse, vises på PDF-en."),
      registrationSource: z.enum(["CONTA", "TIMERABBIT"]).optional().describe("Default CONTA."),
    },
    async ({ opContextOrgId, dryRun, ...fields }) =>
      run(() =>
        client.post(
          orgPath(opContextOrgId, "/invoice-drafts"),
          buildInvoiceDraftBody(fields),
          undefined,
          { dryRun },
        ),
      ),
  );

  tool(
    "create_invoice",
    "Opprett en faktura. Dette er en reell, juridisk bindende faktura med fakturanummer — kjør gjerne med dryRun=true først, og bekreft med brukeren før du kjører for ekte. customerId og minst én fakturalinje er påkrevd. Oppgi invoiceRecipients for å styre levering (sjekk get_allowed_delivery_methods).",
    {
      ...orgSchema,
      ...dryRunSchema,
      customerId: z.number().int().describe("Kunde-id. Påkrevd."),
      invoiceLines: z
        .array(invoiceLineSchema)
        .min(1)
        .describe("Fakturalinjer. Minst én er påkrevd."),
      invoiceRecipients: z
        .array(invoiceRecipientSchema)
        .optional()
        .describe("Leveringsmåter for fakturaen."),
      invoiceDate: z.string().optional().describe("YYYY-MM-DD. Default i dag."),
      invoiceDueDate: z.string().optional().describe("YYYY-MM-DD."),
      type: z.enum(["NORMAL", "CASH", "CREDIT"]).optional(),
      departmentId: z.number().int().optional(),
      projectId: z.number().int().optional(),
      invoiceLanguage: z.enum(["NO", "EN"]).optional(),
      invoiceCurrency: z.string().optional().describe("Valutakode. Default NOK."),
      personalMessage: z.string().optional(),
      customerReference: z.string().optional(),
      kid: z.string().optional().describe("KID-nummer for automatisk betalingsmatching."),
      orgReference: z.string().optional(),
      showDiscount: z.boolean().optional().describe("Vis rabattkolonne på PDF-en."),
      deliveryDate: z.string().optional().describe("YYYY-MM-DD."),
      ehfOrderReference: z.string().optional().describe("Ordrenummer, påkrevd for EHF."),
      invoiceDraftId: z
        .number()
        .int()
        .optional()
        .describe(
          "Id til kladden fakturaen er laget fra. Kladden slettes når fakturaen er opprettet, så den ikke blir liggende og kan faktureres på nytt. Må gjelde samme kunde.",
        ),
    },
    async ({ opContextOrgId, dryRun, invoiceDraftId, ...input }) =>
      run(async () => {
        const draftPath =
          invoiceDraftId === undefined
            ? undefined
            : orgPath(opContextOrgId, `/invoice-drafts/${invoiceDraftId}`);
        // Check the draft before the invoice exists, so a wrong id fails
        // without leaving anything behind and never deletes another customer's draft.
        if (draftPath) {
          const draft = (await client.get(draftPath)) as { customerId?: unknown } | null;
          if (draft?.customerId !== input.customerId) {
            throw new Error(
              `Kladd ${invoiceDraftId} gjelder ikke kunde ${input.customerId}. Ingen faktura er opprettet. Sjekk kladden med get_invoice_draft.`,
            );
          }
        }

        const { fields, stripped } = stripRecipientsOnDryRun(dryRun, input);
        const data = await client.post(
          orgPath(opContextOrgId, "/invoices"),
          buildInvoiceBody(fields),
          undefined,
          { dryRun },
        );

        const notes: string[] = [];
        if (stripped) notes.push(DRY_RUN_RECIPIENTS_NOTE);
        if (draftPath && dryRun) {
          notes.push(`dryRun: kladd ${invoiceDraftId} er ikke slettet.`);
        } else if (draftPath) {
          // The invoice now exists. A failed cleanup must not read as a failed
          // call, or the model may retry and create a second invoice.
          try {
            await client.delete(draftPath);
            notes.push(`Kladd ${invoiceDraftId} er slettet.`);
          } catch (e) {
            const why = e instanceof ContaApiError ? `${e.status} ${e.bodyText}` : String(e);
            notes.push(
              `Fakturaen ER opprettet, men kladd ${invoiceDraftId} ble ikke slettet (${why}). Ikke opprett fakturaen på nytt. Be brukeren slette kladden i Conta.`,
            );
          }
        }
        return notes.length > 0 ? { note: notes.join(" "), contaResponse: data } : data;
      }),
  );

  tool(
    "create_credit_note",
    "Krediter en faktura i sin helhet. Dette oppretter en kreditnota som nuller ut fakturaen. Den originale fakturaen slettes ikke. Ifølge Conta kan en delbetalt faktura ikke krediteres i sin helhet uten at betalingene fjernes. Bekreft med brukeren før du kjører uten dryRun.",
    {
      ...orgSchema,
      ...dryRunSchema,
      id: z.number().int().describe("Id til fakturaen som skal krediteres."),
      creditNoteDate: z
        .string()
        .optional()
        .describe(
          "YYYY-MM-DD. Utelatt bruker Conta datoen til den opprinnelige fakturaen, ikke dagens dato.",
        ),
      removePaymentsIfExist: z
        .boolean()
        .optional()
        .describe(
          "true = fjern registrerte betalinger på fakturaen. Kan ikke angres, og krever CONTA_ALLOW_DELETE=true.",
        ),
      invoiceRecipients: z
        .array(invoiceRecipientSchema)
        .optional()
        .describe("Leveringsmåter for kreditnotaen."),
    },
    async ({ opContextOrgId, dryRun, id, ...input }) =>
      run(async () => {
        // Removing payments is as irreversible as delete_payment, so it sits
        // behind the same switch.
        if (input.removePaymentsIfExist && !policy.allowDelete) {
          throw new Error(
            "removePaymentsIfExist=true fjerner betalinger og krever CONTA_ALLOW_DELETE=true. Ingenting er sendt til Conta. Be brukeren fjerne betalingene i Conta, eller slå på CONTA_ALLOW_DELETE.",
          );
        }
        const { fields, stripped } = stripRecipientsOnDryRun(dryRun, input);
        const data = await client.post(
          orgPath(opContextOrgId, `/invoices/${id}/credit-note`),
          buildCreditNoteBody(fields),
          undefined,
          { dryRun },
        );
        return stripped ? { note: DRY_RUN_RECIPIENTS_NOTE, contaResponse: data } : data;
      }),
  );

  // ==================== BETALINGER (skriv) ====================

  tool(
    "register_invoice_payment",
    "Registrer en innbetaling på en faktura. Finn bankAccountId med search_bank_accounts. Beløpet må være positivt og kan ikke overstige fakturaens sumRemaining — sjekk den med get_invoice først. Verifiser resultatet etterpå med get_invoice.",
    {
      ...orgSchema,
      ...dryRunSchema,
      invoiceId: z.number().int().describe("Faktura-id betalingen gjelder."),
      amount: z
        .number()
        .min(0.01)
        .describe(
          "Beløp. Må være positivt (minst 0.01) og kan ikke overstige fakturaens sumRemaining.",
        ),
      date: z.string().describe("YYYY-MM-DD. Datoen betalingen kom inn på konto."),
      bankAccountId: z.number().int().describe("Bankkontoen betalingen kom inn på."),
      description: z.string().optional().describe("Tekst på bilaget i regnskapet."),
      departmentId: z.number().int().optional(),
      projectId: z.number().int().optional(),
      returnPaymentDate: z
        .string()
        .optional()
        .describe("YYYY-MM-DD. Slik registreres en returnert betaling — ikke som negativt beløp."),
    },
    async ({ opContextOrgId, dryRun, invoiceId, ...fields }) =>
      run(() =>
        client.post(
          orgPath(opContextOrgId, `/invoices/${invoiceId}/payments`),
          buildPaymentBody(fields),
          undefined,
          { dryRun },
        ),
      ),
  );

  tool(
    "delete_payment",
    "Slett en registrert betaling (kun tilgjengelig når CONTA_ALLOW_DELETE=true). Dette kan ikke angres — bekreft betalings-id med get_invoice_payments først, og be brukeren bekrefte.",
    {
      ...orgSchema,
      ...dryRunSchema,
      id: z.number().int().describe("Betalings-id (ikke faktura-id)."),
    },
    async ({ opContextOrgId, dryRun, id }) =>
      run(() =>
        client.delete(orgPath(opContextOrgId, `/payments/${id}`), undefined, { dryRun }),
      ),
  );

  // ==================== PRODUKTER / PROSJEKTER (skriv) ====================

  tool(
    "create_product",
    "Opprett et produkt. MERK: vatCode her bruker produkt-enumen ('output.high'), ikke fakturalinje-enumen ('high'). Finn gyldig bookkeepingAccountNo i kontoplanen.",
    {
      ...orgSchema,
      ...dryRunSchema,
      name: z.string().describe("Produktnavn/beskrivelse. Påkrevd."),
      bookkeepingAccountNo: z
        .string()
        .describe("Kontonummer produktet bokføres på, f.eks. 3000. Påkrevd."),
      vatCode: z
        .enum(PRODUCT_VAT_CODES as unknown as [ProductVatCode, ...ProductVatCode[]])
        .describe("Mva-kode for produktet. Påkrevd. Bruk output.* for salg."),
      price: z.number().optional().describe("Pris per enhet eks. mva."),
      productNo: z.string().optional().describe("Produktnummer."),
      isActive: z.boolean().optional(),
    },
    async ({ opContextOrgId, dryRun, ...fields }) =>
      run(() =>
        client.post(
          orgPath(opContextOrgId, "/products"),
          buildProductBody(fields),
          undefined,
          { dryRun },
        ),
      ),
  );

  tool(
    "create_project",
    "Opprett et prosjekt.",
    {
      ...orgSchema,
      ...dryRunSchema,
      name: z.string().describe("Prosjektnavn. Påkrevd."),
      description: z.string().optional(),
      startDate: z.string().optional().describe("YYYY-MM-DD."),
      endDate: z.string().optional().describe("YYYY-MM-DD."),
      customerId: z.number().int().optional().describe("Knytt prosjektet til en kunde."),
      isHidden: z.boolean().optional(),
    },
    async ({ opContextOrgId, dryRun, ...fields }) =>
      run(() =>
        client.post(
          orgPath(opContextOrgId, "/projects"),
          buildProjectBody(fields),
          undefined,
          { dryRun },
        ),
      ),
  );
}
