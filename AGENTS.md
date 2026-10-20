# AGENTS.md — maestro-reviewer

> `CLAUDE.md` at the repo root is a symlink to `AGENTS.md`. Claude Code follows the same rule set as Codex CLI. Only edit `AGENTS.md` — never edit `CLAUDE.md` directly or replace the symlink with a copy.

## Purpose

The Maestro merge-request review engine and its GitLab CI flow. The DSH host
features (webhook intake, project mappings and local worktrees, the Settings
section, Telegram digests) live in `@ddtcorex/dsh-maestro-review`
(`packages/dsh-maestro-review` in the workspace), which imports this package's
`lib/` modules listed in `tests/engine-exports.test.ts`.

Names by boundary: npm package = `@ddtcorex/maestro-reviewer`; Cordis patch rows = `maestro-review-host` (the package root, mounts the skill provider) and `maestro-review-engine` (provides the `reviewEngine` service); the reviewer-ci profile adds `maestro-review-ci-trigger`.

## Layout

Host code lives in `src/host/` (flat `rootDir`, emits `lib/index.js`); there is no client bundle:

- `engine.ts`: `createReviewEngine` (one run: history, signals, incremental block, agents, comment posting, dedupe outcomes) over a `CodeAccess` of `diff`, `clone` or `workspace`; `toModelSelection`; `engine-row.ts` is the row `maestro-review-engine`.
- `orchestrator.ts`: the run's building blocks: prompts, comment builders, agent turn checks, `runReviewAndAudit` / `runDiffOnlyReview` and their in-flight dedupe, `declineUnmappedDeepReview`.
- `forge/types.ts`: `ReviewForge`; `forge/gitlab/`: `gitlabForge`, the per-agent GitLab tools (`gitlab-client.ts`), auth headers (`gitlab-auth.ts`, `PRIVATE-TOKEN` vs `JOB-TOKEN` via `GITLAB_TOKEN_KIND`), MR REST calls and the finding poster (`mr-api.ts`), award markers (`review-signals.ts`).
- `providers/ci-trigger.ts`: CI entry: builds the `ReviewRequest` and the engine options from the job environment (`ciAccess`, `ciModel`), push-gate, coexistence yield, the deep request (label) and its removal.
- `ci-resolve.ts` / `ci-resolve-run.ts` / `ci-resolve-cli.ts`: the reviewer pipeline's `resolve` job (pure route and child-pipeline rules, the GitLab reads, the CLI run by `docker/resolve.sh`).
- `review-marker.ts` / `ci-coexist.ts` / `ci-clone.ts`: comment marker and metadata, yield checks, CI source clone.
- `review-findings-tool.ts` (registers `report_review_findings`) / `review-history.ts` / `severity.ts` / `incremental.ts`.
- `govard-lint-detection.ts`: whether the govard CLI lint run may be demanded: the `bash` tool resolves for the agent AND `govard` is executable on PATH.
- `events.ts`: `ReviewRequest` / `ReviewResult` types; `index.ts`: host `apply()` (row `maestro-review-host`); `source.ts`: the source kind stamped on injected review messages; `skill-provider.ts` / `skills-tool.ts`: the bundled `skills/` dir and profile loading; `tool-policy.ts`: deny-list of host tools a review agent must not call.
- Review-run tools: `search-tool.ts`, `hyva-theme-inspect-tool.ts`, `hyva-csp-scan-tool.ts`, `layout-xml-tool.ts`, `module-check-tool.ts`, `phtml-escape-scan-tool.ts`, `scope-split-tool.ts`, `perf-log-stats-tool.ts`.
- `augment.d.ts` / `dsh-skill.d.ts`: ambient type declarations.
- `presets/`: agent presets (`maestro-reviewer`, `maestro-auditor` as bundle patch rows; `maestro-coder` as a directory preset, legacy, no patch row ships it); `skills/dsh-native-tools/`: the capability to tool and CLI command map.
- `profiles/reviewer-ci/`: headless DSH profile for the CI image (the engine rows plus the CI trigger; no web connection).
- `docker/`: reviewer image (`Dockerfile`, `entrypoint.sh`, `route.sh` provider route selection sourced by the entrypoint, `resolve.sh` for the resolve job, `ci-settings.*.yaml` model variants).
- `templates/`: `reviewer-project.gitlab-ci.yml` (secrets holder) + `source-project.gitlab-ci.yml` (bridge).
- `docs/ci-reviewer-setup.md`: setup + per-case trigger workflows.
- `tests/`: vitest suites (`pnpm test`).

