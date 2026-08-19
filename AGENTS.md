# Repository agent guide

## Start through Plan2Agent

For new issue work, store a provenance-bound snapshot under `docs/entries/`, then
run `p2a next --entry <snapshot-path>`. To resume existing work, run `p2a next` and
perform only the single action it returns. On a fresh clone, first run
`npm run p2a:init`. The repository bootstrap stages `p2a init` separately so it
does not overwrite tracked agent instructions. It must fail closed when any
manifest-managed asset path, file type, or SHA-256 does not match.

`.plan2agent/` is ignored local execution state. Transfer it only through
Plan2Agent Memory or an explicit export; do not commit it with product changes.

## Required validation

Run all of the following before reporting implementation complete:

```sh
npm run build
npm test
npm run lint
npm run typecheck
p2a doctor --target . --dev
```

For entry snapshots, also run `p2a validate --entry <snapshot-path>`.

## Product invariants

- BuildLore is local-first and Git-backed. Product behavior must not require a
  central database, API server, or always-on process.
- Mode A binds one code repository to one knowledge repository checked out as a
  Git submodule. Isolate content under `projects/<project-id>/`; reject cross-project
  reads and writes.
- Keep knowledge formats and contracts language-neutral. Node.js and TypeScript are
  the v0.1 reference implementation, not a permanent format constraint.
- Preserve the `projector -> sanitizer -> compiler -> knowledge/retrieval` boundary.
  Sanitization must happen before external compilation or persistence.
- Treat suspected secrets as a hard failure. Do not echo source values in errors,
  logs, fixtures, or generated output.
- Do not fork `llm-wiki-compiler`. Introduce it only as an exact-pinned dependency
  behind a replaceable adapter in `src/compiler`.
- Keep direct dependencies exact-pinned and update `package-lock.json` with
  `npm@11.19.0`.

Do not add server infrastructure, real-time collaboration, language-specific wiki
schemas, or cross-project behavior without returning to the relevant P2A Gate.
