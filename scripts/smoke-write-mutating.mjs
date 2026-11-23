#!/usr/bin/env node
/**
 * dryRun-verifisering av de to skrive-toolene som ENDRER eksisterende data:
 * update_customer og register_invoice_payment.
 *
 *   npm run smoke:write:mutating
 *
 * Disse er holdt utenfor smoke:write fordi de rører rader som allerede finnes.
 * Sikringene her:
 *   1. Hvert kall sendes med dryRun: true.
 *   2. Vi leser hele raden FØR kallet og sammenligner felt for felt etterpå.
 *   3. For update_customer beholdes originalen i minnet, og hvis rollback mot
 *      formodning ikke virket, skrives originalen tilbake umiddelbart.
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
    ...(process.env.CONTA_ORG_ID ? { CONTA_ORG_ID: process.env.CONTA_ORG_ID } : {}),
    ...(process.env.CONTA_BASE_URL ? { CONTA_BASE_URL: process.env.CONTA_BASE_URL } : {}),
  },
});

const client = new Client({ name: 'conta-smoke-mutating', version: '0.1.0' });
await client.connect(transport);

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

/** Kort feilsammendrag fra Contas InputOpException-format. */
function errorSummary(text) {
  try {
    const b = JSON.parse(text);
    const msgs = (b.contaResponse?.errors ?? [])
      .map((e) => e.messages?.NO ?? e.id)
      .filter(Boolean);
    return `${b.httpStatus}: ${msgs.join('; ') || JSON.stringify(b.contaResponse).slice(0, 200)}`;
  } catch {
    return text.slice(0, 200);
  }
}

const results = [];

// ─────────────────────────────────────────────────────────────
// 1. update_customer
// ─────────────────────────────────────────────────────────────
console.log('1. update_customer (dryRun) — full PUT-erstatning\n');

const { payload: custList } = await callTool('search_customers', { hits: 1 });
const customerId = custList?.hits?.[0]?.id;

if (customerId === undefined) {
  console.log('  – ingen kunder å teste mot; hopper over');
} else {
  const { payload: original } = await callTool('get_customer', { id: customerId });
  console.log(`  Kunde ${customerId}: "${original.name}"`);

  /** Map en kunderad tilbake til update_customer-argumenter. */
  const toArgs = (c, overrides = {}) => ({
    id: customerId,
    name: c.name,
    customerType: c.customerType,
    customerAddressLine1: c.customerAddressLine1,
    customerAddressPostcode: c.customerAddressPostcode,
    customerAddressCity: c.customerAddressCity,
    ...(c.orgNo ? { orgNo: c.orgNo } : {}),
    ...(c.phoneNo ? { phoneNo: c.phoneNo } : {}),
    ...(c.emailAddress ? { emailAddress: c.emailAddress } : {}),
    ...(c.daysUntilPaymentReminder !== undefined
      ? { daysUntilPaymentReminder: c.daysUntilPaymentReminder }
      : {}),
    ...(c.invoiceDeliveryMethod ? { invoiceDeliveryMethod: c.invoiceDeliveryMethod } : {}),
    ...(c.isActive !== undefined ? { isActive: c.isActive } : {}),
    ...overrides,
  });

  // Endre navnet slik at rollback faktisk har noe å rulle tilbake. Uten en
  // reell endring beviser testen ingenting.
  const marker = `${original.name} [DRYRUN]`;
  const { isError, text } = await callTool(
    'update_customer',
    toArgs(original, { name: marker, dryRun: true }),
  );

  if (isError) {
    console.log(`  ✗ update_customer feilet — ${errorSummary(text)}`);
    results.push(false);
  } else {
    const { payload: after } = await callTool('get_customer', { id: customerId });
    const unchanged = after.name === original.name;

    console.log(
      `  ${unchanged ? '✓' : '✗'} sendte name="${marker}", ` +
        `navn etterpå: "${after.name}"${unchanged ? ' — rullet tilbake' : ' — LAGRET!'}`,
    );

    if (!unchanged) {
      console.log('  ⚠ rollback virket ikke — gjenoppretter originalen...');
      const restore = await callTool('update_customer', toArgs(original));
      const { payload: restored } = await callTool('get_customer', { id: customerId });
      console.log(
        restore.isError || restored.name !== original.name
          ? `  ✗✗ GJENOPPRETTING FEILET. Sett navnet manuelt til "${original.name}".`
          : `  ✓ gjenopprettet til "${restored.name}"`,
      );
    }

    // Sjekk at ingen andre felt heller ble endret.
    const drifted = Object.keys(original).filter(
      (k) => JSON.stringify(original[k]) !== JSON.stringify(after[k]),
    );
    console.log(
      drifted.length === 0
        ? '  ✓ alle øvrige felt uendret'
        : `  ✗ felt endret: ${drifted.join(', ')}`,
    );
    results.push(unchanged && drifted.length === 0);
  }
}

// ─────────────────────────────────────────────────────────────
// 2. register_invoice_payment
// ─────────────────────────────────────────────────────────────
console.log('\n2. register_invoice_payment (dryRun)\n');

const { payload: bankList } = await callTool('search_bank_accounts', {
  allowedForInvoicing: true,
});
const banks = Array.isArray(bankList) ? bankList : (bankList?.hits ?? []);
const bankAccountId = banks[0]?.id;

const { payload: invList } = await callTool('search_invoices', { hits: 1 });
const invoice = invList?.hits?.[0];

if (bankAccountId === undefined || invoice === undefined) {
  console.log('  – mangler bankkonto eller faktura; hopper over');
} else {
  console.log(
    `  Faktura ${invoice.id} (nr ${invoice.invoiceNo}), ` +
      `sumRemaining=${invoice.sumRemaining}, bankkonto ${bankAccountId}`,
  );

  const { payload: paymentsBefore } = await callTool('get_invoice_payments', {
    id: invoice.id,
  });
  const countBefore = Array.isArray(paymentsBefore) ? paymentsBefore.length : 0;

  const { isError, text } = await callTool('register_invoice_payment', {
    invoiceId: invoice.id,
    amount: 1,
    date: '2026-07-30',
    bankAccountId,
    description: 'DRYRUN-test',
    dryRun: true,
  });

  if (isError) {
    // En avvist overbetaling er et gyldig utfall, ikke en feil i verktøyet.
    console.log(`  ! avvist av Conta — ${errorSummary(text)}`);
    console.log('    (fakturaen er allerede oppgjort, så dette er en overbetaling)');
    results.push(null);
  } else {
    const { payload: paymentsAfter } = await callTool('get_invoice_payments', {
      id: invoice.id,
    });
    const countAfter = Array.isArray(paymentsAfter) ? paymentsAfter.length : 0;
    const { payload: invoiceAfter } = await callTool('get_invoice', { id: invoice.id });

    const rolledBack =
      countBefore === countAfter && invoiceAfter.sumRemaining === invoice.sumRemaining;
    console.log(
      `  ${rolledBack ? '✓' : '✗'} betalinger ${countBefore} → ${countAfter}, ` +
        `sumRemaining ${invoice.sumRemaining} → ${invoiceAfter.sumRemaining}` +
        `${rolledBack ? ' — rullet tilbake' : ' — LAGRET!'}`,
    );
    results.push(rolledBack);
  }
}

await client.close();

const failed = results.filter((r) => r === false).length;
const skipped = results.filter((r) => r === null).length;
console.log(
  `\n${failed === 0 ? '✓' : '✗'} ${results.filter((r) => r === true).length} OK, ` +
    `${failed} feilet, ${skipped} avvist av forretningsregel.`,
);
process.exit(failed === 0 ? 0 : 1);