## Development

```sh
pnpm verify   # tsc --noEmit
pnpm build    # tsc -> lib/
pnpm test     # vitest run (engine-exports.test.ts needs lib/)
```

## Git workflow

- Default branch `master`. No direct commits to `master` — use `feat/<topic>` / `fix/<topic>` and a PR.
- Conventional commits, imperative mood (`feat(review): ...`, `fix(review): ...`).
- One TDD task = one commit; never commit while `pnpm verify` is red.
- Always request approval before merge or release: never merge a PR/MR or publish a release (`git tag`/`pnpm publish`/`gh release`) without an explicit human approval — request review (`gh pr ready` / `gh pr request-review` / ask in chat) and wait for `APPROVED`. This applies to every `master` merge and every `vX.Y.Z` tag.

## Release checklist

**Validate locally first — a release cycle is not a debug loop.** On
2026-09-14, one bug (a Cordis DI misuse) went through **four** patch
releases (0.7.1 → 0.7.4) before it was actually fixed, because each
attempted fix was validated by tagging, waiting for `pnpm publish`,
rebuilding the Docker image, pushing it, bumping `REVIEWER_IMAGE` on a
real deployment, and triggering a real merge request — a 5-10 minute
loop, repeated four times, entirely avoidable. **Every one of those fixes
could have been (and the final, correct one was) validated in under a
minute locally, with zero release steps:**

- **A pure logic/API-contract bug** (wrong Cordis usage, a bad type
  assumption): reproduce it directly against the real dependency in a
  vitest test — no Docker, no MR. `new Context()` + `root.plugin(fn)`
  against real `@deepseek-ai/cordis` reproduced the exact "cannot get
  property X without inject" throw in milliseconds; that test is now a
  permanent regression guard (`tests/profile-skills.test.ts`).
- **A dependency-resolution bug** (peer/version skew, a duplicated direct
  dependency splitting a pnpm instance): `pnpm why <pkg>` and `pnpm peers
  check` inside `profiles/reviewer-ci` diagnose it without touching Docker
  at all — `pnpm why @deepseek-ai/dsh-base` is what found two
  `peersSuffixHash`es for one version string, root-causing a "missing
  skills" failure no amount of log-reading found.
