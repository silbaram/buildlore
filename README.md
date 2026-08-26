# BuildLore

[English](README.md) | [한국어](README.ko.md)

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

Each source repository owns its code and a portable source-selection manifest. A
separate BuildLore hub owns one knowledge repository checked out at `knowledge/` as
a Git submodule plus machine-local source bindings. In **Mode A**, one hub can bind
multiple independent source checkouts, while each isolated compiler workspace lives
under `knowledge/projects/<project-id>/`. The top-level `knowledge/` directory is
only the registry and Git boundary; it is never a compiler workspace.

`source` means an input selected from the code repository. `wiki` means the
sanitized, compiled knowledge artifact. A `project-id` is the stable isolation key
that binds those inputs and outputs.

## Install and run locally

- Node.js 24 or newer (Node.js 24 LTS is the reference runtime)
- npm 11, specifically the repository-declared `npm@11.19.0`
- Git, plus access to an existing knowledge repository

From a clean clone:

```sh
npm ci --ignore-scripts
npm run build
node dist/cli/bin.js --help
```

Run commands from the BuildLore hub root. The examples below use
`node dist/cli/bin.js`; replace it with `buildlore` when the package bin is linked or
installed.

The lockfile and every direct dependency use exact versions.
`llm-wiki-compiler@1.1.0` is consumed only through the replaceable `src/compiler`
package-root adapter; BuildLore does not fork it or import its internal modules.

## Quick start

### 1. Create the central hub

Assume BuildLore is installed in `/d` and the independent Git projects are checked
out at `/a`, `/b`, and `/c`. Run every BuildLore command from `/d`. Mode A keeps one
knowledge repository at `/d/knowledge`; that repository must already exist and be
accessible through the user's Git credential helper or SSH agent.

```sh
cd /d
node dist/cli/bin.js init \
  --knowledge-repo https://github.com/acme/example-knowledge.git \
  --branch main
node dist/cli/bin.js knowledge status
```

Initialization creates the hub-local `.buildlore/local-projects.json` registry. It is
Git-ignored because it contains machine-specific absolute checkout roots. Portable
project identities remain in the knowledge repository.

### 2. Declare documents in each source project

Each source project owns and commits `.buildlore/sources.json`. The hub reads only
the declared project-root-relative regular files. For example, `/a/.buildlore/sources.json`
can collect Markdown documentation and approved Plan2Agent planning documents:

```json
{
  "projectId": "a",
  "schemaVersion": "buildlore.sources.v1",
  "sourceRepository": "https://github.com/acme/a.git",
  "sources": [
    {
      "documentKind": "markdown",
      "id": "docs",
      "path": "docs",
      "pathType": "directory",
      "recursive": true
    },
    {
      "documentKind": "p2a-planning",
      "id": "planning",
      "path": ".plan2agent",
      "pathType": "directory",
      "recursive": true
    }
  ]
}
```

Create corresponding manifests in `/b` and `/c` with their own `projectId`,
repository identity, and selections. BuildLore does not crawl undeclared directories,
and planning-only selection does not read `.plan2agent/runs` or `run-index.json`.

This manifest has one canonical byte representation. Encode it as UTF-8 without a
BOM, indent JSON with two spaces, use LF line endings, and end it with exactly one
LF. Keep top-level fields in this order: `projectId`, `schemaVersion`,
`sourceRepository`, `sources`. A file declaration uses `documentKind`, `id`, `path`,
`pathType`; a directory declaration may add `recursive` last. Sort `sources` by its
unique ASCII `id`. BuildLore rejects a semantically equivalent file if its field
order, declaration order, indentation, or newline bytes are not canonical.

### 3. Register and bind projects from the hub

Every operation uses an explicit project ID; BuildLore never infers a default project.

