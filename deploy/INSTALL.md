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
