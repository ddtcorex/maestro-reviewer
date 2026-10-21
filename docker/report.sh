#!/bin/sh
set -eu
# Scheduled report job of the reviewer pipeline (templates/reviewer-project.gitlab-ci.yml):
# aggregates the review jobs' review-report.json over REVIEW_REPORT_DAYS into
# periodic-report.json and periodic-report.md in the job directory.
if [ -n "${CI_PROJECT_DIR:-}" ]; then cd "$CI_PROJECT_DIR"; fi
exec node /app/profiles/reviewer-ci/node_modules/@ddtcorex/maestro-reviewer/lib/ci-report-cli.js
