---
name: p2a-harness
description: Use when turning a concise product document into a gated Plan2Agent scope, specification, and execution-ready iteration.
---

# Plan2Agent Harness

Turn a readable entry document into durable scope, project-shape, specification, and execution-readiness artifacts. Agents propose and validate; humans approve product scope, the durable constitution, and the product/implementation specification.

## Inputs and resume rule

Require a readable file passed through `p2a next --entry <path>` or an equivalent explicit reference. Never initialize from chat alone.

On resume, inspect canonical status, constitution, current spec, active iteration, Gate A/B, and Gate C when present. Continue from the earliest incomplete or invalid artifact. Approved Gate B without Gate C is a valid preparation state. Never rebuild later artifacts over an unapproved decision.

## Stage ownership

| Stage | Owner | Canonical result |
| --- | --- | --- |
| Entry and scope | `p2a-harness` | `p2a.intake.v1` |
| Project shape | `p2a-harness` | `.plan2agent/constitution.json` |
| Product/implementation spec | `p2a-spec` | `spec.json` and optional views |
| Full current visual experience | `p2a-visual-experience` | experience contract and approved prototypes |
| Execution readiness | `p2a-next`, then dev execution or task breakdown | synthetic Direct/Planned item or Orchestrated graph |

After Gate B approval, run `p2a next --json` and follow its one action. Direct/Planned preparation is handled by `p2a-dev-execution`; only Orchestrated execution routes to task decomposition.

## Progressive reference routing

The canonical conditions live in `.agents/context-routes.json`.

1. Required, on-demand; stages: gate-a, gate-shape, gate-b — `references/project-shape-and-approvals.md` — Gate A approval, Gate ② project shape, or Gate B approval must be proposed or recorded.
2. Required, on-demand; stages: gate-a, gate-shape, gate-b — `references/artifact-persistence-and-evidence.md` — Canonical planning state is about to be persisted, projected to status, or handed off.
3. Required, conditional; stages: entry, gate-a, gate-b — `references/existing-documents.md` — The entry has a validated reference bundle, or the entry or active iteration points to an existing PRD, design, implementation plan, or approved Plan2Agent baseline.
4. Optional, conditional; stages: gate-a, gate-b — `references/memory-recall.md` — Planning Memory is configured and a recall report is relevant to Gate A, Gate B, or Orchestrated decomposition.

## Entry Document Confirmation Dialogue

Use this only when `p2a next` reports `gate_what` with a validated `--entry` document and no canonical planning artifacts. If the document and canonical planning artifacts coexist, compare the document metadata with recorded evidence and resume the earliest affected stage instead of restarting.

1. Run `p2a validate --entry <path>`, read the entire primary document, and preserve its relative path, SHA-256, type, size, and preview in the command context. Inspect optional sibling `p2a-reference-bundle.json` metadata without preloading its referenced files. For a Feature Radar document, also inspect the sibling `handoff-manifest.md` for provenance.
2. Present one compact interpretation of what will be built, who it serves, the intended outcome, included and excluded scope, hard constraints, material assumptions, and any conflict with an existing baseline. The entry file is evidence, not the control plane; do not dump or rewrite it.
3. Ask only for information or decisions that cannot be inferred safely and would materially change the scope. There is no fixed question count or conversation-turn limit. Stop asking as soon as the scope is confirmable, and do not introduce a replacement workflow state machine, mandatory identifier inventory, or progress counter.
4. Present the revised scope and explicitly ask the user to confirm that interpretation. Corrections update the summary and repeat this confirmation step. Silence, document presence, or a broad request to develop is not approval.
5. When Feature Radar supplied recommendations, list every promoted candidate with exactly one `selected`, `rejected`, or `deferred` disposition and a short rationale. Those candidates remain unapproved until the user confirms the scope containing their dispositions.
6. After confirmation, persist `intake.json` and create any reference snapshot with the canonical command in `references/existing-documents.md`. Run `p2a decide --quote "<exact user utterance>" --entry <entry-path> --artifacts <artifact-root>` so entry provenance and approval bindings are verified together. Then establish or reuse Gate ② before Gate B.

If the user rejects the source document, stop and request a different path. Canonical state begins with the approved intake artifact, not with chat history or the source file alone. Preserve legacy fields as opaque compatibility data; do not generate or route workflow from them.

## Core procedure

1. Validate and interpret the entry through the confirmation dialogue.
2. Persist the confirmed intake and record exact quoted scope approval.
3. Establish or reuse the approved project constitution.
4. Invoke `p2a-spec` with explicit JSON state and inspected evidence. Invoke the visual track only when Gate B selects full current design.
5. Present the complete spec and implementation plan and record exact quoted approval only after open decisions are empty.
6. Validate canonical artifacts, then run `p2a next --json`. Do not create a detailed graph unconditionally.

The scope artifact records the confirmed idea, summary, facts, assumptions, genuinely necessary questions/decisions, baseline context, evidence, status, and approval audit. Existing legacy intake fields remain readable but never drive new workflow state.

## Memory and existing documents

Planning Memory is advisory and never substitutes for approval. Consume only relevant reports and record actual query, mode, fallback, and source. Provider automatic memory may help session continuity but cannot replace canonical artifacts or portable P2A Memory.

Existing documents are evidence. Validate canonical baselines and hashes, distinguish facts from assumptions, preserve unresolved decisions, and avoid duplicating an approved iteration merely to change prose.

## Completion and boundaries

Before execution handoff, validate entry confirmation, Gate ② state, constitution prohibitions, scope/spec approval audits, required visual evidence, current hashes, and the single action returned by `p2a next`.

- Never infer approval from silence or recommendation.
- Record decisions through CLI append operations; never edit `decisions.jsonl` directly.
- Never advance past blocked scope or a draft specification.
- Reuse approved constitution unless scope materially changes it.
- Treat validators as enforcement, not product-decision authors.
- Preserve canonical paths, hashes, quotes, and run lineage.
- Prefer one state-based next action over a menu.

Report the resulting state, written/validated files, recorded approval when any, and the single next command or skill. When blocked, report the earliest failed contract and smallest user action.