- **A full end-to-end behavior change** (needs the real image, the real
  entrypoint, a real LLM call): build the image locally
  (`docker build -f docker/Dockerfile -t <local-tag> .`), then either
  rebuild fully after a source change, or — to test a `src/` edit without
  rebuilding the whole image or publishing anything — overlay the fresh
  local `lib/` onto an already-built image's installed copy:
  ```sh
  docker run -d --name overlay-test --entrypoint sleep <local-tag> 3600
  docker exec overlay-test readlink -f /app/profiles/reviewer-ci/node_modules/@ddtcorex/maestro-reviewer
  docker cp lib/. overlay-test:<that path>/lib/
  docker commit overlay-test <local-tag>-fixed && docker rm -f overlay-test
  ```
  Then run it with **real credentials from the CI variables** (`glab api
  projects/<group>%2Fci%2Freviewer_ci/variables/<NAME> --hostname
  <gitlab-host>`, piped through a variable and never printed) against a
  **disposable test branch + MR** on a real project, exactly like the CI
  job would: `docker run --rm -e REVIEW_GITLAB_TOKEN=... -e
  SOURCE_PROJECT_ID=... -e MR_IID=... -e GITLAB_HOST=<bare-hostname> ...
  --entrypoint /entrypoint.sh <tag>`. Close the MR and delete the branch
  immediately after — this is throwaway test traffic on someone else's
  real repo, not a fixture.

  **Gotchas proven live, in order of how much time each one wasted:**
  1. `GITLAB_HOST` must be the **bare hostname** (`<gitlab-host>`), never
     a full URL — `ci-trigger.ts` prepends `https://` itself, so
     `GITLAB_HOST=https://<gitlab-host>` silently becomes
     `https://https://<gitlab-host>/...` and every request fails as a
     generic, unhelpful "fetch failed" with no hint why.
  2. Exec `/entrypoint.sh` itself, not `dsh --profile reviewer-ci`
     directly — the `REVIEW_LLM_*` bring-your-own route only activates
     inside `entrypoint.sh`'s settings-file switch.
  3. The push-gate (`already reviewed`), the coexistence check (`webhook
     already reviewed`), **and stale `eyes`/`white_check_mark` award-emoji
     markers** all key off state already on the MR — clear all three
     before a repeat run (`glab api
     projects/<id>/merge_requests/<iid>/award_emoji` to list, `DELETE
     .../award_emoji/<id>` to clear), or push a genuinely fresh commit —
     otherwise the run silently short-circuits ("skipping") without
     exercising anything, and looks identical to a real pass.
  4. `REVIEW_ON_PUSH` is unset by default, so a second push to an
     already-opened MR never re-reviews — open a **fresh MR** (new branch)
     for each independent local validation, not another push to the same
     one.
  5. **Trigger variables cannot be used to test anything any more.** A
     trigger overrides every variable of the downstream pipeline, image
     included, so the reviewer project forbids pipeline variables
     (`no_one_allowed`) and the `resolve` job refuses to run otherwise. A
     manual or API-triggered reviewer run with variables is rejected by
     GitLab; test a new image on a separate reviewer project, or on the
     maintainers' local GitLab rig.
  6. A turn's own error message is all you get: `dsh-session`'s
     `TurnEndReasonMap['error']` only carries `{ message, code }`
     (`errorChain(error)` flattened, by the framework's own design), and
     the session log itself is deleted on `handle.dispose()` once the
     turn ends. There is no stack trace to recover after the fact from a
     CI log or a finished container. If a generic message like "cannot get
     property X without inject" doesn't say enough, don't re-run
     hoping for more detail — go straight to reproducing it directly
     against the real dependency in a test (see above), or add temporary
     `console.error` instrumentation to the exact suspected line before
     the next run.

Before any tag, run the maintainers' local GitLab rig (tier 1 and tier 2
scenarios against the image built from the release commit); a release is
never the debug loop.

Only once a fix is confirmed working this way — ideally end to end against
a real disposable MR — start the release checklist below. It should
produce exactly one new tag, one new Docker image, one `REVIEWER_IMAGE`
bump, and (if warranted) one final confirming live run, not a cascade of
"tag it and see" releases.

Every release ships **two independent artifacts** that must stay in lockstep:
the npm package (`@ddtcorex/maestro-reviewer`) and the Docker image
(`ddtcorex/maestro-reviewer`). The Docker image installs the npm package
from the registry rather than copying source (`docker/Dockerfile`), so a
release that stops after the npm tag ships a Docker image running **stale
code** — every step below exists because of a live incident that class of
gap caused. Version bump: patch (`X.Y.Z+1`) for a fix-only batch (matches
`CHANGELOG.md` precedent, e.g. 0.5.0 → 0.5.1); minor for an Added/Changed
batch.

1. **Bump + sync version, on a `chore/release-X.Y.Z` branch:**
   - `package.json`'s `version`.
   - `CHANGELOG.md` — new `## [X.Y.Z] - YYYY-MM-DD` section (Keep a Changelog
     style), referencing the merged PR numbers it bundles.
   - Every `0.Y.Z`-shaped image-tag reference: `docker/Dockerfile`'s
     top-comment example (`-t ddtcorex/maestro-reviewer:X.Y.Z`),
     `package.json`'s own `docker:build` script (found stale at a
     two-releases-old `0.6.0` on 2026-09-14 — nobody runs that script, so it
     drifts silently), `templates/reviewer-project.gitlab-ci.yml`'s
     `REVIEWER_IMAGE`, and the two mentions in `docs/ci-reviewer-setup.md`
     (intro + troubleshooting `:latest` explanation). `grep -rn
     "0\.<prev-minor>\.<prev-patch>" docker/ templates/ docs/ package.json`
     to find every instance before committing.
   - `pnpm verify && pnpm test && pnpm build` clean, then PR → CI green →
     **human `APPROVED`** → squash-merge.
