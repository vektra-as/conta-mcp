# AGENTS.md

Instruksjoner for AI-kodeassistenter (Codex, Claude Code, Cursor, Copilot m.fl.) som jobber
i dette repoet. Menneskelige bidragsytere: se [CONTRIBUTING.md](CONTRIBUTING.md).

conta-mcp er en MCP-server (stdio) mot Contas API for fakturering og regnskap. Den er en
tynn, presis proxy der feltnavn matcher API-ets DTO-er verbatim, slik at modellen får
Contas egne feilmeldinger og kan selvkorrigere.

## Kommandoer

```bash
npm run build       # tsc, strict
npm run typecheck   # inkluderer tests/
npm test            # vitest, ingen nettverk
```

Kjør alle tre før du sier deg ferdig. Kjør **aldri** `npm run smoke*` uten at brukeren ber
om det: de bruker en ekte Conta-konto.

## Prosjektstruktur

```
src/
  index.ts           # stdio-entry: McpServer + StdioServerTransport, leser policy fra env
  conta-client.ts    # fetch-wrapper: apiKey-header, https-krav, timeout, 429-retry,
                     #   dryRun -> conta-force-rollback, conta-language, feilklasser
  conta-tools.ts     # alle tools (registerTool + annotasjoner), ToolPolicy, Zod-schemas
  conta-transform.ts # DTO-bygging (faktura m/ invoiceLines, betalinger) — ren logikk
  skills/            # norske arbeidsflyter som MCP-prompts + registry.ts
tests/               # vitest + mock-fetch + tool-harness
docs/
  conta-external-api.json   # Contas OpenAPI-spec — KILDEN til feltnavn og schemas
```

## API-fakta

- OpenAPI 3.0.3, base-URL `https://api.gateway.conta.no`. Sandkasse:
  `https://api.gateway.conta-sandbox.no`.
- Auth: header `apiKey: <nøkkel>` på hver request (ingen token-veksling).
- Alle endepunkter er scopet på `{opContextOrgId}`; `GET /invoice/organizations` lister
  org-er nøkkelen har tilgang til.
- To domener: `/invoice/*` (kunder, fakturaer, kladder, betalinger, kreditnota, produkter,
  prosjekter, bankkontoer, Enhetsregisteret-søk) og `/accounting/*` (rapporter m.m.).
- **Dry-run:** header `conta-force-rollback` tvinger rollback. Eksponeres som `dryRun` på
  ALLE skrive-tools. Ved dryRun sendes aldri `invoiceRecipients`.
- Header `conta-language` er `NO` som default (enum `NO` | `EN`; `nb` avvises).
- Paginering på søk: `page`, `hits`, `q`, `sort`, `fromDate`, `toDate`.
- Rate limits er ikke dokumentert — klienten håndterer 429 med backoff og `Retry-After`.

## Avvik mellom spec og faktisk API

Verifisert mot ekte API og håndtert i koden. Ikke «rett» dem tilbake til det spec-en sier.

| Endepunkt | Spec sier | Faktisk |
|---|---|---|
| `open_accounts_receivable` | `endDate` valgfri | Påkrevd (`400 "endDate mangler"`) |
| `get_allowed_delivery_methods` | alle valgfrie | `customerId` og `type` påkrevd; `id` snevrer inn svaret |
| `create_invoice_draft` | kun `registrationSource` påkrevd | Nøyaktig én av `customerId`/`customerGroupId` |
| `register_invoice_payment` | `amount` fritt tall | `>= 0.01` og `<= sumRemaining`; retur via `returnPaymentDate` |
| `conta-language` | eksempel `nb` | Enum er `NO` \| `EN` |

Andre feller:
- **Mva-koder er to ulike enums.** Fakturalinjer: `no.vat`/`high`/`medium`/`low`/`zero.rate`/`exempted`/`export`. Produkter: `input.no.vat`/`output.high`/…
- **Array-parametere** bruker gjentatt nøkkel, ikke kommaseparert liste.
- **`invoiceLines[]` krever `discount`** på hver linje, selv når den er 0. Transformen fyller inn 0 og `quantity` 1.

## Konvensjoner

- TypeScript strict, Node16-moduler, `@modelcontextprotocol/sdk` med `registerTool`.
- Alle tool-inputs defineres med Zod. Feltnavn = API-ets feltnavn verbatim.
- Nye skrive-verktøy: legg dem i `WRITE_TOOLS` (annotasjoner) i `src/conta-tools.ts`, gi
  dem `dryRun`, og legg dem i `WRITE_TOOL_NAMES` i `tests/helpers/tool-harness.ts`.
  Irreversible verktøy legges også i `DELETE_TOOLS`.
- Klienten har både env-basert konstruktør (stdio) og `ContaClientOptions` for
  programmatisk/flerbruker-bruk.
- stdout er MCP-transporten. All logging går til stderr.

## Sikkerhet — absolutte regler

- Aldri les, skriv ut eller commit `.env` eller en API-nøkkel. Nøkkelen skal aldri i logger
  eller feilmeldinger.
- Aldri ekte org-id-er, kunde-id-er, navn eller e-poster i tester, eksempler eller docs.
- Aldri kjør skriveoperasjoner mot ekte API som del av en test.
- Ikke svekk `CONTA_READ_ONLY`, `CONTA_ALLOW_DELETE`, https-kravet eller dryRun-sikringen.
