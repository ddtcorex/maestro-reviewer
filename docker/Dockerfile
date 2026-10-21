# syntax=docker/dockerfile:1.7
# Maestro reviewer image — npm-based: every runtime dependency comes from a
# registry, nothing is COPYed from a host checkout, so the image is
# reproducible from any machine. Build context is the package directory:
#   docker build -f docker/Dockerfile \
#     -t ddtcorex/maestro-reviewer:0.18.0 -t ddtcorex/maestro-reviewer:latest .
# Pinned versions: profiles/reviewer-ci/package.json (dsh CLI included).
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS runtime
ARG CI_COMMIT_SHA=""
ARG CI_COMMIT_TAG=""
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app
ENV DSH_HOME=/app
# Non-interactive build: pnpm v11 aborts a modules-dir purge without TTY
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) unless CI is set.
ENV CI=true

# reviewer-ci profile — hand-authored package.json (exact registry pins, no
# link:) + cordis.patch.yml. Installed once here, read from
# $DSH_HOME/profiles/reviewer-ci at boot. The dsh CLI itself (`@deepseek-ai/dsh`)
# is a dependency of THIS package.json, not a separate `npm install -g` —
# root-caused 2026-09-05: a global CLI install resolves its own independent
# copy of the harness core (dsh-scope, dsh-agent-loop, dsh-agent-presets, ...)
# from ITS OWN node_modules, disjoint from this profile's own pnpm install of
# the same packages. Cordis's plugin loader ends up loading dsh-agent-loop
# (part of dsh-base's bundle) from one copy and dsh-agent-presets (this
# profile's own top-level insert) from the other, so createScope()'s
# Symbol("dsh.scope") tag and dsh-agent-presets' scopeOf() check never see the
# same Symbol — every agent creation failed with "agent-presets: refusing to
# compose an unscoped context". Installing dsh IN this package.json puts it in
# the SAME single pnpm resolution graph as dsh-base, so pnpm dedupes the
# shared core packages to one physical copy — confirmed fixed live (see PATH
# below for how the binary is found at runtime).
COPY profiles/reviewer-ci ./profiles/reviewer-ci
# --config.minimumReleaseAge=0: every dep here is an exact pin verified in
# the frozen lockfile, so the 24h supply-chain age gate only blocks fresh
# releases of our own packages (verified 2026-09-04: it rejected
# the review package 0.5.1 published hours earlier despite
# minimumReleaseAgeExclude entries).
RUN pnpm --dir profiles/reviewer-ci --config.minimumReleaseAge=0 install --frozen-lockfile
# dsh now resolves from the profile's own node_modules/.bin, not a global install.
ENV PATH="/app/profiles/reviewer-ci/node_modules/.bin:${PATH}"

# Reviewer/auditor agent presets now arrive as bundle patch rows shipped by
# @ddtcorex/maestro-reviewer itself (presets/maestro-{reviewer,auditor}.patch.yml,
# listed in its `dsh.bundle.patch`), which the profile composes like any other
# bundle layer — the orchestrator mounts 'dsh-maestro-reviewer'/'dsh-maestro-auditor'
# from the agent-preset registry. No .agent-presets COPY: DSH 0.1.7 declares
# presets from loader rows only, and the plural @deepseek-ai/dsh-agent-presets
# that used to scan that directory is no longer in this profile.
# Host LLM-config mirror for model serving — dsh registers LLM adapters from
# DSH_HOME settings, which is empty in a fresh container. Two variants
# (selection in entrypoint.sh): ci-settings.deepseek.yaml (sole default,
# api.deepseek.com straight — needs DEEPSEEK_API_KEY) and
# ci-settings.generic-openai.yaml (bring-your-own OpenAI-compatible endpoint,
# overlaid when REVIEW_LLM_API_KEY is set). Holds no secrets (each key
# resolves from its apiKeyEnv var at call time). A job-mounted
# /app/settings.yaml overrides both.
COPY docker/ci-settings.deepseek.yaml /app/settings.yaml
COPY docker/ci-settings.generic-openai.yaml /app/settings.generic-openai.yaml
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/resolve.sh /resolve.sh
COPY docker/report.sh /report.sh
COPY docker/route.sh /route.sh
RUN chmod +x /entrypoint.sh /resolve.sh /report.sh

LABEL org.opencontainers.image.source="https://github.com/ddtcorex/maestro-reviewer"
LABEL org.opencontainers.image.revision="$CI_COMMIT_SHA"
LABEL org.opencontainers.image.version="$CI_COMMIT_TAG"

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

# Variants:
# - maestro-reviewer:quick (default, no govard)
# - maestro-reviewer:deep  (adds the govard binary + php, needs DinD or a larger image — phase 2)
