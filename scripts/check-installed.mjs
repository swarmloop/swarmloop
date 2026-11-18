// Checks that the packages installed in <dir>/node_modules equal <dir>/package-lock.json.
// Usage: node scripts/check-installed.mjs <dir>
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const prefix = 'node_modules/';

// The locked packages by name, without links.
function readLocked(dir) {
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  const locked = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key.startsWith(prefix) && !entry.link) locked.set(key.slice(prefix.length), entry);
  }
  return locked;
}

function isFolder(path) {
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

// Adds every package found in one node_modules folder, and the node_modules folders nested in them.
function walkModules(modulesDir, name, installed) {
  if (!existsSync(modulesDir)) return;
  for (const entry of readdirSync(modulesDir)) {
    if (entry.startsWith('.')) continue;
    const path = join(modulesDir, entry);
    if (!isFolder(path)) continue;
    if (entry.startsWith('@')) {
      walkScope(path, `${name}${entry}/`, installed);
    } else {
      addPackage(path, `${name}${entry}`, installed);
    }
  }
}

function walkScope(scopeDir, scopeName, installed) {
  for (const entry of readdirSync(scopeDir)) {
    const path = join(scopeDir, entry);
    if (!entry.startsWith('.') && isFolder(path)) addPackage(path, `${scopeName}${entry}`, installed);
  }
}

function addPackage(path, name, installed) {
  const manifest = join(path, 'package.json');
  if (existsSync(manifest)) installed.set(name, JSON.parse(readFileSync(manifest, 'utf8')).version);
  walkModules(join(path, 'node_modules'), `${name}/node_modules/`, installed);
}

function compare(label, locked, installed) {
  const lines = [];
  for (const name of [...new Set([...locked.keys(), ...installed.keys()])].sort()) {
    const entry = locked.get(name);
    const version = installed.get(name);
    if (!entry) {
      lines.push(`${label}: ${name} ${version} installed, not in lockfile`);
    } else if (version === undefined) {
      if (!entry.optional) lines.push(`${label}: ${name} missing, lockfile ${entry.version}`);
    } else if (version !== entry.version) {
      lines.push(`${label}: ${name} ${version} installed, lockfile ${entry.version}`);
    }
  }
  return lines;
}

function main(argv) {
  if (argv.length !== 1) {
    console.error('usage: node scripts/check-installed.mjs <dir>');
    return 1;
  }
  const dir = argv[0];
  const label = dir.replace(/\/+$/, '');
  if (!existsSync(join(dir, 'package-lock.json'))) {
    console.error(`${label}: no package-lock.json`);
    return 1;
  }
  const installed = new Map();
  walkModules(join(dir, 'node_modules'), '', installed);
  const lines = compare(label, readLocked(dir), installed);
  if (lines.length > 0) {
    console.error(lines.join('\n'));
    return 1;
  }
  console.log(`${label}: installed packages equal package-lock.json`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
