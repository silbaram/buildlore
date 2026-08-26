# Plan2Agent Project Harness

This repository owns its Plan2Agent planning and development loop in-place.

## Start or resume work

Use one state-based entry point whenever you begin or finish a Plan2Agent action:

- Terminal: `p2a next`
- Claude Code, Codex, or Gemini agent session: `/p2a-next`

The result provides one state-based next action and its reason. Continue a returned skill in the same agent session; review and approve a returned CLI or approval action before running it. After that action is complete, run `next` again. When implementation is complete, `iteration_review_or_close_required` returns structured `review` and `close` options. Review leaves the iteration open; when a finding requires code changes, use its returned remediation command to reopen the owning completed task, then run `next` to start a normal remediation run. A clean review returns to the same decision. Only an explicit close choice authorizes the nested close command and archives the iteration.

The project constitution remains at `.plan2agent/constitution.json`. Planning Gates A-C, iteration artifacts, execution runs, and proposal records remain under `.plan2agent/artifacts/<project>/` and `.plan2agent/proposals/`. Treat individual P2A CLI commands as references: use them only when `next` returns them.

## Storage policy

The generated `.plan2agent/` directory is local harness state and is ignored by git.
Keep application/source commits focused on product code, and persist P2A planning and run
knowledge through BuildLore's separate Git-backed knowledge repository when needed.
