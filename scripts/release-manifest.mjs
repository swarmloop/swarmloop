import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const COMPONENTS = [
  'swarmloop-server',
  'swarmloop-dashboard',
  'swarmloop-agent-claude',
  'swarmloop-agent-codex',
  'swarmloop-agent-cursor',
  'swarmloop-egress',
];

function replaceOnce(text, pattern, replacement) {
  if (!pattern.test(text)) {
    throw new Error(`deploy template changed: ${pattern} no longer matches`);
  }
  return text.replace(pattern, replacement);
}

function imageRefs({ components, repo }) {
  const refs = {};
  for (const name of COMPONENTS) {
    const digest = components[name]?.digest;
    if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) {
      throw new Error(`component ${name} has no sha256 digest`);
    }
    refs[name] = `${repo}/${name}@${digest}`;
  }
  return refs;
}

function renderCompose(template, refs, version) {
  const sandboxRefs = COMPONENTS.filter((name) => !/-(server|dashboard)$/.test(name)).map((name) => refs[name]);
  let text = template.replace(
    /image: \$\{SWARMLOOP_REGISTRY[^}]*\}\/(swarmloop-[a-z]+):\$\{SWARMLOOP_VERSION[^}]*\}/g,
    (_, name) => {
      return `image: ${refs[name]}`;
    },
  );
  text = replaceOnce(text, / {4}environment:\n {6}REGISTRY: .*\n {6}VERSION: .*\n/, '');
  // The server records the release that migrated its database, so it gets the version as a literal.
  text = replaceOnce(text, /(SWARMLOOP_VERSION: )\$\{SWARMLOOP_VERSION\}/, `$1${version}`);
  return replaceOnce(
    text,
    /( *)for name in .*; do\n *ref=.*\n/,
    (_, indent) =>
      `${indent}for ref in ${sandboxRefs.join(' ')}; do\n${indent}  name="$\${ref%@*}"; name="$\${name##*/}"\n`,
  );
}

function renderEnv(template) {
  const text = template
    .split('\n')
    .filter((line) => !/^(# )?SWARMLOOP_(VERSION|REGISTRY)=/.test(line))
    .join('\n');
  return replaceOnce(text, /Set these three first/, 'Set these two first');
}

export function generateArtifacts({ components, version, commit, repo, templates }) {
  const refs = imageRefs({ components, repo });
  const images = Object.fromEntries(
    ['agent-claude', 'agent-codex', 'agent-cursor', 'egress'].map((name) => [name, refs[`swarmloop-${name}`]]),
  );
  const cliVersions = {};
  for (const name of COMPONENTS) {
    if (components[name].cliVersion) {
      cliVersions[name] = components[name].cliVersion;
    }
  }
  return {
    'release-manifest.json': `${JSON.stringify({ version, images, commit, components: refs, cliVersions }, null, 2)}\n`,
    'compose.yml': renderCompose(templates.compose, refs, version),
    '.env.example': renderEnv(templates.env),
    'INSTALL.md': templates.install.replaceAll('{{version}}', version).replaceAll('{{commit}}', commit),
  };
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: 'string' },
      commit: { type: 'string' },
      repo: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const read = (rel) => readFileSync(join(repoRoot, 'deploy', rel), 'utf8');
  const files = generateArtifacts({
    components: JSON.parse(readFileSync(positionals[0], 'utf8')),
    version: values.version,
    commit: values.commit,
    repo: values.repo,
    templates: { compose: read('compose.yml'), env: read('.env.example'), install: read('INSTALL.md') },
  });
  mkdirSync(values.out, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(values.out, name), text);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
