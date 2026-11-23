import { SkillDefinition } from "./types.js";

export const maanedsstatusSkill: SkillDefinition = {
  id: "maanedsstatus",
  title: "Månedsstatus",
  description:
    "Samler ubetalte fakturaer, resultat og åpne kundefordringer til én oppsummering av økonomisk status",
  triggers: [
    "månedsstatus",
    "hvordan går det",
    "økonomisk status",
    "oppsummering",
    "hvor mye skylder kundene",
    "resultat hittil",
    "månedsrapport",
  ],
  requiredTools: [
    "search_invoices",
    "open_accounts_receivable",
    "profit_and_loss_report",
    "income_expenses_key_figures",
    "get_unpaid_invoices",
  ],
  buildMessages: () => [
    {
      role: "assistant" as const,
      content: {
        type: "text" as const,
        text: `## Skill: Månedsstatus

Målet er én kort oppsummering brukeren kan handle på — ikke en dump av rådata.

### Steg 1 — Ubetalte og forfalte fakturaer

\`search_invoices\` med \`type: "UNPAID"\` og \`hits: 0\` for å få alle.
\`search_invoices\` med \`type: "OVERDUE"\` for de som har passert forfall.

Forfalte fakturaer er det viktigste tallet i denne rapporten. Nevn dem først
hvis det finnes noen.

\`get_unpaid_invoices\` gir nøkkeltall (\`sumUnpaid\`, \`sumExpired\`) raskt,
men bare de 3 siste fakturaene — bruk \`search_invoices\` for hele listen.

### Steg 2 — Åpne kundefordringer

\`open_accounts_receivable\` med \`endDate\` = i dag (YYYY-MM-DD).
\`endDate\` er PÅKREVD her.

Dette viser hva kundene faktisk skylder per dato, fra regnskapet — som kan
avvike fra fakturalisten hvis noe er bokført manuelt.

### Steg 3 — Resultat

\`profit_and_loss_report\` med \`startDate\` = 1. januar inneværende år og
\`endDate\` = i dag, for resultat hittil i år.

Vil brukeren se én måned, sett \`startDate\`/\`endDate\` til månedens første
og siste dag.

\`income_expenses_key_figures\` med \`year\` gir inntekter/kostnader/resultat
for hele året i en enklere form — bruk den hvis brukeren bare vil ha
hovedtallene.

### Steg 4 — Oppsummer

Skriv en kort oppsummering med:
- Resultat hittil i perioden (inntekter, kostnader, resultat)
- Sum utestående, og hvor mye av det som er forfalt
- De største forfalte fakturaene med kundenavn, beløp og hvor lenge de har
  vært forfalt

Avslutt med hva som eventuelt bør følges opp. Hvis alt er betalt og
resultatet er positivt, si det kort — ikke finn på bekymringer.

Oppgi perioden du faktisk hentet tall for, så brukeren vet hva som er målt.`,
      },
    },
  ],
};
