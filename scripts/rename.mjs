#!/usr/bin/env node
/**
 * Renames the template's placeholder server across the repository:
 *
 *   example  -> <name>       (package, tool prefix, directories, file names)
 *   Example  -> <Name>       (class names, display text)
 *   EXAMPLE  -> <PREFIX>     (environment variables, constants)
 *
 * Usage: node scripts/rename.mjs <name> [PREFIX] [--dry-run]
 *
 * <name> is one lowercase word (letters and digits), e.g. `acme`. PREFIX
 * defaults to the upper-cased name. The name `.env.example` (its content is
 * renamed), LICENSE, .git, node_modules and dist are left alone, and the
 * "Using this template" section of README.md is removed.
 */
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [name, prefixArg] = args.filter(arg => !arg.startsWith('--'));

if (!name || !/^[a-z][a-z0-9]*$/.test(name) || name === 'example') {
  console.error('Usage: node scripts/rename.mjs <name> [PREFIX] [--dry-run]');
  console.error('<name> must be one lowercase word of letters and digits, e.g. acme.');
  process.exit(1);
}
const prefix = prefixArg ?? name.toUpperCase();
if (!/^[A-Z][A-Z0-9_]*[A-Z0-9]$|^[A-Z]$/.test(prefix)) {
  console.error('PREFIX must be upper case letters, digits and underscores, e.g. ACME (no trailing underscore).');
  process.exit(1);
}
const title = name.charAt(0).toUpperCase() + name.slice(1);

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), '..');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const SKIP_FILES = new Set(['LICENSE']);
/** Text (and file names) that contain the word but are not the placeholder. */
const PROTECTED = ['.env.example'];

const TEMPLATE_SECTION = /\n<!-- template:start -->[\s\S]*?<!-- template:end -->\n\n/;

function replaceAll(text) {
  const tokens = [];
  let protectedText = text;
  PROTECTED.forEach((value, index) => {
    const token = `\u0000${index}\u0000`;
    tokens.push([token, value]);
    protectedText = protectedText.split(value).join(token);
  });
  let result = protectedText
    .replace(/EXAMPLE/g, prefix)
    .replace(/Example/g, title)
    .replace(/example/g, name);
  for (const [token, value] of tokens) {
    result = result.split(token).join(value);
  }
  return result;
}

function walk(dir, files = [], dirs = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        dirs.push(path);
        walk(path, files, dirs);
      }
    } else if (entry.isFile() && path !== self && !SKIP_FILES.has(entry.name)) {
      files.push(path);
    }
  }
  return { files, dirs };
}

function isText(buffer) {
  return !buffer.subarray(0, 8000).includes(0);
}

const { files, dirs } = walk(root);
let changed = 0;

for (const file of files) {
  const buffer = readFileSync(file);
  if (!isText(buffer)) {
    continue;
  }
  const original = buffer.toString('utf8');
  let updated = replaceAll(original);
  if (relative(root, file) === 'README.md') {
    updated = updated.replace(TEMPLATE_SECTION, '\n');
  }
  if (updated !== original) {
    changed += 1;
    console.log(`edit   ${relative(root, file)}`);
    if (!dryRun) {
      writeFileSync(file, updated);
    }
  }
}

// Rename files, then directories, deepest first so parent paths stay valid.
const renames = [...files, ...dirs]
  .filter(path => basename(path).includes('example') && !PROTECTED.includes(basename(path)))
  .sort((a, b) => b.length - a.length);
for (const path of renames) {
  const target = join(dirname(path), basename(path).split('example').join(name));
  console.log(`rename ${relative(root, path)} -> ${relative(root, target)}`);
  if (!dryRun) {
    if (statSync(target, { throwIfNoEntry: false })) {
      console.error(`Refusing to overwrite ${relative(root, target)}.`);
      process.exit(1);
    }
    renameSync(path, target);
  }
}

console.log(
  `\n${dryRun ? 'Would change' : 'Changed'} ${changed} files and ${renames.length} paths: example -> ${name}, ` +
    `Example -> ${title}, EXAMPLE -> ${prefix}.`,
);
if (!dryRun) {
  console.log('Next: review `git diff`, run `npm ci && npm run typecheck && npm test && npm run build`,');
  console.log('then delete scripts/rename.mjs.');
}
