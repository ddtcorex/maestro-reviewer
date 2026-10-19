# Provider route selection, sourced by entrypoint.sh (and by the tests).
# select_route <settings file> <generic template>
#
# Only our baked template (the __CI_MANAGED__ marker) is rewritten; a
# job-mounted settings file passes through untouched. Routes:
#   unset/default  deepseek is the baked default (DEEPSEEK_API_KEY); setting
#                  REVIEW_LLM_API_KEY overlays the bring-your-own
#                  OpenAI-compatible route (REVIEW_LLM_BASE_URL/MODEL/API).
#   project        written by the resolve job for a project with its own
#                  provider: the key and model come from that project's
#                  review/<id> scope, the base URL and API from the resolve job
#                  (REVIEW_ROUTE_BASE_URL/API), never from an inherited value;
#                  the REVIEW_MODEL_PROVIDER/REVIEW_MODEL pin is dropped.
#   unconfigured   the project requires its own key and has none: return 3,
#                  the caller exits without a review.
route_fail() {
  echo "[review] $1" >&2
  return 1
}

select_route() {
  settings="$1"
  generic="$2"
  grep -q __CI_MANAGED__ "$settings" 2>/dev/null || return 0
  case "${REVIEW_ROUTE:-}" in
    ''|default) ;;
    unconfigured)
      echo "[review] this project requires its own provider key and has none; not reviewing"
      return 3
      ;;
    project)
      [ -n "${REVIEW_LLM_API_KEY:-}" ] || { route_fail "REVIEW_LLM_API_KEY is required for the project route"; return 1; }
      [ -n "${REVIEW_LLM_MODEL:-}" ] || { route_fail "REVIEW_LLM_MODEL is required for the project route"; return 1; }
      [ -n "${REVIEW_ROUTE_BASE_URL:-}" ] || { route_fail "REVIEW_ROUTE_BASE_URL is required for the project route"; return 1; }
      REVIEW_LLM_BASE_URL="$REVIEW_ROUTE_BASE_URL"
      REVIEW_LLM_API="${REVIEW_ROUTE_API:-openai-completions}"
      # A default-scope model pin must not choose the model a project pays for.
      unset REVIEW_MODEL_PROVIDER REVIEW_MODEL
      ;;
    *)
      route_fail "invalid REVIEW_ROUTE (allowed: default, project, unconfigured)"
      return 1
      ;;
  esac
  [ -n "${REVIEW_LLM_API_KEY:-}" ] || return 0
  [ -n "${REVIEW_LLM_BASE_URL:-}" ] || { route_fail "REVIEW_LLM_BASE_URL is required when REVIEW_LLM_API_KEY is set"; return 1; }
  [ -n "${REVIEW_LLM_MODEL:-}" ] || { route_fail "REVIEW_LLM_MODEL is required when REVIEW_LLM_API_KEY is set"; return 1; }
  REVIEW_LLM_API="${REVIEW_LLM_API:-openai-completions}"
  case "$REVIEW_LLM_API" in
    openai-completions|openai-responses) ;;
    *) route_fail "invalid REVIEW_LLM_API (allowed: openai-completions, openai-responses)"; return 1 ;;
  esac
  # Charset guards keep the sed substitutions below injection-free.
  case "$REVIEW_LLM_BASE_URL" in
    *[!A-Za-z0-9:/_.+-]*) route_fail "invalid REVIEW_LLM_BASE_URL (allowed: A-Za-z0-9:/_.+-)"; return 1 ;;
  esac
  case "$REVIEW_LLM_MODEL" in
    *[!A-Za-z0-9/_+.-]*) route_fail "invalid REVIEW_LLM_MODEL (allowed: A-Za-z0-9/_+.-)"; return 1 ;;
  esac
  # A stable per-job session id for gateways that key routing/prompt-cache
  # affinity off it (e.g. OpenCode Zen's Go route hard-requires
  # x-opencode-session, see ci-settings.generic-openai.yaml). One CI job is
  # one review "conversation", so GitLab's own CI_JOB_ID (always numeric,
  # unique per job) is a stable id with no charset guard needed; $$ covers a
  # local `docker run` where CI_JOB_ID is unset.
  REVIEW_LLM_SESSION_ID="${CI_JOB_ID:-$$}"
  sed -e "s#__REVIEW_LLM_API__#${REVIEW_LLM_API}#g" \
      -e "s#__REVIEW_LLM_BASE_URL__#${REVIEW_LLM_BASE_URL}#g" \
      -e "s#__REVIEW_LLM_MODEL__#${REVIEW_LLM_MODEL}#g" \
      -e "s#__REVIEW_LLM_SESSION_ID__#${REVIEW_LLM_SESSION_ID}#g" \
      "$generic" > "$settings.tmp" && mv "$settings.tmp" "$settings"
}
