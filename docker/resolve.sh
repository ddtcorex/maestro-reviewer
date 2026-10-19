#!/bin/sh
set -eu
# Resolve job of the reviewer pipeline (templates/reviewer-project.gitlab-ci.yml):
# identifies the upstream MR through GitLab, decides the provider route and
# writes review-child.yml into the job directory for the child trigger.
if [ -n "${CI_PROJECT_DIR:-}" ]; then cd "$CI_PROJECT_DIR"; fi
exec node /app/profiles/reviewer-ci/node_modules/@ddtcorex/maestro-reviewer/lib/ci-resolve-cli.js
