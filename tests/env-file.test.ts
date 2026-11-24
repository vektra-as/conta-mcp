import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContaEnvFile, defaultEnvFilePath } from '../src/env-file.js';

describe('loadContaEnvFile', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'conta-env-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const writeDefault = (content: string, mode = 0o600) => {
    const path = defaultEnvFilePath(home);
    mkdirSync(join(home, '.config', 'conta-mcp'), { recursive: true });
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
  };

  it('is a no-op when the default file is missing', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = loadContaEnvFile(env, { home });
    expect(res.loaded).toBe(false);
    expect(env).toEqual({});
  });

  it('throws when an explicit CONTA_ENV_FILE is missing', () => {
    const env: NodeJS.ProcessEnv = { CONTA_ENV_FILE: join(home, 'nope.env') };
    expect(() => loadContaEnvFile(env, { home })).toThrow(/CONTA_ENV_FILE/);
  });

  it('applies CONTA_* values from the file and reports names only', () => {
    writeDefault('CONTA_API_KEY=test-key-123\nCONTA_READ_ONLY=false\nOTHER=x\nCONTA_ORG_ID=\n');
    const env: NodeJS.ProcessEnv = {};
    const res = loadContaEnvFile(env, { home });
    expect(env.CONTA_API_KEY).toBe('test-key-123');
    expect(env.CONTA_READ_ONLY).toBe('false');
    expect(env.OTHER).toBeUndefined();
    expect(env.CONTA_ORG_ID).toBeUndefined();
    expect(res.applied.sort()).toEqual(['CONTA_API_KEY', 'CONTA_READ_ONLY']);
    expect(JSON.stringify(res)).not.toContain('test-key-123');
  });

  it('lets the existing environment win over the file', () => {
    writeDefault('CONTA_API_KEY=from-file\nCONTA_READ_ONLY=false\n');
    const env: NodeJS.ProcessEnv = { CONTA_API_KEY: 'from-env', CONTA_READ_ONLY: '' };
    loadContaEnvFile(env, { home });
    expect(env.CONTA_API_KEY).toBe('from-env');
    expect(env.CONTA_READ_ONLY).toBe('false');
  });

  it('reads the file named by CONTA_ENV_FILE', () => {
    const path = join(home, 'custom.env');
    writeFileSync(path, 'CONTA_API_KEY=custom\n');
    chmodSync(path, 0o600);
    const env: NodeJS.ProcessEnv = { CONTA_ENV_FILE: path };
    loadContaEnvFile(env, { home });
    expect(env.CONTA_API_KEY).toBe('custom');
  });

  it('warns when the file is readable by others', () => {
    writeDefault('CONTA_API_KEY=k\n', 0o644);
    const res = loadContaEnvFile({}, { home, platform: 'darwin' });
    expect(res.warnings[0]).toMatch(/chmod 600/);
  });

  it('does not warn for mode 600', () => {
    writeDefault('CONTA_API_KEY=k\n', 0o600);
    const res = loadContaEnvFile({}, { home, platform: 'darwin' });
    expect(res.warnings).toEqual([]);
  });
});
