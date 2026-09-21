# Artifact Persistence and Evidence

Read when writing or handing off canonical planning state.

## Explicit state passing

Pass JSON, not hidden conversation state. Include project/iteration ids, any approved constitution or advisory repository-convention evidence, validated decision ledger, artifact root and paths, entry evidence and intake, baseline/spec hashes, approval audits, any inspected BuildLore source references, and the visual contract when applicable.

Downstream stages validate every incoming path and hash. Missing, outside-root, stale, or inconsistent references stop that stage.

## Canonical locations

```text
.plan2agent/constitution.json       # optional unless a material Gate ② decision exists
<artifact-root>/
├── status.md
├── current-spec.json
├── iterations/<iteration-id>/
│   ├── iteration.json
│   ├── gate-a-intake/{intake.json,intake.md}
│   ├── gate-b-spec/{spec.json,product-spec.md,implementation-plan.md}
│   └── gate-c-task-graph/{task-graph.json,task-graph.md}
└── runs/
```

Persist atomically where supported and validate JSON immediately. Do not promote by renaming an unvalidated draft. Preserve task/run lineage when replacing graphs; after execution begins, use a new iteration or maintenance lane.

For greenfield co-located work, approve scope/spec, follow `p2a next`, create the selected Gate C record, then run `p2a iteration init`. Do not configure a transient root-level graph.

## Supplementary files

Keep CLI-provided paths and existing IDs. Omit `--iteration-id` on open/replace-scope for the short `iter-0001` sequence; do not rename history or append `-next` yourself.

When a supplementary report is needed without a run, use `iterations/<iteration-id>/notes/<topic>.md` and optional `<topic>/` attachments. With a run, use `evidence/<iteration-id>/<run-id>/report.md`, with optional `logs/` and `attachments/`. Paths are relative to the artifact root; maintenance uses `maintenance` as its iteration ID. Without an iteration, retain the existing Gate/Radar paths. Do not create an iteration or run merely to store a report.

Use lowercase kebab-case topic names and relative evidence links. Preserve referenced evidence; use an unused numeric suffix for another attempt. Do not add topic/date folders at the artifact root, duplicate final/latest summaries, or empty report scaffolds. Keep source copies and installed dependencies in task-owned temporary directories, not artifacts.

## Status projection

`status.md` is readable projection, not approval authority. Generate it from canonical artifacts with a literal `Progress:` line, active iteration, next action, Gate states, planning validation, and numbered sections for understanding, decisions, specification, tasks, and readiness.

## Evidence ids

- `USER-n`: user documents or decisions
- `LOCAL-n`: inspected repository files, commands, or BuildLore retrieval results
- `WEB-n`: inspected current web evidence

Each item records what it supported. Web evidence has an HTTP(S) URL; local facts identify a real path or command. Never cite uninspected material. Feature Radar remains candidate evidence until Gate A/B records its disposition.
