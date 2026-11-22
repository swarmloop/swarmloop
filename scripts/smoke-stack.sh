#!/usr/bin/env bash
# Starts compose.yml alone, with no .env, in an empty directory and checks the stack answers.
# The caller exports SWARMLOOP_REGISTRY and SWARMLOOP_VERSION of images that are already on this host.
set -eu

# The closing `docker compose down -v` drops the fixed-name volumes, so an existing installation must not be here.
if docker volume inspect swarmloop-worktrees > /dev/null 2>&1; then
  echo "The volume swarmloop-worktrees already exists on this Docker host; the closing docker compose down -v would drop swarmloop-checkouts and swarmloop-worktrees. Not starting." >&2
  exit 1
fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
mkdir -p "$work/home" "$work/stack"
cp "$repo/compose.yml" "$work/stack/compose.yml"
# No person exists in this stack: only what needs none is checked. Every other route answers 401 without a token.
cd "$work/stack"
export SWARMLOOP_HOME="$work/home"
trap 'docker compose logs; docker compose down -v' EXIT
# Under QEMU a service can be up before it answers: retry the first request to each.
retry=(--retry 20 --retry-all-errors --retry-delay 3)
docker compose up -d --wait --pull never
curl -fsS "${retry[@]}" http://127.0.0.1:3920/health
curl -fsS "${retry[@]}" http://127.0.0.1:3920/auth/first-run
curl -fsS "${retry[@]}" http://127.0.0.1:3921/ > /dev/null
curl -fsS http://127.0.0.1:3921/swarmloop-api/health
curl -fsS http://127.0.0.1:3921/swarmloop-api/auth/first-run
curl -fsS http://127.0.0.1:3921/login > /dev/null
SWARMLOOP_SOCKET_URL=http://live.example:4000 docker compose up -d --wait --pull never
curl -fsS "${retry[@]}" http://127.0.0.1:3921/ | grep -F 'http://live.example:4000'
# Files a leaked data folder would expose, written by the server's own user so the folder keeps its owner.
docker compose exec -T server sh -c 'mkdir -p /app/data/codex && echo "{}" > /app/data/codex/auth.json && echo "{}" > /app/data/x-session.json'
assert_status() {
  status="$(curl --path-as-is -s -o /dev/null -w '%{http_code}' "$2")"
  if [ "$status" != "$1" ]; then
    echo "expected $1 from $2, got $status" >&2
    exit 1
  fi
}
# The dashboard serves no data folder.
for path in /run-logs/swarmloop.sqlite /run-logs/codex/auth.json /run-logs/x-session.json /run-logs/../.env; do
  assert_status 404 "http://127.0.0.1:3921$path"
done
# Without a token every route but /health and /auth answers 401, the log routes included.
for base in http://127.0.0.1:3921/swarmloop-api http://127.0.0.1:3920; do
  for path in /readiness /runs /runs/nope/steps/plan/log; do
    assert_status 401 "$base$path"
  done
done
# A project container gets its run folder on the worktrees volume as /tmp, and a write of more than 1 GB into it succeeds.
# The server image stands in for a project image, and the arguments are the ones the server builds for a project launch.
docker compose exec -T server node - <<'NODE'
const { execFileSync } = require('child_process');
const { mkdirSync, rmSync } = require('fs');
const { sandboxArgs, sandboxUserId } = require('/app/server/dist/sandbox/sandbox-launch');
const { prepareRunTmp, runTmpDir } = require('/app/server/dist/sandbox/run-tmp');
const { OwnMounts } = require('/app/server/dist/sandbox/own-mounts');

const docker = (args) => Promise.resolve(execFileSync('docker', args, { encoding: 'utf8' }));
const work = '/app/worktrees/ci-tmp/demo';
const volume = 'swarmloop-cli-claude-000000000000';
const bytes = 1200000000;

async function main() {
  mkdirSync(work, { recursive: true });
  const userId = sandboxUserId();
  const tmp = await prepareRunTmp(runTmpDir('/app', 'ci-tmp', 'checks-demo-0'), userId, true);
  const own = new OwnMounts(() => docker);
  const [mount, tmpMount] = await own.withDaemonPaths([{ hostPath: work, containerPath: '/work/demo' }, tmp]);
  const args = sandboxArgs({
    runtime: 'claude',
    runKey: 'ci-tmp',
    step: 'checks-0',
    attemptId: 'ci-tmp',
    mounts: [mount],
    tmp: tmpMount,
    workRoots: ['/app/worktrees'],
    envMasks: [],
    allowHosts: [],
    command: [],
    userId,
    maskFile: '/app/data/swarmloop-empty-env',
    project: {
      image: `${process.env.SWARMLOOP_REGISTRY}/swarmloop-server:${process.env.SWARMLOOP_VERSION}`,
      cliVolume: volume,
      path: '/usr/local/bin:/usr/bin:/bin',
      certFile: false,
      caches: [],
      shell: `test "$(stat -c %a /tmp)" = 1777 && head -c ${bytes} /dev/zero > /tmp/big && test "$(stat -c %s /tmp/big)" = ${bytes}`,
    },
  });
  let code = 0;
  try {
    execFileSync('docker', args, { stdio: 'inherit' });
  } catch (error) {
    code = typeof error.status === 'number' ? error.status : 1;
  }
  rmSync('/app/worktrees/ci-tmp', { recursive: true, force: true });
  rmSync('/app/worktrees/.tmp/ci-tmp', { recursive: true, force: true });
  try {
    execFileSync('docker', ['volume', 'rm', volume], { stdio: 'inherit' });
  } catch {
    // The volume is only a placeholder; the closing docker compose down -v does not need it.
  }
  if (code === 0) {
    console.log('1.2 GB was written into /tmp of a project container');
  }
  process.exit(code);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
