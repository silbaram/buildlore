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
not save that plan or launch a Claude/Codex executable, agent SDK, background agent,
or agent/provider child process. The current caller session may use its existing skills and
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

#### Recommended hierarchical CLI workflow

The CLI is the recommended product workflow when the current Codex or Claude session
authors a hierarchical Wiki. Every handoff path is relative to the BuildLore hub, and
every digest argument must be copied exactly from the preceding command result.

```sh
# Refresh the sanitized project corpus, then create and inspect a durable local run.
node dist/cli/bin.js sync --project example
node dist/cli/bin.js compile hierarchy start \
  --project example \
  --purpose handoffs/wiki-purpose.json \
  --json
node dist/cli/bin.js compile hierarchy status \
  --project example \
  --run run-<64-lowercase-hex> \
  --json

# Give the returned exchange to the already-running agent session, then submit its JSON.
node dist/cli/bin.js compile hierarchy submit \
  --project example \
  --run run-<64-lowercase-hex> \
  --input handoffs/page-submission.json \
  --expect-exchange sha256:<exchange-digest> \
  --json

# A hard page-quality failure keeps the run alive. Correct only that page with the
# new exchange returned by status; at most three page-local resubmissions are allowed.
node dist/cli/bin.js compile hierarchy resubmit \
  --project example \
  --run run-<64-lowercase-hex> \
  --page page-<64-lowercase-hex> \
  --input handoffs/corrected-page-submission.json \
  --expect-exchange sha256:<new-exchange-digest> \
  --json

# Explicitly review child synthesis before reviewing the combined content diff and quality.
node dist/cli/bin.js compile hierarchy child-review \
  --project example \
  --run run-<64-lowercase-hex> \
  --input handoffs/child-review.json \
  --expect-review sha256:<child-review-digest> \
  --json
node dist/cli/bin.js compile hierarchy review \
  --project example \
  --run run-<64-lowercase-hex> \
  --json

# Finalize the reviewed surface, then record a separate explicit human approval.
node dist/cli/bin.js compile hierarchy finalize \
  --project example \
  --run run-<64-lowercase-hex> \
  --input handoffs/final-review.json \
  --expect-review sha256:<integrated-review-digest> \
  --json
node dist/cli/bin.js compile hierarchy approve \
  --project example \
  --run run-<64-lowercase-hex> \
  --expect-ledger sha256:<ledger-digest> \
  --confirm-approval \
  --json

# Approval does not activate. Use the bundle path returned by approve and present its digest.
node dist/cli/bin.js compile activate \
  --project example \
  --input .buildlore/hierarchy-runs/example/run-<64-lowercase-hex>/approved-wiki.json \
  --confirm-approval sha256:<approval-digest> \
  --json
node dist/cli/bin.js compile hierarchy status \
  --project example \
  --run run-<64-lowercase-hex> \
  --json

# A clean, active run is available through the normal Wiki and retrieval commands.
node dist/cli/bin.js wiki list --project example --json
node dist/cli/bin.js wiki curate --project example --json
node dist/cli/bin.js wiki read --project example --page page-<64-lowercase-hex> --json
node dist/cli/bin.js wiki citations --project example --page page-<64-lowercase-hex> --json
node dist/cli/bin.js search --project example --query "reviewed activation lineage" --mode graph
```

Each invocation may be a new OS process. BuildLore persists the project-confined run in
the Git-ignored local directory `.buildlore/hierarchy-runs/`, then deterministically
replays sanitized inputs, exchanges, generation receipts, reviews, and ledger bindings
before advancing it. The `review` result presents the combined content diff and
deterministic quality report; it does not accept the candidates. `approve` records the
explicit human decision but does not activate, publish Git, or silently accept anything.
An unfinished run created under an older hierarchy contract is never upgraded in place:
`status` reports `policy-outdated` with the `start-new-run` recovery action. Authority that
was already activated by the prior contract remains readable and can be rematerialized.

BuildLore never launches Codex, Claude, a model provider, an agent SDK, or an
agent/provider child process for this workflow. It never authors proposals, auto-accepts
reviews, activates implicitly,
or auto-publishes Git. The already-running caller session owns proposal authoring and
passes only the declared JSON handoffs back to BuildLore.

#### Library API

