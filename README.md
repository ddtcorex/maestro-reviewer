# @ddtcorex/maestro-reviewer

> Renamed from `@ddtcorex/dsh-maestro-review` in 0.13.0. Profile owners: replace the
> dependency with `@ddtcorex/maestro-reviewer`. Cordis row ids, the data directory
> and settings keys are unchanged, so existing profile patches keep applying.

Automated merge-request review for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a GitLab merge-request pipeline, an orchestrator that spins up reviewer/auditor
child agents on fresh worktrees, webhook intake for GitLab events, and a settings/tunnel
client UI injected into the DSH Web slots.

Part of the Maestro Harness suite (`dsh-maestro-*`). Cordis patch rows:
`maestro-review-host` (package root, bundled skills), `maestro-review-webhook` (intake),
`maestro-review-orchestrator` (pipeline), `maestro-review-settings-rpc` (settings UI),
all served by this npm package.

## What it provides

- **GitLab pipeline**: webhook and CI intake, MR diff/thread tools and finding posting for GitLab.
- **Orchestrator** — reviewer + auditor agent runs against a disposable worktree of the MR,
  model selection overridable globally (`reviewModel`) and per project mapping.
- **Webhook intake** — receives GitLab MR events, enqueues reviews (dedup + retention).
- **Review findings/history/signals**: findings written through the `report_review_findings`
  tool by tool-only review subagents (never free text); history + signals tracked per MR.
- **Review tools** (workspace search, Magento/Hyva scans, query-log stats, GitLab diff tools) mounted into review runs.
- **Client half** — settings section rendered into DSH Web slots; notification copy stays
  here, delivery goes through the optional `maestroNotifier` service.

## CI reviewer (no local checkout)

The same pipeline also runs headless from GitLab CI: a shared reviewer
project (holds secrets and the image) serves any number of source projects
through a small bridge job, with no DSH host and no project mapping.

- **Trusted trigger.** The reviewer project forbids pipeline variables, and a
  `resolve` job asks GitLab which MR triggered it, so a source project can
  never change what the reviewer runs or where its secrets go.
- **Per-project providers.** Each source project can bring its own AI provider
  and key (`openai`, `anthropic`, `gemini`, `openrouter`, `deepseek` presets or
  any OpenAI-compatible endpoint), set as reviewer variables scoped
  `review/<project id>`; a require switch guarantees a paying project never
  falls back to the default key.
- **Quick** runs diff-only (or on a checkout when `REVIEW_PROFILE` names a
  framework); **deep** runs once per head SHA on the `maestro-review::deep`
  label, cloning the MR head with a static-only audit.

Full setup, per-case trigger workflows (quick/deep × CI/webhook), model
selection, and troubleshooting: [`docs/ci-reviewer-setup.md`](docs/ci-reviewer-setup.md).
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
