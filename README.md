# BuildLore

BuildLore is local-first, Git-backed tooling for turning a code repository into a
reviewable development wiki. The v0.1 foundation is a reusable TypeScript CLI and a
set of explicit architecture boundaries; it does not require a database or a
long-running service.

## Core flow

1. A projector selects repository content for one `project-id`.
2. A sanitizer rejects secrets and unsafe source before compilation.
3. A compiler adapter produces language-neutral wiki artifacts.
4. Retrieval reads the committed knowledge files for local agent use.
5. Git review and history remain the source of collaboration and provenance.

The code repository owns source code and BuildLore configuration. The separate
knowledge repository owns generated and curated wiki content. In **Mode A**, one
knowledge repository is checked out as a Git submodule of one code repository, and
each isolated knowledge set lives under `projects/<project-id>/`. A projection must
never read from or write to another project directory.

`source` means an input selected from the code repository. `wiki` means the
sanitized, compiled knowledge artifact. A `project-id` is the stable isolation key
that binds those inputs and outputs.

## Requirements and setup

- Node.js 24 or newer (Node.js 24 LTS is the reference runtime)
- npm 11, specifically the repository-declared `npm@11.19.0`

From a clean clone:

```sh
npm ci --ignore-scripts
npm run build
node dist/cli/index.js --help
```

The lockfile and every direct development dependency use exact versions. There are
no runtime dependencies in Step 1. When `llm-wiki-compiler` is introduced, it must
be exact-pinned behind the replaceable `src/compiler` adapter; BuildLore does not
fork it.

## Development commands

```sh
npm run build
npm test
npm run lint
npm run typecheck
```

The initial module boundaries are:

- `src/cli`: command-line interface and process I/O
- `src/projector`: source selection and project isolation
- `src/sanitizer`: secret and unsafe-content rejection
- `src/compiler`: replaceable compiler integration
- `src/retrieval`: local knowledge lookup
- `src/knowledge`: language-neutral knowledge contracts
- `test/fixtures`: deterministic, non-secret test inputs

Sanitization is fail-closed: uncertain or secret-bearing input is rejected before
it can reach a compiler or knowledge repository. Credentials must never appear in
fixtures, generated output, logs, or CLI error reflection.

## Plan2Agent entry

The issue snapshot for this iteration is
[`docs/entries/github-issue-2.md`](docs/entries/github-issue-2.md). On a fresh clone,
initialize local harness state and enter through the snapshot:

```sh
npm run p2a:init
p2a next --entry docs/entries/github-issue-2.md
```

`p2a:init` stages `p2a init` outside the checkout and copies only its ignored local
state back. This avoids overwriting the P2A agent assets and `PLAN2AGENT.md` already
tracked by the repository. Before succeeding, it verifies every manifest-managed
asset SHA-256 and runs `p2a doctor`; reruns validate existing local state the same way.

Thereafter, use `p2a next` for the single state-based next action. `.plan2agent/` is
ignored local state; use Plan2Agent Memory or an explicit export to continue the
same history in another environment. See [PLAN2AGENT.md](PLAN2AGENT.md) and the
[entry snapshot rules](docs/entries/README.md).

## Non-goals for v0.1

- A central database or mandatory API server
- Real-time collaborative editing
- Forking `llm-wiki-compiler`
- A language-specific knowledge contract
- Cross-project reads or writes

Architecture decisions and their trade-offs are recorded in
[ADR 0001](docs/adr/0001-foundation-and-boundaries.md).
