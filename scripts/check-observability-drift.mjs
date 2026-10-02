#!/usr/bin/env node
/**
 * Fails when an alert rule or dashboard panel references a metric the application does not emit.
 *
 * Dashboards and alerts rot silently. Someone renames a counter, the alert stops matching anything,
 * and it simply never fires again — the failure is invisible until the incident it was supposed to
 * catch. Nothing in a normal test suite covers this, because the rules live in YAML and the metrics
 * live in TypeScript and neither imports the other.
 *
 * Emitted metrics are discovered from `.counter('name')` / `.histogram('name', ...)` calls in the
 * source. Referenced metrics are extracted from the rules YAML and dashboard JSON. Recording rules
 * defined in the same file count as legitimate names, since panels are meant to consume them.
 *
 * Exits non-zero on a reference to something that is not emitted. Metrics that exist but are
 * observed by nothing are reported as information, not treated as an error — an unused metric is a
 * hint, not a defect.
 *
 * Run: node scripts/check-observability-drift.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const REPO_ROOT = process.cwd();

const SOURCE_DIRS = ['packages/api/src', 'services/gateway/src'];
const OBSERVABILITY_DIR = 'deploy/observability';

/**
 * Series Prometheus provides itself, or that a histogram expands into. `le` is a label rather than
 * a metric but appears in the same position in some expressions.
 */
const BUILTIN_METRICS = new Set(['up', 'scrape_duration_seconds', 'scrape_samples_scraped']);

/** Suffixes Prometheus derives from a histogram; strip before comparing against emitted names. */
const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'];

function walk(dir, predicate) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // directory absent in this checkout — not this script's problem to report
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('dist-')) {
          continue;
        }
        stack.push(full);
      } else if (predicate(full)) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Metric names the application actually registers. */
function collectEmitted() {
  const emitted = new Map(); // name -> file it was found in
  const call = /\.(counter|histogram|gauge)\(\s*'([a-zA-Z_:][a-zA-Z0-9_:]*)'/g;

  for (const dir of SOURCE_DIRS) {
    for (const file of walk(join(REPO_ROOT, dir), (f) => extname(f) === '.ts' && !f.endsWith('.d.ts'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(call)) {
        const name = m[2];
        if (!emitted.has(name)) emitted.set(name, relative(REPO_ROOT, file));
      }
    }
  }
  return emitted;
}

/**
 * Metric names referenced by rules and dashboards, plus the recording-rule names those files
 * define (which are legitimate targets for a panel).
 */
function collectReferenced() {
  const referenced = new Map(); // name -> Set of files
  const defined = new Set();
  const root = join(REPO_ROOT, OBSERVABILITY_DIR);

  const files = walk(root, (f) => ['.yml', '.yaml', '.json'].includes(extname(f)));

  // First pass: every recording rule this configuration defines.
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/^\s*-?\s*record:\s*([a-zA-Z_:][a-zA-Z0-9_:]*)/gm)) {
      defined.add(m[1]);
    }
  }

  // Second pass: the metric names inside every expression.
  const promqlKeywords = new Set([
    'sum', 'rate', 'irate', 'avg', 'min', 'max', 'count', 'count_values', 'by', 'without',
    'increase', 'histogram_quantile', 'clamp_min', 'clamp_max', 'absent', 'absent_over_time',
    'and', 'or', 'unless', 'on', 'ignoring', 'group_left', 'group_right', 'offset', 'bool',
    'topk', 'bottomk', 'quantile', 'label_replace', 'label_join', 'vector', 'scalar', 'time',
    'delta', 'idelta', 'predict_linear', 'deriv', 'group', 'stddev', 'stdvar', 'sort', 'sort_desc',
    'abs', 'ceil', 'floor', 'round', 'exp', 'ln', 'log2', 'log10', 'sqrt', 'changes', 'resets',
    'e', 'inf', 'nan',
  ]);

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(REPO_ROOT, file);
    const exprs = [];

    if (extname(file) === '.json') {
      // Dashboard panels keep PromQL in "expr" fields.
      for (const m of text.matchAll(/"expr"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        exprs.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
      }
    } else {
      exprs.push(...extractYamlExprs(text));
    }

    for (const raw of exprs) {
      // Strip the things that contain identifiers which are NOT metric names:
      //   "..."            string literals
      //   {...}            label matchers      -> status=~"5.."
      //   [...]            range selectors     -> [5m]; otherwise the unit letter reads as a series
      //   offset <d>       offset durations    -> offset 15m, for the same reason
      //   by/without(...)  grouping clauses    -> by (route)
      const cleaned = raw
        .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
        .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
        .replace(/\{[^}]*\}/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\boffset\s+-?(?:\d+(?:ms|[smhdwy]))+/g, ' ')
        .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ');

      // What remains: a metric name is a whole identifier that is not immediately a function call.
      //
      // The "is it a call?" test is done by looking at the character AFTER the match rather than
      // with a negative lookahead. A lookahead lets the engine backtrack to a shorter identifier
      // to satisfy itself — `sum(` matched as `su`, because `m` is not `(` — which reported
      // fragments of PromQL keywords as missing metrics.
      for (const m of cleaned.matchAll(/[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z0-9_:]+)*/g)) {
        const name = m[0];
        if (promqlKeywords.has(name)) continue;
        const after = cleaned.slice(m.index + name.length).match(/^\s*\(/);
        if (after) continue; // a function call, not a series
        if (!referenced.has(name)) referenced.set(name, new Set());
        referenced.get(name).add(rel);
      }
    }
  }

  return { referenced, defined };
}

