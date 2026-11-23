import { describe, it, expect } from 'vitest';
import {
  ContaClient,
  ContaApiError,
  type ContaClientOptions,
} from '../../src/conta-client.js';
import { mockFetch } from '../helpers/mock-fetch.js';

/**
 * Behaviour lockdown for ContaClient's non-rate-limit paths: auth header,
 * base URL, control headers (dryRun / forceReadonly / language), query-param
 * building, body parsing and the error envelope. 429 coverage lives in
 * `rate-limit.test.ts`.
 */

const PROD_BASE = 'https://api.gateway.conta.no';
const API_KEY = 'test-api-key-123';

function buildOptions(
  overrides: Partial<ContaClientOptions> = {},
): ContaClientOptions {
  return { apiKey: API_KEY, ...overrides };
}

describe('constructor', () => {
  it('sends the apiKey header and defaults to the production base URL', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: [{ id: 1 }] }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.get('/invoice/organizations');

    expect(fetchHandle.calls).toHaveLength(1);
    expect(fetchHandle.calls[0].url).toBe(`${PROD_BASE}/invoice/organizations`);
    expect(fetchHandle.calls[0].headers['apikey']).toBe(API_KEY);
    // No Authorization header — Conta authenticates with the apiKey header only.
    expect(fetchHandle.calls[0].headers['authorization']).toBeUndefined();
  });

  it('honors an explicit baseUrl override and strips a trailing slash', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: {} }]);
    const client = new ContaClient(
      buildOptions({
        baseUrl: 'https://conta.example.test/',
        fetch: fetchHandle.fetch,
      }),
    );

    await client.get('/invoice/ping');

    expect(fetchHandle.calls[0].url).toBe('https://conta.example.test/invoice/ping');
  });

  it('throws when called with no options and CONTA_API_KEY is missing', () => {
    const orig = process.env.CONTA_API_KEY;
    delete process.env.CONTA_API_KEY;
    try {
      expect(() => new ContaClient()).toThrow(/Missing CONTA_API_KEY/);
    } finally {
      if (orig !== undefined) process.env.CONTA_API_KEY = orig;
    }
  });

  it('reads apiKey, orgId, language and baseUrl from env when no options are given', () => {
    const snapshot = {
      key: process.env.CONTA_API_KEY,
      org: process.env.CONTA_ORG_ID,
      lang: process.env.CONTA_LANGUAGE,
      base: process.env.CONTA_BASE_URL,
    };
    process.env.CONTA_API_KEY = 'env-key';
    process.env.CONTA_ORG_ID = '4242';
    process.env.CONTA_LANGUAGE = 'en';
    process.env.CONTA_BASE_URL = 'https://env.example.test';
    try {
      const client = new ContaClient();
      expect(client.defaultOrgId).toBe(4242);
      expect(client.resolveOrgId()).toBe(4242);
    } finally {
      for (const [k, v] of Object.entries({
        CONTA_API_KEY: snapshot.key,
        CONTA_ORG_ID: snapshot.org,
        CONTA_LANGUAGE: snapshot.lang,
        CONTA_BASE_URL: snapshot.base,
      })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('rejects a non-integer CONTA_ORG_ID rather than sending NaN to the API', () => {
    const snapshot = {
      key: process.env.CONTA_API_KEY,
      org: process.env.CONTA_ORG_ID,
    };
    process.env.CONTA_API_KEY = 'env-key';
    process.env.CONTA_ORG_ID = 'not-a-number';
    try {
      expect(() => new ContaClient()).toThrow(/CONTA_ORG_ID must be a positive integer/);
    } finally {
      if (snapshot.key === undefined) delete process.env.CONTA_API_KEY;
      else process.env.CONTA_API_KEY = snapshot.key;
      if (snapshot.org === undefined) delete process.env.CONTA_ORG_ID;
      else process.env.CONTA_ORG_ID = snapshot.org;
    }
  });

  it('rejects an unsupported CONTA_LANGUAGE value', () => {
    const snapshot = {
      key: process.env.CONTA_API_KEY,
      lang: process.env.CONTA_LANGUAGE,
    };
    process.env.CONTA_API_KEY = 'env-key';
    process.env.CONTA_LANGUAGE = 'nb';
    try {
      expect(() => new ContaClient()).toThrow(/CONTA_LANGUAGE must be NO or EN/);
    } finally {
      if (snapshot.key === undefined) delete process.env.CONTA_API_KEY;
      else process.env.CONTA_API_KEY = snapshot.key;
      if (snapshot.lang === undefined) delete process.env.CONTA_LANGUAGE;
      else process.env.CONTA_LANGUAGE = snapshot.lang;
    }
  });
});

describe('resolveOrgId', () => {
  it('prefers an explicit id over the client default', () => {
    const client = new ContaClient(buildOptions({ orgId: 1 }));
    expect(client.resolveOrgId(2)).toBe(2);
  });

  it('falls back to the client default when no id is passed', () => {
    const client = new ContaClient(buildOptions({ orgId: 7 }));
    expect(client.resolveOrgId()).toBe(7);
  });

  it('throws an actionable message when neither is available', () => {
    const client = new ContaClient(buildOptions());
    expect(() => client.resolveOrgId()).toThrow(/list_organizations/);
  });
});

describe('control headers', () => {
  it('defaults conta-language to NO', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: {} }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.get('/invoice/ping');

    expect(fetchHandle.calls[0].headers['conta-language']).toBe('NO');
  });

  it('uses the client-level language override', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: {} }]);
    const client = new ContaClient(
      buildOptions({ language: 'EN', fetch: fetchHandle.fetch }),
    );

    await client.get('/invoice/ping');

    expect(fetchHandle.calls[0].headers['conta-language']).toBe('EN');
  });

  it('lets a per-request language win over the client default', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: {} }]);
    const client = new ContaClient(
      buildOptions({ language: 'NO', fetch: fetchHandle.fetch }),
    );

    await client.get('/invoice/ping', undefined, { language: 'EN' });

    expect(fetchHandle.calls[0].headers['conta-language']).toBe('EN');
  });

  it('sends conta-force-rollback: true when dryRun is set', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: { id: 1 } }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.post('/invoice/organizations/1/customers', { name: 'Acme' }, undefined, {
      dryRun: true,
    });

    expect(fetchHandle.calls[0].headers['conta-force-rollback']).toBe('true');
  });

  it('omits conta-force-rollback entirely when dryRun is false or absent', async () => {
    const fetchHandle = mockFetch([
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.post('/x', { a: 1 });
    await client.post('/x', { a: 1 }, undefined, { dryRun: false });

    expect(fetchHandle.calls[0].headers['conta-force-rollback']).toBeUndefined();
    expect(fetchHandle.calls[1].headers['conta-force-rollback']).toBeUndefined();
  });

  it('sends conta-force-readonly: true when forceReadonly is set', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: {} }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.post('/accounting/organizations/1/transactions', {}, undefined, {
      forceReadonly: true,
    });

    expect(fetchHandle.calls[0].headers['conta-force-readonly']).toBe('true');
    expect(fetchHandle.calls[0].headers['conta-force-rollback']).toBeUndefined();
  });

  it('carries the apiKey header on every verb, including multipart', async () => {
    const fetchHandle = mockFetch([
      { status: 200, body: {} },
      { status: 200, body: {} },
      { status: 200, body: {} },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.get('/a');
    await client.post('/a', {});
    await client.put('/a', {});
    await client.delete('/a');
    await client.postMultipart('/a', new FormData());

    for (const call of fetchHandle.calls) {
      expect(call.headers['apikey']).toBe(API_KEY);
    }
  });

  it('does not set Content-Type on multipart requests (fetch owns the boundary)', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: {} }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.postMultipart('/upload', new FormData());

    expect(fetchHandle.calls[0].headers['content-type']).toBeUndefined();
  });
});

