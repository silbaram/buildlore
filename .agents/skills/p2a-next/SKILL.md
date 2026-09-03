---
name: p2a-next
description: Use when a Plan2Agent user asks what to do next, wants to resume a project, or needs one state-based next action in an agent session.
---

# Plan2Agent Next

Use the CLI result as the only decision authority. Do not infer, list, or encode project-state rules in this skill.

## Procedure

1. Run `p2a next --json --contract v2` from the target project. Pass `--project-id <id>` only when the user selected an artifact explicitly. The unqualified JSON command `p2a next --json` remains the backward-compatible `p2a.next.v1` surface; human output defaults to v2 so structured options remain visible.
2. Parse the one returned `command`, `continuation`, `reason`, `reasonCode`, and `state`. `reasonCode` is the stable schema-enumerated machine identifier and currently equals `state` for compatibility.
3. Present the result in the conversation using the returned reason.

If the v2 result contains an `immediate` continuation, request its references once with `p2a context show --artifacts <dir> --continuation <id> --provider <provider>`. For `after_command_success`, first validate the single `p2a.execution_result.v1` result, then pass its `runId` to the same command. Do not rediscover or individually reopen packet-managed references.

## Handle the returned command

- For `kind: cli` with `requiresApproval: true`, show the command and wait for the user's approval before running it. Do not infer approval from successful work or a clean review.
- For `kind: cli` with `requiresApproval: false`, run it immediately. This flag is emitted only for read-only repair inspection or the post-Gate B development, verification, and required-review loop already authorized by the approved contract. Iteration close is never part of this automatic loop.
- For `kind: approval` with `options`, present every structured option and wait for the user's explicit choice. For `review`, keep the iteration open and perform a read-only review of the completed diff, code, tests, and existing current-revision final verification evidence. Judge test adequacy from those sources, but do not rerun tests, builds, lint, typechecking, or other product commands merely because review was selected; `next` already routes missing or stale final evidence before offering this choice. If a finding requires code changes, replace the placeholders in the returned `action.remediation` command with the owning completed task id and a concrete finding note, run it, then run `next` to enter a new remediation run through the normal lifecycle. A clean review runs `next` again and returns to the same decision. For `retrospective`, keep product review and close separate: report returned candidates in plain language and distinguish product verification performance from P2A workflow signals, or when there are none ask once whether the user experienced P2A delay, errors, wrong routing, or unnecessary steps. If the user reports an issue, summarize the observed fact, user impact, and suggested improvement before asking whether to continue the retrospective; if they report none, create nothing and return to the same decision. When the user explicitly continues, write the returned `action.report.path` once with only `Observed issue`, `User impact`, `Suggested improvement`, and concise evidence; do not overwrite an existing report, copy raw command output, or infer missing facts. Report approval does not authorize proposal mining. For `close`, the user's exact choice authorizes only the returned nested close command; execute it without treating a clean review or retrospective as approval.
- Proposal mining writes proposals from retrospective candidates and therefore always requires approval; never treat it as part of the autonomous close loop.
- When a CLI action has an `after_command_success` continuation, execute its returned `argv` exactly and parse the single `p2a.execution_result.v1` JSON document. Activate the continuation only when the command exits zero, `outcome` is `succeeded`, and `runStatus` is `started`; bind the returned `runId` without parsing human output.
- For `kind: skill`, continue in this agent session with the returned `skill` and `args`. Carry over only the declared continuation context; do not re-decide the next action.
- For `gate_b_approved_needs_execution_prepare`, pass the returned `--prepare-mode` to `p2a-dev-execution`. The skill selects and records the concrete adaptive mode; do not ask the user to choose from a mode menu or approve the synthetic compatibility work item.
- For `kind: approval` without `options`, show the returned artifact or approval instruction and wait for the user's decision.

Never execute a CLI command when `requiresApproval` is true. If the CLI requests project selection, ask the user to choose the displayed project id and run this skill again with that id.
