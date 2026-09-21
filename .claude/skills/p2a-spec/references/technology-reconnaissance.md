# Technology and Reference Reconnaissance

Read only when a material implementation choice may be stale, externally versioned, or consequential.

Trigger a lightweight scan when the implementation depends on a library, framework, runtime, protocol, package, database, cloud service, or external API choice; when the user requests current recommendations; or when the choice affects architecture, security, cost, licensing, deployment, performance, compatibility, or maintenance.

Use primary sources first: official documentation, release notes, standards, registries, source repositories, and vendor documentation. Research is read-only. Do not install dependencies or treat popularity as sufficient evidence.

Compare viable options, explain trade-offs, recommend one only when evidence supports it, and cite inspected sources near the affected spec field. A choice that changes scope or major constraints stays draft as an `ND-n` decision.

## Reference reconnaissance data

Use `evidence` for source metadata and `reference_reconnaissance` for decision metadata:

- `triggers`: why the comparison was needed.
- `candidates`: `REF-n` items pointing to real evidence ids, with `selected`, `rejected`, `deferred`, `context`, or `open` decisions.
- `selected_patterns`: reusable patterns, affected spec fields, and rationale.
- `rejected_patterns`: patterns intentionally not reused and rationale.
- `open_questions`: unresolved reference trade-offs that block approval when material.

Feature Radar artifacts use the same model. Local Markdown/JSON files become `LOCAL-n`; material URLs become `WEB-n`. Recommendations begin as `context` until Gate B explicitly marks them selected, rejected, or deferred. Radar output is evidence, never approval by itself.

If a separate readable research note is needed for an active iteration, save `iterations/<iteration-id>/notes/<topic>.md` under the artifact root, with optional `<topic>/` attachments and relative links. Use lowercase kebab-case and an unused numeric suffix for another report. Keep source metadata in the canonical spec; do not duplicate it into additional summary JSON or create topic/date folders at the artifact root. Preserve CLI-provided Gate/Radar paths when no iteration exists.
