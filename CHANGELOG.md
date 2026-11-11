# Changelog

All notable changes to this project are documented here.

This format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Public contribution, security, and project history documentation.
- GitHub issue forms and a pull request template.

### Changed
- Install and update with one `compose.yml` in the repository root: `docker compose up -d` pulls the release images (`:latest`, or `SWARMLOOP_VERSION`), `docker compose pull` updates them. `compose.build.yml` builds from a checkout. A release is a `v*` tag on `main`.
- The server backs up its database before a migration and refuses a database a newer version migrated.
- Key-shaped words in a prompt, such as `UTF-8` or `SHA-256`, no longer start a Jira run. Only keys of an existing Jira project count, and the new optional `JIRA_PROJECTS` limits them to a list of projects.
- Restore and `.env` masking follow git's ignore rules instead of a fixed folder name, tracked env files are not masked, and the plan skill's example is neutral.

## [0.1.0] - 2026-11-05

### Added
- Initial public release of swarmloop.
