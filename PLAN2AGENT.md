# Plan2Agent Project Harness

This repository owns its Plan2Agent planning and development loop in-place.

## Start or resume work

Use one state-based entry point whenever you begin or finish a Plan2Agent action:

- Terminal: `p2a next`
- Claude Code, Codex, or Gemini agent session: `/p2a-next`

The result provides one state-based next action and its reason. Continue a returned skill in the same agent session and execute CLI actions within their returned approval boundary, reusing explicit approval for that same pending action. Run `next` after completion. The `iteration_review_or_close_required` result offers `review`, `retrospective`, and `close` separately: review is read-only unless fixes were requested; authorized findings use `p2a execute remediate` in the same open iteration. Retrospective can be summarized, written, or published according to the user's request, without repeated approval for that same outcome. For an explicit GitHub issue request, use `p2a proposals issue-preview --retrospective <project-relative-path>` then `p2a proposals publish-issue --retrospective <project-relative-path> --yes` from the target project; proposal mining is not required. Follow the closeout reference in `p2a-dev-execution` for details. Skipping retrospective never blocks close, and only an explicit close choice archives the iteration. Final maintenance completion offers the same optional review/retrospective choices without a new close state.

An optional project constitution lives at `.plan2agent/constitution.json`. Planning Gates A-C, iteration artifacts, execution runs, and proposal records remain under `.plan2agent/artifacts/<project>/` and `.plan2agent/proposals/`. Use `next` for state transitions and the owning skill's commands for explicit review or retrospective requests.

## Storage policy

The generated `.plan2agent/` directory is local harness state and is ignored by git.
Keep application/source commits focused on product code, and persist P2A planning and run
knowledge through BuildLore's separate Git-backed knowledge repository when needed.
