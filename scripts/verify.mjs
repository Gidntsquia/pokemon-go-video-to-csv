#!/usr/bin/env node
// JavaScript Document
//
// Verify a scanned collection CSV against a hand-checked reference CSV.
//
// The accuracy oracle for scanner work: rows are matched as a multiset on
// the compared columns, so duplicate specimens of one species are handled
// correctly. Unmatched rows are then paired by name to show which fields
// actually differ, instead of dumping two whole rows.
//
// Usage:
//   node scripts/verify.mjs <scanned.csv> <reference.csv> [options]
//
// Options:
//   --ignore a,b    columns to exclude from comparison (e.g. level,cp)
//   --min N         exit 0 only if match percentage >= N   (default 100)
//   --quiet         only print the summary line
//   --help
//
// Exit codes: 0 accuracy >= --min, 1 below it, 2 usage error.

import { readFileSync } from 'node:fs';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** @returns {{header: string[], rows: Record<string, string>[]}} */
function loadCollection(path) {
  const [header, ...body] = parseCsv(readFileSync(path, 'utf8'));
  const cols = header.map((h) => h.trim().toLowerCase());
  const rows = body.map((cells) =>
    Object.fromEntries(cols.map((col, i) => [col, (cells[i] ?? '').trim()]))
  );
  return { header: cols, rows };
}

// Blank, "0" and "false" all mean "not shadow" across the two CSV dialects.
function normalize(col, value) {
  if (col === 'shadow') return /^(1|true|yes)$/i.test(value) ? '1' : '';
  if (/^\d+(\.\d+)?$/.test(value)) return String(Number(value));
  return value.toLowerCase();
}

function keyOf(row, cols) {
  return cols.map((c) => normalize(c, row[c] ?? '')).join('|');
}

function parseArgs(argv) {
  const opts = { ignore: [], min: 100, quiet: false, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help': case '-h': opts.help = true; break;
      case '--ignore': opts.ignore = argv[++i].split(',').map((s) => s.trim().toLowerCase()); break;
      case '--min': opts.min = Number(argv[++i]); break;
      case '--quiet': opts.quiet = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
        opts.paths.push(arg);
    }
  }
  return opts;
}

const USAGE = `Usage: node scripts/verify.mjs <scanned.csv> <reference.csv>
                              [--ignore level,cp] [--min 100] [--quiet]`;

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (opts.help || opts.paths.length !== 2) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
  }

  const [scannedPath, referencePath] = opts.paths;
  const scanned = loadCollection(scannedPath);
  const reference = loadCollection(referencePath);
  const cols = reference.header.filter(
    (c) => scanned.header.includes(c) && !opts.ignore.includes(c)
  );
  if (cols.length === 0) {
    console.error('error: the two files share no comparable columns');
    process.exit(2);
  }

  // Multiset exact-row match on the compared columns.
  const pool = new Map();
  for (const row of scanned.rows) {
    const k = keyOf(row, cols);
    pool.set(k, (pool.get(k) ?? 0) + 1);
  }
  const missing = [];
  let matched = 0;
  for (const row of reference.rows) {
    const k = keyOf(row, cols);
    const n = pool.get(k) ?? 0;
    if (n > 0) { pool.set(k, n - 1); matched++; }
    else missing.push(row);
  }
  const extra = [];
  for (const row of scanned.rows) {
    const k = keyOf(row, cols);
    const n = pool.get(k) ?? 0;
    if (n > 0) { pool.set(k, n - 1); extra.push(row); }
  }

  const total = reference.rows.length;
  const pct = total === 0 ? 100 : (matched / total) * 100;
  console.log(
    `verify: ${matched}/${total} reference rows matched (${pct.toFixed(1)}%) ` +
      `on [${cols.join(',')}] -- ${missing.length} missing, ${extra.length} extra in scan`
  );

  if (!opts.quiet && (missing.length || extra.length)) {
    // Pair leftovers by name so the report shows the differing fields.
    const extraByName = new Map();
    for (const row of extra) {
      const name = normalize('name', row.name ?? '');
      if (!extraByName.has(name)) extraByName.set(name, []);
      extraByName.get(name).push(row);
    }
    for (const ref of missing) {
      const name = normalize('name', ref.name ?? '');
      const candidates = extraByName.get(name) ?? [];
      const scan = candidates.shift();
      if (scan) {
        const diffs = cols
          .filter((c) => normalize(c, ref[c] ?? '') !== normalize(c, scan[c] ?? ''))
          .map((c) => `${c}: ref=${ref[c] || '(blank)'} scan=${scan[c] || '(blank)'}`);
        console.log(`  MISMATCH ${ref.name}: ${diffs.join(', ')}`);
      } else {
        console.log(`  MISSING  ${cols.map((c) => `${c}=${ref[c]}`).join(' ')}`);
      }
    }
    for (const rows of extraByName.values()) {
      for (const row of rows) {
        console.log(`  EXTRA    ${cols.map((c) => `${c}=${row[c]}`).join(' ')}`);
      }
    }
  }

  process.exit(pct >= opts.min ? 0 : 1);
}

main();
