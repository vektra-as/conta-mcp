import { SkillDefinition } from "./types.js";

export const opprettOgSendFakturaSkill: SkillDefinition = {
  id: "opprett-og-send-faktura",
  title: "Opprett og send faktura",
  description:
    "Arbeidsflyt for å fakturere en kunde i Conta: slå opp virksomheten i Enhetsregisteret, finn eller opprett kunden, lag kladd, og opprett fakturaen",
  triggers: [
    "fakturer",
    "send faktura",
    "opprett faktura",
    "lag faktura",
    "ny faktura",
    "create invoice",
  ],
  requiredTools: [
    "search_enhetsregisteret",
    "search_customers",
    "create_customer",
    "create_invoice_draft",
    "get_allowed_delivery_methods",
    "create_invoice",
    "get_invoice",
  ],
  buildMessages: () => [
    {
      role: "assistant" as const,
      content: {
        type: "text" as const,
        text: `## Skill: Opprett og send faktura

En faktura er et juridisk bindende dokument med eget fakturanummer. Den kan
ikke slettes — kun krediteres. Derfor: bekreft med brukeren før du kaller
\`create_invoice\` uten \`dryRun\`.

### Steg 1 — Finn eller opprett kunden

Søk først blant eksisterende kunder:
\`search_customers\` med \`q\` = navn eller organisasjonsnummer.

**Hvis kunden finnes:** noter \`id\`. Gå til steg 2.

**Hvis kunden ikke finnes:** slå opp virksomheten før du oppretter den, så
navn, orgnr og adresse blir riktige:
\`search_enhetsregisteret\` med \`q\` = navn eller orgnr.

Opprett så kunden med \`create_customer\`. Disse feltene er påkrevd:
- \`name\`, \`customerType\` (ORGANIZATION eller INDIVIDUAL)
- \`customerAddressLine1\`, \`customerAddressPostcode\`, \`customerAddressCity\`

Ta med \`orgNo\` og \`emailAddress\` når du har dem — e-post trengs for å sende
fakturaen, og orgnr for EHF.

### Steg 2 — Bygg fakturalinjene

Hver linje trenger \`description\`, \`price\` (eks. mva) og \`vatCode\`.
\`quantity\` blir 1 og \`discount\` blir 0 hvis du utelater dem.

Mva-koder for fakturalinjer (MERK: produkter bruker en annen enum):
- \`high\` — 25 % (normalsats)
- \`medium\` — 15 % (næringsmidler)
- \`low\` — 12 % (persontransport, overnatting)
- \`zero.rate\` — 0 %
- \`exempted\` — unntatt mva
- \`export\` — eksport
- \`no.vat\` — utenfor mva-området

Spør brukeren om noe er uklart: hva som skal faktureres, beløp og mva-sats.
Ikke gjett på mva-satsen.

### Steg 3 — Lag kladd først

Kall \`create_invoice_draft\` med linjene og \`customerId\`. Kladden er trygg:
den har ikke fakturanummer og kan slettes.

MERK: en kladd krever nøyaktig én av \`customerId\` eller \`customerGroupId\`.

Vis kladden til brukeren og be om bekreftelse på beløp, mva og forfallsdato
før du går videre.

### Steg 4 — Sjekk leveringsmåte

Kall \`get_allowed_delivery_methods\` med \`customerId\` og \`type\` (begge
påkrevd). Svaret er en liste, f.eks. \`["EMAIL","MAIL","EHF"]\`.

Ikke anta at EHF er tilgjengelig — sjekk listen. EHF krever at mottakeren er
registrert som EHF-mottaker.

### Steg 5 — Opprett fakturaen

Kjør gjerne \`create_invoice\` med \`dryRun: true\` først for å validere.
Bekreft så med brukeren, og kjør uten \`dryRun\`.

Påkrevd: \`customerId\` og minst én linje i \`invoiceLines\`.
Bruk \`invoiceRecipients\` for å styre levering, f.eks.:
\`[{ "type": "EMAIL", "emailAddress": "kunde@example.no" }]\`

### Steg 6 — Verifiser

Kall \`get_invoice\` med id-en fra svaret og bekreft fakturanummer, sum og
status tilbake til brukeren.`,
      },
    },
  ],
};
