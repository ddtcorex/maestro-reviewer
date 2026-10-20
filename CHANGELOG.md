# Changelog

## [0.15.1] - 2026-10-20

Temporary opt-out for installations without a dedicated bot user (#174).

### Added

- `REVIEW_ACCEPT_PRIVILEGED_BOT=1` (reviewer project variable): the two bot
  role checks of 0.15 (Developer or above on the config project, Maintainer
  or above on the reviewer project) only log a warning. For installations
  that cannot create a dedicated bot user yet; it accepts the risk those
  checks guard against. Administrators stay refused; every other check stays.

## [0.15.0] - 2026-10-20

External pipeline config so Developers can trigger reviews, the
`REVIEW_GITLAB_TOKEN` rename, and a full setup guide (#171).

### Fixed

- **Developers could not trigger a review.** GitLab only lets a user trigger
  a protected downstream branch when they can push or merge it, and 0.14
  required the reviewer branch to be Maintainers only, so a Developer's MR
  bridge failed with `insufficient_bridge_permissions` and got no review.

### Changed

- **BREAKING: the reviewer pipeline file lives in a separate config project.**
  The reviewer project's Custom CI config path must name
  `<file>@<group>/<config project>[:<branch>]`; `resolve` checks that the
  config branch is protected for Maintainers only (push and merge, no force
  push, no per-user or per-group grants) and that the bot is below Maintainer
  there, and no longer requires the reviewer branch to be Maintainers only, so
  Developers may merge it and therefore trigger it. Everyone who triggers the
  reviewer, and the bot, needs Reporter on the config project. The config
  path is parsed the way GitLab resolves it (remote URLs and anything that is
  not a lowercase `.yml`/`.yaml` file in another project are refused), the
  reviewer repository may not hold a file at that literal path, and every
  protection rule matching the config branch, wildcards included, must be
  Maintainers only.
- **BREAKING: the bot's roles are checked.** `resolve` refuses a bot that is
  Developer or above on the config project or Maintainer or above on the
  reviewer project (counting inherited and shared-group access), or a GitLab
  administrator, so a reviewer Maintainer's personal token no longer works.
- CI skip messages use a comma instead of a dash
  (`another review is running, skipping`).
- **BREAKING: `MAESTRO_GITLAB_TOKEN` is now `REVIEW_GITLAB_TOKEN`**, so every
  reviewer project variable shares the `REVIEW_` prefix. The old name is not
  read.

### Docs

- `docs/ci-reviewer-setup.md` rewritten: GitLab setup in click order, an
  access matrix, and a reference of every variable with its scope, flags,
  default and effect. Removed the Telegram variables, which the CI flow never
  read.

## [0.14.0] - 2026-10-20

Trusted CI trigger, per-project AI providers, and the split into the review
engine plus CI (this package) and the `@ddtcorex/dsh-maestro-review` DSH host
plugin (#168).

### Security

- **Source projects can no longer change what the CI reviewer runs.** A
  trigger overrides every variable of the downstream pipeline, the job image
  included, so any member able to start a reviewer pipeline could run their
  own image with the reviewer's secrets or redirect its token and LLM key.
  The reviewer project must now forbid pipeline variables, bridges pass none,
  and a new `resolve` job learns the MR from GitLab (GraphQL upstream).
- **Namespace allowlist:** `REVIEW_ALLOWED_NAMESPACES` (required) lists the
  groups or projects allowed to use the reviewer; any other source project
  gets no review, so a personal project can neither spend the default key nor
  feed content to an agent holding the bot token.
- `resolve` also refuses to run unless the reviewer pipeline branch is
  Maintainer-only (push, merge, no force push), while a project variable
  shadows a value the child pipeline pins, or when a project's base URL or
  model holds characters GitLab would expand. The review job refuses a key
  other than the one `resolve` saw, so a deleted project key never lets the
  default key reach that project's endpoint.
- `resolve` refuses provider, mode and require variables scoped with a
  wildcard other than `*` (for example `review/*`), which would reach every
  matching project. `REVIEW_REQUIRE_PROJECT_KEY` set at `*` now applies to
  every project, a project's scoped `0` opting out; an unconfigured route
  never reviews even with a job-mounted settings file. The unconfigured note
  is found on any notes page, and a failed post is logged.
- **Only the bot's own signals skip a CI review.** A completed marker pasted
  by someone else, or a human's eyes reaction, no longer suppresses it.

### Added

- **Per-project AI providers** through reviewer variables scoped
  `review/<source project id>`: presets `openai`, `anthropic`, `gemini`,
  `openrouter`, `deepseek` and `custom`, an all-or-nothing project route, and
  `REVIEW_REQUIRE_PROJECT_KEY` so a paying project never falls back to the
  default key (it gets a one-time "not configured" note instead).
- **Deep review on request:** the `maestro-review::deep` MR label runs one
  deep review per head SHA, and the bot removes the label once it is posted.
- `REVIEW_RESOLVE_TOKEN`, a Maintainer token scoped to the `resolve`
  environment so the review job never receives it.
- Review comments carry a hidden, versioned metadata block (head SHA, mode,
  models, and findings as code, fingerprint and severity, never body text).
- Findings accept an optional stable `code` (for example `SEC-XSS-ESCAPE`).

### Fixed

- **Diffs over 20 files are paginated** (D1): the reviewer reads every page
  up to 3000 files and says so in the comment when it had to stop.
- **CI review state comes from GitLab, not the runner cache** (D2): the
  push-gate and the incremental base read the newest bot review comment. The
  cache is a fallback only, keyed per MR, with a per-MR `resource_group`.
- **The merge base is reachable in CI clones** (D3): a 50-commit clone is
  deepened until the base is an ancestor of the head; if it still is not, the
  review continues with a warning.

### Changed (split)

- **maestro-reviewer is now the review engine plus the CI flow.** The DSH
  host features (GitLab webhook intake, the host orchestrator with project
  mappings, worktrees and the govard environment, the settings RPC, the
  Maestro Review Settings section and Telegram digests) moved to the
  `@ddtcorex/dsh-maestro-review` plugin, which runs this engine. The bundle
  ships `maestro-review-host` and the new `maestro-review-engine` row (the
  `reviewEngine` service) only, with no client bundle and no
  `@deepseek-ai/dsh-client-connection` peer.
- The CI trigger calls the engine with an explicit code access (`diff` or
  `clone`) and reads `REVIEW_BOT_USERNAME`, `REVIEW_MODEL_PROVIDER` and
  `REVIEW_MODEL` itself; the engine no longer detects CI from the
  environment, and the reviewer-ci profile overrides no rows.
- Engine forge calls go through `ReviewForge` (`src/host/forge/`), with GitLab
  in `forge/gitlab/`; `gitlab-client`, `gitlab-auth` and `review-signals`
  moved there.
- The `lib/` paths the host plugin imports are pinned by
  `tests/engine-exports.test.ts`.

### Changed (breaking, no compatibility path)

- New reviewer and source templates: `resolve` then a child pipeline; the
  bridge passes and forwards no variable. Bridge variables (`REVIEW_MODE`,
  `REVIEW_PROFILE`, `REVIEW_ON_PUSH`, `SOURCE_PROJECT_ID`, `MR_IID`,
  `GITLAB_HOST`) are gone; per-project settings are scoped reviewer variables.
- Manual and trigger-token reviewer runs are gone (they cannot name an MR
  without variables); deep on demand uses the label.
- Comments without the metadata block (0.13 and older) no longer count for
  the push-gate, so each open MR is reviewed once more after the upgrade.
- After the first CI review of an MR, later pushes are skipped unless
  `REVIEW_ON_PUSH=1`: the state comes from GitLab, where runners without a
  shared cache used to re-review every push.
- `REVIEW_MODEL_PROVIDER`/`REVIEW_MODEL` pin the default route only.
- The CI flow only sees a webhook review in flight when both flows use the
  same GitLab user.

### Upgrade

Follow [Upgrading from 0.13](docs/ci-reviewer-setup.md#8-upgrading-from-013)
in one maintenance window, then rotate `MAESTRO_GITLAB_TOKEN` and the default
LLM key.

## [0.13.0] - 2026-10-19

### Changed

- **Renamed to `@ddtcorex/maestro-reviewer`** (#164), matching the Docker image
  `ddtcorex/maestro-reviewer`. The GitHub repository is now
  `ddtcorex/maestro-reviewer`; the old URL redirects. Cordis module paths are
  `@ddtcorex/maestro-reviewer/lib/...`.
- **Settings RPC channel is `/maestro-reviewer`.** Host and client ship in one
  bundle, so no alias is kept.

### Migration

- Replace the profile dependency `@ddtcorex/dsh-maestro-review` with
  `@ddtcorex/maestro-reviewer`, and update any profile patch entry that names a
  module path (`@ddtcorex/dsh-maestro-review/lib/...`).
- Unchanged: Cordis row ids (`maestro-review-*`), preset ids, settings keys, the
  `dsh-maestro-review/` data directory (`reviews.json`, `runtime.json`) and the
  message source kind, so history and rehydrated sessions carry over.
- The old npm name is deprecated, not unpublished; pinned CI images keep working.

## [0.12.1] - 2026-10-17

### Fixed

- **Declare `webServer` on the `connection` entry for DSH 0.2.x.** On
  0.2.x `ctx.connection.rpc.handle` resolves `webServer` on the connection
  row's own fiber, so the settings-rpc row-level inject could not reach it:
  `maestro-review-settings-rpc` never activated and `/dsh-maestro-review`
  answered 405. The bundle patch now carries the top-level
  `- id: connection` entry with `[webStartup, webServer]`, identical to
  core/remote/memory/notifier, pinned by `tests/connection-inject.spec.ts`.

## [0.12.0] - 2026-10-10

### Removed

- **Unmounted tool modules.** `git_worktree`, `maestro_plan_track` and `maestro_tdd_evidence` were never registered by any Cordis row, preset or the orchestrator, so the three modules, their tests and the `git_worktree` rows of the `dsh-native-tools` skill are gone.
- **`webhook-secret.ts`.** `generateWebhookSecret`, `gitlabWebhookUrl` and `GITLAB_WEBHOOK_PATH` (added in 0.11.0) were never called by the settings section or any other code, so the module and its spec are removed. The `webhookSecret` setting itself is unchanged.
- **`ReviewProvider` abstraction.** The `ReviewProvider` interface (`intake`, `postFindings`), the no-op `gitlabProvider`, the throwing GitHub stub and the `runReviewWithProvider` wrapper were never called by the live pipeline and are removed. GitLab intake (`providers/gitlab.ts` `apply`) is unchanged.

### Fixed

- **Presets drop removed delegation keys.** DSH 0.2.1-alpha.x removed `backgroundMode` from dsh-tool-subagent and the loop built-in cwd prompt variable; the reviewer/auditor/coder presets state neither, and the working-directory service supplies the directory instead.

## [0.11.2] - 2026-10-06

### Fixed

- **Phone layout.** Every settings field fills the row width, with or without a Save button (the button stays on the same row), and a row whose control is a single checkbox keeps its label left and a 44px tap target right on one line instead of a lone box under the label.

## [0.11.1] - 2026-10-06

### Fixed

- **Settings fields share one box.** The host's own `ConfigField` declaration plus a 44px touch floor; the secret Save button beside its field is 44px tall to equal it.

## [0.11.0] - 2026-10-05

### Security

- **The settings read no longer answers another plugin's keys.** `loadUserConfig`
  returned the whole shared document, so this package's RPC handed out the
  tunnel hostname and the Telegram chat id — domains other plugins own. It now
  answers only the keys listed in `REVIEW_OWNED_KEYS`.
- **Merge-request content is untrusted input in the auditor prompt.** The MR
  title, description and diff are wrapped as untrusted, so text inside them can
  no longer read as an instruction to the auditor. The auditor's environment is
  also torn down when the run ends.

### Changed

- **The settings store is embedded, not depended on.** `src/host/vendor/store.ts`
  is a committed, hash-sealed copy generated by core's
  `scripts/vendor-store.mjs`; the published settings library is gone.
- **The GoVard lint tool is no longer registered here.** Review asks for the
  `govard` CLI through the shell, so the lint signal is not a second copy of
  another plugin's tool. A `review`-only install therefore runs reviews
  without a lint signal, which is the intended trade.
- **`.client-build/` is no longer tracked.** It is `tsconfig.client.json`'s
  `outDir`, a build artifact like `lib/`.

### Added

- **The GitLab settings section**, in the house pattern.
- **`generateWebhookSecret` and `gitlabWebhookUrl`** — the operator no longer
  has to invent a 32-character base64url secret by hand, and a hand-written one
  carrying `+`, `/` or `=` no longer breaks the webhook token comparison.


## [0.10.0] - 2026-09-29

### Changed

- **Retarget the suite to DSH `0.2.0-rc.2`.** The `@deepseek-ai/dsh-*` dev
  pins move to the newest published runtime, so a green `verify` again means
  something about the runtime the host actually boots instead of three
  releases behind it (#139).
- **The `dsh-client-connection` peer ceiling re-anchors to `<0.3.0-0`**
  (#137). The old `<0.2.0-0` denied the whole `0.2` line — it fires on
  `0.2.0-rc.1` and every later `0.2.x` — so the plugin was disabled at boot
  on a runtime it supports. The floor and the `-0` suffix are unchanged: the
  `-0` is load-bearing, since a plain `<0.3.0` would re-admit
  `0.3.0-alpha.1`. This release exists so the `reviewer-ci` profile can move
  onto the `0.2` line; the profile pin itself lands in the follow-up commit.
- **The `dsh-maestro-meta` install path is gone from the docs** (#138).

### Fixed

- **CRLF skill frontmatter is parsed, and injected messages are attributed**
  (#136). A skill file written on Windows produced an empty `description`,
  which crippled skill selection in the reviewer; messages the plugin injects
  into a session were attributed to the host rather than to the plugin.

## [0.9.0] - 2026-09-24

### Changed

- **Retarget the suite to DSH `0.1.7-rc.1`.** Every exact `@deepseek-ai/dsh-*`
  dev pin and the reviewer-ci profile's `@deepseek-ai/dsh` move to the newest
  published runtime, and both lockfiles are regenerated from scratch: an
  in-place `pnpm install` keeps stale transitive resolutions
  (`@deepseek-ai/cordis-plugin-group@1.0.2` against a `~1.0.4` peer,
  `@deepseek-ai/cordis-plugin-include@1.0.7` against `~1.0.9`) that the image
  then ships through its `--frozen-lockfile` install. The retired plural
  `@deepseek-ai/dsh-agent-presets` leaves the reviewer-ci profile for
  `@deepseek-ai/dsh-agent-preset-registry`, and `@deepseek-ai/dsh-client-connection`
  joins the devDependencies so the plugin's own RPC types resolve from the
  runtime instead of an auto-installed 0.1.1 graph (#131).
- **The reviewer and auditor presets ship inside the plugin bundle.** DSH 0.1.7
  declares agent presets from loader rows and no longer scans
  `$DSH_HOME/.agent-presets`, so `presets/maestro-{reviewer,auditor}.patch.yml`
  — listed in this package's `dsh.bundle.patch` — replace the directory
  presets, the Dockerfile's `.agent-presets` COPY is gone, and every profile
  composing the bundle (the headless CI profile and the web app alike) declares
  them itself. A deployment that inserted `preset-dsh-maestro-reviewer`/
  `-auditor` in its own patch must drop that copy or override by bare id before
  its next boot, or the bundle row and the profile row collide as duplicates
  (#132).

### Fixed

- The hand-rolled `connection.rpc.handle` type no longer advertises an `opts`
  third parameter the Host never reads (#131).

## [0.8.1] - 2026-09-23

### Fixed

- **A headless/CI profile can mount the plugin again.** The host row declared
  `inject: ['connection', 'skills']` while `apply()` reads only `skills`, so on
  a profile with no web `connection` the row stayed pending forever and the
  boot failed with `1 entry did not activate @ddtcorex/dsh-maestro-review:
  pending (waiting for service: connection)` — the failure the published
  reviewer-ci image hit on a real GitLab run. The row now declares the one
  service it reads, and a regression test slices the mounted row (#124).
- **Two detached promises can no longer reach the host's fatal
  unhandled-rejection path** (`installFailLoud` exits the whole process): the
  GitLab webhook handler now answers 500 and logs instead of escaping, and the
  fire-and-forget Telegram digest chain gains a terminal catch alongside its
  existing delivery-result check (#125).

### Changed

- Retarget every exact `@deepseek-ai/dsh-*` pin to `0.1.7-alpha.2` and align the
  vendor peer ranges with upstream's `workspace-release-ranges` policy
  (`~4.0.4` cordis, `~3.18.4` schemastery). `@deepseek-ai/dsh-agent-presets`
  stays at `0.1.6-alpha.2` — that package publishes no `0.1.7-alpha.2` (#125).

## [0.8.0] - 2026-09-22

### Added

- **The DSH native-tools skill is served from this plugin** (#119).

### Fixed

- **`apply()` no longer claims the settings RPC channel** (#120).
- **The workflow worker row is renamed for the DSH 0.1.6 PTC runtime** (#118).
- **`requiresRestart` is reported from the LAN PIN toggle** (#117).

### Changed

- Bump the `@deepseek-ai/*` pins to `0.1.7-alpha.1` (#122) and move to
  vitest 3 so the suite loads the DSH 0.1.6 peers (#121).
- Pin the `reviewer-ci` profile to `dsh-maestro-review@0.7.5` (#116).

## [0.7.5] - 2026-09-14

### Fixed

- **`loadedReviewProfile()` reading `ctx.agent` never actually worked** —
  0.7.4 stopped it from crashing (`cannot get property "agent" without
  inject`), but `ctx.agent` is not an actual injectable Cordis service
  anywhere in this composition, so the guarded read always returned
  `undefined` — every profile-configured review (`REVIEW_PROFILE=magento2`
  etc.) failed with "did not successfully load the required ... review
  skill profile" even when the tool had just loaded it correctly. Dropped
  Cordis entirely: `loadedReviewProfile` now takes the plain `Agent`
  object directly (`handle.agent`, the same object the tool's own
  `exec.agent` already used successfully) instead of a Cordis `Context`.
- **`profiles/reviewer-ci` had `@deepseek-ai/dsh-base` as a direct
  dependency at the same version `@deepseek-ai/dsh` already depends on it
  — which does not dedupe them.** `pnpm why @deepseek-ai/dsh-base` showed
  two physically distinct instances (different `peersSuffixHash`, matching
  version string), so `@ddtcorex/maestro-skills` registered its skill
  provider into one `skills` service instance while the reviewer agent's
  own composition read from the other — every profile-configured review
  reported "Missing required review skill(s)" despite every skill file
  being present in the image. Removed the redundant direct dependency;
  `dsh` already carries it.
- Both root-caused and fixed with **zero release cycles**: reproduced the
  Cordis throw directly against real `@deepseek-ai/cordis` in a test, the
  dependency split with `pnpm why`, and the full fix end-to-end locally
  (`docker build` + overlay `lib/` + `docker run --entrypoint
  /entrypoint.sh` against a real disposable test MR with `REVIEW_PROFILE`
  set) — confirmed working (`✅ Completed`, real findings posted) before
  this release existed. See the new "Validate locally first" note at the
  top of the release checklist in `AGENTS.md`.

## [0.7.4] - 2026-09-14

### Fixed

- **`loadedReviewProfile()` crashed instead of returning `undefined`** when
  called from a Cordis context with no `agent` service available —
  `ctx.agent === undefined` still throws `cannot get property "agent"
  without inject`, because Cordis's `Context` proxy throws synchronously on
  any unregistered property read, before the equality check ever runs. Live
  reproduced on a real MR (a CI-managed project): the reviewer turn failed
  with exactly that message on the real CI runner, twice, while the
  identical request succeeded locally both times it was retried —
  non-deterministic because it depends on whether the model actually calls
  `maestro_load_review_profile`). Reproduced deterministically instead
  against real `@deepseek-ai/cordis` (a nested plugin context lacking
  `agent` always throws on `.agent`), fixed with a try/catch, and covered
  by a regression test — no live MR needed to validate this one.
- The reviewer persona's static prefix (cached, sent on every turn)
  unconditionally told the model to call `maestro_load_review_profile`
  "before inspecting code", while the per-request scope prompt separately
  told a diff-only CI review (no `REVIEW_PROFILE` configured) "there is no
  local checkout or Magento environment" — two conflicting instructions
  with no guidance on which wins, which is what let the model hit the bug
  above in the first place. The prefix now explicitly skips profile
  loading for a diff-only review.

## [0.7.3] - 2026-09-14

### Fixed

- **0.7.2's `profiles/reviewer-ci` bump crashed the entire `dsh` boot** —
  `docker run --entrypoint /entrypoint.sh` with real credentials
  reproduced it locally (`GITLAB_HOST` must be the bare hostname, no
  `https://` prefix — `ci-trigger.ts` prepends the scheme itself, a fix
  found while root-causing this). Bumping only `dsh`/`dsh-base`/
  `dsh-agent-presets` left ~23 of their transitive `@deepseek-ai/dsh-*`
  deps resolved at the old `0.1.2-rc.1` line (a peer-warning-only
  mismatch at install time, fatal at boot: e.g.
  `dsh-session-persistence-jsonl@0.1.5-rc.2` ESM-importing
  `SessionAlreadyExistsError` from `dsh-session-persistence@0.1.2-rc.1`,
  which never exported it). `profiles/reviewer-ci/pnpm-workspace.yaml`
  now overrides all of them to `0.1.5-rc.2`. Live-verified end to end
  locally: a real review now completes (`✅ Completed`) instead of
  crashing or failing on the persona config.
- **0.7.2 was never actually deployed** — it crashed on the first real MR
  it hit, so `REVIEWER_IMAGE` was reverted to `0.7.1` within the same
  incident window before this fix shipped. No production regression
  window beyond the immediate revert.

## [0.7.2] - 2026-09-14

### Fixed

- **`profiles/reviewer-ci` was still pinned to `@deepseek-ai/dsh`/`dsh-base`/
  `dsh-agent-presets@0.1.2-rc.1`**, whose bundled `@deepseek-ai/dsh-persona`
  requires a `text` config field. #102 (shipped in 0.7.0) migrated the
  reviewer/auditor presets to the `prefix`/`suffix` format that only a newer
  `dsh-persona` understands, but the reviewer-ci profile's own pin was never
  bumped — 0.7.0 and 0.7.1 both shipped a Docker image that failed every
  review with `failed to create reviewer agent: ... invalid config: $.text
  missing required value`, live-verified via a real MR on a CI-managed
  project before this fix and confirmed silent afterward. Bumped to
  `0.1.5-rc.2` to match; verified exactly one `@deepseek-ai/dsh-scope`
  instance ships in the built image (no dual-instance regression).
- `profiles/reviewer-ci`'s `@ddtcorex/dsh-maestro-review` and
  `@ddtcorex/maestro-skills` pins now use caret ranges (`^0.7.1`, `^2.0.0`)
  instead of exact versions, so a future patch release reaches the CI image
  on the next profile lockfile refresh instead of silently lagging behind
  npm the way this release's root cause did.

## [0.7.1] - 2026-09-14

### Fixed

- The generic OpenAI-compatible route (`REVIEW_LLM_*`) now sends a stable
  `x-opencode-session` header, derived from GitLab's `CI_JOB_ID`. Gateways
  that route/cache by conversation — OpenCode Zen's Go route
  (`opencode.ai/zen/go/v1`) in particular — started hard-rejecting requests
  missing it with `400 MissingSessionID`, breaking every review on a
  project pointed at that route. (#107)
- `auditorOutputFromSession` no longer throws on a legacy/degraded session
  event missing `data.stream`: `@deepseek-ai/dsh-subagent` 0.1.5's
  `AssistantOutputFold.push` iterates that field unconditionally, which
  broke the function's documented never-throws contract. (#107)

### Changed

- Upgrade the pinned `@deepseek-ai/dsh-agent`, `dsh-agent-default-model`,
  `dsh-agent-presets`, `dsh-attachment`, `dsh-llm`, `dsh-session`,
  `dsh-session-title`, `dsh-subagent`, and `dsh-tools` devDependencies from
  `0.1.2-rc.1` to `0.1.5-rc.2`. (#107)

## [0.7.0] - 2026-09-13

### Added

- Reviewer/auditor delegation rows in the shipped presets (#103).
- Persist and validate `pinSessionTtlHours` through the settings RPC (#104).

### Fixed

- Migrate preset persona rows to prefix/suffix (#102).
- Declare row `inject` for the settings-rpc row on DSH 0.1.5 (#101).

### Changed

- Document the bot identity best practice for CI reviewer setup (#100) and the
  release checklist (#99); pin the reviewer-ci profile to
  `dsh-maestro-review@0.6.2` (#98).

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.2] - 2026-09-05

### Fixed

- **Critical: `getTurnErrorMessage()` read a nonexistent `session.events`
  property.** The real `@deepseek-ai/dsh-session` `Session` class only
  exposes `ownEvents()`/`snapshotEvents()`, never a bare `.events` array —
  so `assertTurnSucceeded`/`assertTurnSucceededOrSalvage` silently returned
  "no error" for every real turn, regardless of what actually happened. A
  fully broken provider (invalid key, no balance, rate-limited) was
  reported as `✅ Completed` with 0 findings — indistinguishable from a
  clean review. Fixed by extracting the same host/session API-skew-tolerant
  reader already used for the auditor's output into a shared
  `readSessionEvents()` helper. Live-verified: an invalid API key now
  correctly surfaces `ok=false` with the real auth error instead of a false
  "Completed". (#96)
- Guard against a finding positioned on a deleted file (fallback to a
  clearly-labeled top-level note instead of relying on incidental diff-hunk
  behavior); added a DELETED FILES rule to the reviewer scope prompt so
  migration-gap findings land on the replacement file, not the deleted one.
  (#95)
- Clear a stale terminal marker (`white_check_mark`/`warning`) before
  re-awarding the same name — a second consecutive completed/failed review
  of one MR previously hit a GitLab 404 ("Award Emoji Name has already been
  taken") and left the marker stale. (#94)
- Make the source-project review bridge template non-blocking
  (`allow_failure: true`) by default — the bridge job only fails on a
  reviewer-infra problem, never on findings severity, so a shared
  reviewer-project outage should not block a source project's own
  merge/deploy. (#93)

## [0.6.1] - 2026-09-05

### Fixed

- **Root-caused and fixed `agent-presets: refusing to compose an unscoped
  context`.** `npm install -g @deepseek-ai/dsh` in the reviewer image
  resolved its own independent copy of the harness core (`dsh-scope`,
  `dsh-agent-loop`, `dsh-agent-presets`, ...), disjoint from the profile's
  own `pnpm install` of the same packages — `dsh-scope`'s module-level
  `Symbol("dsh.scope")` evaluated twice, so scope identity checks never
  matched. Fixed by installing `@deepseek-ai/dsh` as a `profiles/reviewer-ci`
  dependency (same pin as `dsh-base`) instead of a separate global install,
  so pnpm dedupes every shared core package into one physical copy. (#86)
- Log GitLab API failures instead of silently swallowing them when the
  running-marker ("eyes") award-emoji signal fails to set or clear. (#87)
- Make the CI reviewer's `botUsername` configurable via
  `REVIEW_BOT_USERNAME` instead of a hardcoded `maestro-bot` — the hardcoded
  value never matched the real token identity, so stale "eyes" markers were
  never cleared and own-thread dedup silently failed. (#88)
- Stop discarding already-captured findings when a reviewer/auditor turn
  errors out after producing usable output — the error is now logged as a
  warning and the salvaged output is used, instead of being thrown away.
  (#90)

### Changed

- Rewrote `.dockerignore` as an allowlist (only `profiles/reviewer-ci`,
  `presets/`, `docker/` are sent to the Docker build context) instead of a
  denylist, and corrected stale `:latest`-tag claims in
  `docs/ci-reviewer-setup.md`. (#89)

## [0.6.0] - 2026-09-04

### Changed

- **Removed OpenCode Go entirely.** The reviewer image no longer bakes an
  opencode-based default: `DEEPSEEK_API_KEY` is now the sole baked default
  (`deepseek-official` straight from `api.deepseek.com`), and setting
  `REVIEW_LLM_API_KEY` overlays a bring-your-own OpenAI-compatible endpoint
  (`REVIEW_LLM_BASE_URL` + `REVIEW_LLM_MODEL`, optional `REVIEW_LLM_API`)
  instead. `OPENCODE_GO_API_KEY`/`OPENCODE_MODEL` and
  `docker/ci-settings.opencode.yaml` are gone. (#82)

### Fixed

- Surface the real turn error (auth/billing/rate-limit) instead of a
  misleading "did not successfully load the required skill profile" message
  in the reviewer, and a silent clean-looking empty report in the auditor —
  both previously masked a provider-level failure as a maestro-skills
  installation problem. (#81)
- Bump harness devDependencies (`dsh-agent`, `dsh-agent-presets`, `dsh-llm`,
  etc.) from `0.1.2-alpha.2` to `0.1.2-rc.1` to match the version actually
  running on deployed hosts, pinning `dsh-attachment` explicitly to avoid an
  incompatible transitive resolution. (#80)
- Pin the public template's `REVIEWER_IMAGE` to `:0.1.0` instead of
  `:latest`. (#79)

## [0.5.1] - 2026-09-04

### Fixed

- Harden the webhook push path: 15s ceiling on pre-agent GitLab fetches,
  post-comment/reply and signal calls; structured drop/dedup reasons in the
  host log (orchestrator gates, intake identity, in-flight dedup); in-flight
  key now includes trigger + push SHA so concurrent pushes stop suppressing
  each other; history read-modify-write serialized and prune never drops a
  running entry. A deduped decline no longer records a bogus completion.
  (Ported from #73 onto the v0.5.0 flow.)
- CI review comments use the real project path (`references.full` from the MR
  detail call) in the header and View-MR link instead of `project/<id>`,
  falling back to the synthetic form on old servers.

## [0.5.0] - 2026-09-04

### Added

- Shared review flow for CI: unmapped deep reviews with CI env + head SHA
  skip the decline/diff-only fallback, clone the source at the head SHA and
  reuse the mapped machinery with a static-only auditor (no govard runtime).
  (#69)
- Review auto-trigger gates: global + per-project config for re-review on
  push (`autoRereviewOnPush`, default off) and review on reviewer assignment
  (`autoReviewOnAssign`, default on); per-project rows override globals and
  inherit when unset. Manual mentions always trigger. (#70, requires
  `@ddtcorex/dsh-maestro-config-lib@^0.1.6`)
- CI quick with profile: unmapped quick + non-generic `REVIEW_PROFILE`
  joins the clone branch reviewer-only (no auditor) instead of diff-only;
  the comment header carries the profile. (#71)

## [0.4.0] - 2026-09-04

### Added

- Natural-language deep-review trigger: "deep review" phrasing routes to
  deep mode instead of quick review. (#55)
- `gitlab_get_file_diff` per-file diff tool, preferred over full-diff spill
  to stay under the file-spill threshold. (#61)
- Mandatory lint rule in the reviewer scope prompt: at least one
  `govard_audit_lint` call (diff scope) before `report_review_findings`.
  (#64)
- Magento phpunit invocation guidance in the `govard_shell` tool
  description (`-c` config or bootstrap + scoped paths; no bare or
  full-suite runs; `PIPESTATUS` trap). (#67)

### Fixed

- Read the auditor transcript across the session API skew. (#56)
- Review effectiveness: finding dedup, severity calibration, lint detail,
  worktree vendor bind. (#57)
- Lint diff base default and container vendor bind. (#58)
- Preserve the project mount and bind `env.php` in the container
  override. (#59)
- Xdebug off in the worktree env plus `--allow-xdebug` for lint runs.
  (#60)
- Collect nested envelope findings including the compat bucket for
  non-phpcs/phpstan findings. (#62)
- Strip the pterm `ERROR` trailer and collect `jobs`-nested findings.
  (#63)
- Strip `undefined` fields from collected lint findings (DSH rejects
  non-lossless tool output). (#65)
- Replace private project paths in test fixtures. (#66)

## [0.3.2] - 2026-09-03

### Removed

- **Dead `supervisorModel` setting** — removed from `MaestroUserConfig` and the
  settings-RPC savable keys (the supervisor runs a deterministic debug-agent
  without LLM and the orchestrator never read it). Old clients sending the key
  now get `Unknown settings key "supervisorModel"`.

## [0.3.1] - 2026-09-02

### Fixed

- **Release 0.3.0 already published** — bump to 0.3.1 for re-publish after tag move.


## [0.3.0] - 2026-09-02

### Added

- **Review message redesign** — redesign review messages for GitLab and Telegram (#48, #49 telegram HTML digest word-boundary truncation and quote escape).

### Changed

- Bump @deepseek-ai/* to 0.1.2-alpha.2, cordis 4.0.2 (#47), bump dsh-maestro-ci pin (#46), restore workspace dep for config-lib (#45).

### Fixed

- Use npm ^0.1.2 for config-lib to unblock 0.2.1 release (#44).


## [0.3.0] - 2026-09-03

### Added

- **Telegram HTML digest + GitLab Markdown parity** — `reviewDigestText` now emits Telegram HTML (`<b>`, `<code>`, `<a href>`, `&amp;/&lt;/&gt;/&quot;`) with `🤖 Maestro Review` header, status, mode/profile/duration, findings (`new`/`reply`/`failed`/`no inline findings`), word-boundary truncated summary (`160 chars + …`), and `View MR →` footer; mirrors new `buildReviewComment` / `buildNotStartedComment` Markdown helpers in `orchestrator.ts`. Delivery via `maestroNotifier` with `parse_mode:HTML`, `protect_content:true`, `disable_web_page_preview:true` — verified live `200 {ok:true}` on `example-project !3772`.

### Changed

- **Word-boundary summary truncation** — `orchestrator summarize` now strips `## 🤖 Maestro Review` header and truncates at last space before 160 chars (` …`), avoiding half-cut code (`:src="item.displayI`); `notify formatSummary` applies same bound before `escapeHtml`.

### Fixed

- **Quote escaping in Telegram href** — `escapeHtml` now escapes `"` → `&quot;` for attribute safety.

## [0.2.1] - 2026-08-30

### Fixed

- **Publishable config-lib dep for 0.2.0** — release `0.2.0` failed (`Cannot find module '@ddtcorex/dsh-maestro-config-lib'`) because tagged manifest kept `workspace:^0.1.1` instead of `npm ^0.1.2`; fix to `^0.1.2` with regenerated `pnpm-lock.yaml` (`0.0.0 → 0.1.2`).

## [0.2.0] - 2026-08-30

### Added

- **Review profiles for 4 frameworks** — extend `REVIEW_PROFILE_SKILLS` with `laravel` (`govard-toolbox` + `govard-laravel` + `php-dev-core`), `symfony` (`govard-toolbox` + `govard-symfony` + `php-dev-core`), `wordpress` (`govard-toolbox` + `govard-wordpress` + `php-dev-core`) alongside existing `magento2` (9 skills) and `generic`. Sync `MAESTRO_SKILLS_INSTALL_COMMAND` union (13 skills) and `orchestrator Config.reviewProfile` schema; `maestro_load_review_profile` now advertises all 5 profiles. Fixes WP/Laravel/Symfony MRs falling back to `generic` with no skills.

### Changed

- **Govard audit lint — framework-aware timeout** — `govard_audit_lint` defaults `DEFAULT_TIMEOUT 120s→900s (15m)`, extends `timeoutMs` range `300s→30m (1_800_000)`, and forwards `govard audit run --timeout auto (90s-30m, 22.5m for wordpress/magento2)` + `--lint-provider govard` + `--mode`/`--scope`/`--php`/`--no-lint-result-cache` passthrough. Prevents watchdog `cancelled` on large `wordpress 282M 509s` / `magento2 1.3M 19m` runs with `govard 1.67` image `84f9097`.

### Fixed

- **Branch-not-found fallback test** — `ensureWorktree` now throws `BRANCH_NOT_FOUND` on `couldn't find remote ref` so `failStaleRunning` can distinguish missing branch vs infra; add `isBranchNotFoundError` helper.

## [0.1.2] - 2026-08-28

### Fixed

- **Govard audit lint schema** — add `errors`/`diagnostics`/`sessionId`/`runId` to `govard_audit_lint` output and normalize `exitCode`/`rawJson` (`124` timeout, `127` not_found, `1` parse_error, `0` success) to prevent `INVALID_TOOL_OUTPUT` after long runs (#38).
- **Inline posting fallback** — `postReviewFindings` falls back to MR note `**Inline fallback — \`path:line\` line is not in current MR diff**` when `diffPositionForNewLine` is undefined; preserves throw for file-not-in-diff and collapsed diff (#38).
- **Stale running auto-fail** — `failStaleRunning` marks `running` >2h as `failed` via `recordReviewStart`/`pruneHistory` to avoid leaked running after host restart (#38).

### Verified

- `pnpm verify` clean, `pnpm test` 92/92, `pnpm build` markers, live MR `!28` (0+Failed) → `!29` (1 inline 0 failed) on example-project `2columns.phtml:22`.

## [0.1.1] - 2026-08-28

Patch release to unblock publishing and carry forward DSH 0.1.2 compatibility.

### Fixed

- **Publishable `config-lib` dependency** — switched `workspace:^` to `npm ^0.1.1` for the
  tagged release (`fix(review): use npm ^0.1.1 for config-lib to unblock release #34`)
  and restored the workspace dep on `master` afterwards (`chore(review): restore workspace
  dep for config-lib after 0.1.1 release #35`).
- **DSH 0.1.2 compat** — migrated `apiproxy` row to `client-connection`
  (`chore: migrate apiproxy to client-connection for DSH 0.1.2 compat #36`).
- **Supervisor model** — accept `supervisorModel` in settings save / bump to 0.1.1
  (`feat(review): accept supervisorModel in settings save #32`, `chore(dsh-maestro-review):
  bump to 0.1.1 for supervisorModel #33`).
- **Reasoning effort fallback** — handle unsupported `reasoningEffort` with fallback
  and clearer error (`fix(review): handle unsupported reasoningEffort #31`).

### Changed

- CI now unified via reusable `ddtcorex/dsh-maestro-ci` workflows
  (`ci: unify release via reusable node-release #30`, `node-plugin.yml@22511d64e`).

## [0.1.0] - 2026-08-25

Initial public release of `@ddtcorex/dsh-maestro-review` — pluggable
ReviewProvider + orchestrator for automated MR review in DeepSeek Harness.

### Added

- **ReviewProvider abstraction** (`src/providers/interface.ts`) — pluggable contract;
  GitLab provider (`src/providers/gitlab.ts`) with live MR fetch/comment, GitHub
  stub (`src/providers/github.stub.ts`).
- **Orchestrator** (`src/orchestrator.ts`) — reviewer + auditor child agents on
  disposable worktrees, model selection overridable globally (`reviewModel`) and
  per-project, dedup + retention.
- **Webhook intake** (`src/gitlab-webhook.ts`, row `maestro-review-webhook`) and
  review intake/findings/history/signals
  (`src/review-intake.ts`, `src/review-findings-tool.ts`, `src/review-history.ts`,
  `src/review-signals.ts`) — findings written only via the `review-findings` tool
  by tool-only presets, never free text.
- **Settings & auth** (`src/settings-rpc.ts`, `src/config-store.ts`, `src/pin-store.ts`,
  `src/secure-compare.ts`) — shared namespaced settings store
  (`~/.dsh/maestro/settings.json` via `@ddtcorex/dsh-maestro-config-lib`), PIN auth
  with constant-time compare.
- **Govard / workspace / skills tooling** (`src/govard-tool.ts`, `src/workspace-tool.ts`,
  `src/skills-tool.ts`, `src/notify.ts`) — Govard audit + workspace file access
  inside review runs; notifier texts via optional `maestroNotifier` service.
- **Deterministic review gates** — `hyva_csp_scan` (#19), `layout_xml_extract` (#20),
  `magento_module_check` (#21), `phtml_escape_scan` (#22), `maestro_review_scope_split`
  (#23), `govard_audit_lint` alias (#24), `maestro_perf_log_stats` (#25),
  `git_worktree {inspect|create|remove}` (#26), `maestro_plan_track` + `maestro_tdd_evidence`
  (#27), streaming perf log + trailing-error strip (#28/#29), incremental re-review
  context for push-heavy MRs (#17).
- **Cordis rows** via `cordis.patch.yml` — `maestro-review-webhook`, `maestro-review-orchestrator`,
  `maestro-review-settings-rpc` (`/dsh-maestro-review` channel).
- **Client half** — settings section rendered into DSH Web slots.

[0.3.0]: https://github.com/ddtcorex/dsh-maestro-review/releases/tag/v0.3.0
[0.2.1]: https://github.com/ddtcorex/dsh-maestro-review/releases/tag/v0.2.1
[0.2.0]: https://github.com/ddtcorex/dsh-maestro-review/releases/tag/v0.2.0
[0.1.2]: https://github.com/ddtcorex/dsh-maestro-review/releases/tag/v0.1.2
[0.1.1]: https://github.com/ddtcorex/dsh-maestro-review/releases/tag/v0.1.1
[0.1.0]: https://github.com/ddtcorex/dsh-maestro-review/releases/tag/v0.1.0
