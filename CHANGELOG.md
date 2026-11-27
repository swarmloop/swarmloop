# Changelog

All notable changes to this project are documented here.

This format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- calls-limit: A run has one budget, money (`MAX_RUN_USD`), checked in the door for every automatic start. A person's Resume runs the step past it, and a run blocked at it goes on by itself once `MAX_RUN_USD` is above its spend. Code review asks once for its whole round. The shipped `EPIC_EFFORT` is `high`, so no agent runs at `xhigh` by default.
- f111: Worktrees and checkouts now live in the Docker volumes `swarmloop-worktrees` and `swarmloop-checkouts`, not in folders of the host. An existing installation runs `scripts/move-to-volumes.sh` once with the server stopped (from a clone, or the one file fetched into the installation folder), then deletes `CHECKOUTS_ROOT` from `.env`, which the server no longer reads. A new installation needs nothing.

### Removed
- calls-limit: `MAX_AGENT_CALLS` and `MAX_RUN_TOKENS`. A `.env` that still sets them starts, with one warning. A stored `DID_NOT_FIT` block can still be resumed.
- ide-bridge-out: `bin/sloop`, its ACP agent (`acp.json`) and `sloop login` are gone, and with them the routes only they called: `POST /runs/:key/chat`, `POST /runs/shell`, `GET /runs/:key/shell`, `POST /runs/:key/shell/lock`, `POST /runs/:key/shell/unlock`, `GET /runs/:key/snapshots`, `POST /runs/:key/rewind` and `GET /checkouts/origins`, the CLI login (`POST /auth/cli/logins`, `GET /auth/cli/logins/:id`, `GET /tokens/cli/:code`, `POST /tokens/cli/:code/approve` and the dashboard page `/cli-login`), the chat and shell locks, and the per-step snapshots. A run that an old chat or shell lock still held is given back its status and reason at the first start. The server no longer reads `SWARMLOOP_API_URL`; a `.env` that sets it still starts. `bin/swarmloop` and personal API tokens stay.

## [0.3.1] - 2026-11-15

### Changed
- `CHECKS_PARALLEL` now defaults to `3`. A `.env` that sets it keeps its value.

### Fixed
- f78: An agent run returns only after its log and session writes have finished, one after another, so the session file holds the final state and no write outlives the run.

## [0.3.0] - 2026-11-15

### Added
- Public contribution, security, and project history documentation.
- GitHub issue forms and a pull request template.

### Changed
- f44: Install with one command and no `.env`. Every default lives in `defaults.env`, which replaces `.env.example`; `.env` only overrides, and a variable set in the shell now wins over `.env`. Checkouts default to the folder above `compose.yml` (`CHECKOUTS_ROOT=..`). A clone builds from source through `compose.override.yml`; delete an old `COMPOSE_FILE=compose.yml:compose.build.yml` line from `.env`. A release ships only `compose.yml`. `CHECKS_PARALLEL` is now `9`, and Settings → Server shows where each value comes from.
- Install and update with one `compose.yml` in the repository root: `docker compose up -d` pulls the release images (`:latest`, or `SWARMLOOP_VERSION`), `docker compose pull` updates them. `compose.build.yml` builds from a checkout. A release is a `v*` tag on `main`.
- The server backs up its database before a migration and refuses a database a newer version migrated.
- Key-shaped words in a prompt, such as `UTF-8` or `SHA-256`, no longer start a Jira run. Only keys of an existing Jira project count, and the new optional `JIRA_PROJECTS` limits them to a list of projects.
- Restore and `.env` masking follow git's ignore rules instead of a fixed folder name, tracked env files are not masked, and the plan skill's example is neutral.

## [0.1.0] - 2026-11-05

### Added
- Initial public release of swarmloop.
