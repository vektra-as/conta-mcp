#!/usr/bin/env node
/**
 * Røyk-test mot ekte Conta-API — KUN read-only kall (steg 3 i byggerekkefølgen).
 *
 *   npm run smoke
 *
 * Leser CONTA_API_KEY fra miljøet eller .env (via --env-file-if-exists).
 * Kjører:
 *   1. GET /invoice/ping            — healthcheck
 *   2. GET /invoice/organizations   — org-er nøkkelen har tilgang til
 *
 * Skriver ALDRI data. Nøkkelen logges aldri — kun en maskert hale.
 */

import { ContaClient, ContaApiError } from '../dist/conta-client.js';

/** Vis kun de siste 4 tegnene, slik at feil nøkkel kan gjenkjennes uten å lekke den. */
function maskKey(key) {
  if (!key) return '(mangler)';
  return `${'*'.repeat(Math.max(0, key.length - 4))}${key.slice(-4)}`;
}

function fail(message, detail) {
  console.error(`\n✗ ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

const apiKey = process.env.CONTA_API_KEY;
if (!apiKey) {
  fail(
    'CONTA_API_KEY er ikke satt.',
    'Kopier .env.example til .env og fyll inn nøkkelen, eller kjør:\n' +
      '  CONTA_API_KEY=xxx npm run smoke',
  );
}

const client = new ContaClient();
// `||` not `??` — an empty CONTA_BASE_URL in .env must fall back like the client does.
console.log(`Base-URL : ${process.env.CONTA_BASE_URL || 'https://api.gateway.conta.no'}`);
console.log(`apiKey   : ${maskKey(apiKey)}`);
console.log(`org (env): ${client.defaultOrgId ?? '(ikke satt)'}\n`);

// 1. ping
try {
  const pong = await client.get('/invoice/ping');
  console.log('✓ GET /invoice/ping →', JSON.stringify(pong));
} catch (err) {
  if (err instanceof ContaApiError) {
    fail(`GET /invoice/ping feilet (${err.status})`, err.bodyText);
  }
  fail('GET /invoice/ping feilet', err instanceof Error ? err.message : String(err));
}

// 2. organizations
let orgs;
try {
  orgs = await client.get('/invoice/organizations');
} catch (err) {
  if (err instanceof ContaApiError) {
    const hint =
      err.status === 401 || err.status === 403
        ? '\nHint: 401/403 betyr som regel at apiKey er feil eller mangler tilgang.'
        : '';
    fail(`GET /invoice/organizations feilet (${err.status})`, err.bodyText + hint);
  }
  fail(
    'GET /invoice/organizations feilet',
    err instanceof Error ? err.message : String(err),
  );
}

if (!Array.isArray(orgs)) {
  fail(
    'GET /invoice/organizations returnerte ikke en liste.',
    JSON.stringify(orgs, null, 2),
  );
}

console.log(`✓ GET /invoice/organizations → ${orgs.length} organisasjon(er)\n`);
for (const org of orgs) {
  const flags = [
    org.active === false ? 'INAKTIV' : null,
    org.blockedStatus && org.blockedStatus !== 'NOT_BLOCKED' ? org.blockedStatus : null,
  ]
    .filter(Boolean)
    .join(', ');
  console.log(`  id=${org.id}  ${org.name}${flags ? `  [${flags}]` : ''}`);
}

if (orgs.length === 0) {
  console.log('\n⚠ Nøkkelen har ikke tilgang til noen organisasjoner.');
} else if (!client.defaultOrgId) {
  console.log(`\nTips: sett CONTA_ORG_ID=${orgs[0].id} i .env som default-org.`);
}

console.log('\n✓ Røyk-test OK (kun read-only kall utført).');
