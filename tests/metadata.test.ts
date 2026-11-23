import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** package.json, server.json (MCP Registry) and manifest.json (.mcpb) must agree. */
const read = (file: string) =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

describe('release metadata', () => {
  const pkg = read('package.json');
  const server = read('server.json');
  const manifest = read('manifest.json');

  it('uses one version everywhere', () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
  });

  it('uses one registry name and npm package name', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.packages[0].identifier).toBe(pkg.name);
  });
});