```sh
node dist/cli/bin.js project add \
  --id a \
  --name "Project A" \
  --source-repo https://github.com/acme/a.git \
  --source-root /a
node dist/cli/bin.js project add \
  --id b \
  --source-repo https://github.com/acme/b.git \
  --source-root /b
node dist/cli/bin.js project add \
  --id c \
  --source-repo https://github.com/acme/c.git \
  --source-root /c
node dist/cli/bin.js project list
node dist/cli/bin.js project show --project a
```

This creates isolated compiler workspaces under `knowledge/projects/a/`, `b/`, and
`c/`. Repository locators may not contain embedded
credentials, query strings, fragments, custom remote helpers, or absolute personal
paths. The `--source-root` value is validated and stored only in the ignored local
registry; list, show, JSON output, errors, and knowledge files never expose it.

For a portable project created by an older BuildLore version, or after moving a
checkout, migrate only its local binding:

```sh
node dist/cli/bin.js project bind --project a --source-root /a
```

`project bind` validates the existing portable repository identity and the source
manifest. It never guesses a checkout and does not rewrite the source project.

### 4. Preview, synchronize, then compile explicitly

`sync` resolves the selected local binding, reads only that project's declared files,
sanitizes them, and writes approved canonical source documents into the matching
knowledge workspace. Preview the complete selection and security path before writing:

```sh
node dist/cli/bin.js sync --project a --dry-run
node dist/cli/bin.js sync --project a
node dist/cli/bin.js compile --project a
```

Synchronization never compiles, publishes, or contacts a provider. Compilation is a
separate explicit project-scoped operation. Neither command reads or changes project
B or C while project A is selected.

Source checkouts are read-only to BuildLore. Traversal, symlinks, non-regular files,
identity mismatches, size/count limits, drift, and suspected secrets fail closed
before persistence. Rejected values and absolute source roots are not echoed. The
sanitized source, wiki, and compiler state remain confined to
`/d/knowledge/projects/<project-id>/`.

### 5. Configure provider access when needed

Local project, sync, check, and lexical search commands need no model provider.
Compilation and query require one. Semantic or hybrid search and context use a
provider only when their requested path needs embeddings or model work.

Provider credentials stay in the process environment and must not be written to the
code or knowledge repository. For example, an OpenAI-compatible provider uses:

```sh
export LLMWIKI_PROVIDER=openai
export OPENAI_API_KEY=<value-from-your-secret-manager>
```

Provider access is also controlled by `projects/<project-id>/security-policy.json`
inside the knowledge repository (for this layout,
`knowledge/projects/example/security-policy.json`). A newly registered project is
fail-closed (`restricted` with no egress rules). Review the data classification and
explicitly allow only the capabilities and `public` or `internal` classifications that
may leave the machine. `restricted` data can never be authorized for egress.

For example, after confirming that every projected input is suitable for `internal`
provider processing, the reviewed policy can allow only the operations in use:

```json
{
  "schemaVersion": "buildlore.security-policy.v1",
  "projectId": "example",
  "defaultClassification": "internal",
  "classificationRules": [],
  "egressRules": [
    {
      "allowedClassifications": ["internal", "public"],
      "capability": "compile"
    },
    {
      "allowedClassifications": ["internal", "public"],
      "capability": "context"
    },
    {
      "allowedClassifications": ["internal", "public"],
      "capability": "query"
    },
    {
      "allowedClassifications": ["internal", "public"],
      "capability": "search"
    }
  ],
  "overrides": []
}
```

The policy uses the same canonical UTF-8, two-space indentation, LF, and exactly-one
final LF requirements as `sources.json`. Keep its top-level fields in this order:
`schemaVersion`, `projectId`, `defaultClassification`, `classificationRules`,
`egressRules`, `overrides`. Classification rules are sorted by `sourceKind` and then
the optional `sourceIdentitySha256`; egress rules are sorted by `capability`, with
`allowedClassifications` sorted as `internal`, then `public`. Overrides are sorted by
`sourceIdentitySha256`, `sourceRevisionOrContentSha256`, then `ruleId`. An override
uses optional `auditRef` first, followed by `reasonCode`, `ruleId`,
`sourceIdentitySha256`, and `sourceRevisionOrContentSha256`.

