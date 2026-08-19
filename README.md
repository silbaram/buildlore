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
knowledge repository is checked out at `knowledge/` as a Git submodule of one code
repository, and each isolated compiler workspace lives under
`projects/<project-id>/`. The top-level `knowledge/` directory is only the registry
and Git boundary; it is never a compiler workspace.

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
node dist/cli/bin.js --help
```

The lockfile and every direct dependency use exact versions.
`llm-wiki-compiler@1.1.0` is consumed only through the replaceable `src/compiler`
package-root adapter; BuildLore does not fork it or import its internal modules.

## Mode A commands

Connect or restore one knowledge submodule and inspect its Git-native pin:

```sh
buildlore knowledge clone --repository <https-ssh-or-relative-local-locator> --branch main
buildlore knowledge init
buildlore knowledge status
```

Register and inspect an isolated project workspace:

```sh
buildlore project add \
  --project-id example \
  --display-name "Example" \
  --source-repository https://example.invalid/example.git
buildlore project list
buildlore project show --project-id example
buildlore project validate --project-id example
buildlore knowledge status --project-id example
```

Project commands require the `knowledge/` submodule to be initialized at the
superproject's pinned commit. `knowledge status` uses schema
`buildlore.status.v1` and reports `initialized`, `currentCommit`, `pinnedCommit`,
`pinState`, and, when selected, `projectId`, `workspacePath`, and compiler status.

New product commands return deterministic JSON. Repository locators may not contain
embedded credentials, query strings, fragments, custom remote helpers, or absolute
personal paths. Authentication remains the responsibility of the user's existing
Git credential helper or SSH agent.

`knowledge/manifest.json` uses `buildlore.knowledge.v1`; each project descriptor
uses `buildlore.project.v1`. Project paths are always `projects/<project-id>`, and
source Markdown is stored directly under `sources/` with the compiler-required
`title`, `source`, and `ingestedAt` frontmatter plus `buildlore.sourceKind`.

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

The current Mode A iteration snapshot is
[`docs/entries/github-issue-3.md`](docs/entries/github-issue-3.md). On a fresh clone,
initialize local harness state and enter through the snapshot:

```sh
npm run p2a:init
p2a next --entry docs/entries/github-issue-3.md
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
[ADR 0001](docs/adr/0001-foundation-and-boundaries.md) and
[ADR 0002](docs/adr/0002-mode-a-knowledge-workspaces.md).
