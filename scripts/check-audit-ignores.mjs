#!/usr/bin/env node
// Keeps the dependency-audit ignore list honest.
//
// package.json -> pnpm.auditConfig.ignoreGhsas silences two advisories for the whole workspace
// (RA-001 node-forge, RA-002 braces; docs/security/risk-acceptances.md). They were accepted ONLY for
// developer and build tooling reached through apps/mobile -> expo. `pnpm audit` cannot scope an
// ignore to a package, so this script supplies the scope: it fails when a package covered by an
// ignore appears in the PRODUCTION dependency closure of any code that runs on a server.
//
// It also fails when package.json ignores an advisory this script does not know about, so a new
// ignore cannot be added without an explicit scope decision and a risk-acceptance entry.
//
// Usage (needs `pnpm install` first; CI runs it in the quality job):
//   node scripts/check-audit-ignores.mjs
// Options, for proving that the check itself can fail (do not use them in CI):
//   --ban=<pkg>[,<pkg>]            check these package names instead of the ignored advisories
//   --workspaces=<name>[,<name>]   check these workspaces instead of the server-side list
// Exit codes: 0 clean, 1 a covered package is in the closure (or an unknown ignore), 2 the check could not run.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Advisory -> the package it was accepted for, and the risk-acceptance entry that records why. */
const ACCEPTED_ADVISORIES = new Map([
  ['GHSA-86w9-cpqp-85rv', { pkg: 'node-forge', ra: 'RA-001' }],
  ['GHSA-vfj7-8cjw-p6xm', { pkg: 'braces', ra: 'RA-002' }],
]);

/**
 * Workspaces whose production dependencies run on a server. The API, its libraries, and the two
 * portals (Next.js servers). Each is expanded with its workspace dependencies (`name...`), so
 * auth-client, portal-kit and design-tokens are covered through the portals. apps/mobile is
 * deliberately absent: it is the scope of the acceptance and ships no server code.
 */
const SERVER_WORKSPACES = [
  '@udofin/api',
  '@udofin/adapters',
  '@udofin/contracts',
  '@udofin/domain',
  '@udofin/ops-portal',
  '@udofin/lender-portal',
];

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { ban: null, workspaces: null };
  for (const arg of argv) {
    const m = /^--(ban|workspaces)=(.+)$/.exec(arg);
    if (!m) fail(2, `Unknown argument: ${arg}`);
    opts[m[1]] = m[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return opts;
}

function ignoredAdvisories() {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const list = pkg?.pnpm?.auditConfig?.ignoreGhsas ?? [];
  if (!Array.isArray(list)) fail(2, 'package.json pnpm.auditConfig.ignoreGhsas is not an array');
  return list;
}

/** Depth-first walk of `pnpm ls --json` output, collecting every node whose name is in `banned`. */
function findHits(project, banned) {
  const hits = [];
  const walk = (deps, chain) => {
    for (const [key, node] of Object.entries(deps ?? {})) {
      const here = [...chain, key];
      if (banned.has(key) || banned.has(node?.from)) {
        hits.push({ project: project.name, chain: here, version: node?.version ?? 'unknown' });
      }
      walk(node?.dependencies, here);
    }
  };
  walk(project.dependencies, []);
  return hits;
}

const opts = parseArgs(process.argv.slice(2));
const ignored = ignoredAdvisories();

const unknown = ignored.filter((id) => !ACCEPTED_ADVISORIES.has(id));
if (opts.ban === null && unknown.length > 0) {
  fail(
    1,
    `package.json ignores advisories that scripts/check-audit-ignores.mjs does not scope: ${unknown.join(', ')}.\n` +
      'Add the advisory (with its package and a risk-acceptance id from docs/security/risk-acceptances.md) ' +
      'to ACCEPTED_ADVISORIES, or remove the ignore.',
  );
}

const banned = new Set(opts.ban ?? ignored.map((id) => ACCEPTED_ADVISORIES.get(id).pkg));
const workspaces = opts.workspaces ?? SERVER_WORKSPACES;
if (banned.size === 0) {
  console.log('No audit ignores are configured; nothing to scope.');
  process.exit(0);
}

const filters = workspaces.flatMap((w) => ['--filter', `${w}...`]);

/** Runs `pnpm ls --prod --json` for the selected workspaces and returns the parsed project list. */
function listProjects(extra) {
  let output;
  try {
    output = execFileSync('pnpm', [...filters, 'ls', '--prod', '--json', ...extra], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    fail(
      2,
      `pnpm ls failed (is the workspace installed? run \`pnpm install\`):\n${String(e.stderr ?? e)}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail(2, 'pnpm ls did not return JSON');
  }
  if (!Array.isArray(parsed)) fail(2, 'pnpm ls returned an unexpected JSON shape');
  return parsed;
}

const projects = listProjects(['--depth', 'Infinity', ...banned]);

// Guard against a vacuous pass: every requested workspace must appear in the result.
const seen = new Set(projects.map((p) => p.name));
const missing = workspaces.filter((w) => !seen.has(w));
if (missing.length > 0) {
  fail(
    2,
    `pnpm ls did not report these workspaces, so they were not checked: ${missing.join(', ')}`,
  );
}

// Second guard. A search that matches nothing prints a bare project entry, which is also what pnpm
// prints when nothing is installed. So prove that pnpm can see the installed tree: every direct
// production dependency a workspace declares must be reported for it.
for (const project of listProjects(['--depth', '0'])) {
  const manifest = JSON.parse(readFileSync(resolve(project.path, 'package.json'), 'utf8'));
  const reported = new Set(Object.keys(project.dependencies ?? {}));
  const absent = Object.keys(manifest.dependencies ?? {}).filter((d) => !reported.has(d));
  if (absent.length > 0) {
    fail(
      2,
      `pnpm ls cannot see the installed dependencies of ${project.name} (missing: ${absent.join(', ')}). ` +
        'Run `pnpm install` first; a result without them would pass vacuously.',
    );
  }
}

const hits = projects.flatMap((p) => findHits(p, banned));
if (hits.length > 0) {
  const byPkg = (name) =>
    [...ACCEPTED_ADVISORIES.values()].find((a) => a.pkg === name)?.ra ?? 'not an accepted package';
  console.error(
    'Production dependency closure of server-side code contains a package covered by an audit ignore:',
  );
  for (const h of hits) {
    const name = h.chain[h.chain.length - 1];
    console.error(`  ${h.project}: ${h.chain.join(' > ')}@${h.version}  (${byPkg(name)})`);
  }
  console.error(
    '\nThe ignore was accepted for apps/mobile build tooling only. Upgrade or replace the dependency, ' +
      'or remove the ignore and re-audit; do not extend the scope without a new risk acceptance.',
  );
  process.exit(1);
}

console.log(
  `OK: ${[...banned].join(', ')} not in the production dependency closure of ${String(projects.length)} server-side workspaces (${[...seen].join(', ')}).`,
);
