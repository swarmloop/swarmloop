# Contributing

## Set up and run

Install dependencies from the repository root:

```sh
(cd server && npm ci)
(cd dashboard && npm ci)
```

Start the application with Docker:

```sh
docker compose up --build
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
