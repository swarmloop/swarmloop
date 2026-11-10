# Contributing

## Set up and run

Install dependencies from the repository root:

```sh
(cd server && npm ci)
(cd dashboard && npm ci)
```

Start the application with Docker, built from this checkout. Put `COMPOSE_FILE=compose.yml:compose.build.yml` in `.env` once, then:

```sh
docker compose up -d --build
```

## Code structure

- Keep HTTP and CLI entry points in `api/` and `cli/`; they translate input and output.
- Keep workflow orchestration in `pipeline/` and individual workflow behavior in `steps/`.
- Keep vendor and provider integrations behind `integrations/` interfaces.
- Keep persistence in `history/`; business and workflow code uses its services, not its database details.
- Keep sandbox and process boundaries in `sandbox/`; do not let transport or workflow layers bypass them.

## Checks and pull requests

CI runs type checks, tests, lint and structure checks, dependency-cycle and unused-code checks, builds, and Docker image builds. CI is the judge: every required job must pass.

Keep pull requests small, tested, and CI green. In the description, explain what changed, why, and how it was tested.

## Releases

A release is a tag on `main`: `git tag v0.2.0 && git push origin v0.2.0`. The release workflow builds the images, starts the stack from them, moves `:latest` to them and creates the GitHub release with `compose.yml` and `env.example` (a copy of `.env.example`: GitHub renames an asset that starts with a dot). A tag with a suffix (`v0.2.0-rc1`) is a prerelease and leaves `:latest` alone. Add the version to `CHANGELOG.md` before tagging.

## Briefs

A capability is something a person or a later step relies on: what a screen shows, what a button or command does, what a step receives in its prompt or input, what the server guarantees. Every brief that changes or removes a capability has:

- a `Removes` section that names each capability it changes or removes, one line each (`Removes: the old run list filter`);
- a `Must keep` section that lists the capabilities next to it that stay as they are.

Research, plan and both reviews treat a capability named in `Removes` or `Behavior change` as intended. They stop on any other change that removes one.
