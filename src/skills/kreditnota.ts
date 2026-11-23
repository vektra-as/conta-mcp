import { SkillDefinition } from "./types.js";

export const kreditnotaSkill: SkillDefinition = {
  id: "kreditnota",
  title: "Kreditnota",
  description:
    "Arbeidsflyt for å kreditere en faktura i sin helhet i Conta og bekrefte resultatet",
  triggers: [
    "kreditnota",
    "krediter faktura",
    "kreditere",
    "annuller faktura",
    "makuler faktura",
    "credit note",
  ],
  requiredTools: [
    "search_invoices",
    "get_invoice",
    "get_invoice_payments",
    "get_allowed_delivery_methods",
    "create_credit_note",
  ],
  buildMessages: () => [
    {
      role: "assistant" as const,
      content: {
        type: "text" as const,
        text: `## Skill: Kreditnota

### Bakgrunn

En faktura kan ikke slettes etter at den er utstedt — den må krediteres. En
kreditnota er et eget juridisk dokument med eget nummer som reverserer den
opprinnelige fakturaen. Den opprinnelige fakturaen blir stående.

Conta har et eget endepunkt for dette. Du skal IKKE lage en faktura med
negative linjer — bruk \`create_credit_note\`.

**Merk:** \`create_credit_note\` krediterer fakturaen i sin HELHET. Delvis
kreditering støttes ikke av dette verktøyet. Hvis brukeren vil kreditere bare
deler av en faktura, si at det må gjøres i Conta sitt web-grensesnitt.

### Steg 1 — Finn fakturaen

\`search_invoices\` med \`invoiceNo\` eller \`customerId\`.
\`get_invoice\` med id-en for å se linjer, sum og status.

Les tilbake til brukeren hvilken faktura du har funnet — fakturanummer,
kunde, dato og beløp — og få bekreftet at det er riktig faktura FØR du gjør
noe mer.

### Steg 2 — Sjekk om det finnes betalinger

\`get_invoice_payments\` med fakturaens id.

Ifølge Conta kan en faktura som er delbetalt ikke krediteres i sin helhet
mens betalingene står. Hvis det finnes registrerte betalinger må du spørre
brukeren hva som skal skje med dem:
- Fjerne dem: \`removePaymentsIfExist: true\`. Det kan ikke angres og krever
  at serveren kjører med \`CONTA_ALLOW_DELETE=true\`. Uten det avviser
  verktøyet kallet, og brukeren må fjerne betalingene i Conta selv.
- Beholde dem: utelat \`removePaymentsIfExist\`. Er fakturaen delbetalt, vil
  Conta da sannsynligvis avvise kreditnotaen.

Ikke velg dette selv. Det påvirker regnskapet.

### Steg 3 — Bekreft, så krediter

Kjør \`create_credit_note\` med \`dryRun: true\` først.

Be så brukeren bekrefte eksplisitt, og kjør uten \`dryRun\`:
- \`id\` — fakturaen som skal krediteres
- \`creditNoteDate\` — YYYY-MM-DD. Utelatt bruker Conta datoen til den
  opprinnelige fakturaen, ikke dagens dato. Spør brukeren hvilken dato som
  skal gjelde
- \`removePaymentsIfExist\` — fra steg 2
- \`invoiceRecipients\` — hvis kreditnotaen skal sendes til kunden

Sjekk \`get_allowed_delivery_methods\` først hvis den skal sendes.

### Steg 4 — Bekreft resultatet

Kall \`get_invoice\` på den opprinnelige fakturaen. Statusen skal nå være
\`CLOSED_BY_CREDIT_NOTE\`.

Rapporter kreditnotaens nummer og id til brukeren.`,
      },
    },
  ],
};
