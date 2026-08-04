#!/usr/bin/env node
/**
 * Zero-dependency syntax validator: recursively walks the given directories
 * (default: src, test, scripts) and runs `node --check` against every
 * .js/.mjs file it finds, skipping node_modules and any .scratch (test
 * temp-dir) directories. Exits non-zero if any file fails to parse.
 *
 * Usage: node scripts/check-syntax.mjs [dir ...]
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.scratch']);
const CHECKED_EXTENSIONS = new Set(['.js', '.mjs']);

const projectRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const targets = process.argv.slice(2);
const roots = (targets.length > 0 ? targets : ['src', 'test', 'scripts']).map((t) => path.resolve(projectRoot, t));

/**
 * @param {string} dir
 * @returns {Promise<string[]>} absolute paths of all matching files under dir
 */
async function collectFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else if (entry.isFile() && CHECKED_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const allFiles = [];
  for (const root of roots) {
    allFiles.push(...(await collectFiles(root)));
  }
  allFiles.sort();

  let failures = 0;
  for (const file of allFiles) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      failures += 1;
      const stderr = err.stderr ? err.stderr.toString() : err.message;
      process.stderr.write(`✗ ${path.relative(projectRoot, file)}\n${stderr}\n`);
    }
  }

  if (failures > 0) {
    process.stderr.write(`\n${failures}/${allFiles.length} file(s) failed node --check.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`✓ ${allFiles.length} file(s) passed node --check.\n`);
}

main();
