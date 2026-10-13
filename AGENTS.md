# Agent instructions

## Commit and push when appropriate

Commit and push without asking, once the change is verified. Do not leave finished
work sitting as uncommitted working-tree changes.

"When appropriate" means all of these hold:

- The change is complete and its checks pass (see **Verifying** below).
- You touched only files that belong to this change. Stage by explicit path —
  never `git add -A` or `git add .`. Do not sweep up unrelated edits that another
  agent or the user made.
- No secrets, tokens, or credentials are in the diff.
- The commit is on `main` and the site deploy is intended.

Commit message: match the existing log style — `type: lowercase summary` (e.g.
`fix:`, `ci:`, `docs:`, `v1.9.0: ...`) with a body explaining **why**, then:

```
Generated with Codebuff 🤖
Co-Authored-By: Codebuff <noreply@codebuff.com>
```

Push with `git push origin main`. Do not open a pull request for routine work;
this project deploys straight from `main`.

## Verify in production after pushing

A push to `main` triggers the Pages workflow, so production must be checked after
every push, not just the local build.

1. Confirm the push landed: `git rev-parse HEAD` must equal `git rev-parse origin/main`.
2. Watch the run: `gh run watch <id> --exit-status` (or `gh run list --workflow=pages.yml --limit 3`).
   Every step must be green, including **Sanity-check the staged site**.
3. Check the live origin, not the receipt. Deploy success alone does not prove the
   files are served:

   ```sh
   BASE="https://spuds0588.github.io/Mortgage-Underwriting-Conditions-to-Borrower-Needs-Conversion-AI-Harness"
   curl -s -D - -o /dev/null "$BASE/<path>"
   ```

   Require **HTTP 200**, `x-cache: MISS`, and `age: 0` for a freshly deployed
   path, then fetch the body and grep for the marker that proves the new code
   shipped (the removed code should be absent too).

### Cache trap

GitHub Pages/Fastly keys its cache on host **+ path** and ignores the query
string. `?cb=<random>` does **not** bust the cache. A cached 404 looks identical
to a live one — `x-cache: HIT` with `age: 0` on a 404 is a cached response, not
an origin verdict. Before believing a 404, vary the path or the host, and require
two independent vantage points to see `MISS` with `age: 0`.

### Deploy gate

[.github/workflows/pages.yml](.github/workflows/pages.yml) asserts required files
exist in the staged site. **Any new runtime file must be added to that list and
committed in the same commit**, or the deploy refuses to publish. That failure is
correct behavior — fix it, do not bypass it.

## Verifying before committing

- `npm test` — smoke suite, no browser required.
- `npm run test:headed:needle` — headed Chrome, `needle` engine on the OCR sample.
- `npm run test:headed:all` — full engine × sample matrix (slow; `transformers`
  and `nano` take minutes).

Capture the real exit status; do not pipe test output through `tail` without
`pipefail`, and never weaken an assertion or skip a check to make a run pass.

## Layout notes

- The site is zero-build static assets — no bundler, no transpile step.
- `node_modules/`, `.cache/`, `.chrome-profile/`, `tests/out/`, and `.freebuff/`
  are dev-only and gitignored. They are absent from a CI checkout; do not depend
  on them in committed code and do not commit them.