An override is not a wildcard. It applies only to an overridable rule for the exact
source identity and exact source revision/content digest. Changing the selected
bytes makes the old override stop matching. Never put the matched value or a secret
in an override or `auditRef`. Omit any egress rule that the project does not need.

### 6. Compile and verify the wiki

Review mode writes generated pages to the compiler candidate queue without changing
the live wiki. A normal compile writes live compiled output and incremental state.

```sh
node dist/cli/bin.js compile --project example --review
node dist/cli/bin.js compile --project example
node dist/cli/bin.js check --project example
```

For generation owned by the current Claude Code or Codex session, use the separate
provider-free plan/apply boundary:

```sh
node dist/cli/bin.js compile plan --project example --json
node dist/cli/bin.js compile apply \
  --project example \
  --page proposals/session-concept.json \
  --page proposals/session-decision.json \
  --json
```

`compile plan` returns sanitized source text, deterministic tasks and merge
candidates, exact original-file citation anchors, and a plan digest. BuildLore does
not save that plan or launch a Claude/Codex executable, agent SDK, background worker,
or child process. The current caller session may use its existing skills and
subagents to author canonical `buildlore.compile-proposal.v1` files. `compile apply`
regenerates the current plan, validates every proposal as one batch, scans generated
content again, and admits matching output only through the public SDK's untrusted OKF
import. The result is always a held review candidate; it never promotes or writes a
live page. The public JSON contracts are exported under `schemas/compile-*.schema.json`
and `schemas/session-compile-provenance.schema.json`.

Proposal files use the property order shown by the proposal schema, two-space JSON
indentation, LF line endings, and exactly one final LF. `proposalDigest` is
`sha256:` plus the lowercase SHA-256 of those canonical bytes after removing only
the `proposalDigest` property. `callerHarness.compatibilityDigest` hashes the same
canonical JSON representation of `{ contractDigest, kind, proposalSchemaVersion,
version }` in that exact order. The contract digest comes from the plan and the
proposal schema version is `buildlore.compile-proposal.v1`. A mismatch is rejected
before the public compiler SDK is called.

Default-profile `concept` and `query` proposals omit `profileFields`. Custom-profile
proposals use only their initial review state: `decision` requires `status: active`,
`failure` requires `failureClass` and `status: open`, and `verification` requires
`verificationKind`, one or more `evidenceRefs`, and `status: recorded`. The conditional
rules and field bounds are normative in `compile-proposal.schema.json`; later lifecycle
transitions remain review-owned and cannot be requested through `compile apply`.

The isolated project workspace contains flat sanitized sources under `sources/`,
generated pages under `wiki/`, compiler state under `.llmwiki/`, and the applied
language-neutral lifecycle profile.

## Read and retrieve knowledge

Lexical search is deterministic and works without credentials:

```sh
node dist/cli/bin.js search \
  --project example \
  --query "실패 원인" \
  --mode lexical
```

Semantic and hybrid search can use the configured embedding provider. If compatible
embedding state or provider access is unavailable, the result explicitly reports its
lexical fallback or recovery action instead of silently rebuilding the index.

```sh
node dist/cli/bin.js search --project example --query "authentication decision" --mode hybrid
node dist/cli/bin.js query --project example --question "Why was this design selected?"
node dist/cli/bin.js context --project example --prompt "Prepare an implementation plan"
```

`query` always requests `save: false`, but the upstream compiler still appends query
activity to the selected project's `log.md`. Context can explicitly fall back to a
local lexical path when embeddings or provider access are unavailable. Add `--json`
to any command to receive one deterministic
`buildlore.cli-envelope.v1` object suitable for automation.

## Publish knowledge through Git

Publication is deliberately split into reviewable operations. First obtain the full
source revision with `git rev-parse HEAD`, then plan and commit only the selected
project's allowed knowledge paths:

