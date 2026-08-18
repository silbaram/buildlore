---
name: p2a-spec
description: Use when converting Plan2Agent intake output and user answers into product and implementation specs.
---

# Plan2Agent Spec

Create a development-ready product and implementation specification from approved intake. Product authorship belongs to `p2a-spec-author`; implementation planning belongs to `p2a-implementation-planner`. When subagents are unavailable, keep those responsibilities logically separate.

## Preconditions and inputs

- `intake_json` is `ready_for_spec` with a valid Gate A approval audit.
- A new project has an approved `.plan2agent/constitution.json`; a legacy project may use `.plan2agent/style.md` as compatibility guidance.
- High-impact user decisions, explicit constraints, and non-goals are present.
- Optional inputs include a validated baseline, prior draft spec, Feature Radar evidence, a validated entry reference bundle, and relevant Planning Memory reports.

Treat a legacy `interview` object as opaque compatibility data. Never inspect a legacy `interview` object to derive routing or block Gate B.

## Progressive reference routing

The canonical conditions live in `.agents/context-routes.json`.

1. Required, on-demand; stages: gate-b — `references/spec-contract.md` — A Gate B specification is about to be authored or validated.
2. Required, conditional; stages: gate-b — `references/technology-reconnaissance.md` — A material external technology or reusable implementation choice may be stale, current-version-sensitive, or consequential.
3. Required, conditional; stages: gate-b — `references/baseline-and-memory.md` — The intake carries a validated baseline, a prior spec is reused, or a relevant Planning Memory report exists.
4. Required, conditional; stages: gate-b — `references/entry-reference-bundle.md` — The validated entry has a p2a-reference-bundle.json with material evidence for Gate B.
5. Optional, conditional; stages: gate-b — `references/markdown-views.md` — A human-readable product or implementation view is requested or needed for review.

## Procedure

1. Validate the intake, approval, constitution/style fallback, evidence, and any baseline hashes.
2. Separate product decisions from implementation decisions and preserve every explicit non-goal.
3. Run conditional reconnaissance only when its trigger applies; do not invent technology selections from model memory.
4. Author a complete `p2a.spec.v1` object and dispose every intake `CQ-n` through the contract reference.
5. Classify `visual_experience`. Invoke `p2a-visual-experience` only for `full + current_iteration`.
6. When Gate A has `reference-bundle-snapshot.json`, author the matching `reference-bundle-usage.json` sidecar, including an empty inspected list when none of its references were opened.
7. Validate the draft against schema, constitution prohibitions, source hashes, evidence, provenance sidecars, and open-decision rules.
8. Optionally render Markdown from the validated JSON.
9. Present consequential choices, trade-offs, unresolved decisions, and verification strategy. Keep the authoring result draft; the harness owner records explicit approval.

## Output

Return:

- schema-valid `spec_json` as the source of truth;
- `open_decisions` containing only unresolved `ND-n` ids;
- exact `clarifying_question_disposition` coverage;
- evidence with stable ids and actual inspected locators;
- `p2a.reference_bundle_usage.v1` sidecar data when Gate A contains a reference snapshot;
- optional `reference_reconnaissance` when a comparison occurred;
- optional generated `product-spec.md` and `implementation-plan.md` views.

When intake is persisted, bind `source_intake` and the SHA-256 of its exact bytes. Never refresh a stale hash merely to make validation pass.

## Boundaries

- Do not start Gate B without approved Gate A scope and the required constitution state.
- Do not turn unknown required fields into silent assumptions; keep material uncertainty in `open_decisions` and `approval: draft`.
- Do not invent API providers, storage engines, frameworks, or external facts.
- Do not treat Feature Radar, Planning Memory, provider automatic memory, or prior prose as approval.
- Do not edit files, install dependencies, or run implementation commands in the authoring role.
- Do not advance to task breakdown before explicit spec approval is recorded by the harness owner.