The optional `wikiTitle` in the purpose becomes the root Wiki title; when omitted, the
registered project display name is used. The product-level library boundary is
`createHierarchicalWorkflowService({ hubRoot, knowledgeRoot })`. Its
`start/status/submit/resubmit/childReview/review/finalize/approve` methods mirror the CLI while
persisting and replaying the ignored, project-confined local run. `approve` returns the
exact `activationBundlePath`, approval digest, and `activationArgs`; pass those to the
separate activation service when the human intends to make the reviewed generation
active. The lower-level compiler APIs keep outline, evidence, semantic quality, run
lineage, and approval separate from model execution.

An agent host can connect the already-active session to hierarchical generation through
the importable `createCurrentSessionGenerationService({ knowledgeRoot })` API. Its
`prepare(...)` call returns one bounded, serializable exchange containing the writing
brief, sanitized evidence, reviewed child summaries, instructions, and the exact proposal
contract. Give only that exchange to the current agent, then pass its versioned
`buildlore.current-session-proposal-submission.v2` response to `session.submit(...)`.
Exchange v2 exposes the enforced rule codes and a required/optional section guide. A
submission must include every required section, may add at most eight unique optional
sections, and may give any section a human-readable `title`. Each substantive paragraph
must carry a citation or contain a declared grounded claim; claims, independent summaries,
and non-generic titles are checked with the shared semantic-token policy.
`prepare(...)` deliberately accepts only the original `EvidencePackV1` returned by
`createEvidencePack(...)` in the same process; do not JSON-round-trip the pack before
preparing the exchange. Reuse one service instance for the complete leaf-to-parent run so
its sanitizer-approved child proofs remain bound to parent synthesis. BuildLore verifies
the project, page, exchange, request, snapshot and live sanitizer-policy bindings, scans
the generated text again, computes claim/proposal digests itself, and returns only a
candidate plus a generation receipt. A later handoff can call
`verifyCurrentSessionGenerationResult(result, exchange, projectId)` after JSON
round-tripping to replay the closed proposal contract and verify the purpose, blueprint,
evidence-pack, snapshot, request, sanitizer-policy, proposal, and exchange bindings. The
same canonical scan digest is available without exposing the body through
`digestCurrentSessionProposalSecurityBody(proposal, projectId)`. The public JSON boundary
is `schemas/hierarchical-current-session.schema.json`.

`createIntegratedWikiReviewSurface(...)` combines only verified `{ exchange, result }`
handoffs with the actual outline, planning inventory, link reconciliation, deterministic
semantic-quality reports, exact citation anchors, and a section-level content diff. It
returns incomplete prefix runs as visible non-approvable review surfaces; duplicate,
swapped, or non-prefix generations fail closed. A null `baselineGenerationDigest` means
there is no prior baseline and requires an empty baseline proposal list. A non-null value
names the prior authoritative generation while the full baseline proposals are bound by
the surface digest. Approval replays that identity against the actual active state and
requires the baseline page/proposal set to match it exactly. Baseline-only pages retain
their full sanitized proposal for deletion review and prevent acceptance until a dedicated
removal decision exists.

This route does not launch a provider, agent SDK, executable, network client, or child
process from BuildLore. `buildloreInitiatedEgress: "none"` records that boundary; it does
not mean that sanitized evidence was hidden from the already-active agent session that
received the exchange. Review, quality approval, finalization, activation, and Git
publication remain separate steps. `finalizeCompileRun` now replays every generation
handoff and requires the exact receipt set, integrated review surface, accepted page
reviews, and reviewed child-summary set. Their canonical digests continue through the
integrity report, finalized ledger, ownership graph, human activation approval, active
state, and authoritative check. A self-rehashed receipt, review, approval, or stale
baseline cannot substitute for those original inputs.

`createHumanActivationApproval(...)` records an explicit local confirmation bound to the
finalized ledger, ownership graph, receipt/review digests, and previous active generation.
It does not claim to prove a cryptographic human identity, and it cannot be created for an
ineligible ledger. Activation requires the caller to present that exact approval digest
again before BuildLore reads live sources or changes the approved projection.

Activation remains explicit:

```sh
node dist/cli/bin.js compile activate \
  --project example \
  --confirm-approval sha256:<approval-digest> \
  --json
```