2. **Tag + publish** (guarded — present the exact commands and get explicit
   approval before running, per the Guard git-protection rule in the workspace root AGENTS.md):
   ```sh
   git -C <repo> tag vX.Y.Z
   git -C <repo> push origin vX.Y.Z
   ```
   Pushing the tag triggers `.github/workflows/release.yml` →
   `maestro-ci`'s `node-release.yml` (`pnpm publish --access public` +
   GitHub Release). Never run `pnpm publish`/`npm publish` manually — it
   bypasses the Release workflow and leaves `CHANGELOG`/GitHub Release out
   of sync. Confirm both: `gh run watch <run-id>` on the release workflow,
   and poll `npm view @ddtcorex/maestro-reviewer version` until it shows
   `X.Y.Z` (registry propagation lags the workflow's "done" by roughly
   1-2 minutes — a stale `npm view` right after tagging is not a failure).
3. **Bump the `profiles/reviewer-ci` pin, on its own `chore/pin-reviewer-ci-X.Y.Z`
   branch** (mandatory, not optional — this is the step that actually makes
   the Docker image pick up the release): set
   `profiles/reviewer-ci/package.json`'s
   `dependencies["@ddtcorex/maestro-reviewer"]` to `X.Y.Z` (a `^X.Y.Z`
   range is fine to declare, but **does not self-update**: a plain `pnpm
   install` keeps whatever version is already locked as long as it still
   satisfies the range — pnpm does not eagerly re-resolve to the newest
   match. This silently shipped a stale `0.7.1` through the 0.7.2 and 0.7.3
   fixes on 2026-09-14, discovered only because those two releases
   happened to live in files the Dockerfile copies directly from the
   checkout (`presets/`, `profiles/reviewer-ci/pnpm-workspace.yaml`) rather
   than in `maestro-reviewer`'s own installed code — 0.7.4's actual fix
   would have shipped silently absent otherwise. Always force it with
   `pnpm update @ddtcorex/maestro-reviewer` (not bare `install`) — and a
   version published minutes ago is inside pnpm's 24h `minimumReleaseAge`
   window, so bypass that too (the exact same flag is already baked into
   `docker/Dockerfile`'s own frozen install for this reason,
   `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` otherwise):
   ```sh
   cd profiles/reviewer-ci && pnpm --config.minimumReleaseAge=0 update @ddtcorex/maestro-reviewer
   ```
   Verify the resulting `git diff --stat profiles/reviewer-ci/pnpm-lock.yaml`
   touches only that one package (specifier/resolution/integrity) before
   committing — unrelated transitive churn is a signal something else drifted
   and needs a closer look, not a rubber-stamp commit.

   **The profile's OTHER `@deepseek-ai/*` pins (`dsh`, `dsh-base`,
   `dsh-agent-preset-registry`) must independently track whatever the shipped
   preset patch files (`presets/maestro-reviewer.patch.yml`,
   `presets/maestro-auditor.patch.yml`) actually require — bumping only the
   `maestro-reviewer` pin is not sufficient.** Root-caused 2026-09-14:
   #102 (0.7.0) migrated the persona rows from a `text` field to
   `prefix`/`suffix`, which only `@deepseek-ai/dsh-persona` ≥ some 0.1.5-line
   version understands; the reviewer-ci profile stayed on
   `dsh-agent-presets@0.1.2-rc.1` (whose bundled `dsh-persona` still expects
   `text`) straight through the 0.7.0 and 0.7.1 releases, so **every review
   failed closed** with `failed to create reviewer agent: ... invalid
   config: $.text missing required value` — silently, because step 5 below
   didn't exist yet and nobody re-validated end to end after finally
   rebuilding the image. When a preset's config shape changes, check
   whether it needs a newer registry/`dsh-persona` in
   `profiles/reviewer-ci` too, in the same PR. (The presets themselves travel
   inside the plugin bundle — `dsh.bundle.patch` lists the two patch files —
   so the profile does not carry its own copy of them.)

   PR → CI green → `APPROVED` → merge.
