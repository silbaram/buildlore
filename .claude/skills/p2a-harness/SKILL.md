---
name: p2a-harness
description: Use when turning a concise product document into a gated Plan2Agent scope, specification, and execution-ready iteration.
---

# Plan2Agent Harness

Turn a concise product idea or readable entry document into durable scope, specification, and execution-readiness artifacts. Agents propose and validate; humans approve product scope, material durable project-shape decisions, and the product/implementation specification.

## Inputs and resume rule

Accept either a readable file through `p2a next --entry <path>` or explicit idea text through `p2a next --idea "<text>"`. For a conversational request, pass the user's idea text to `--idea`; the CLI creates a stable provisional entry snapshot before Gate A. Chat history itself is never canonical evidence.

On resume, run `p2a next --json --contract v2` and follow its one action. Read the canonical inputs needed by that action; do not reconstruct project-state routing or repeat already-recorded approvals.

## Stage ownership

| Stage | Owner | Canonical result |
| --- | --- | --- |
| Entry and scope | `p2a-harness` | `p2a.intake.v1` |
| Material project shape | `p2a-harness` | `.plan2agent/constitution.json` only when separate approval is required |
| Product/implementation spec | `p2a-spec` | `spec.json` and optional views |
| Full current visual experience | `p2a-visual-experience` | experience contract and approved prototypes |
| Execution readiness | `p2a-next`, then dev execution or task breakdown | synthetic Direct/Planned item or Orchestrated graph |

## Progressive reference routing

The canonical conditions live in `.agents/context-routes.json`.

1. Required, on-demand; stages: gate-a, gate-shape, gate-b — `references/project-shape-and-approvals.md` — Gate A approval, a material Gate ② project-shape decision, or Gate B approval must be proposed or recorded.
2. Required, on-demand; stages: gate-a, gate-shape, gate-b — `references/artifact-persistence-and-evidence.md` — Canonical planning state is about to be persisted, projected to status, or handed off.
3. Required, conditional; stages: entry, gate-a, gate-b — `references/existing-documents.md` — The entry has a validated reference bundle, or the entry or active iteration points to an existing PRD, design, implementation plan, or approved Plan2Agent baseline.
4. Optional, conditional; stages: gate-a, gate-b — `references/buildlore-knowledge.md` — BuildLore is configured and committed project knowledge is relevant to Gate A, Gate B, or Orchestrated decomposition.

## Entry Document Confirmation Dialogue

Use this when `p2a next` reports `gate_what`. The validated entry may be a file or an `--idea` snapshot. Preserve any baseline-backed `active_planning` state supplied by the CLI.

1. Run `p2a validate --entry <path>`, read the entire primary document, and preserve its relative path, SHA-256, type, size, and preview in the command context. Inspect optional sibling `p2a-reference-bundle.json` metadata without preloading its referenced files. For a Feature Radar document, also inspect the sibling `handoff-manifest.md` for provenance.
2. Present one compact interpretation of what will be built, who it serves, the intended outcome, included and excluded scope, hard constraints, material assumptions, and any conflict with an existing baseline. The entry file is evidence, not the control plane; do not dump or rewrite it.
3. Ask only what cannot be inferred safely and would materially change scope. There is no fixed question count or conversation-turn limit; stop when scope is confirmable. Show plain-language questions; `CQ-n`/`ND-n` ids are internal bookkeeping, not user work. Do not add a workflow state machine, identifier inventory, or progress counter.
4. Present the revised scope and explicitly ask the user to confirm that interpretation. Corrections update the summary and repeat this confirmation step. Silence, document presence, or a broad request to develop is not approval.
5. When Feature Radar supplied recommendations, list every promoted candidate with exactly one `selected`, `rejected`, or `deferred` disposition and a short rationale. Those candidates remain unapproved until the user confirms the scope containing their dispositions.
6. After confirmation, persist `intake.json` and capture any required reference snapshot. Follow `references/project-shape-and-approvals.md` to record the exact quoted approval and provenance through the CLI.

If the user rejects the source document, stop and request a different path. Canonical state begins with the approved intake artifact, not with chat history or the source file alone. Preserve legacy fields as opaque compatibility data; do not generate or route workflow from them.

## Specification and execution handoff

Reuse an approved constitution unless the scope materially changes it. If none exists, repository conventions are advisory; only a hard prohibition or difficult-to-reverse architecture/stack choice requires separate Gate ② approval. Use the approval reference for recording or amending that decision.

Invoke `p2a-spec` with explicit JSON state and inspected evidence. Invoke the visual track only when Gate B selects full current design. Present the complete spec and implementation plan together, then use the approval reference to record the user's exact quote only after open decisions are empty and required visual evidence is approved.

After Gate B approval, run `p2a next --json --contract v2` and follow its one action. Approved Gate B without Gate C is a valid preparation state. Direct/Planned preparation is handled by `p2a-dev-execution`; only Orchestrated execution routes to task decomposition.

## Completion and boundaries

Validate authored artifacts before handoff. Record decisions through CLI append operations; never edit `decisions.jsonl` directly. Preserve canonical paths, hashes, quotes, and run lineage. Validators enforce contracts, not product decisions; never advance past blocked scope or a draft specification.

Report the understood outcome, any material decision still needed, and the recommended next action in product language. Keep resulting state ids, file paths, and exact commands internal unless the user requests details or troubleshooting. When blocked, explain the reason and the smallest user action needed to continue.
