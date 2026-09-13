# Gate C Draft Contract

Read before authoring a new task graph draft.

For an active iteration, run:

```bash
p2a iteration context --artifacts <root>
```

Use the `p2a.task_context.v2` fields: `project_id`, `effective_spec`, `existing_tasks`, `spec_field_changes`, `idea`, `active_iteration`, and `code_signals`. Real code signals prevent duplicate or already-completed work. The legacy flat `p2a-task-breakdown` entry supplies an approved spec instead; its owner handles flat paths and persistence without inventing iteration context.

The author returns complete JSON without writing. For an active iteration, the owner may persist only:

```text
iterations/<active_iteration>/gate-c-task-graph/task-graph.draft.json
```

The draft conforms to `p2a.task_graph.v1` and contains the exact project id, `<active_iteration>-draft` version (or the supplied flat version), `../gate-b-spec/spec.json` source relative to the graph, and non-empty `tasks[]`.

Each newly authored task includes sequential `task-NNN` id, title, a one-sentence `intent`, description, `todo` status, same-graph dependencies, concrete acceptance criteria, target area, a short outcome-focused agent prompt, and at least one real `sourceSpecRefs` field. Write `intent` last, after the precise contract is complete, in the approved product spec's primary language as “who can do what when this task is done.” It is explanatory only: acceptance and completion always use `acceptanceCriteria`. Do not restate the full implementation recipe in the agent prompt.

For `full + current_iteration`, every task declares `workKind`. UI/mixed tasks include only lightweight `visualImpact.screenStates`; non-UI tasks omit it. Impact routes remediation and does not own final review cases.

## Decomposition judgment

- Prefer one cohesive vertical item when one owner can implement and verify it in one resumable run.
- Split only for a real dependency, separate write owner, useful verification/rollback boundary, or cross-session recovery value.
- Split by independently verifiable outcomes, not automatically by file, screen, API, data, and test layers.
- Merge tightly coupled work even across target areas.
- Each task's acceptance must be satisfiable from its scope plus declared completed dependencies, never from later or unready work.
- Include dependency auto-configuration needed by required checks in the same task or a completed prerequisite. Do not defer a required passing build or check to a later task.
- Keep graphs acyclic and dependencies inside the same draft.
- Do not create tasks absent from the approved effective spec.
- When `spec_field_changes` exists, focus on changed fields without losing necessary baseline context.

Use BuildLore-derived spec evidence only when materially relevant. Cite the selected evidence and applicable `decision:ND-n` in addition to a real spec field. Convert relevant failure evidence into mitigation or regression acceptance. Unavailable or irrelevant knowledge is not a blocker.

Product meaning changes return to a new feature iteration through Gates A-C; they are not smuggled into a task draft.