describe('HTTP method helpers', () => {
  it('POST sends method=POST with a JSON-stringified body and JSON Content-Type', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: { id: 10 } }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.post('/foo', { bar: 1 });

    expect(fetchHandle.calls[0].method).toBe('POST');
    expect(fetchHandle.calls[0].body).toBe(JSON.stringify({ bar: 1 }));
    expect(fetchHandle.calls[0].headers['content-type']).toBe('application/json');
  });

  it('PUT sends method=PUT with a JSON-stringified body', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: { id: 11 } }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.put('/foo/11', { bar: 2 });

    expect(fetchHandle.calls[0].method).toBe('PUT');
    expect(fetchHandle.calls[0].body).toBe(JSON.stringify({ bar: 2 }));
  });

  it('PATCH sends method=PATCH with a JSON-stringified body', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: { id: 12 } }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.patch('/foo/12', { bar: 3 });

    expect(fetchHandle.calls[0].method).toBe('PATCH');
    expect(fetchHandle.calls[0].body).toBe(JSON.stringify({ bar: 3 }));
  });

  it('DELETE sends method=DELETE with no body and no Content-Type', async () => {
    const fetchHandle = mockFetch([{ status: 204, bodyText: '' }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.delete('/foo/11');

    expect(fetchHandle.calls[0].method).toBe('DELETE');
    expect(fetchHandle.calls[0].body).toBeUndefined();
    expect(fetchHandle.calls[0].headers['content-type']).toBeUndefined();
  });
});