4. **Rebuild and push the Docker image — only after step 3 merges:**
   ```sh
   docker build -f docker/Dockerfile -t ddtcorex/maestro-reviewer:X.Y.Z -t ddtcorex/maestro-reviewer:latest .
   ```
   Verify before pushing, don't assume: confirm the release's actual fix is
   present in the built image (e.g. `docker run --rm --entrypoint sh
   ddtcorex/maestro-reviewer:X.Y.Z -c 'grep -c <distinguishing-symbol>
   .../lib/orchestrator.js'`), and — if the change touches shared harness
   packages — confirm no dual-instance regression:
   `find /app/profiles/reviewer-ci/node_modules/.pnpm -maxdepth 1 -iname
   '@deepseek-ai+dsh-scope@*'` inside the image must show exactly one match.
   Then:
   ```sh
   docker push ddtcorex/maestro-reviewer:X.Y.Z
   docker push ddtcorex/maestro-reviewer:latest
   ```
5. **Bump `REVIEWER_IMAGE` in the reviewer project(s) using this image**
   (a separate repo per deployment, e.g. a company's `reviewer_ci` — not
   this checkout) to `X.Y.Z`, then **live-verify against a real MR before
   calling the release done**: trigger a review that produces a fresh head
   SHA (the push-gate skips a SHA that already has a completed run, so
   retrying an old pipeline/job proves nothing — see
   [Coexistence](docs/ci-reviewer-setup.md#6-coexistence-ci-yields-to-webhook)
   for the push-gate). A green Docker push is evidence the image *built*,
   not that a review actually completes — steps 1-4 alone shipped a silently
   broken image twice (0.7.0, 0.7.1) before this step existed, because the
   only feedback loop was the next real user hitting the bug days later.

See **"Validate locally first"** at the top of this checklist for the
overlay technique, the credential-fetching pattern, and every gotcha
proven live while testing this way (`GITLAB_HOST` format, stale
award-emoji markers, `REVIEW_ON_PUSH`, no recoverable stack trace) — it
belongs before step 1, not after step 5, so read it before starting a
release, not after one goes wrong.

## Conventions

- **One forge, behind `forge/types.ts`**: the engine reaches the forge only through `ReviewForge` (head and base SHA, compare, notes, findings, signals, the agents' read tools); GitLab is the one implementation, in `src/host/forge/gitlab/`. Only that directory and the `ci-*` modules (GitLab CI by definition) build `/api/v4/` URLs, pinned by `tests/forge-boundary.test.ts`. A second forge is a sibling directory, added together with a real user of it.
- **Tool-only review subagents**: review/audit subagents run with tool-only presets; findings are written via the `report_review_findings` tool, not free text.
- **Secrets**: never log or commit real tokens. In CI, `REVIEW_GITLAB_TOKEN` must be a PAT/group token (`api` scope); `CI_JOB_TOKEN` is read-only for posting (probed on GitLab 18.11); redact it from clone URLs and errors.
- **CI trust model**: never read identity or configuration from a trigger. The reviewer project forbids pipeline variables, and its pipeline file lives in a separate config project protected for Maintainers only (Custom CI config path `<file>@<project>`), because GitLab requires anyone triggering a protected downstream branch to be able to merge it, so the reviewer branch itself must let Developers merge; `resolve` learns the MR from GitLab (GraphQL `pipeline.upstream`, the upstream ref, MR labels) and writes the child pipeline with literal values. Per-project settings are reviewer variables scoped `review/<source project id>`; a project route is all or nothing. Reviewer-project reads use `REVIEW_RESOLVE_TOKEN` (Maintainer, environment scope `resolve`, never present in the review job); source reads use `REVIEW_GITLAB_TOKEN`. No backward compatibility shims.
- **CI flow**: `providers/ci-trigger.ts` owns the push-gate and coexistence yield and calls the engine with an explicit access: quick with no or the generic profile is `diff`, a framework profile and deep are `clone` (a plain worktree, no vendor or govard linking, static-only auditor). The engine never reads CI variables. CI yields to the webhook flow, never the reverse.
- **Engine exports are a contract**: `dsh-maestro-review` imports `lib/` modules by path; rename or move one only together with the plugin, and keep `tests/engine-exports.test.ts` in step.

## Validation

`pnpm verify` + `pnpm build` + `pnpm test` green before any success claim, and the maestro-harness GitLab rig (tier 1 and tier 2) for CI behavior. Webhook intake is validated in `dsh-maestro-review`.
