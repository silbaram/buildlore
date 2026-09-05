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

## Status projection

`status.md` is readable projection, not approval authority. Generate it from canonical artifacts with a literal `Progress:` line, active iteration, next action, Gate states, planning validation, and numbered sections for understanding, decisions, specification, tasks, and readiness.

## Evidence ids

- `USER-n`: user documents or decisions
- `LOCAL-n`: inspected repository files, commands, or BuildLore retrieval results
- `WEB-n`: inspected current web evidence

Each item records what it supported. Web evidence has an HTTP(S) URL; local facts identify a real path or command. Never cite uninspected material. Feature Radar remains candidate evidence until Gate A/B records its disposition.