describe('query params', () => {
  it('builds the URL with every supplied param', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: [] }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.get('/invoice/organizations/1/customers', { q: 'acme', page: 0, hits: 25 });

    const url = new URL(fetchHandle.calls[0].url);
    expect(url.origin + url.pathname).toBe(`${PROD_BASE}/invoice/organizations/1/customers`);
    expect(url.searchParams.get('q')).toBe('acme');
    expect(url.searchParams.get('page')).toBe('0');
    expect(url.searchParams.get('hits')).toBe('25');
  });

  it('skips undefined and null params instead of serialising them', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: [] }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.get('/x', { a: '1', b: undefined, c: null });

    const url = new URL(fetchHandle.calls[0].url);
    expect(url.searchParams.get('a')).toBe('1');
    expect(url.searchParams.has('b')).toBe(false);
    expect(url.searchParams.has('c')).toBe(false);
  });

  it('serialises booleans as "true"/"false", not "1"/"0"', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: [] }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.get('/x', { onlyActive: true, includeOldTransactions: false });

    const url = new URL(fetchHandle.calls[0].url);
    expect(url.searchParams.get('onlyActive')).toBe('true');
    expect(url.searchParams.get('includeOldTransactions')).toBe('false');
  });

  it('repeats an array param once per item (OpenAPI form/explode default)', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: [] }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.get('/x', { detailedCategories: ['ASSETS', 'EQUITY'] });

    const url = new URL(fetchHandle.calls[0].url);
    expect(url.searchParams.getAll('detailedCategories')).toEqual(['ASSETS', 'EQUITY']);
  });

  it('emits nothing for an empty array param', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: [] }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.get('/x', { a: [], b: '1' });

    const url = new URL(fetchHandle.calls[0].url);
    expect(url.searchParams.has('a')).toBe(false);
    expect(url.searchParams.get('b')).toBe('1');
  });

  it('keeps a falsy zero param rather than dropping it', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: [] }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await client.get('/x', { page: 0 });

    expect(new URL(fetchHandle.calls[0].url).searchParams.get('page')).toBe('0');
  });
});

describe('response body parsing', () => {
  it('parses a JSON object response', async () => {
    const fetchHandle = mockFetch([{ status: 200, body: { id: 42, name: 'Gamma' } }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    expect(await client.get('/x')).toEqual({ id: 42, name: 'Gamma' });
  });

  it('parses a top-level JSON array response (the shape /invoice/organizations returns)', async () => {
    const orgs = [{ id: 1, name: 'Acme AS', active: true }];
    const fetchHandle = mockFetch([{ status: 200, body: orgs }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    expect(await client.get('/invoice/organizations')).toEqual(orgs);
  });

  it('returns {} when the response body is empty (204 No Content)', async () => {
    const fetchHandle = mockFetch([{ status: 204, bodyText: '' }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    expect(await client.delete('/invoice/organizations/1/payments/5')).toEqual({});
  });

  it('returns the raw string when the body is not valid JSON (e.g. the ping response)', async () => {
    const fetchHandle = mockFetch([{ status: 200, bodyText: 'pong' }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    expect(await client.get('/invoice/ping')).toBe('pong');
  });
});

describe('error responses', () => {
  it('throws ContaApiError with status and bodyText preserved on 500', async () => {
    const fetchHandle = mockFetch([{ status: 500, bodyText: 'boom: database offline' }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    let caught: unknown;
    try {
      await client.get('/invoice/organizations');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ContaApiError);
    const apiErr = caught as ContaApiError;
    expect(apiErr.status).toBe(500);
    expect(apiErr.bodyText).toBe('boom: database offline');
    expect(apiErr.name).toBe('ContaApiError');
  });

  it('surfaces a 401 without retrying — there is no session to refresh', async () => {
    const fetchHandle = mockFetch([{ status: 401, bodyText: 'invalid api key' }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    await expect(client.get('/invoice/organizations')).rejects.toThrow(ContaApiError);
    expect(fetchHandle.calls).toHaveLength(1);
  });

  it('throws ContaApiError with status 404 when the resource is missing', async () => {
    const fetchHandle = mockFetch([{ status: 404, bodyText: 'not found' }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    let caught: unknown;
    try {
      await client.get('/invoice/organizations/1/customers/9999');
    } catch (err) {
      caught = err;
    }

    expect((caught as ContaApiError).status).toBe(404);
  });

  it('never leaks the API key into the error message', async () => {
    const fetchHandle = mockFetch([{ status: 403, bodyText: 'forbidden' }]);
    const client = new ContaClient(buildOptions({ fetch: fetchHandle.fetch }));

    let caught: unknown;
    try {
      await client.get('/invoice/organizations');
    } catch (err) {
      caught = err;
    }

    const apiErr = caught as ContaApiError;
    expect(apiErr.message).not.toContain(API_KEY);
    expect(apiErr.message).toContain('/invoice/organizations');
  });
});
