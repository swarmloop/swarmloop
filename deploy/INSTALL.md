# Install swarmloop {{version}}

This release was built from commit `{{commit}}`. Every image in `compose.yml` is pinned by digest.

1. Install Docker and Docker Compose (see the support matrix below).
2. Create a directory and download `compose.yml` and `.env.example` from this release into it. Copy `.env.example` to `.env`.
3. In `.env`, set `SWARMLOOP_HOME` (one host directory for data and worktrees) and `CHECKOUTS_ROOT` (the directory with your git checkouts). Set the credentials: the key of your `RUNTIME` (`CURSOR_API_KEY`, `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_API_KEY` or `CODEX_AUTH`) and the token of your code host (`GITHUB_TOKEN` or `GITLAB_TOKEN`).
4. Export the same two paths in your shell, then start the stack:

   ```
   export SWARMLOOP_HOME=/absolute/path/home CHECKOUTS_ROOT=/absolute/path/checkouts
   docker compose up -d --wait
   ```

5. Open the dashboard at http://127.0.0.1:3921.
6. Check readiness on the start page. Every item must be `ok` or `warn`; an item that says `fail` names the next step. The same list is printed by:

   ```
   docker compose exec server node dist/main.js doctor
   ```

7. Click **New run**, pick a repository, and start a run.

`release-manifest.json` lists the image digests and CLI versions of this release.

## Upgrade

1. Drain the instance. It stops taking new runs and new steps, lets a running step finish, and prints `idle` when nothing runs:

   ```
   docker compose exec server node dist/main.js drain
   ```

   The dashboard has the same **Drain** button. A run that was waiting or stopped at a step boundary keeps its state.

2. Set `SWARMLOOP_VERSION` in `.env` to the new release, then pull and start it:

   ```
   docker compose pull
   docker compose up -d --wait
   ```

3. When the new server finds migrations to run, it first writes `data/backups/swarmloop-<old-version>-<time>.sqlite` and a copy of the session files next to it, and keeps the last 3. If a backup fails, the server does not migrate and does not start; its log says why.
4. Resume the drained runs. A run keeps the images it started with, so a release never changes a run in flight.

Keep the previous `release-manifest.json` and its images until no run uses them. Nothing removes them while a run that is not done refers to them.

## Rollback

1. Drain the instance: `docker compose exec server node dist/main.js drain`.
2. Stop the stack: `docker compose down`.
3. Restore the backup. The older server that refuses to start on a newer database names the file in its log. Copy that file from `data/backups` over `data/swarmloop.sqlite`, and delete `data/swarmloop.sqlite-wal` and `data/swarmloop.sqlite-shm` if they exist. Copy the session files of the same backup from `data/backups/<backup name>.sessions` back into `data/`.
4. Set `SWARMLOOP_VERSION` in `.env` to the previous release, and start it: `docker compose up -d --wait`.
5. Reconcile: run `docker compose exec server node dist/main.js doctor`, then resume the drained runs.

## Support matrix

| Component | Tested | Minimum |
| --- | --- | --- |
| Linux, Docker Engine | not measured yet | not measured yet |
| macOS, Docker Desktop | not measured yet | not measured yet |
| Docker Compose | not measured yet | 2.24 (`env_file.required` in `compose.yml`) |
| Windows, WSL | untested | untested |

| Per run | Measured |
| --- | --- |
| RAM | not measured yet |
| Disk | not measured yet |
