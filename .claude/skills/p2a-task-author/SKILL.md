---
name: p2a-task-author
description: Use when authoring and validating a Gate C task graph draft from a Plan2Agent context bundle before canonical promotion.
---

# Plan2Agent Task Author

Author a reviewable Gate C draft from an approved active iteration. This skill proposes and validates a complete draft; only `promote-tasks` creates canonical `task-graph.json`.

## Preconditions and ownership

Use only when Gate B is approved, open decisions are empty, and Orchestrated execution actually benefits from a dependency/ownership graph.

Draft authorship belongs to the read-only `p2a-task-author` agent. The skill owner obtains context, reviews returned JSON, persists the draft, and runs validation/promotion. When subagents are unavailable, preserve the same author-versus-persistence boundary locally.

## Progressive reference routing

The canonical conditions live in `.agents/context-routes.json`.

1. Required, on-demand; stages: gate-c — `references/draft-contract.md` — A new Gate C task graph draft is about to be authored from validated task context.
2. Required, conditional; stages: gate-c — `references/replacement-and-promotion.md` — A canonical graph already exists, or a draft is ready for validation and promotion.

## Procedure

1. Run `p2a iteration context --artifacts <root>` and validate the returned `p2a.task_context.v1` bundle.
2. Inspect the effective spec, changed fields, code signals, active/maintenance task summaries, and relevant planning memory.
3. Choose cohesive, independently verifiable work boundaries. Task count is not a quality target.
4. Have the read-only author return one complete `p2a.task_graph.v1` draft.
5. Persist only `iterations/<active_iteration>/gate-c-task-graph/task-graph.draft.json`.
6. Validate `gate-c-draft`; promote only validator-clean content.

## Boundaries

- Every task is backed by actual effective-spec fields and has concrete acceptance criteria.
- Do not create product scope, cross-iteration dependencies, or duplicate existing work.
- Do not replace an active graph after task or run history exists.
- Do not change application code, dependencies, approval artifacts, or canonical graph bytes directly.
- If the requested work changes product meaning, return it to a new feature iteration rather than encoding it as a task.

Return the draft path, validation outcome, promotion outcome when applicable, and any exact blocker.
