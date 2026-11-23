#!/usr/bin/env node
/**
 * Ende-til-ende røyk-test av MCP-serveren over stdio, mot ekte Conta-API.
 *
 *   npm run smoke:mcp
 *
 * Starter `dist/index.js` som subprosess, gjør en ekte MCP-handshake, lister
 * tools og kaller et utvalg READ-ONLY tools. Skriver ALDRI data.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (!process.env.CONTA_API_KEY) {
  console.error('✗ CONTA_API_KEY er ikke satt. Fyll inn .env først.');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  // Serveren leser CONTA_* fra sitt eget miljø, akkurat som Claude Desktop gjør.
  env: {
    PATH: process.env.PATH,
    CONTA_API_KEY: process.env.CONTA_API_KEY,
    ...(process.env.CONTA_ORG_ID ? { CONTA_ORG_ID: process.env.CONTA_ORG_ID } : {}),
    ...(process.env.CONTA_BASE_URL ? { CONTA_BASE_URL: process.env.CONTA_BASE_URL } : {}),
    ...(process.env.CONTA_LANGUAGE ? { CONTA_LANGUAGE: process.env.CONTA_LANGUAGE } : {}),
  },
});

const client = new Client({ name: 'conta-smoke', version: '0.1.0' });
await client.connect(transport);
console.log('✓ MCP-handshake OK\n');

const { tools } = await client.listTools();
console.log(`✓ tools/list → ${tools.length} tools`);
console.log(`  ${tools.map((t) => t.name).sort().join(', ')}\n`);

/** Siste rå JSON-svar fra callTool, slik at vi kan plukke ut id-er til by-id-kall. */
let lastPayload;

/** Kall ett tool og skriv en kort oppsummering. Returnerer true ved suksess. */
async function callTool(name, args = {}) {
  lastPayload = undefined;
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  const label = `${name}(${JSON.stringify(args)})`;

  if (res.isError) {
    console.log(`  ✗ ${label}\n     ${text.replace(/\n/g, '\n     ').slice(0, 400)}`);
    return false;
  }

  try {
    lastPayload = JSON.parse(text);
  } catch {
    /* non-JSON body, e.g. the ping response */
  }

  let summary;
  try {
    const parsed = JSON.parse(text);
    summary = Array.isArray(parsed)
      ? `array(${parsed.length})`
      : typeof parsed === 'object' && parsed !== null
        ? `object{${Object.keys(parsed).slice(0, 6).join(', ')}}`
        : JSON.stringify(parsed);
  } catch {
    summary = text.slice(0, 80);
  }
  console.log(`  ✓ ${label} → ${summary}`);
  return true;
}

const year = new Date().getFullYear();

console.log('Read-only tool-kall:');
const results = [];
results.push(await callTool('ping'));
results.push(await callTool('list_organizations'));
results.push(await callTool('get_account_settings'));
results.push(await callTool('search_customers', { hits: 3 }));
results.push(await callTool('search_invoices', { hits: 3 }));
results.push(await callTool('search_invoice_drafts', { hits: 3 }));
results.push(await callTool('search_products', { hits: 3 }));
results.push(await callTool('search_projects', { hits: 3 }));
results.push(await callTool('search_invoice_payments', { hits: 3 }));
results.push(await callTool('get_unpaid_invoices'));
results.push(await callTool('search_enhetsregisteret', { q: 'Conta', hits: 3 }));
results.push(
  await callTool('profit_and_loss_report', {
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
  }),
);
results.push(
  await callTool('balance_report', {
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
  }),
);
results.push(
  await callTool('trial_balance', {
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
  }),
);
results.push(await callTool('open_accounts_receivable', { endDate: `${year}-12-31` }));
results.push(await callTool('income_expenses_key_figures', { year }));

// ---- by-id tools: hent en ekte id fra et søk, så les den ----
// Disse verifiserer path-byggingen (.../customers/{id} osv.), som er nettopp
// det en skrivefeil ville brutt uten at enhetstestene fanger API-siden.

/** Første treff i et Conta-søkeresultat ({ hits: [...] }), eller undefined. */
function firstHit(payload) {
  const hits = payload?.hits;
  return Array.isArray(hits) && hits.length > 0 ? hits[0] : undefined;
}

/**
 * Søk med `searchTool`, og kall hvert [toolName, argsFromHit]-par med det
 * første treffet. Hopper over hele kjeden hvis søket ikke gir treff.
 */
async function chain(searchTool, searchArgs, readTools) {
  if (!(await callTool(searchTool, searchArgs))) {
    results.push(false);
    return;
  }
  const hit = firstHit(lastPayload);
  const names = readTools.map(([name]) => name).join(', ');
  if (hit === undefined) {
    console.log(`  – ${searchTool} ga ingen treff; hopper over ${names}`);
    return;
  }
  for (const [tool, argsFromHit] of readTools) {
    results.push(await callTool(tool, argsFromHit(hit)));
  }
}

const byId = (hit) => ({ id: hit.id });

console.log('\nBy-id tool-kall (id-er hentet fra søk over):');
await chain('search_customers', { hits: 1 }, [['get_customer', byId]]);
await chain('search_invoices', { hits: 1 }, [
  ['get_invoice', byId],
  ['get_invoice_payments', byId],
  // customerId og type er påkrevd her, id snevrer inn svaret.
  [
    'get_allowed_delivery_methods',
    (hit) => ({ id: hit.id, customerId: hit.customerId, type: hit.type }),
  ],
]);
await chain('search_invoice_drafts', { hits: 1 }, [['get_invoice_draft', byId]]);
await chain('search_products', { hits: 1 }, [['get_product', byId]]);
await chain('search_projects', { hits: 1 }, [['get_project', byId]]);

await client.close();

const failed = results.filter((ok) => !ok).length;
console.log(
  `\n${failed === 0 ? '✓' : '✗'} ${results.length - failed}/${results.length} tool-kall OK` +
    ' (kun read-only).',
);
process.exit(failed === 0 ? 0 : 1);
