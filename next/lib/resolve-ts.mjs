import { existsSync, readFileSync } from 'node:fs';
import { register, stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (!process.env.SWARMLOOP_TS_RESOLVE) {
  process.env.SWARMLOOP_TS_RESOLVE = '1';
  register(import.meta.url);
}

export async function resolve(specifier, context, nextResolve) {
  const file = tsFile(specifier, context.parentURL);
  if (file) {
    return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && /\.[cm]?ts$/.test(url)) {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'strip' }), shortCircuit: true };
  }
  return nextLoad(url, context);
}

function tsFile(specifier, parentURL) {
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (!relative || !parentURL) {
    return '';
  }
  const parent = dirname(fileURLToPath(parentURL));
  const file = /\.[cm]?ts$/.test(specifier) ? join(parent, specifier) : join(parent, `${specifier}.ts`);
  if (/\.[cm]?js$|\.json$|\.node$/.test(specifier) || !existsSync(file)) {
    return '';
  }
  return file;
}
