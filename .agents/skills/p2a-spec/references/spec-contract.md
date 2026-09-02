# Gate B Specification Contract

Read before authoring or validating `spec_json`.

## Canonical output

Return `spec_json` conforming to `spec.schema.json`, `open_decisions`, and one `clarifying_question_disposition` for every intake `CQ-n`. Preserve intake evidence and add only inspected `WEB-n` or `LOCAL-n` sources. JSON is canonical; Markdown is a generated view.

When intake comes from persisted `intake.json`, set `source_intake` to its Gate A path and compute `source_intake_sha256` from its exact bytes. Recompute only when regenerating from a changed intake.

## Product fields

`spec_json.product` includes:

- `problem`
- `target_users`
- `goals`
- `must_preserve`
- `non_goals`
- `core_flows`
- `screens_or_interfaces`
- `data_model_draft`
- `external_integrations`
- `success_criteria`
- `constraints`

`spec_json.evidence` follows the harness evidence contract.

## Visual experience

New specs include `visual_experience` with `has_visual_interface`, `design_scope`, `design_timing`, and a concrete `rationale`.

- `full + current_iteration` requires `experience_spec_ref`, its exact SHA-256, and an explicitly approved visual experience.
- `reuse + current_iteration` requires `design_system_refs`.
- Function-first work may choose `minimal` or `full + deferred_iteration` when justified.

For `full + current_iteration`, invoke `p2a-visual-experience` and keep Gate B draft until its HTML prototype and experience contract are approved.

## Implementation fields

`spec_json.implementation` includes:

- `architecture`
- `interfaces`
- `data_flow`
- `dependencies`
- `edge_cases`
- `verification`

When an approved constitution exists, the implementation plan conforms to it. Validator prohibitions are hard failures, while review and advisory prohibitions remain judgment guidance. Without one, repository architecture, stack, and style conventions are advisory inputs. A material hard prohibition or difficult-to-reverse project-shape choice returns to focused Gate ② approval rather than being silently assumed.

## Clarifying-question disposition

Each intake question id appears exactly once with `id`, `status`, `rationale`, `affects`, and only the detail required by its status:

- `answered` → `resolved_by`
- `assumed` → `assumption`
- `deferred_non_goal` → `non_goal`
- `promoted_to_decision` → `promoted_decision_id`

Only `ND-n` ids belong in `open_decisions`. Promote an unresolved blocking `CQ-n` to `ND-n` and keep the spec draft. Map canonical answered, assumed, or not-applicable intake values directly instead of replacing them with generic assumptions.

Route every answered high-impact decision to the exact `product.*` or `implementation.*` fields it affects. Treat a legacy `interview` object as opaque compatibility data. Never inspect it for routing.

## Approval

- Gate A must be `ready_for_spec` with a valid approval audit.
- An approved constitution is required only when Gate A contains a material hard prohibition or difficult-to-reverse project-shape choice; otherwise its absence is valid.
- Keep `approval: draft` until every `CQ-n` is disposed, all promoted decisions are resolved, `open_decisions` is empty, and required visual approval exists.
- The authoring pass never fabricates approval fields. After explicit approval, the harness owner records the exact quote through `p2a decide`.
- Do not advance to task breakdown while the spec is draft.
