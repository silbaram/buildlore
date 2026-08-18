# Existing Graph Replacement and Promotion

Read when a canonical graph already exists or a draft is ready to validate and promote.

## Existing task state

If `existing_tasks.active` is non-empty, do not author an incremental-only draft: the context contains summaries, not complete canonical task bodies.

- When every canonical task remains `todo`, use `p2a iteration diff-tasks --force` as the authoritative complete-replacement check. It generates a complete draft only when no run history exists.
- Review the complete result and promote with explicit `--replace-existing`.
- If any task is `in_progress`, `done`, or `blocked`, or any run history exists even after reopening a task, do not replace the graph. Open a new feature iteration or use maintenance work.
- `existing_tasks.maintenance` is context only; do not merge maintenance pilot work into the feature graph.

Do not infer replacement safety from bounded recent-change summaries.

## Validate and promote

Validate the draft:

```bash
p2a iteration validate --artifacts <root> --stage gate-c-draft
```

After validation passes:

```bash
p2a iteration promote-tasks --artifacts <root>
```

`promote-tasks` writes provenance to `task-graph.draft.meta.json` and creates canonical `task-graph.json`. Never write the canonical graph directly.

The task-author subagent is read-only. The owner may write only the draft and run the scoped validation/promotion commands. Neither role changes application code or dependencies during Gate C authoring.
