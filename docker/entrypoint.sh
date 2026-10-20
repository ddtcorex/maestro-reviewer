#!/bin/sh
set -eu
# Auth: REVIEW_GITLAB_TOKEN must be a PAT/Project/Group token (api scope).
# CI_JOB_TOKEN is deliberately NOT accepted: proven 2026-09-04 on GitLab 18.11
# (GET=200 but POST /notes=401 even with the source allowlisting this project),
# so falling back would "complete" reviews without ever posting the comment.
# The JOB-TOKEN header path (GITLAB_TOKEN_KIND, gitlab-auth.ts) stays for
# future use; it just must not be wired here until writes work.
if [ -z "${REVIEW_GITLAB_TOKEN:-}" ] || [ -z "${SOURCE_PROJECT_ID:-}" ] || [ -z "${MR_IID:-}" ]; then
  echo "[review] missing required env (REVIEW_GITLAB_TOKEN as a user/project token, SOURCE_PROJECT_ID, MR_IID)" >&2
  exit 1
fi
if [ -n "${CI_PROJECT_DIR:-}" ]; then cd "$CI_PROJECT_DIR"; fi
export REVIEW_REPORT_DIR="$PWD"
# GitLab's docker executor keeps the image WORKDIR (/app), not the job's build
# dir — without this, reports/history land inside the container and the
# artifacts/cache steps find nothing (proven 2026-09-04 live). Local `docker
# run -w` sets PWD already, so this only fires in real CI.
# Provider route selection lives in route.sh (unit tested): the baked
# deepseek default, the bring-your-own OpenAI-compatible overlay, and the
# per-project route written by the resolve job. Return 3 means the project
# requires its own key and has none: exit cleanly without a review.
. /route.sh
rc=0
select_route /app/settings.yaml /app/settings.generic-openai.yaml || rc=$?
if [ "$rc" -eq 3 ]; then exit 0; fi
if [ "$rc" -ne 0 ]; then exit "$rc"; fi
# Review history must survive across jobs (fresh container each run) or the
# push-gate and incremental context go blind. The reviewer job caches
# $REVIEW_REPORT_DIR/.maestro-history (see templates/reviewer-project.gitlab-ci.yml);
# point DSH's history store at it via symlink before exec (a symlink survives exec,
# a copy-back after would not). Falls back to ephemeral /app storage when unmounted.
if [ -d "$REVIEW_REPORT_DIR" ]; then
  mkdir -p "$REVIEW_REPORT_DIR/.maestro-history"
  # -sfn on an existing real dir would nest inside it; only link when absent.
  [ -e /app/dsh-maestro-review ] || ln -s "$REVIEW_REPORT_DIR/.maestro-history" /app/dsh-maestro-review
fi
# Boot the published DSH CLI against the baked reviewer-ci profile
# ($DSH_HOME/profiles/reviewer-ci).
exec dsh --profile reviewer-ci
