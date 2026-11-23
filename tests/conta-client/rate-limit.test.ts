import { describe, it, expect } from 'vitest';
import {
  ContaClient,
  ContaApiError,
  ContaRateLimitError,
  computeBackoffMs,
} from '../../src/conta-client.js';
import { mockFetch, mockSleep } from '../helpers/mock-fetch.js';

/**
 * 429 backoff behaviour. Conta's spec documents no rate limits at all, so the
 * client has to be defensive: honour `Retry-After` when the gateway sends it,
 * otherwise back off linearly and eventually give up with a typed error.
 */

function makeClient(
  fetchImpl: typeof globalThis.fetch,
  sleepImpl: (ms: number) => Promise<void>,
  overrides: { maxRetries?: number; initialBackoffMs?: number } = {},
): ContaClient {
  return new ContaClient({
    apiKey: 'test-api-key-123',
    fetch: fetchImpl,
    sleep: sleepImpl,
    initialBackoffMs: overrides.initialBackoffMs ?? 100,
    maxRetries: overrides.maxRetries ?? 3,
  });
}

describe('computeBackoffMs', () => {
  it('uses Retry-After (seconds) when present and numeric', () => {
    expect(computeBackoffMs(0, new Headers({ 'Retry-After': '5' }), 1000)).toBe(5000);
  });

  it('uses linear fallback when Retry-After is absent', () => {
    const headers = new Headers();
    expect(computeBackoffMs(0, headers, 1000)).toBe(1000);
    expect(computeBackoffMs(1, headers, 1000)).toBe(2000);
    expect(computeBackoffMs(2, headers, 1000)).toBe(3000);
  });

  it('treats a non-numeric Retry-After (HTTP-date form) as absent', () => {
    // Retry-After may legally be an HTTP-date. We do not parse that form; the
    // linear fallback keeps us from sleeping NaN ms.
    const headers = new Headers({ 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' });
    expect(computeBackoffMs(1, headers, 500)).toBe(1000);
  });

  it('treats an empty Retry-After as absent rather than as zero', () => {
    expect(computeBackoffMs(0, new Headers({ 'Retry-After': '  ' }), 750)).toBe(750);
  });

  it('clamps a negative Retry-After to zero', () => {
    expect(computeBackoffMs(0, new Headers({ 'Retry-After': '-5' }), 1000)).toBe(0);
  });
});

describe('429 retry behavior', () => {
  it('retries a single 429 using Retry-After and returns the 200 body', async () => {
    const successBody = { id: 99, name: 'Acme' };
    const fetchHandle = mockFetch([
      { status: 429, headers: { 'Retry-After': '2' } },
      { status: 200, body: successBody },
    ]);
    const sleepHandle = mockSleep();
    const client = makeClient(fetchHandle.fetch, sleepHandle.sleep);

    const result = await client.get('/invoice/organizations');

    expect(result).toEqual(successBody);
    expect(sleepHandle.delays).toEqual([2000]);
    expect(fetchHandle.calls).toHaveLength(2);
    expect(fetchHandle.calls[1].url).toContain('/invoice/organizations');
    expect(fetchHandle.calls[1].method).toBe('GET');
  });

  it('falls back to linear backoff when no Retry-After header is present', async () => {
    const fetchHandle = mockFetch([{ status: 429 }, { status: 200, body: { ok: true } }]);
    const sleepHandle = mockSleep();
    const client = makeClient(fetchHandle.fetch, sleepHandle.sleep, {
      initialBackoffMs: 100,
    });

    await client.get('/invoice/ping');

    // attempt=0, initialBackoffMs=100 -> 100 * (0 + 1) = 100
    expect(sleepHandle.delays).toEqual([100]);
  });

  it('retries twice when two 429s arrive in a row', async () => {
    const fetchHandle = mockFetch([
      { status: 429 },
      { status: 429, headers: { 'Retry-After': '2' } },
      { status: 200, body: { ok: true } },
    ]);
    const sleepHandle = mockSleep();
    const client = makeClient(fetchHandle.fetch, sleepHandle.sleep, {
      initialBackoffMs: 100,
    });

    const result = await client.get('/invoice/ping');

    expect(result).toEqual({ ok: true });
    expect(fetchHandle.calls).toHaveLength(3);
    // attempt 0 -> linear 100, attempt 1 -> Retry-After 2000
    expect(sleepHandle.delays).toEqual([100, 2000]);
  });

  it('re-sends the apiKey header and the original body on every retry', async () => {
    const fetchHandle = mockFetch([
      { status: 429 },
      { status: 200, body: { id: 1 } },
    ]);
    const sleepHandle = mockSleep();
    const client = makeClient(fetchHandle.fetch, sleepHandle.sleep);

    await client.post(
      '/invoice/organizations/1/customers',
      { name: 'Acme' },
      undefined,
      { dryRun: true },
    );

    expect(fetchHandle.calls).toHaveLength(2);
    for (const call of fetchHandle.calls) {
      expect(call.headers['apikey']).toBe('test-api-key-123');
      expect(call.headers['conta-force-rollback']).toBe('true');
      expect(call.body).toBe(JSON.stringify({ name: 'Acme' }));
    }
  });

  it('throws ContaRateLimitError once retries are exhausted', async () => {
    const rateLimited = {
      status: 429,
      headers: { 'Retry-After': '1' },
      bodyText: 'slow down',
    };
    const fetchHandle = mockFetch([rateLimited, rateLimited, rateLimited, rateLimited]);
    const sleepHandle = mockSleep();
    const client = makeClient(fetchHandle.fetch, sleepHandle.sleep, {
      maxRetries: 2,
      initialBackoffMs: 100,
    });

    let caught: unknown;
    try {
      await client.get('/invoice/organizations');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ContaRateLimitError);
    expect(caught).toBeInstanceOf(ContaApiError);
    const rateErr = caught as ContaRateLimitError;
    expect(rateErr.status).toBe(429);
    expect(rateErr.bodyText).toBe('slow down');
    expect(rateErr.retryAfterMs).toBe(1000);
    // initial attempt + 2 retries = 3 fetches; the 4th mock stays unconsumed.
    expect(fetchHandle.calls).toHaveLength(3);
    expect(sleepHandle.delays).toHaveLength(2);
    expect(fetchHandle.remaining()).toBe(1);
  });

  it('does not retry at all when maxRetries is 0', async () => {
    const fetchHandle = mockFetch([{ status: 429, bodyText: 'nope' }]);
    const sleepHandle = mockSleep();
    const client = makeClient(fetchHandle.fetch, sleepHandle.sleep, { maxRetries: 0 });

    await expect(client.get('/invoice/ping')).rejects.toThrow(ContaRateLimitError);
    expect(fetchHandle.calls).toHaveLength(1);
    expect(sleepHandle.delays).toEqual([]);
  });

  it('applies the same retry loop to multipart uploads', async () => {
    const fetchHandle = mockFetch([
      { status: 429, headers: { 'Retry-After': '1' } },
      { status: 200, body: { id: 3 } },
    ]);
    const sleepHandle = mockSleep();
    const client = makeClient(fetchHandle.fetch, sleepHandle.sleep);

    const result = await client.postMultipart('/upload', new FormData());

    expect(result).toEqual({ id: 3 });
    expect(sleepHandle.delays).toEqual([1000]);
  });
});

describe('normal non-429 paths still work', () => {
  it('returns the parsed JSON body on a 200 response without sleeping', async () => {
    const body = { id: 1, name: 'Hello' };
    const fetchHandle = mockFetch([{ status: 200, body }]);
    const sleepHandle = mockSleep();
    const client = makeClient(fetchHandle.fetch, sleepHandle.sleep);

    expect(await client.get('/x')).toEqual(body);
    expect(sleepHandle.delays).toEqual([]);
  });

  it('does not retry a 500 — only 429 is retried', async () => {
    const fetchHandle = mockFetch([{ status: 500, bodyText: 'boom' }]);
    const sleepHandle = mockSleep();
    const client = makeClient(fetchHandle.fetch, sleepHandle.sleep);

    let caught: unknown;
    try {
      await client.get('/x');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ContaApiError);
    expect(caught).not.toBeInstanceOf(ContaRateLimitError);
    expect((caught as ContaApiError).status).toBe(500);
    expect(fetchHandle.calls).toHaveLength(1);
    expect(sleepHandle.delays).toEqual([]);
  });
});
