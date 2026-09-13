---
name: p2a-task-breakdown
description: Use as the compatibility entry for task decomposition from a legacy flat Plan2Agent spec; active iterations use p2a-task-author.
---

# Plan2Agent Task Breakdown

This is a compatibility entry, not a second decomposition policy.

- With an active iteration, continue with `p2a-task-author --artifacts <root>` in this session. That owner obtains context, saves the draft, validates, and promotes it.
- For a legacy flat artifact root, validate `<root>/gate-b-spec/spec.json` with `p2a validate --spec <path>`. Require approved scope, no open decisions, and valid clarifying-question dispositions before authoring.
- Use the shared draft contract below for task shape and decomposition judgment. A read-only `p2a-task-graph` author may return the JSON; the foreground owner is responsible for persistence and validation.
- Save a new flat draft to `<root>/gate-c-task-graph/task-graph.draft.json` with `sourceSpec: "../gate-b-spec/spec.json"`. Run `p2a validate --task-graph <draft> --require-approved-spec <spec>`, then persist the validated content as `task-graph.json` only if no canonical graph already exists. Run `p2a next` to continue; do not call iteration-only promotion commands on a flat root.
- If a canonical graph exists, return through `p2a next` instead of replacing it. Preserve task and run history.
- When only an in-memory approved spec is supplied and no artifact persistence is requested, return complete graph JSON and identify that it has not been persisted or validated by the CLI.

Do not implement product code or change approved scope during decomposition. Read-only providers return proposed JSON to a write-capable foreground owner.

## Progressive reference routing

- Required, on-demand; stages: gate-c — `.agents/skills/p2a-task-author/references/draft-contract.md` — This compatibility entry is about to decompose an approved spec into a task graph.
