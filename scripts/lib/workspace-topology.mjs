/**
 * @file Single authoritative source of workspace discovery and test topology metadata.
 * Dynamically derives workspace packages from root package.json, preventing drift
 * between hermetic runners, test count auditors, and topology checkers.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '../..');

/**
 * Reads root package.json and discovers all valid workspace package manifests.
 *
 * @param {string} [root=REPO_ROOT] - Repository root directory.
 * @returns {Array<{ name: string, dir: string, relDir: string, manifest: object }>}
 */
export function discoverWorkspacePackages(root = REPO_ROOT) {
  const rootPkgPath = join(root, 'package.json');
  if (!existsSync(rootPkgPath)) {
    throw new Error(`Root package.json not found at ${rootPkgPath}`);
  }
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  const workspacePatterns = rootPkg.workspaces || [];

  const packages = [];

  for (const pattern of workspacePatterns) {
    if (pattern.endsWith('/*')) {
      const baseDir = join(root, pattern.slice(0, -2));
      if (!existsSync(baseDir)) continue;
      const entries = readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pkgDir = join(baseDir, entry.name);
        const pkgJsonPath = join(pkgDir, 'package.json');
        if (existsSync(pkgJsonPath)) {
          const manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
          packages.push({
            name: manifest.name,
            dir: pkgDir,
            relDir: relative(root, pkgDir).replace(/\\/g, '/'),
            manifest,
          });
        }
      }
    } else {
      const pkgDir = join(root, pattern);
      const pkgJsonPath = join(pkgDir, 'package.json');
      if (existsSync(pkgJsonPath)) {
        const manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        packages.push({
          name: manifest.name,
          dir: pkgDir,
          relDir: relative(root, pkgDir).replace(/\\/g, '/'),
          manifest,
        });
      }
    }
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Packages with partitioned non-hermetic or specialized execution suites.
 * In these packages, `npm test` runs only the hermetic unit tests, while
 * environment-dependent tests (Postgres, live providers, smoke) are partitioned.
 */
export const PARTITIONED_PACKAGES = Object.freeze([
  '@chess-platform/api',
  '@chess-platform/persistence',
  '@chess-platform/ai-orchestrator',
  '@chess-platform/ai-features',
]);

/**
 * Derives the list of all hermetic package names to be executed during root `npm test`.
 * Every workspace under `packages/` is hermetically tested during root `npm test`.
 *
 * @param {string} [root=REPO_ROOT]
 * @returns {readonly string[]} Sorted list of workspace package names.
 */
export function getHermeticWorkspaces(root = REPO_ROOT) {
  const packagesDir = resolve(root, 'packages');
  const discovered = discoverWorkspacePackages(root);
  return Object.freeze(
    discovered
      .filter((pkg) => {
        const resolvedPkgDir = resolve(pkg.dir);
        const rel = relative(packagesDir, resolvedPkgDir);
        return !rel.startsWith('..') && !isAbsolute(rel) && rel !== '';
      })
      .map((pkg) => pkg.name)
  );
}