```sh
node dist/cli/bin.js publish plan \
  --project example \
  --source-revision <full-source-git-oid> \
  --json

node dist/cli/bin.js publish commit \
  --project example \
  --source-revision <same-full-source-git-oid> \
  --expect-plan <plan-digest-from-the-plan-result> \
  --json
```

Copy the returned knowledge revision into the explicit non-force push, then plan and
commit the parent repository's submodule pin:

```sh
node dist/cli/bin.js publish push \
  --project example \
  --knowledge-revision <full-knowledge-git-oid>

node dist/cli/bin.js knowledge pin plan \
  --knowledge-revision <same-full-knowledge-git-oid> \
  --iteration <iteration-id> \
  --intent iteration-close \
  --json

node dist/cli/bin.js knowledge pin commit \
  --knowledge-revision <same-full-knowledge-git-oid> \
  --iteration <same-iteration-id> \
  --intent iteration-close \
  --expect-plan <pin-plan-digest> \
  --json
```

Planning is mutation-free. Knowledge commit, remote push, and parent pin are separate
transactions; no command performs all three. The pin command creates only the local
parent commit and never pushes the code repository. Use `--registration` when the
reviewed publication includes the new project registry entry, and
`--include-policy-track` only when review candidates or other policy-tracked artifacts
must be included.

## Command summary

```text
init -> project add -> sync --dry-run -> sync -> compile -> check
                                         |                    |
                                         +-> compile plan -> current session -> compile apply -> review
                                         +-> search/query/context
                                         +-> publish plan -> commit -> push -> knowledge pin
```

Compatibility aliases remain available for `knowledge clone`, `knowledge init`,
`knowledge status`, and `project validate`.

Compiler operations accept only a registered `projectId`. Provider-backed compile,
full evaluation, search, query, and semantic context operations deny egress unless the
project security policy allows the exact capability and every input classification.
Context with `topChunks: 0` stays local and requires no provider permit.

The upstream SDK has no active cancellation, overall deadline, or progress callback,
so BuildLore does not claim those behaviors. A host may translate process signals
into the adapter's `AbortSignal`; the adapter itself installs no global handlers.

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
npm run eval:retrieval
```

`eval:retrieval` runs the frozen Korean/English/code-symbol corpus without network
or provider credentials. It emits a `buildlore.retrieval-eval.v1` report containing
Recall@5, MRR, selected strategy identity, recorded semantic fixture identity,
canonical input hashes, index bytes, and environment-qualified latency. Runtime
search uses the same versioned Unicode word plus Hangul bigram/trigram strategy.
Semantic and hybrid modes disclose embedding compatibility and fall back to local
lexical results with an explicit compile recovery action when the project marker is
missing or outdated.

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

P2A entry snapshots are local working knowledge under the Git-ignored
`plans/entries/` directory. On a fresh clone, initialize local harness state, create
a provenance-bound snapshot from the source issue, validate it, and enter through
that snapshot:

```sh
npm run p2a:init
p2a validate --entry plans/entries/github-issue-<n>.md
p2a next --entry plans/entries/github-issue-<n>.md
```

`p2a:init` stages `p2a init` outside the checkout and copies only its ignored local
state back. This avoids overwriting the P2A agent assets and `PLAN2AGENT.md` already
tracked by the repository. Before succeeding, it verifies every manifest-managed
asset SHA-256 and runs `p2a doctor`; reruns validate existing local state the same way.

Thereafter, use `p2a next` for the single state-based next action. `.plan2agent/` and
`plans/` are ignored local state; use Plan2Agent Memory, an explicit export, or the
separate knowledge repository to continue the same history in another environment.
See [PLAN2AGENT.md](PLAN2AGENT.md).

## Non-goals for v0.1

- A central database or mandatory API server
- Real-time collaborative editing
- Forking `llm-wiki-compiler`
- A language-specific knowledge contract
- Cross-project reads or writes

Working architecture decisions and their trade-offs may be kept under the local,
Git-ignored `plans/adr/` directory before being projected into the project knowledge
repository.
