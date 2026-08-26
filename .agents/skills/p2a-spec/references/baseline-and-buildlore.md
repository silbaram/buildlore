# Baseline and BuildLore Knowledge

Read when `intake_json.baseline_context`, a prior `spec_json`, or relevant committed BuildLore knowledge is present.

## Baseline

Treat the validated baseline as inherited product scope, not optional background. Preserve its constraints unless the current Gate A decision explicitly supersedes them. Trace each selected baseline field to its source and keep unresolved conflicts visible.

## Prior specification

Reuse prior spec content only when its source hash and approval binding still match the active baseline. A stale draft is evidence, not authority.

## BuildLore knowledge

BuildLore retrieval is advisory. Consume only project-scoped results whose query, source reference, knowledge revision, and evidence remain relevant. Record requested/effective search mode, fallback, and actual source in `LOCAL-n` evidence when BuildLore affects the spec.

Retrieved knowledge remains context until the spec selects or rejects it. Preserve materially relevant failed or blocked history for Gate C decomposition and mitigation. Disabled, unavailable, empty, fallback, or irrelevant retrieval does not block Gate B.

Provider automatic memory may retain incidental session preferences, but it cannot replace approved Gate artifacts, repository evidence, or committed BuildLore knowledge. When they conflict, canonical artifacts and inspected repository evidence win.
