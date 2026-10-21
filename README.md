# @ddtcorex/maestro-reviewer

The Maestro merge-request review engine and its GitLab CI flow: reviewer and
auditor agents, comment and finding posting, review history and signals, the
`resolve` job, the reviewer Docker image and the CI templates. It needs no DSH
web host, no settings store and no local checkout.

The DSH host side (GitLab webhook intake, project mappings with local
worktrees, the Maestro Review Settings section, Telegram digests) is the
separate plugin [`@ddtcorex/dsh-maestro-review`](https://github.com/ddtcorex/dsh-maestro-review),
which runs this engine.

## What it provides

- **Review engine** (`src/host/engine.ts`, Cordis row `maestro-review-engine`,
  service `reviewEngine`): one review run from an explicit configuration
  (GitLab URL, token and bot username, model, agent timeout, profile) and a
  code access mode: `diff` (the GitLab diff only), `clone` (the source cloned
  at the head SHA) or `workspace` (a worktree the caller prepares).
- **Forge boundary** (`src/host/forge/`): the engine reaches GitLab only through
  `ReviewForge`, implemented in `forge/gitlab/`.
- **Findings, history and signals**: findings come only through the
  `report_review_findings` tool of tool-only review agents; history and the
  running and final MR markers are tracked per MR.
- **Review tools** (workspace search, Magento and Hyva scans, query-log stats,
  GitLab diff tools) mounted into review runs, and the bundled
  `dsh-native-tools` skill (row `maestro-review-host`).

## CI reviewer (no local checkout)

The same pipeline also runs headless from GitLab CI: a shared reviewer
project (holds secrets and the image) serves any number of source projects
through a small bridge job, with no DSH host and no project mapping.

- **Trusted trigger.** The reviewer project forbids pipeline variables, and a
  `resolve` job asks GitLab which MR triggered it, so a source project can
  never change what the reviewer runs or where its secrets go. The pipeline
  file lives in a separate Maintainer-only config project, so every developer
  can trigger a review while only Maintainers can change what receives the
  keys.
- **Per-project providers.** Each source project can bring its own AI provider
  and key (`openai`, `anthropic`, `gemini`, `openrouter`, `deepseek` presets or
  any OpenAI-compatible endpoint), set as reviewer variables scoped
  `review/<project id>`; a require switch guarantees a paying project never
  falls back to the default key.
- **Per-repository settings.** A `.maestro-review.yml` on the target branch
  sets the profile, extra ignore globs, project rules, the minimum severity
  to post, the comment language and the fan-out thresholds; an MR cannot
  change the settings its own review runs with.
- **Safe input.** Secrets and personal data are redacted before any model
  call, and generated, vendored and lock files never reach the model; large
  MRs are reviewed in parallel parts, re-pushes only by their interdiff.
- **MR commands.** `/maestro explain`, `/maestro fix` (a GitLab suggestion
  block), `/maestro rereview [path]` and `/maestro dismiss [CODE]`, answered
  by the next review job; a code a project keeps dismissing is muted.
- **Optional gate and reports.** `REVIEW_GATE=blocking` fails the review job
  while the MR has an open blocking thread; a Code Quality artifact and a
  scheduled periodic report (findings, tokens, tool calls per project).
- **Quick** runs diff-only (or on a checkout when `REVIEW_PROFILE` names a
  framework); **deep** runs once per head SHA on the `maestro-review::deep`
  label, cloning the MR head with a static-only audit.

Step-by-step GitLab setup, the access each user and token needs, every
variable with its scope and flags, daily use, and troubleshooting: [`docs/ci-reviewer-setup.md`](docs/ci-reviewer-setup.md).
Templates live in `templates/`, the image in `docker/`.

## Settings

Reads its configuration through the **shared namespaced settings store**
(`~/.dsh/dsh-maestro-config/settings.json`) via the flat adapter in
`src/host/config-store.ts`, over the embedded store copy `src/host/vendor/store.ts`
(generated from `dsh-maestro-core`, no runtime dependency); machine runtime state stays in a
package-local sidecar.

## Install

```sh
dsh plugin --profile web add @ddtcorex/maestro-reviewer
```

## Development

```sh
pnpm install
pnpm verify        # tsc --noEmit
pnpm test          # vitest run
pnpm build         # tsc -> lib/, plus the browser bundle lib/client.js
```

See AGENTS.md for conventions (host/client split, secrets handling, live-validation rules).

## Use from a DSH profile

```sh
dsh plugin --profile web add @ddtcorex/maestro-reviewer @ddtcorex/dsh-maestro-review
```

The engine alone provides the skill and the `reviewEngine` service; the
webhook and Settings need `@ddtcorex/dsh-maestro-review`.

## Development

```sh
pnpm install
pnpm verify        # tsc --noEmit
pnpm build         # tsc -> lib/
pnpm test          # vitest run (engine-exports.test.ts reads lib/, so build first)
```

See AGENTS.md for conventions (trust model, forge boundary, secrets handling, live-validation rules).

## Release

A release ships **two artifacts that must stay in lockstep**: the npm
package and the `ddtcorex/maestro-reviewer` Docker image — the image
installs the npm package from the registry rather than copying source, so
tagging a release alone is not enough to ship it to CI users. In short:
bump `package.json` + `CHANGELOG.md` + the three image-tag references →
tag `vX.Y.Z` (triggers npm publish + GitHub Release) → bump
`profiles/reviewer-ci/package.json`'s own pin to match → rebuild and push
the Docker image. Full step-by-step checklist, including the pnpm
supply-chain age-gate workaround and how to live-test a fix in the image
before a full release: see **Release checklist** in [`AGENTS.md`](AGENTS.md).

## License

MIT
