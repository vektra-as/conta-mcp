#!/usr/bin/env node
/**
 * Røyk-test av SKRIVE-tools med dryRun=true — mot ekte Conta-API.
 *
 *   npm run smoke:write
 *
 * Hensikten er å bevise, ikke anta, at `conta-force-rollback` faktisk ruller
 * tilbake: for hvert kall teller vi antall rader før og etter, og krever at
 * tallet er uendret.
 *
 * SIKKERHET:
 *   - Hvert kall sendes med dryRun: true. Scriptet nekter å kjøre uten.
 *   - Kun endepunkter som OPPRETTER nye rader er dekket. Tools som endrer
 *     eksisterende data (create_invoice, create_credit_note,
 *     register_invoice_payment, delete_payment, update_customer) kjøres IKKE
 *     her — de må verifiseres bevisst og manuelt.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (!process.env.CONTA_API_KEY) {
  console.error('✗ CONTA_API_KEY er ikke satt.');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: {
    PATH: process.env.PATH,
    CONTA_API_KEY: process.env.CONTA_API_KEY,
    // Serveren er skrivebeskyttet som standard. dryRun-testene trenger skrive-verktøyene.
    CONTA_READ_ONLY: 'false',
    ...(process.env.CONTA_ORG_ID ? { CONTA_ORG_ID: process.env.CONTA_ORG_ID } : {}),
    ...(process.env.CONTA_BASE_URL ? { CONTA_BASE_URL: process.env.CONTA_BASE_URL } : {}),
  },
});

const client = new Client({ name: 'conta-smoke-write', version: '0.1.0' });
await client.connect(transport);

/** Rå JSON fra et tool-kall, eller undefined hvis svaret ikke var JSON. */
async function callTool(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    /* ikke JSON */
  }
  return { isError: Boolean(res.isError), text, payload };
}

/** hitCount for en søke-tool — brukes som «antall rader»-måling. */
async function countVia(searchTool) {
  const { payload, text, isError } = await callTool(searchTool, { hits: 1 });
  if (isError) throw new Error(`${searchTool} feilet: ${text.slice(0, 200)}`);
  if (typeof payload?.hitCount !== 'number') {
    throw new Error(`${searchTool} ga ingen hitCount: ${text.slice(0, 200)}`);
  }
  return payload.hitCount;
}

const results = [];

/**
 * Kjør ett skrive-tool med dryRun=true og bevis at radantallet er uendret.
 * `countTool` er søke-toolet som måler samme kolleksjon.
 */
async function dryRunCreates(label, writeTool, args, countTool) {
  const guarded = { ...args, dryRun: true };
  if (guarded.dryRun !== true) throw new Error('refusing to run without dryRun');

  const before = await countVia(countTool);
  const { isError, text, payload } = await callTool(writeTool, guarded);
  const after = await countVia(countTool);

  if (isError) {
    console.log(`  ✗ ${label}\n     ${text.replace(/\n/g, '\n     ').slice(0, 500)}`);
    results.push(false);
    return;
  }

  const rolledBack = before === after;
  const newId = payload?.id ?? payload?.value?.id;
  console.log(
    `  ${rolledBack ? '✓' : '✗'} ${label} → svar ok${newId ? ` (id ${newId} i svaret)` : ''}, ` +
      `${countTool} hitCount ${before} → ${after}` +
      `${rolledBack ? ' — rullet tilbake' : ' — LAGRET! rollback virket IKKE'}`,
  );
  results.push(rolledBack);
}

console.log('dryRun=true mot ekte API — beviser rollback ved å telle før/etter:\n');

await dryRunCreates(
  'create_project',
  'create_project',
  { name: 'DRYRUN-test (skal rulles tilbake)' },
  'search_projects',
);

await dryRunCreates(
  'create_product',
  'create_product',
  {
    name: 'DRYRUN-test produkt',
    bookkeepingAccountNo: '3000',
    vatCode: 'output.high',
  },
  'search_products',
);

await dryRunCreates(
  'create_customer',
  'create_customer',
  {
    name: 'DRYRUN Testkunde AS',
    customerType: 'ORGANIZATION',
    customerAddressLine1: 'Teststreet 1',
    customerAddressPostcode: '0155',
    customerAddressCity: 'Oslo',
  },
  'search_customers',
);

// En kladd krever nøyaktig én av customerId/customerGroupId, så vi låner
// id-en til en eksisterende kunde.
const { payload: customerSearch } = await callTool('search_customers', { hits: 1 });
const existingCustomerId = customerSearch?.hits?.[0]?.id;

if (existingCustomerId === undefined) {
  console.log('  – ingen kunder i org-en; hopper over create_invoice_draft');
} else {
  await dryRunCreates(
    `create_invoice_draft (customerId ${existingCustomerId})`,
    'create_invoice_draft',
    {
      customerId: existingCustomerId,
      invoiceDraftLines: [
        { description: 'DRYRUN-linje', price: 1000, vatCode: 'high', quantity: 2 },
      ],
    },
    'search_invoice_drafts',
  );
}

await client.close();

const failed = results.filter((ok) => !ok).length;
console.log(
  `\n${failed === 0 ? '✓' : '✗'} ${results.length - failed}/${results.length} dryRun-kall ` +
    'validerte OK og ble rullet tilbake.',
);
console.log(
  'Ikke dekket her (endrer eksisterende data — verifiser manuelt):\n' +
    '  create_invoice, create_credit_note, register_invoice_payment,\n' +
    '  delete_payment, update_customer',
);
process.exit(failed === 0 ? 0 : 1);