Activation validates the human approval, reviewed receipt lineage, prior active generation,
approved state, ownership, evidence and sanitizer identities. A missing, mismatched, or
stale confirmation preserves the previous projection. A successful activation also writes a
deterministic, Git-trackable human reading surface under
`knowledge/projects/<project-id>/wiki/buildlore-hierarchy/`: one `index.md`, one stable
`page-<64-lowercase-hex>.md` per active page, and `manifest.json`. The approved JSON remains
the only authority; direct Markdown edits are reported as materialization drift and are never
used as retrieval or semantic-index input. Activation does not call an LLM, embed content,
rebuild an index, commit/push Git, or pin the knowledge submodule.

If status reports `renderer-outdated` for an intact prior materialization, regenerate only
the derived Markdown from the already verified authority. This does not repeat generation,
review, approval, or semantic indexing and does not change the authority identity:

```sh
node dist/cli/bin.js compile activate --project example --rematerialize --json
```

## Read and retrieve knowledge

Lexical search is deterministic and works without credentials:

```sh
node dist/cli/bin.js search \
  --project example \
  --query "실패 원인" \
  --mode lexical
```

`wiki curate --project <project-id>` is also fully model-free. It reads only the clean,
active approved Wiki and returns bounded review suggestions for possible duplicates,
unsupported claims, broken links, and weak connections. Suggestion identities and
evidence locators are deterministic and path-free. The command never edits, merges,
approves, or deletes a page; a stored stale or invalid authority fails closed. Curate is
projection-scoped and does not independently rescan the source checkout. Run sync and the
compile authority check to discover source drift before a new explicit activation.

Graph search also works without a model. Semantic and hybrid search use only the
quality-approved hierarchical projection and the explicitly bound local model. Index status
reports the approved projection, Markdown materialization, and semantic generation separately.
Rebuild remains explicit; search never downloads a model or rebuilds an index implicitly.
Before switching the semantic active pointer, rebuild re-reads the authority, corpus generation,
sanitizer policy, chunker, and local embedding identity. A drifted build stays staged and the
previous healthy index remains active.

```sh
node dist/cli/bin.js index status --project example --json
node dist/cli/bin.js index rebuild --project example --json
node dist/cli/bin.js search --project example --query "related decisions" --mode graph
node dist/cli/bin.js search --project example --query "authentication decision" --mode hybrid --intent current
node dist/cli/bin.js search --project example --query "Gate B decision" --mode hybrid --intent historical
node dist/cli/bin.js query --project example --question "Why was this design selected?"
node dist/cli/bin.js context --project example --prompt "Prepare an implementation plan"
```

`--intent` accepts `auto` (the default), `current`, `historical`, or `neutral`.
Auto uses only bounded Gate, iteration/version, and historical markers; it does not call a
classifier. Retrieval result v3 reports the effective intent, base and adjusted scores,
bounded authority/lifecycle/evidence adjustments, diversification reason, and ranking-policy
digest for every hit. Missing legacy meaning metadata stays searchable as
`unknown/unknown/other`, receives no boost, and is reported as `legacy-default-neutral`.

Source adapters or manifests may declare `values.retrievalMeaning` with separate authority,
lifecycle, evidence kind, revision ordinal, topic/iteration groups, and supersession refs.
Malformed explicit metadata fails closed. Semantic index v2 embeds `semanticText`, which removes
closed-form renderer and machine-provenance noise while preserving raw page bodies and citation
locators for inspection. Rebuild this derived index explicitly after metadata or projection
policy changes.

`semantic` returns a structured failure for a missing, stale, or incompatible local
provider/index. Only `hybrid` may visibly exclude the semantic channel and continue
with lexical/graph results. A project without an activated hierarchical projection
keeps the legacy lexical reader as an explicitly partial compatibility path; it is not
treated as semantic-quality-approved content.

`context` reads the active approved hierarchical Wiki first. It returns the section's
semantic text together with structured page, section, source, and citation locators, and reports
any visible hybrid-to-local fallback. The legacy compiler context path is used only when an
approved projection is unavailable. `query` still requests `save: false`, but the upstream
compiler appends query activity to the selected project's `log.md`. Add `--json`
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
                                         +-> hierarchical quality approval -> compile activate -> index rebuild
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