/**
 * Pulls `expr:` values out of a rules file, handling both inline scalars and `|` block scalars.
 *
 * Done by indentation rather than regex: a block scalar continues only while lines are indented
 * further than the `expr:` key itself. A greedy `(\s{2,}.*\n?)+` swallows the following `labels:`
 * and `annotations:` blocks too, which is how prose from a comment ended up being reported as a
 * missing metric on the first run of this script.
 */
function extractYamlExprs(text) {
  const lines = text.split(/\r?\n/);
  const exprs = [];

  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)expr:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;

    const indent = match[1].length;
    const inline = match[2].trim();

    if (inline !== '' && !inline.startsWith('|') && !inline.startsWith('>')) {
      exprs.push(inline);
      continue;
    }

    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') {
        block.push('');
        continue;
      }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) break;
      block.push(line.trim());
    }
    exprs.push(block.join(' '));
  }

  return exprs;
}

function baseName(metric) {
  for (const suffix of HISTOGRAM_SUFFIXES) {
    if (metric.endsWith(suffix)) return metric.slice(0, -suffix.length);
  }
  return metric;
}

function main() {
  const emitted = collectEmitted();
  const { referenced, defined } = collectReferenced();

  if (emitted.size === 0) {
    console.error('✗ No emitted metrics found — the source scan is broken, not the config.');
    process.exit(2);
  }

  const unknown = [];
  const observed = new Set();

  for (const [name, files] of referenced) {
    if (defined.has(name) || BUILTIN_METRICS.has(name)) continue;
    const base = baseName(name);
    if (emitted.has(base)) {
      observed.add(base);
      continue;
    }
    unknown.push({ name, files: [...files] });
  }

  console.log('');
  console.log('=== Observability drift check ===');
  console.log('');
  console.log(`  emitted by source:      ${emitted.size}`);
  console.log(`  recording rules:        ${defined.size}`);
  console.log(`  referenced in configs:  ${referenced.size}`);
  console.log('');

  const unobserved = [...emitted.keys()].filter((m) => !observed.has(m)).sort();
  if (unobserved.length > 0) {
    console.log('  Emitted but not referenced by any rule or dashboard (informational):');
    for (const m of unobserved) console.log(`    - ${m}  (${emitted.get(m)})`);
    console.log('');
  }

  if (unknown.length > 0) {
    console.log('  ✗ Referenced but NOT emitted by the application:');
    for (const { name, files } of unknown.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`    - ${name}`);
      for (const f of files) console.log(`        ${f}`);
    }
    console.log('');
    console.log(`=== Results: ${unknown.length} unknown metric(s) referenced ===`);
    console.log('An alert or panel points at a metric nothing emits, so it can never fire or plot.');
    process.exit(1);
  }

  console.log(`=== Results: every referenced metric is emitted (${observed.size} in use) ===`);
}

main();
