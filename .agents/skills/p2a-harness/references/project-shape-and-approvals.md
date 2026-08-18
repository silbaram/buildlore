# Project Shape and Approval Recording

Read when Gate A is ready to record, a project constitution must be established/amended, or Gate B is ready for explicit approval.

## Gate A scope approval

Present problem/users, in-scope outcome, exclusions, assumptions, unresolved decisions, and evidence used. State that approval authorizes specification work. Preserve the exact user utterance and run:

```bash
p2a decide --quote "<exact user utterance>" --entry <entry-path> --artifacts <artifact-root>
```

This revalidates the original entry, requires a matching snapshot when its sibling reference bundle exists, appends `gate.what.approved`, and updates intake to `ready_for_spec` with an audit copy. Baseline-backed iteration intake and legacy approval-copy rebinding retain their entry-less compatibility path. Without explicit confirmation, keep it blocked and stop.

## Gate ② project constitution

Before the first Gate B spec, establish `.plan2agent/constitution.json`. Reuse an approved constitution across iterations unless scope materially changes architecture, foundational stack, a project-wide prohibition, or coding style.

Present a compact, reviewable proposal:

- up to 10 `ARCH-n` architecture rules with scope, rationale, and trade-off;
- up to 10 `STACK-n` choices with rationale and evidence for current external choices;
- up to 10 `NO-n` prohibitions with rationale and enforcement;
- one coding-style contract, importing substantive legacy style when present.

Use `advisory` by default, `review` for judgment, and `validator` only with concrete spec/task-graph targets and forbidden terms. Validate the draft, then after explicit approval record the exact quote through `p2a shape approve`. Validate the approved constitution and decision ledger before Gate B.

Legacy style-only projects remain compatible. `p2a shape migrate-style` creates an unapproved draft and never implies approval. Constitution amendments use a focused diff, remove the old audit from the draft, and require a new quoted approval.

## Technology boundary

Gate A owns product scope. Gate ② owns durable architecture, stack, prohibitions, and style. Gate B owns iteration-specific implementation inside those constraints. For a material current technology choice, inspect repository evidence and official sources, compare viable options, record the selected trade-off, and leave consequential uncertainty in `open_decisions`.

## Gate B approval

Present the complete product specification and implementation plan together, including consequential choices, trade-offs, open decisions, selected/rejected recommendations, and verification strategy. Approval requires no open decisions and any required selected visual prototype evidence.

After explicit approval, record the exact quote with `p2a decide`. Then run `p2a next --json`. Direct/Planned preparation creates a synthetic work item; only Orchestrated execution routes to task decomposition. Neither path adds a human Gate C approval.
