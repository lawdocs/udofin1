import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');
const ALLOWED = ['system', 'workers'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('system pool import boundary', () => {
  it('only src/system and src/workers import the system pool', () => {
    const offenders = files(SRC).filter((file) => {
      const rel = relative(SRC, file);
      if (ALLOWED.includes(rel.split(sep)[0] ?? '')) return false;
      return /from\s+['"][^'"]*system\/pool(\.js)?['"]/.test(readFileSync(file, 'utf8'));
    });
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('the HTTP server never imports anything from src/system or src/workers', () => {
    const server = readFileSync(join(SRC, 'server.ts'), 'utf8');
    expect(server).not.toMatch(/from\s+['"]\.\/(system|workers)\//);
  });

  it('modules and routes do not import the system folder either', () => {
    const offenders = files(SRC).filter((file) => {
      const rel = relative(SRC, file);
      if (ALLOWED.includes(rel.split(sep)[0] ?? '')) return false;
      return /from\s+['"][^'"]*\/system\//.test(readFileSync(file, 'utf8'));
    });
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
