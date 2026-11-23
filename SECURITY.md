# Sikkerhet / Security

## Melde en sårbarhet

Ikke opprett et offentlig issue for sikkerhetshull. Bruk GitHubs private rapportering:
**Security → Report a vulnerability** på
<https://github.com/valstrand-vektra/mcp-conta/security/advisories/new>.

Ta med hva som er sårbart, hvordan det kan utnyttes, og hvilken versjon du testet. Du får
svar så snart som mulig. Dette er et frivillig prosjekt, så det finnes ingen garantert
responstid.

Sårbarheter i Contas eget API eller i Conta-appen meldes til Conta, ikke hit:
<https://hjelp.conta.no/kontakt/>.

*Please report vulnerabilities privately via GitHub's "Report a vulnerability" button, not
in public issues.*

## Støttede versjoner

Bare siste publiserte versjon får sikkerhetsrettinger.

## Hva serveren gjør for å beskytte deg

- API-nøkkelen logges aldri og tas aldri med i feilmeldinger.
- `CONTA_BASE_URL` må være `https://` (http er bare lov mot localhost), så nøkkelen ikke
  sendes ukryptert.
- `CONTA_READ_ONLY=true` fjerner alle skrive-verktøy.
- `delete_payment` er av med mindre `CONTA_ALLOW_DELETE=true`.
- `dryRun` sender aldri leveringsmottakere, så en test kan ikke nå en kunde.
- Alle verktøy har MCP-annotasjoner, så klienten kan be om bekreftelse på skrivekall.
- Requests har timeout, og store svar avkortes.

## Gode vaner for brukere

- Bruk en egen Conta-bruker med begrenset tilgang til AI-bruk, og test i sandkassen først.
- Ikke del klientens konfigurasjonsfil. Den inneholder nøkkelen i klartekst.
- Slett API-nøkkelen i Conta hvis du tror den har lekket.
