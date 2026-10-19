// R-04 (static half): the domain schemas hold functions that are safe only because clients reach the
// database through the API. PostgREST must therefore never expose them. This fails if supabase/config.toml
// ever lists a domain schema in the REST API's exposed schemas. (The hosted project's setting, and a live
// request against the REST endpoint, still need to be checked on the real project: docs/operations.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONFIG = join(import.meta.dirname, '..', '..', '..', 'supabase', 'config.toml');
const ALLOWED_EXPOSED = ['public', 'graphql_public'];

/** Returns the string list assigned to `key` inside `[section]`, or undefined. Minimal TOML: enough for config.toml. */
function stringList(toml: string, section: string, key: string): string[] | undefined {
  let current = '';
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header?.[1]) {
      current = header[1];
      continue;
    }
    if (current !== section || !new RegExp(`^${key}\\s*=`).test(line)) continue;
    // The list may span several lines; comments are dropped line by line (no '#' appears inside our values).
    const stripComment = (value: string) => value.replace(/#.*$/, '');
    let text = stripComment(line.slice(line.indexOf('=') + 1));
    while (!text.includes(']') && i + 1 < lines.length) {
      i += 1;
      text += ` ${stripComment(lines[i] ?? '')}`;
    }
    const inside = /\[([\s\S]*)\]/.exec(text)?.[1] ?? '';
    return [...inside.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
  }
  return undefined;
}

describe('PostgREST exposure (supabase/config.toml)', () => {
  const toml = readFileSync(CONFIG, 'utf8');

  it('reads the exposed schemas (the check is not vacuous)', () => {
    const schemas = stringList(toml, 'api', 'schemas');
    expect(schemas).toBeDefined();
    expect(schemas?.length).toBeGreaterThan(0);
  });

  it('exposes only public and graphql_public, never a domain schema', () => {
    const schemas = stringList(toml, 'api', 'schemas') ?? [];
    const extra = schemas.filter((schema) => !ALLOWED_EXPOSED.includes(schema));
    expect(extra).toEqual([]);
  });

  it('does not put a domain schema on the extra search path either', () => {
    const extra = stringList(toml, 'api', 'extra_search_path') ?? [];
    const domain = [
      'tenancy',
      'identity',
      'consent',
      'audit',
      'lending',
      'servicing',
      'payments',
      'ops',
      'onboarding',
      'documents',
      'private',
    ];
    expect(extra.filter((schema) => domain.includes(schema))).toEqual([]);
  });

  it('the parser finds a domain schema when one is listed (guards against a parser that always passes)', () => {
    const bad = '[api]\nenabled = true\nschemas = [\n  "public",\n  "lending", # oops\n]\n';
    expect(stringList(bad, 'api', 'schemas')).toEqual(['public', 'lending']);
  });
});
