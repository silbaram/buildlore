---
name: p2a-next
description: Use when a Plan2Agent user asks what to do next, wants to resume a project, or needs one state-based next action in an agent session.
---

# Plan2Agent Next

Use the CLI result as the only decision authority. Do not infer, list, or encode project-state rules in this skill.

## Procedure

1. Run `p2a next --json --contract v2` from the target project. Pass `--project-id <id>` only when the user selected an artifact explicitly. The unqualified command remains the backward-compatible `p2a.next.v1` surface.
2. Parse the one returned `command`, `continuation`, `reason`, `reasonCode`, and `state`. `reasonCode` is the stable schema-enumerated machine identifier and currently equals `state` for compatibility.
3. Present the result in the conversation using the returned reason.

If the v2 result contains an `immediate` continuation, request its references once with `p2a context show --artifacts <dir> --continuation <id> --provider <provider>`. For `after_command_success`, first validate the single `p2a.execution_result.v1` result, then pass its `runId` to the same command. Do not rediscover or individually reopen packet-managed references.

## Handle the returned command

- For `kind: cli` with `requiresApproval: true`, show the command and wait for the user's approval before running it.
- For `kind: cli` with `requiresApproval: false`, run it immediately. This flag is emitted only for read-only repair inspection or the post-Gate B development/verification/close loop already authorized by the approved contract.
- Proposal mining writes retrospective candidates and therefore always requires approval; never treat it as part of the autonomous close loop.
- When a CLI action has an `after_command_success` continuation, execute its returned `argv` exactly and parse the single `p2a.execution_result.v1` JSON document. Activate the continuation only when the command exits zero, `outcome` is `succeeded`, and `runStatus` is `started`; bind the returned `runId` without parsing human output.
- For `kind: skill`, continue in this agent session with the returned `skill` and `args`. Carry over only the declared continuation context; do not re-decide the next action.
- For `gate_b_approved_needs_execution_prepare`, pass the returned `--prepare-mode` to `p2a-dev-execution`. The skill selects and records the concrete adaptive mode; do not ask the user to choose from a mode menu or approve the synthetic compatibility work item.
- For `kind: approval`, show the returned artifact or approval instruction and wait for the user's decision.

Never execute a CLI command when `requiresApproval` is true. If the CLI requests project selection, ask the user to choose the displayed project id and run this skill again with that id.
