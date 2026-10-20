---
name: dsh-native-tools
description: Use when running a Maestro skill inside DeepSeek Harness and its text says "native ... when provided" — this maps each such capability (query-log stats, lint, deploy preflight, layout extraction, theme inspection, review scope split, escape scan, module check, MR diff) to the DSH tool or the govard CLI command, run with bash, that provides it
---

# DSH Native Tools

Every public Maestro skill names a **capability**, never a tool: "if the runtime
provides a native query-log stats tool, prefer it; otherwise use the recipe below".
Inside DeepSeek Harness those tools exist, and this file is the map from capability
to call.

Load this whenever a loaded Maestro skill says *native … when provided*, then call
the tool named here instead of the portable recipe in that skill.

## Harness-agnostic actions → DSH tools

The process skills (superpowers fork, `using-superpowers`) describe actions in
harness-neutral words — announce, dispatch a subagent, ask your partner. On DSH:

| Action in skill text | DSH tool |
|---|---|
| Invoke / load a skill | `skill` with `{ name }` |
| Dispatch a fresh subagent per task | `subagent` (background by default; pass `run_in_background: false` only when the next step depends on its result) |
| Continue or redirect an existing subagent | `send_message` to its durable `subagent_id` |
| Fan out independent tasks concurrently | several independent tool calls in one assistant turn |
| Large multi-phase orchestration | `workflow` — only when the human explicitly asks for a workflow |
| Fresh-agent iterative loop | `ralph` — only when the human explicitly asks for Ralph |
| Seed a child with this conversation | `subagent_fork` |
| Create a todo / checklist item | `todo_write` (whole list every call) |
| Ask your human partner | `ask_user_question` |
| Present a plan for approval | `exit_plan_mode` (plan mode only) |
| Long-running objective across turns | goal tools: `create_goal`, `get_goal`, `update_goal` |
| Read a file / find files / search contents | `read`, `glob`, `grep` |
| Write / edit files | `write`, `edit` (read before edit) |
| Run shell commands, tests, git | `bash`; background via `run_in_background: true`, collect with `job_output`, stop with `job_kill` |
| Search the web | `web_search` |
| Look at an image file | `read_image` |

## Native capability tools

Left column is the phrase the public skill uses; right column is what to call.

| Public skill says | Tool and signature |
|---|---|
| native query-log stats tool | `maestro_perf_log_stats {topN?, repeatThreshold?, timeThresholdMs?}` → streaming and bounded; never hand-grep a 16–50k line log or open it as a spreadsheet |
| native lint tool | `govard audit run --checks lint --format json --mode auto --timeout auto --lint-provider govard --scope diff --base <sha>` run with `bash` in the review worktree (`--scope project` drops `--base`); `govard audit run --checks integrity --format json` is the container-free analysis. Read the JSON; exit `0` is clean, `1` findings, `3` a missing capability. A missing `govard` binary or Docker is not a finding: report lint as unavailable |
| native deploy preflight | `govard deploy plan <remote>` (add `--json` for machine-readable) prints the pipeline without connecting; `govard deploy check <remote>` preflights connectivity and the release layout. Both run with `bash`, `remote` is a remote from `.govard.yml`, and running the deploy itself stays in the terminal |
| native layout extraction | `layout_xml_extract {changedFiles:<MR layout files>}` → handles/blocks/moves + templateExists/parseError |
| native theme inspection | `hyva_theme_inspect {classes:["<class-from-diff>"]}` → `{themes[],tailwind:{major,...},hyvaPackages[]}`; a null field means downgrade to a question |
| native review scope split | `maestro_review_scope_split {diffStats:{files,addedLinesPerFile}, mode}` → `{split:{quick,deep},reason,estimatedSavingsTokens}`; run quick checks only on quick files |
| native escape scan | `phtml_escape_scan {scope:"diff", paths:<changed phtml>}` → `{findings[],scannedFiles,truncated}` with confidence + M2-SEC-xxx; `hyva_csp_scan {maxFiles?}` covers CSP work and truncates at `maxFiles` with no `truncated` flag — size the input yourself |
| native module check | `magento_module_check {modulePath:"app/code/Vendor/Module"}` → `{modules[],scannedModules,truncated}`; always check `scannedModules` against what you expected |
| native MR diff | `gitlab_get_mr_diff`, `gitlab_list_own_review_threads`, `gitlab_post_inline_comment` — diff plus own threads plus inline comments in one call |
| local environment inside a review worktree | `govard env up` brings it up, `govard shell -c "<command>"` runs one command in the container, `govard env down -v` tears it down (always, even after a failure). All three run with `bash`; the worktree carries its own project name so it never collides with the primary checkout |

## Session-shape notes

- Skills arrive as catalog summaries in a `<system-reminder>`; load one with the
  `skill` tool before acting on it. There is no session-start bootstrap injection
  on DSH, so checking the available-skills list first is your job.
- Background subagents notify you when they settle — do not poll. Collect any
  still-relevant jobs before finishing a turn.
- "Announce …" in a process skill is plain prose in your reply; DSH has no separate
  announcement channel.
- "interactive when the runtime supports it" means call `ask_user_question` rather
  than guessing a default; on DSH interactive questions are always available.

## Maintenance

- Public skills stay tool-neutral. Never copy a tool name back into
  `maestro-skills`: its catalog test rejects `maestro_*`, `DSH`
  and `DeepSeek Harness` anywhere in skill content, `compatibility: dsh` frontmatter
  excepted.
- Renaming a tool in `src/host` must fail `tests/dsh-native-tools-skill.test.ts`, so
  this map cannot rot silently.
- Update this file when the DSH tool surface changes; the public skills need no edit.
