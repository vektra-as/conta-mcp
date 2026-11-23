# Bidra til conta-mcp

Takk for at du vil bidra! Issues og pull requests er velkomne, på norsk eller engelsk.

## Kom i gang

```bash
git clone https://github.com/valstrand-vektra/mcp-conta.git
cd mcp-conta
npm install
npm run build && npm run typecheck && npm test
```

Krever Node 22 eller nyere. Alle tre kommandoene må være grønne før en PR kan merges, og
CI kjører dem på hver PR.

## Regler

- **Feltnavn er API-ets egne, verbatim.** Ikke «forbedre» navn i tool-schemas. Kilden er
  `docs/conta-external-api.json`, men se avvikstabellen i README.
- **Alle skrive-verktøy tar `dryRun`**, og må legges inn i `WRITE_TOOLS` i
  `src/conta-tools.ts` med riktige annotasjoner. Nye verktøy må også inn i
  `READ_TOOL_NAMES` eller `WRITE_TOOL_NAMES` i `tests/helpers/tool-harness.ts`.
- **Transform-funksjoner er rene** og skal ha enhetstester.
- **Aldri ekte data i tester.** Bruk fiktive navn (`Acme AS`, `Eksempel AS`), fiktive
  id-er og `example.no`-adresser. Aldri en ekte org-id, kunde-id eller API-nøkkel.
- **Aldri commit `.env`.** Den er gitignorert. CI skanner etter lekkede nøkler.
- **Ekte skriveoperasjoner** gjøres bevisst og manuelt, aldri i en automatisert test.
  Røyktestene (`npm run smoke*`) kjøres lokalt, helst mot sandkassen, og aldri i CI.

## Pull requests

- Hold PR-en liten og om én ting.
- Beskriv hva du endret og hvordan du testet det.
- Legg til tester for ny oppførsel.

## Lisens

Ved å bidra godtar du at bidraget ditt lisensieres under [MIT](LICENSE).

## Ny versjon (for vedlikeholdere)

1. Oppdater `version` i `package.json`, `server.json` (to steder) og `manifest.json`.
   En test sjekker at de er like.
2. `npm publish` (kjører build, typecheck og test først via `prepublishOnly`).
3. MCP Registry: `mcp-publisher login github && mcp-publisher publish` (leser `server.json`).
4. Claude Desktop-utvidelse: `npm ci --omit=dev && npm run build && npx @anthropic-ai/mcpb pack`,
   og legg `.mcpb`-fila ved GitHub-releasen.
