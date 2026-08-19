# Plan2Agent Project Harness

This repository owns its Plan2Agent planning and development loop in-place.

## Start or resume work

On a fresh clone, recreate local harness state first:

```sh
npm run p2a:init
p2a next --entry docs/entries/github-issue-2.md
```

The repository bootstrap runs `p2a init` in an isolated staging directory and
copies only ignored `.plan2agent/` state into the checkout. This preserves the
tracked provider assets and this repository-specific guide. It verifies all
manifest-managed asset hashes and runs doctor for both new and existing state.

`docs/entries/` contains immutable, URL- and SHA-256-bound source snapshots. Use a
new snapshot as the `--entry` whenever a GitHub issue begins a new P2A iteration.

Use one state-based entry point whenever you begin or finish a Plan2Agent action:

- Terminal: `p2a next`
- Claude Code, Codex, or Gemini agent session: `/p2a-next`

The result provides exactly one next action and its reason. Continue a returned skill in the same agent session; review and approve a returned CLI or approval action before running it. After that action is complete, run `next` again.

The project constitution remains at `.plan2agent/constitution.json`. Planning Gates A-C, iteration artifacts, execution runs, and proposal records remain under `.plan2agent/artifacts/<project>/` and `.plan2agent/proposals/`. Treat individual P2A CLI commands as references: use them only when `next` returns them.

## Storage policy

The generated `.plan2agent/` directory is local harness state and is ignored by git.
Keep application/source commits focused on product code, and persist P2A planning and run
history through Plan2Agent Memory or an explicit export when needed.
