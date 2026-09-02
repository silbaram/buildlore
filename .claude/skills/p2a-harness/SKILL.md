---
name: p2a-harness
description: Use when turning a concise product document into a gated Plan2Agent scope, specification, and execution-ready iteration.
---

# Plan2Agent Harness

Turn a concise product idea or readable entry document into durable scope, specification, and execution-readiness artifacts. Agents propose and validate; humans approve product scope, material durable project-shape decisions, and the product/implementation specification.

## Inputs and resume rule

Accept either a readable file through `p2a next --entry <path>` or explicit idea text through `p2a next --idea "<text>"`. For a conversational request, pass the user's idea text to `--idea`; the CLI creates a stable provisional entry snapshot before Gate A. Chat history itself is never canonical evidence.

On resume, inspect canonical status, constitution, current spec, active iteration, Gate A/B, and Gate C when present. Continue from the earliest incomplete or invalid artifact. Approved Gate B without Gate C is a valid preparation state. Never rebuild later artifacts over an unapproved decision.

## Stage ownership

| Stage | Owner | Canonical result |
| --- | --- | --- |
| Entry and scope | `p2a-harness` | `p2a.intake.v1` |
| Material project shape | `p2a-harness` | `.plan2agent/constitution.json` only when separate approval is required |
| Product/implementation spec | `p2a-spec` | `spec.json` and optional views |
| Full current visual experience | `p2a-visual-experience` | experience contract and approved prototypes |
| Execution readiness | `p2a-next`, then dev execution or task breakdown | synthetic Direct/Planned item or Orchestrated graph |

After Gate B approval, run `p2a next --json --contract v2` and follow its one action. Direct/Planned preparation is handled by `p2a-dev-execution`; only Orchestrated execution routes to task decomposition.

## Progressive reference routing

The canonical conditions live in `.agents/context-routes.json`.

1. Required, on-demand; stages: gate-a, gate-shape, gate-b — `references/project-shape-and-approvals.md` — Gate A approval, a material Gate ② project-shape decision, or Gate B approval must be proposed or recorded.
2. Required, on-demand; stages: gate-a, gate-shape, gate-b — `references/artifact-persistence-and-evidence.md` — Canonical planning state is about to be persisted, projected to status, or handed off.
3. Required, conditional; stages: entry, gate-a, gate-b — `references/existing-documents.md` — The entry has a validated reference bundle, or the entry or active iteration points to an existing PRD, design, implementation plan, or approved Plan2Agent baseline.
4. Optional, conditional; stages: gate-a, gate-b — `references/buildlore-knowledge.md` — BuildLore is configured and committed project knowledge is relevant to Gate A, Gate B, or Orchestrated decomposition.

## Entry Document Confirmation Dialogue

Use this when `p2a next` reports `gate_what`. The validated entry may be a file or an `--idea` snapshot. Preserve any baseline-backed `active_planning` state; otherwise resume the earliest affected canonical stage.

1. Run `p2a validate --entry <path>`, read the entire primary document, and preserve its relative path, SHA-256, type, size, and preview in the command context. Inspect optional sibling `p2a-reference-bundle.json` metadata without preloading its referenced files. For a Feature Radar document, also inspect the sibling `handoff-manifest.md` for provenance.
2. Present one compact interpretation of what will be built, who it serves, the intended outcome, included and excluded scope, hard constraints, material assumptions, and any conflict with an existing baseline. The entry file is evidence, not the control plane; do not dump or rewrite it.
3. Ask only what cannot be inferred safely and would materially change scope. There is no fixed question count or conversation-turn limit; stop when scope is confirmable. Show plain-language questions; `CQ-n`/`ND-n` ids are internal bookkeeping, not user work. Do not add a workflow state machine, identifier inventory, or progress counter.
4. Present the revised scope and explicitly ask the user to confirm that interpretation. Corrections update the summary and repeat this confirmation step. Silence, document presence, or a broad request to develop is not approval.
5. When Feature Radar supplied recommendations, list every promoted candidate with exactly one `selected`, `rejected`, or `deferred` disposition and a short rationale. Those candidates remain unapproved until the user confirms the scope containing their dispositions.
6. After confirmation, persist `intake.json`, capture any reference snapshot, then bind provenance and approval with `p2a decide --quote "<exact user utterance>" --entry <entry-path> --artifacts <artifact-root>`. Reuse an approved constitution. Create Gate ② only for a hard prohibition or difficult-to-reverse architecture/stack choice; otherwise use repository conventions as advisory Gate B input.

If the user rejects the source document, stop and request a different path. Canonical state begins with the approved intake artifact, not with chat history or the source file alone. Preserve legacy fields as opaque compatibility data; do not generate or route workflow from them.

## Core procedure

1. Validate and interpret the entry through the confirmation dialogue.
2. Persist the confirmed intake and record exact quoted scope approval.
3. Reuse an approved constitution. If none exists, inspect repository evidence for advisory conventions and continue unless a hard prohibition or consequential architecture/stack decision requires a separately approved constitution.
4. Invoke `p2a-spec` with explicit JSON state and inspected evidence. Invoke the visual track only when Gate B selects full current design.
5. Present the complete spec and implementation plan and record exact quoted approval only after open decisions are empty.
6. Validate canonical artifacts, then run `p2a next --json --contract v2`. Do not create a detailed graph unconditionally.

The scope artifact records the confirmed idea, summary, facts, assumptions, genuinely necessary questions/decisions, baseline context, evidence, status, and approval audit. Existing legacy intake fields remain readable but never drive new workflow state.

## BuildLore knowledge and existing documents

BuildLore retrieval is advisory and never substitutes for approval. Consume only relevant project-scoped results and record the actual query, requested/effective mode, fallback, knowledge revision, and source. Provider automatic memory may help session continuity but cannot replace canonical artifacts, inspected repository evidence, or committed BuildLore knowledge.

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

Report the understood outcome, any material decision still needed, and the recommended next action in product language. Keep resulting state ids, file paths, and exact commands internal unless the user requests details or troubleshooting. When blocked, explain the reason and the smallest user action needed to continue.
