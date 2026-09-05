# Plan2Agent Project Harness

This repository owns its Plan2Agent planning and development loop in-place.

## Start or resume work

Use one state-based entry point whenever you begin or finish a Plan2Agent action:

- Terminal: `p2a next`
- Claude Code, Codex, or Gemini agent session: `/p2a-next`

The result provides one state-based next action and its reason. Continue a returned skill in the same agent session; review and approve a returned CLI or approval action before running it. After that action is complete, run `next` again. When implementation is complete, `iteration_review_or_close_required` returns structured `review`, `retrospective`, and `close` options. Product review leaves the iteration open; when a finding requires code changes, use its `p2a execute remediate` action to start a linked run for the owning completed task in the same open iteration. P2A retrospective reports bounded development-process signals or asks once about user-observed friction; after separate approval it writes one minimal report to the returned path. Proposal mining remains a different approval. Skipping retrospective writes nothing and never blocks close. Only an explicit close choice authorizes the nested close command and archives the iteration. When the final maintenance task finishes, `p2a execute finish --maintenance` prints the same review/retrospective/finish choices once without creating a maintenance close state.

The project constitution remains at `.plan2agent/constitution.json`. Planning Gates A-C, iteration artifacts, execution runs, and proposal records remain under `.plan2agent/artifacts/<project>/` and `.plan2agent/proposals/`. Treat individual P2A CLI commands as references: use them only when `next` returns them.

## Storage policy

The generated `.plan2agent/` directory is local harness state and is ignored by git.
Keep application/source commits focused on product code, and persist P2A planning and run
knowledge through BuildLore's separate Git-backed knowledge repository when needed.
