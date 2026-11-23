import { SkillDefinition } from "./types.js";

export const registrerBetalingSkill: SkillDefinition = {
  id: "registrer-betaling",
  title: "Registrer betaling",
  description:
    "Arbeidsflyt for å registrere en innbetaling på en faktura i Conta og verifisere restbeløpet etterpå",
  triggers: [
    "registrer betaling",
    "innbetaling",
    "betalt faktura",
    "marker som betalt",
    "delbetaling",
    "register payment",
  ],
  requiredTools: [
    "search_invoices",
    "get_invoice",
    "search_bank_accounts",
    "register_invoice_payment",
    "get_invoice_payments",
  ],
  buildMessages: () => [
    {
      role: "assistant" as const,
      content: {
        type: "text" as const,
        text: `## Skill: Registrer betaling

### Steg 1 — Finn fakturaen

\`search_invoices\` med \`type: "UNPAID"\`, eventuelt \`customerId\` eller
\`invoiceNo\` hvis brukeren oppga det.

Kall \`get_invoice\` med id-en og noter:
- \`sumTotal\` — fakturaens totalbeløp
- \`sumRemaining\` — hva som faktisk gjenstår
- \`invoiceCurrency\`

Sammenlign innbetalt beløp mot \`sumRemaining\`, ikke mot \`sumTotal\`. En
faktura kan allerede ha delbetalinger.

### Steg 2 — Finn bankkontoen

\`search_bank_accounts\` med \`allowedForInvoicing: true\`.
Noter \`id\` for kontoen pengene kom inn på. Hvis det er flere kontoer og
brukeren ikke har sagt hvilken, spør.

### Steg 3 — Registrer betalingen

\`register_invoice_payment\` med:
- \`invoiceId\` — fakturaens id
- \`amount\` — beløpet som kom inn
- \`date\` — YYYY-MM-DD, datoen pengene kom inn på konto (ikke dagens dato,
  med mindre det er samme dag)
- \`bankAccountId\` — fra steg 2
- \`description\` — valgfri tekst på bilaget

Bruk \`dryRun: true\` først hvis noe er usikkert.

**Avvik du må håndtere, ikke skjule:**
- Beløp < \`sumRemaining\` → delbetaling. Fakturaen forblir ubetalt. Si det.
- Beløp > \`sumRemaining\` → overbetaling. Conta avviser beløp over
  \`sumRemaining\`. Ikke registrer noe før du har spurt brukeren hvordan
  overskuddet skal håndteres.
- Tilbakebetaling eller returnert betaling registreres med
  \`returnPaymentDate\`, aldri som negativt beløp. Verktøyet avviser beløp
  under 0.01.

### Steg 4 — Verifiser

Kall \`get_invoice\` på nytt og les \`sumRemaining\`.

Rapporter til brukeren: beløp registrert, ny \`sumRemaining\`, og om fakturaen
nå er gjort opp. Ikke si "betalt" hvis \`sumRemaining\` fortsatt er over null.

Bruk \`get_invoice_payments\` hvis brukeren vil se alle betalingene på
fakturaen.`,
      },
    },
  ],
};
