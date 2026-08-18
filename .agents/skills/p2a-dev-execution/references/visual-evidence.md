# Visual evidence loop

Read this reference only for `ui`/`mixed` work or an execution envelope with `visualContract`.

A task with `visualImpact` records only the screens and states implementation can affect. Keep the implementation run open while the owner renders those approved route/state/viewport cases, applies the `p2a-visual-experience` feedback classification, and corrects implementation drift. Return contract changes to Gate B; do not ask the user to approve each task-level result. This loop is non-gating and unrecorded and does not satisfy the iteration-level `confirm_ui` gate.

After all tasks covered by a required visual contract are done and integrated, run `p2a execute review --artifacts <artifact-root> --agent-tool <reviewer>`. The resulting `runKind: final_visual_review` run uses the canonical workspace, `isolation.mode: none`, no changed files, and the complete Gate B visual matrix. `reviewPasses.visual` controls only the additional independent reviewer: `on` always invokes it, `opt_in` invokes it only when explicitly requested, and `off` keeps the owner review. It never removes required owner render evidence.

Capture the actual application for every declared case at the exact viewport, save deterministic PNGs and the accessibility report under `visual-evidence/<iterationId>/<runId>/`, and compare them with the approved experience/prototype. The prototype is a comparison target, never implementation evidence.

Immediately before capture, run `p2a runs revision --run-id <runId> --artifacts <artifact-root>`. Save the `p2a.visual_review.v2` sidecar as `<runId>.visual-review.json` with the iteration id, source refs, workspace identity/revision, screenshot hashes/media/dimensions/URLs/timestamps, and the hash-bound `p2a.visual_accessibility_report.v1`. Finish requires an unchanged workspace, complete passing cases, passing accessibility, and `confirm_ui`, then seals `visualReviewEvidenceSha256`. A failed/blocked review reopens its remediation owner; a stale workspace requires a new review.

If a visual issue is discovered only after an implementation run finishes, reopen its owner with `p2a tasks todo <id> --reopen --note <reason>` before editing.
