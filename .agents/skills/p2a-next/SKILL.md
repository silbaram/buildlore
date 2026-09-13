---
name: p2a-next
description: Use when a Plan2Agent user asks what to do next, wants to resume a project, or needs one state-based next action in an agent session.
---

# Plan2Agent Next

Use the CLI result as the only decision authority for project-state transitions, not as permission to replace the user's request. Do not infer or duplicate project-state rules.

## Procedure

Explicit review, explanation, status, or Git-operation requests take precedence over this resume procedure. Handle the requested outcome without advancing unrelated development; read-only requests do not authorize code or lifecycle changes. Use `next` only for missing state context in these cases, not as authority to execute its returned action.

For a direct review or request to summarize, write, or register an identified retrospective, follow the closeout reference below with the supplied code, report, or observations. Do not present an unrelated planning or close menu.

1. Run `p2a next --json --contract v2` from the target project. Pass `--project-id <id>` when the user selected a project, and `--idea <request>` or `--entry <path>` for an actual new change request. Reviewing completed work or summarizing/registering an existing retrospective is not a new feature idea.
2. Read the returned `command`, `continuation`, and reason. Explain the understood outcome, material decision if any, and next action in product language. Keep state ids, run ids, hashes, and artifact paths internal unless requested.
3. Execute the authorized action below, then rerun `next` after it completes unless the result is terminal or a closeout choice is still pending. If project selection is required, ask for one of the displayed project ids.

## Authority and dispatch

- For `kind: skill`, continue with the exact returned `skill` and `args` in this session. Preserve supplied context and user authorization; do not re-decide the route.
- For `kind: cli`, execute the returned `argv`. When `requiresApproval: true`, wait for explicit authorization for that pending action; an already-given approval satisfies the boundary once and does not need repeating. A false flag covers read-only inspection or the already-authorized development loop, not iteration close.
- For `kind: approval` without options, present `decisionSummary` and obtain explicit approval. Replace only the exact `quotePlaceholder` argument with the verbatim user utterance and execute once. A legacy payload without `argv` returns to the owning `p2a-harness` approval procedure; never parse a command from human display text.
- For approval `options`, present the choices unless the user already selected one. Follow the closeout reference below only for this closeout interaction or a direct review/retrospective/report/issue request. Review alone is read-only even if an older payload marks remediation automatic; an explicit request to fix authorizes the linked remediation action. Report writing, GitHub publication, and iteration close are distinct outcomes, each satisfied by its corresponding user request.

Do not reuse approval for a different action or changed state. Let the CLI validate approval records and transitions.

## Progressive reference routing

- Required, conditional; stages: closeout — `.agents/skills/p2a-dev-execution/references/closeout-choices.md` — A closeout choice or an explicit review/retrospective/report/issue request is being handled.

## Continuation context

For an `immediate` continuation, request its reference packet once with `p2a context show --artifacts <dir> --continuation <id> --provider <provider>`. For `after_command_success`, first execute the returned argv and validate its single `p2a.execution_result.v1` JSON result: exit zero, `outcome: succeeded`, and `runStatus: started`. Then bind its `runId` to the context request. Do not parse human output or individually reopen packet-managed references.

Pass `--prepare-mode` unchanged to the execution skill. Adaptive mode selection and compatibility work-item preparation do not need another product approval.

## Request and recovery boundaries

- `iteration_complete`: the next concrete user change request authorizes the returned action and supplies its one `<change idea>` placeholder verbatim. The CLI allocates the iteration id.
- `entry_deferred`: the request is saved, not permission to replace or execute current work. Ask whether to revise the current planned scope or keep the request for later, as directed by the returned decision summary. Preserve existing artifacts and approvals until the choice; plain `next` resumes existing work.
- `blocked_scope_replacement_ready`: explain preservation of old task/run evidence, execute `replace-scope` only with explicit approval, then rerun `next` with the same `--entry`.
- `tasks_blocked`: the returned approval command records the answer and reopens only that task. Continue with `next`; if the answer changes product scope instead, leave it blocked and pass the replacement request through `--idea` or `--entry`.
- `relevant_verification_required`: run the returned relevant check; do not substitute a product-wide suite when only docs/metadata changed.
- `flat_execution_complete`: report completion and verification, explain there is no iteration to close, and stop.
