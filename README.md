# conta-mcp

MCP-server (stdio) som lar AI-assistenter jobbe mot [Conta](https://conta.no) sitt API for
fakturering og regnskap. Fungerer med alle klienter som støtter Model Context Protocol, for
eksempel Claude Desktop, Claude Code, Cursor, VS Code og OpenAI Codex.

*English summary: [README.en.md](README.en.md)*

> **Uoffisielt prosjekt.** conta-mcp er laget av frivillige og er ikke utviklet, godkjent
> eller støttet av Conta AS. «Conta» er Contas varemerke og brukes her bare for å beskrive
> hvilket API serveren snakker med. Bruk skjer på eget ansvar, se [LICENSE](LICENSE).

## Kom i gang (la AI-en gjøre det)

1. **Lag en API-nøkkel i Conta.** Trykk på profilen din, velg **Bruker → Data og tilgang →
   Opprett ny API-nøkkel**, og kopier nøkkelen.
2. **Be AI-en din sette opp koblingen.** Skriv dette i Claude Code, Codex, Cursor eller et
   annet verktøy som kan kjøre kommandoer på maskinen din:
   > Sett opp Conta-MCP fra https://github.com/vektra-as/conta-mcp
3. **Lim inn nøkkelen selv.** AI-en lager fila `~/.config/conta-mcp/.env` og sier fra når
   den er klar. Åpne fila, lim inn nøkkelen etter `CONTA_API_KEY=`, lagre og start
   AI-verktøyet på nytt.

Ikke lim nøkkelen inn i chatten. Da sendes den til AI-leverandøren. I fila blir den bare
liggende på din egen maskin, og bare du kan lese den.

Koblingen er skrivebeskyttet til du selv setter `CONTA_READ_ONLY=false` i den samme fila.
Det trengs for å lage fakturakladder.

### Instruks til AI-assistenten

Du setter opp denne MCP-serveren for brukeren. Følg stegene, og be aldri om API-nøkkelen i
chatten.

1. Sjekk at Node 22 eller nyere er installert (`node -v`).
2. Legg til en stdio-server som heter `conta`, med kommandoen
   `npx -y github:vektra-as/conta-mcp`. Ikke legg API-nøkkelen i klientens konfigurasjon.
   - Claude Code: `claude mcp add --scope user conta -- npx -y github:vektra-as/conta-mcp`
   - Codex: `codex mcp add conta -- npx -y github:vektra-as/conta-mcp`
   - Andre klienter: `"command": "npx", "args": ["-y", "github:vektra-as/conta-mcp"]`
3. Hvis `~/.config/conta-mcp/.env` ikke finnes, lag den med dette innholdet og
   `chmod 600`. Overskriv aldri en fil som finnes, og les ikke innholdet i den.
   ```
   CONTA_API_KEY=
   CONTA_READ_ONLY=true
   ```
   På Windows ligger fila i `%USERPROFILE%\.config\conta-mcp\.env`.
4. Fortell brukeren hvor fila ligger. Be brukeren åpne den, lime inn nøkkelen etter
   `CONTA_API_KEY=`, sette `CONTA_READ_ONLY=false` hvis koblingen skal kunne lage
   fakturakladder, og starte klienten på nytt.
5. Etter omstart: kall `ping` og deretter `list_organizations` for å sjekke at koblingen
   virker.

Serveren er en tynn, presis proxy: feltnavnene i verktøyene er API-ets egne, verbatim. Når
et kall feiler, refererer Contas feilmelding til de samme navnene som modellen brukte, slik
at den kan rette seg selv uten et oversettelseslag i mellom.

Arkitekturen er modellert etter [`cwvedvik/tripletex-mcp`](https://github.com/cwvedvik/tripletex-mcp) (MIT).

## Før du starter: sikkerhet

Denne serveren gir en AI-assistent tilgang til regnskapet ditt. Les dette først.

- **API-nøkkelen har samme tilgang som brukeren som lagde den.** Lag gjerne en egen
  Conta-bruker med begrenset tilgang til AI-bruk.
- **Serveren er skrivebeskyttet som standard.** Bare lese-verktøy registreres, og
  assistenten kan ikke lage fakturaer, registrere betalinger eller endre kunder. Skriving
  slås på med `CONTA_READ_ONLY=false`. Ukjente verdier (for eksempel `on`) stopper serveren
  i stedet for å velge modus.
- **Sletting er av som standard.** `delete_payment` finnes bare når
  `CONTA_ALLOW_DELETE=true` er satt. Det samme gjelder `create_credit_note` med
  `removePaymentsIfExist: true`, som fjerner betalinger.
- **`create_invoice` lager en ekte, juridisk bindende faktura** med fakturanummer. Be
  assistenten bruke `dryRun: true` først, og godkjenn hvert skrivekall i klienten din.
  Verktøyene er merket med MCP-annotasjoner (`readOnlyHint`, `destructiveHint`), så
  klienter som støtter det kan be om bekreftelse.
- **Legg nøkkelen i `~/.config/conta-mcp/.env`** (rettigheter 600), ikke i chatten og ikke i
  klientens konfigurasjonsfil. Serveren leser fila selv og advarer hvis andre kan lese den.
  Variabler som klienten setter, går foran verdiene i fila.
- **Test i Contas sandkasse** før du kobler til ekte regnskap (se under).

Fant du en sårbarhet? Se [SECURITY.md](SECURITY.md).

## Skaff en API-nøkkel

1. Logg inn på Conta i nettleseren.
2. Gå til **Bruker → Data og tilgang → Opprett ny API-nøkkel**.
3. Kopier nøkkelen. Den sendes som `apiKey`-header på hver request.

API-et krever et aktivt Conta-abonnement, og noen funksjoner avhenger av abonnementet ditt.
Se [Contas egen API-side](https://hjelp.conta.no/api).

**Sandkasse:** Conta har et gratis testmiljø på <https://app.conta-sandbox.no>. Registrer
deg der og be Contas kundestøtte om tilgang. Pek serveren dit med
`CONTA_BASE_URL=https://api.gateway.conta-sandbox.no`. Sandkassen kan ikke sende e-post
eller EHF.

## Installasjon

Krever Node 22 eller nyere. Serveren hentes og bygges rett fra GitHub første gang den
startes:

```bash
npx -y github:vektra-as/conta-mcp
```

**Fra kildekode:**

```bash
git clone https://github.com/vektra-as/conta-mcp.git
cd conta-mcp
npm install
npm run build
```

## Oppsett

Innstillingene leses fra miljøet og fra nøkkelfila `~/.config/conta-mcp/.env`. Bare
`CONTA_*`-variabler hentes fra fila, og verdier som alt er satt i miljøet, går foran.

| Variabel | Påkrevd | Beskrivelse |
|---|---|---|
| `CONTA_ENV_FILE` | nei | Annen sti til nøkkelfila. Default `~/.config/conta-mcp/.env`. Kan bare settes i miljøet. |
| `CONTA_API_KEY` | ja | API-nøkkel. Sendes som `apiKey`-header på hver request. |
| `CONTA_ORG_ID` | nei | Default organisasjon. Uten denne må hvert verktøykall oppgi `opContextOrgId`. |
| `CONTA_READ_ONLY` | nei | Default `true` = bare lese-verktøy. `false` slår på skrive-verktøyene. |
| `CONTA_ALLOW_DELETE` | nei | `true` = registrer `delete_payment` og tillat `removePaymentsIfExist` på kreditnota. Av som standard. |
| `CONTA_BASE_URL` | nei | Override av base-URL. Default `https://api.gateway.conta.no`. Må være `https://`. |
| `CONTA_LANGUAGE` | nei | `NO` (default) eller `EN`. Settes som `conta-language`-header. |
| `CONTA_TIMEOUT_MS` | nei | Timeout per request. Default `30000`. |
| `CONTA_MAX_RESPONSE_CHARS` | nei | Svar lengre enn dette avkortes. Default `100000`. |

Finn organisasjons-id-en din (fra kildekode, med verdiene i en lokal `.env` i repoet):

```bash
cp .env.example .env   # fyll inn CONTA_API_KEY
npm run smoke
```

Eller spør assistenten: «List organisasjonene mine i Conta» (verktøyet `list_organizations`).

Den lokale `.env` brukes bare av smoke-skriptene. Den er gitignorert og skal aldri committes. API-nøkkelen logges ikke og tas aldri med i
feilmeldinger.

### Claude Desktop

Legg dette i `claude_desktop_config.json`, og legg nøkkelen i `~/.config/conta-mcp/.env`:

```json
{
  "mcpServers": {
    "conta": {
      "command": "npx",
      "args": ["-y", "github:vektra-as/conta-mcp"]
    }
  }
}
```

Fra kildekode bytter du `command`/`args` med `"node"` og
`["/absolutt/sti/til/conta-mcp/dist/index.js"]`.

### Claude Code

```bash
claude mcp add --scope user conta -- npx -y github:vektra-as/conta-mcp
```

### Codex

```bash
codex mcp add conta -- npx -y github:vektra-as/conta-mcp
```

### Andre klienter

Alle MCP-klienter som kan starte en stdio-server fungerer. Kommandoen er
`npx -y github:vektra-as/conta-mcp`, og innstillingene ligger i nøkkelfila.

## dryRun — valider uten å lagre

Alle skrive-verktøy tar en `dryRun`-parameter. Med `dryRun: true` sendes headeren
`conta-force-rollback`, og Conta ruller transaksjonen tilbake etter at requesten er
validert. Du får et fullt svar — inkludert id-en raden *ville* fått — men ingenting lagres.

`dryRun` er `false` som default. Det er et bevisst valg: en modell som tror den har lagret
noe uten at den har det, er en verre feilmodus enn en som må spørre om lov.

**Levering ved dryRun:** Det er ikke dokumentert om rollback også stopper utsending av
e-post, EHF eller brev. Derfor fjerner `create_invoice` og `create_credit_note` alltid
`invoiceRecipients` når `dryRun: true`, og svaret sier fra om det. Leveringsmåtene blir da
ikke validert i dry run.

Rollback er verifisert mot ekte API ved å telle rader før og etter:

```bash
npm run smoke:write
```

## Verktøy

### Organisasjon og oppsett
`ping`, `list_organizations`, `get_account_settings`

### Kunder
`search_customers`, `get_customer`, `search_enhetsregisteret`, `create_customer`,
`update_customer`

### Faktura
`search_invoices`, `get_invoice`, `search_invoice_drafts`, `get_invoice_draft`,
`get_unpaid_invoices`, `get_allowed_delivery_methods`, `create_invoice_draft`,
`create_invoice`, `create_credit_note`

### Betalinger
`search_invoice_payments`, `get_invoice_payments`, `search_bank_accounts`,
`register_invoice_payment`, `delete_payment` (bare med `CONTA_ALLOW_DELETE=true`)

### Produkter og prosjekter
`search_products`, `get_product`, `create_product`, `search_projects`, `get_project`,
`create_project`

### Rapporter (read-only)
`profit_and_loss_report`, `balance_report`, `trial_balance`, `open_accounts_receivable`,
`income_expenses_key_figures`

Som standard (`CONTA_READ_ONLY` utelatt eller `true`) registreres bare verktøyene som leser
(`ping`, `list_*`, `get_*`, `search_*` og rapportene). Skrive-verktøyene krever
`CONTA_READ_ONLY=false`.

`update_customer` tar bare feltene som skal endres. Serveren henter kunden først og beholder
resten, fordi Contas PUT erstatter hele kunden.

`create_invoice` tar `invoiceDraftId` når fakturaen er laget fra en kladd. Kladden sjekkes mot
kunden før fakturaen opprettes, og slettes etterpå.

## Arbeidsflyter (skills)

Fire norske arbeidsflyter er tilgjengelige som MCP-prompts:

| Skill | Hva den dekker |
|---|---|
| `opprett-og-send-faktura` | Enhetsregisteret-oppslag → finn/opprett kunde → kladd → faktura |
| `registrer-betaling` | Finn faktura → finn bankkonto → registrer betaling → verifiser restbeløp |
| `kreditnota` | Finn faktura → sjekk betalinger → full kreditnota → bekreft |
| `maanedsstatus` | Ubetalte fakturaer + resultat + åpne fordringer i én oppsummering |

Ressursen `conta://skills` lister alle med utløserord.

## Eksempelprompter

- «Hvilke fakturaer er forfalt?»
- «Hva er resultatet hittil i år?»
- «Slå opp Eksempel AS i Enhetsregisteret og opprett dem som kunde»
- «Lag en fakturakladd til Acme AS på 10 timer rådgivning à 1200 kr»
- «Registrer at faktura 1042 ble betalt med 12 500 kr den 15. juli»
- «Gi meg en månedsstatus»

## Utvikling

Se [CONTRIBUTING.md](CONTRIBUTING.md) for hvordan du bidrar, og [AGENTS.md](AGENTS.md) for
instruksjoner til AI-kodeassistenter.

```bash
npm run build       # tsc, strict
npm run typecheck   # inkluderer tests/
npm test            # vitest
npm run test:watch
```

### Røyk-tester mot ekte API

Røyktestene bruker **din egen Conta-konto** med nøkkelen i `.env`. Kjør dem helst mot
sandkassen. De kjøres aldri i CI.

| Kommando | Hva den gjør |
|---|---|
| `npm run smoke` | `ping` + `list_organizations` direkte via klienten. Read-only. |
| `npm run smoke:mcp` | Starter serveren over stdio og kjører alle read-verktøy. Read-only. |
| `npm run smoke:write` | Kjører opprett-verktøy med `dryRun: true` og beviser at rollback virker ved å telle rader før/etter. |
| `npm run smoke:write:mutating` | Samme for verktøy som endrer eksisterende rader (`update_customer`, `register_invoice_payment`). Har innebygd gjenoppretting hvis rollback mot formodning skulle svikte. |

Første ekte skriveoperasjon bør gjøres bevisst og manuelt — aldri som del av en
automatisert test.

### Rate limiting og retry

Contas rate limits er ikke dokumentert. Klienten prøver på nytt ved `429` (opptil 3
ganger, og respekterer `Retry-After`), også for POST. Det er trygt fordi en `429` betyr at
requesten ble avvist før den ble behandlet.

## Avvik mellom OpenAPI-spec og faktisk API

`docs/conta-external-api.json` er kilden til feltnavn (se [docs/README.md](docs/README.md)),
men er ikke alltid presis om hva som er påkrevd. Følgende er verifisert mot det ekte API-et
og håndteres i koden:

| Endepunkt | Spec sier | Faktisk oppførsel |
|---|---|---|
| `open_accounts_receivable` | `endDate` valgfri | Påkrevd — `400 "endDate mangler"` uten |
| `get_allowed_delivery_methods` | alle valgfrie | `customerId` og `type` er påkrevd |
| `create_invoice_draft` | kun `registrationSource` påkrevd | Krever nøyaktig én av `customerId`/`customerGroupId`; begge samtidig avvises |
| `register_invoice_payment` | `amount` er et fritt tall | Må være ≥ 0.01 og ≤ fakturaens `sumRemaining`. Negative beløp avvises (`currency.min`) — en returnert betaling uttrykkes med `returnPaymentDate` |
| `conta-language` | eksempel `nb` | Enum er `NO` \| `EN` |

Array-parametere (`detailedCategories`, `bookkeepingAccountNos`, `kraviaInvoiceStatuses`)
setter ikke `style`/`explode` i spec-en, så OpenAPI-defaulten `form`/`explode=true` gjelder:
gjentatt nøkkel, ikke kommaseparert liste.

### Mva-koder: to ulike enums

Fakturalinjer og produkter bruker forskjellige mva-kode-enums. Å blande dem gir en 400 som
er vanskelig å tolke.

- **Fakturalinjer:** `no.vat`, `high`, `medium`, `low`, `zero.rate`, `exempted`, `export`
- **Produkter:** `input.no.vat`, `output.high`, `output.medium`, `output.low`,
  `output.zero.rate`, `output.exempted`, `output.export`

## Veikart

- Leverandører med kontakter, bilagsinnboks (filopplasting), avdelinger og EHF.
- Strømbar HTTP-transport med OAuth, for en hostet flerbrukerversjon. Klienten støtter
  allerede `ContaClientOptions` per bruker.

Bidrag er velkomne, se [CONTRIBUTING.md](CONTRIBUTING.md).

## Lisens

[MIT](LICENSE). `docs/conta-external-api.json` tilhører Conta og er ikke omfattet av
lisensen.
