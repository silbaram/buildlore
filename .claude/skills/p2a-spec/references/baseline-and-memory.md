# Baseline and Planning Memory

Read when `intake_json.baseline_context`, prior `spec_json`, or a relevant Planning Memory report is present.

## Baseline reuse

- Validate the immutable baseline `spec_ref` and `spec_sha256` before reuse.
- Reuse an answer or disposition only when the current change does not affect its recorded scope.
- Preserve source intake/spec provenance in the explanation and evidence.
- Prefer a current confirmed override, but state the conflict and resolution without mutating the baseline.
- Build a complete baseline-shaped `p2a.spec.v1`; intake is scope evidence, not a patch language.
- Ask a new question only for changed or newly ambiguous scope.
- A Markdown review may show changed fields first, but canonical `spec.json` remains complete.

## Planning Memory

Planning Memory is advisory. Consume only reports whose project, scope, query, and evidence remain relevant. Record requested/effective search mode, fallback, and actual report reference in `LOCAL-n` evidence when Memory affects the spec.

Retrieved history remains context until the spec selects or rejects it. Preserve materially relevant failed/blocked history for Gate C decomposition and mitigation. Disabled, unavailable, empty, or irrelevant Memory does not block Gate B.

Provider automatic memory may retain incidental session preferences, but it cannot replace approved Gate artifacts, repository evidence, or portable P2A Memory. When they conflict, canonical artifacts and inspected repository evidence win.
