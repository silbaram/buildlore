# Completeness authoring

Use this only for a run whose purpose selects completeness authoring. Consult the installed `buildlore/schemas/project-knowledge-completeness.schema.json` and `buildlore/schemas/project-knowledge-workflow.schema.json` for input shapes.

- Read `compile hierarchy status --project <id> --run <id> --role <role> --json`. Roles are `author`, `completeness-reviewer` and `source-reviewer`; show each reviewer only its role view.
- Every `compile hierarchy completeness <action>` write takes `--project`, `--run`, `--input` and `--expect-stage` copied from that role's current `stageViewDigest`.
- Commit the blind reviewer's `shadow` inventory before the author's `inventory`. An independent `inventory-review` accepts or identifies missing items; use `reconcile` only when requested by the actual stage. Preserve all review dispositions.
- Submit prose and its exact inventory-to-claim mapping through `submit`. Then obtain `review` from the completeness reviewer and `source-review` from the source reviewer. Coverage alone is not source support or approval.
- If correction is admitted, `correct` uses the fixed accepted inventory and the returned correction binding. Do not silently replace the inventory or erase earlier review rounds. When the workflow disallows another correction, report the terminal failure.
- `compile hierarchy finalize` uses the final review input and returned review/stage binding appropriate to the run. Read the emitted status before choosing flags; older non-completeness runs use different schemas and must retain their original protocol.
- A finalized completeness result still needs explicit human approval and activation. Never treat passed coverage as permission to activate or publish.
