# Install swarmloop {{version}}

This release was built from commit `{{commit}}`. Every image in `compose.yml` is pinned by digest.

1. Create a directory and put `compose.yml` and `.env.example` in it. Copy `.env.example` to `.env`.
2. Fill in `SWARMLOOP_HOME` (one host directory for data and worktrees) and `CHECKOUTS_ROOT` (the directory with your git checkouts). Add the tracker and agent keys you use.
3. Export the same two paths in your shell, then start the stack:

   ```
   export SWARMLOOP_HOME=/absolute/path/home CHECKOUTS_ROOT=/absolute/path/checkouts
   docker compose up -d --wait
   ```

4. Open the dashboard at http://127.0.0.1:3921. The API listens on http://127.0.0.1:3920.

`release-manifest.json` lists the image digests and CLI versions of this release.
