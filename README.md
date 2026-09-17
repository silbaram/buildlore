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

Each source repository owns its code and a portable source-selection manifest. In legacy Mode A, a
separate BuildLore hub owns one knowledge repository checked out at `knowledge/` as
a Git submodule plus machine-local source bindings. In **Mode A**, one hub can bind
multiple independent source checkouts, while each isolated compiler workspace lives
under `knowledge/projects/<project-id>/`. The top-level `knowledge/` directory is
only the registry and Git boundary; it is never a compiler workspace.

`source` means an input selected from the code repository. `wiki` means the
sanitized, compiled knowledge artifact. A `project-id` is the stable isolation key
that binds those inputs and outputs.

## Recommended: install locally in the knowledge repository

Use Node.js 24+, npm 11.19.0 and Git. Install the **distributed npm package into your knowledge Git checkout**, which can hold several projects. The checkout itself manages the Wiki; no separate hub or product source copy is needed.

The package is not published to the npm registry yet. Install a supplied release tarball as below. After publication, the install command can become `npm install buildlore`. Building a tarball from product source is a maintainer step described below.

```sh
git clone <knowledge-repository-URL> my-knowledge
cd my-knowledge
npm install --save-exact /path/to/buildlore-0.1.1-rc.1.tgz
node node_modules/buildlore/dist/cli/bin.js workspace init --json
```

Without a Git origin, supply an explicit portable `--knowledge-repo <repository-id>`. Initialization does not convert existing hubs or source checkouts.

```text
my-knowledge/
  package.json                  # version in Git
  package-lock.json             # version in Git; local tarball must also be delivered
  node_modules/                 # installed package; ignored by Git
  .buildlore/workspace.json      # portable workspace mode/identity
  .buildlore/local-projects.json # local source paths; ignored by Git
  manifest.json
  projects/<project-id>/
```

### Find the next setup step

From the knowledge checkout, run `node node_modules/buildlore/dist/cli/bin.js workspace guide --project my-project`. It inspects without writing and shows the next step, execution location and required inputs. Rerun after each step. Add `--json` for the `buildlore.workspace-guide.v1` contract. A project is never selected automatically, even when only one exists.

`ready` covers inspected local Wiki and connection state. AI client registration, AI quality and embeddings remain unchecked. `blocked` indicates damage or a path problem; restore trusted Git data instead of recreating approval records. Diagnose source connections with `doctor` or `connection status` from that source checkout.

### Register → create a Wiki → read through MCP

1. In the source repository, declare selected inputs in `.buildlore/sources.json`. Start with the following identity manifest; add document selections with the CLI after registration. Save the JSON with this key order, two-space indentation and a final newline. Use the same project ID and source repository when registering:

```json
{
  "projectId": "my-project",
  "schemaVersion": "buildlore.sources.v2",
  "sourceRepository": "https://example.org/team/my-project.git",
  "sources": []
}
```

2. Register and author from the **knowledge repository**:

```sh
node node_modules/buildlore/dist/cli/bin.js project add --id my-project --source-repo https://example.org/team/my-project.git --source-root /work/my-project --json
node node_modules/buildlore/dist/cli/bin.js source add --project my-project --id docs --kind markdown --path docs --recursive --json

```

New projects deny external compilation by default. Review classification and allowed capabilities in `projects/my-project/security-policy.json` using the security policy section below before authoring. Inspect selections and policy failures with `sync --dry-run`; never disable secret detection to bypass a failure.

```sh
node node_modules/buildlore/dist/cli/bin.js sync --project my-project --dry-run --json
node node_modules/buildlore/dist/cli/bin.js sync --project my-project --json
```

Use the packaged `skills/buildlore-authoring/SKILL.md` for authoring and `skills/buildlore-activation/SKILL.md` for approval/activation. Ask your AI to read `node_modules/buildlore/skills/…/SKILL.md`, or copy the skill into your client's **knowledge-workspace-local skill directory**. Global skill installation is optional. MCP reads require an explicitly approved and activated generation; writing a draft does not authorize approval.

3. Connect from each **source repository**, using the package installed in the knowledge repository:

```sh
cd /work/my-project
node /work/my-knowledge/node_modules/buildlore/dist/cli/bin.js connect --workspace /work/my-knowledge --project my-project --json
node /work/my-knowledge/node_modules/buildlore/dist/cli/bin.js client configure --client codex --project-dir /work/my-project --json
# Review the preview, then apply using its returned planDigest.
node /work/my-knowledge/node_modules/buildlore/dist/cli/bin.js client configure --client codex --project-dir /work/my-project --apply --expect-plan <planDigest> --json
```

The complete authoring workflow is verified on Linux. Native Windows path, connection and sync checks have been exercised, but authoring state storage fails with `HIERARCHICAL_WORKFLOW_RUN_WRITE_FAILED` because its existing file permission checks require POSIX modes. The complete Windows authoring workflow has not passed support validation. Use `node .../bin.js` on Windows with actual drive paths and quote paths containing spaces. MCP reads only the selected project's approved knowledge. No separate BuildLore installation is needed in each source project.

Commit workspace initialization and npm metadata (`.gitignore`, `.buildlore/workspace.json`, `package.json`, `package-lock.json`) separately before project publication. Root metadata changes deliberately block `publish`; it never selects npm files as Wiki content.

For an activated Wiki, publication derives lineage from verified approval records and includes the immutable history needed by a fresh clone. Model identities describe the declared authoring actors, not proof of a provider invocation; prompt identity binds the recorded authoring exchanges. Publishing approved text requires no embedding provider. A detached source HEAD is supported; the knowledge repository still needs a publication branch. Initialization reasserts effective ignore rules for local npm/run files and stops if those files are already tracked; it does not untrack user files.

Direct workspaces track knowledge commits, generations and approval history. They have no parent gitlink, so parent pin is `not_applicable` and `knowledge pin` is unsupported. This does not provide the legacy parent-commit pin guarantee. Existing `setup --hub`, `connect --hub`, submodule and pin workflows remain supported; migration is never automatic.

Developer verification: `npm run verify:installed-workspace` installs the tarball into a temporary knowledge repository and executes authoring, approval, activation, a publication commit and two-project MCP reads. On Linux it hides the product source and blocks writes/network for MCP. It uses deterministic protocol fixtures, not a paid AI quality evaluation.

### Restore on another PC or in a fresh clone

A local `.tgz` installation records a file path in npm metadata. A Git clone followed by `npm ci` is insufficient when that original tarball path is unavailable. **Deliver the same tarball separately**, then reinstall from its new location:

```sh
cd /new/my-knowledge
npm install --save-exact /new/downloads/buildlore-0.1.1-rc.1.tgz
node node_modules/buildlore/dist/cli/bin.js workspace guide --project my-project
node node_modules/buildlore/dist/cli/bin.js workspace init --json
node node_modules/buildlore/dist/cli/bin.js project bind --project my-project --source-root /new/my-project --json
cd /new/my-project
node /new/my-knowledge/node_modules/buildlore/dist/cli/bin.js connect --workspace /new/my-knowledge --project my-project --json
node /new/my-knowledge/node_modules/buildlore/dist/cli/bin.js doctor --json
```

Restore the source checkout and its `.buildlore/sources.json` too. The clone's Git origin must identify the knowledge repository recorded in the workspace. Rerunning `workspace init` prepares local folder permissions and binding storage that Git does not preserve; it retains existing Wiki and approval records. Repeat bind/connect for each project, and preview client configuration with the new paths before applying it. Review and commit changed npm metadata separately.

### Maintainers: local distribution, then npm preparation

1. With Node 24+ and **npm 11.19.0**, pass build/test/lint/typecheck and `npm run verify:installed-workspace`. Linux verification requires `bwrap`; its absence is reported as failure.
2. Use `npm pack --json --pack-destination <distribution-directory>` to inspect the tarball file list, size and integrity. Deliver `sha256sum <file.tgz>` with the identical archive. It contains runtime code, public schemas and authoring/activation skills; product source, tests, user knowledge and local state are excluded.
3. Keep `private: true` for now. Immediately before a future registry release, verify name availability, version, license, package contents and account permissions; change public-release settings only with separate publication approval. This workflow does not publish to npm.

Installed verification covers CLI registration, source selection, authoring, review, explicit test approval, activation and publication for two projects, then clone/reinstall and MCP search/read/isolation. It removes the original tarball and uses a separately delivered copy. Deterministic inputs test protocols, not actual AI quality or a real client conversation. Windows OS verification remains follow-up work.

Local archive behavior follows the official [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/) and [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/) commands.

## Product development and legacy hub usage


- Node.js 24 or newer (Node.js 24 LTS is the reference runtime)
- npm 11, specifically the repository-declared `npm@11.19.0`
- Git, plus access to an existing knowledge repository

For maintainers building the package from a product source checkout (users follow the local package installation above):

```sh
npm ci --ignore-scripts
npm run build
node dist/cli/bin.js --help
```

Run registration, collection, compilation and approval commands from the BuildLore hub root. The examples below use
`node dist/cli/bin.js`; replace it with `buildlore` when the package bin is linked or
installed.

The lockfile and every direct dependency use exact versions.
`llm-wiki-compiler@1.1.0` is consumed only through the replaceable `src/compiler`
package-root adapter; BuildLore does not fork it or import its internal modules.


### Install the package and read from source folders

The M1 reference environment is Linux x64, Node.js 24.19.0, npm 11.19.0 and Git 2.53.0.
Other operating systems have not been validated. The package remains `private: true`;
install a local tarball without publishing it to a registry.

```sh
# In the BuildLore development checkout, using npm@11.19.0
npm ci --ignore-scripts
npm run build
npm pack --pack-destination /tmp
npm install --prefix "$HOME/.local/buildlore" --omit=dev /tmp/buildlore-0.1.1-rc.1.tgz
export PATH="$HOME/.local/buildlore/node_modules/.bin:$PATH"

buildlore setup --hub /work/wiki-hub --knowledge-repo https://example.org/team/knowledge.git
cd /work/my-source
buildlore connect --hub /work/wiki-hub --project my-project
buildlore connection status --json
buildlore wiki list --json
buildlore search --query "design decision" --json
# Copy readContext.generation from list/search/memory
buildlore wiki read --page overview --expect-generation sha256:<64-hex-digits> --json
buildlore wiki memory --task "review design decisions" --progressive --json
```

`setup` initializes a separate empty hub or registers an existing matching hub. Register the
project in its knowledge repository before `connect`, using the hub workflow below. Connecting
without an approved Wiki is valid but reports `readable: false`. If the source has no Git origin,
pass `--source-repo <registered-locator>` at connection time. Additional clones and worktrees of
the same project each have their own local binding.

Connected reads resolve the project from the nearest Git worktree, including subdirectories.
An explicit `--project` must match. `read`, `citations` and `lookup` require
`--expect-generation`; `list`, `search` and `memory` accept it optionally. A changed generation
fails without content; obtain a new list or memory response before retrying. Connected reads use
approved project-knowledge or hierarchical output and lexical search. Hierarchical output supports
list/search/read/citations, but not memory, lookup or reader view. Hub JSON remains v1; connected
reads use `buildlore.cli-envelope.v2` with repository digest and generation in `readContext`.

Shared `.buildlore/connection.json` contains only a portable repository locator, its digest and
project ID. Absolute paths belong in PC-local `connections.json`: an absolute
`BUILDLORE_CONFIG_DIR` takes precedence over `$XDG_CONFIG_HOME/buildlore`, then
`$HOME/.config/buildlore`. Connections do not modify the writer's `local-projects.json` or source
`sources.json`. `disconnect` removes the local binding; add `--remove-shared` to remove the shared
connection too. Retry the same `connect` after an interrupted connection. Disconnect before
replacing a connection with a different identity.

`connection status` and `doctor` inspect approval, dirty state and pin health without repair.
Dirty state covers the connected project’s knowledge files, without opening other projects’ content.
Source revision comparison uses recorded Git HEAD metadata, not working-file equivalence.
Remote freshness is `not_checked`. Resolve pin errors through the existing hub `knowledge status`
and pin plan/commit workflow. Reads create no model, index or temporary files and need no network.
Read-only history validation uses repeated traversal to keep live memory bounded, so a cold read
of a long history may be slower. MCP client integration and automatic updates belong to later work.

For development validation, run `npm run verify:installed-read` with npm 11.19.0, `strace`,
`bwrap` and permission to create user namespaces. Missing tools fail the check. Installation uses
the network; subsequent reads run with read-only mounts and a separate network namespace.

### Optional local semantic-search runtime

A fresh tarball installation with `--omit=dev` excludes the local embedding runtime.
Wiki authoring through the current AI session, lexical search, connected Wiki reads and
MCP do not require it. Development `npm ci` includes the runtime for tests.

For local semantic/hybrid search on Linux x64, install the exact runtime version into
the **same prefix as BuildLore**:

```sh
npm install --prefix "$HOME/.local/buildlore" --omit=dev --save-exact @huggingface/transformers@4.2.0
```

A separate global installation does not supply the runtime to this prefix. Model files
remain separate: use the existing `model bind`, `model verify` and `index rebuild`
workflow from the hub. Installing the runtime does not download model weights or build
an index. Without a usable runtime, semantic operations report the existing structured
unavailable error; hybrid retains its explicit fallback where supported. Connected
search remains lexical. An upgrade preserves a runtime you explicitly installed.

BuildLore declares an optional peer dependency because `optionalDependencies` are still
installed by default. Other compiler dependencies remain in the base installation;
this change does not promise a particular installed size or vulnerability count.

To verify upgrades as well as isolated reads, developers can provide a retained tarball
that required transformers 4.2.0 and a prepared local `multilingual-e5-small` model directory:

```sh
BUILDLORE_EMBEDDING_BASELINE_TARBALL=/path/previous-buildlore.tgz \
BUILDLORE_EMBEDDING_MODEL_DIR=/path/multilingual-e5-small \
npm run verify:installed-read
```

This uses disposable installations to check runtime removal, recovery, and preservation
after explicit installation, with actual local semantic/hybrid searches. It copies the
model for testing and makes no paid AI calls. The same npm and isolation tools are required.

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

#### Generic JSON and JSON knowledge adapters

Use `buildlore.sources.v2` to collect JSON as a normal, producer-neutral source. A
directory declaration selects every matching regular `.json` file below the declared
path; it does not require one entry per file:

```json
{
  "projectId": "a",
  "schemaVersion": "buildlore.sources.v2",
  "sourceRepository": "https://github.com/acme/a.git",
  "sources": [
    {
      "adapterId": "buildlore.json",
      "adapterVersion": 1,
      "id": "run-data",
      "kind": "json",
      "path": "artifacts/runs",
      "pathType": "directory",
      "recursive": true
    }
  ]
}
```

The project `profile-binding.json` must use `buildlore.profile-binding.v2` and bind
the exact adapter registration digest. Generate this contract with the exported
`createProfileBindingV2(...)` API instead of inventing a digest. Existing v1 profile
bindings remain readable but intentionally authorize only their legacy adapters.
After the v2 binding is installed, `source add --kind json` can add the built-in JSON
declaration.

The built-in JSON adapter performs strict UTF-8 and JSON parsing, rejects duplicate
keys and bounded-resource violations, orders object keys canonically, and emits a
deterministic Markdown evidence source. `SourceDocument` v3 records the original
`sourceRef`, RFC 6901 JSON Pointer, input hash, and source location for every emitted
range. Those pointers survive compile, activation, semantic indexing, query, and
citation lookup.

For code-free specialization, put sorted `profiles` plus optional `profileRequired`
under the declaration's `buildlore.json-metadata.v1` metadata values. The public
`json-extraction-profile.schema.json` contract defines exact match, include/exclude,
title, section, array, display-label, and sort rules. Ambiguous matches, a required
profile that does not match, invalid pointers, or incompatible rules fail closed; the
adapter never guesses domain meaning.

Trusted hosts can register a versioned local adapter with
`registerJsonKnowledgeAdapter(...)`, add its exact registration to
`createProfileBindingV2(...)`, and inject the returned definition through the
`jsonKnowledgeAdapters` construction option on sync, source management, compiler,
and activation services; Wiki read accepts the same definitions through
`sourceAdapterRegistrations`. The adapter receives only BuildLore-confined,
deeply frozen parsed documents and provenance. It receives no writer, filesystem,
network, environment, clock, or process capability, and BuildLore validates its
bounded drafts before the common sanitizer and atomic writer.

`p2aRunJsonKnowledgeAdapter()` is an optional reference adapter built on that same
public contract. The official CLI pre-registers it, but a project activates it only
through an exact profile binding and an explicit source declaration. Other trusted
hosts must register and inject it themselves. Declare the exact P2A
`runs/run-index.json` file with adapter ID `buildlore.p2a-run`; recursive directory
declarations are rejected. BuildLore derives a deterministic, project-confined closure
containing only indexed runs and their referenced task graphs, current/effective specs,
execution envelopes, gates, and current development contract. Unindexed historical JSON
is not read. The adapter accepts supported `p2a.run.v2` and `p2a.run_index.v1`
documents only when every reference, schema, digest, task contract, and index summary
matches exactly. It merges matching implementation/final-verification evidence, keeps
failure-to-success history, and deduplicates verification. Missing, ambiguous,
unsupported, or mismatched closure inputs fail selection before collection.

Run `sync --dry-run` first. JSON parse/profile/adapter failures and quarantine entries
return value-free reason codes; correct the source, binding, profile, or index and run
the preview again. The sanitizer scans every selected JSON field, including fields
excluded from projected text, so hiding a suspected secret with an extraction rule
cannot make the source eligible. After closure verification, the P2A reference adapter
normalizes only exact schema-bound technical metadata and segments structured
path/taxonomy values so each component is still scanned. The common sanitizer may redact
workspace paths; suspected credentials, unknown high-entropy components, and unsafe
trace content still fail closed. A failed preview or sync writes no partial source and
does not replace healthy Wiki or semantic-index authority.

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

To opt into source-only masking, add `"sourceSecretHandling": "mask"` after
`overrides`. Omission or `"reject"` preserves existing security behavior. Intake
masks detected credential and entropy spans, rescans the entire derivative, and
uses only the approved derivative for sync and compilation. Original source files
are not edited. After changing this digest-bound policy, resync and prepare a new
Wiki generation run.

Private keys, prompt injection (even with an override), ambiguous overlap, scan
overflow, residual findings and unsafe citation metadata still fail closed. This
option does not change AI proposal/review/evaluation validation or egress permissions.
`<REDACTED:CREDENTIAL>` and `<REDACTED:SECRET>` denote unavailable values; affected
lines are excluded from factual evidence in new knowledge snapshots. Masking
handles detected risk; it does not guarantee detection of every secret.

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

#### Project knowledge mode (opt-in, phase 1)

This mode organizes generic Markdown/JSON into project facts and exactly three pages:
overview, architecture and decisions. P2A is an optional source adapter, not the
knowledge model. It is an opt-in development feature; protocol tests are not evidence
that an independent AI can answer project questions correctly.

Use this question-bound purpose file with the existing `compile hierarchy start` command.
Choose questions and source requirements for the selected project before drafting:

```json
{
  "schemaVersion": "buildlore.hierarchical-workflow-purpose-input.v3",
  "projectId": "example",
  "generationModel": "project-knowledge-v1",
  "outputLanguage": "en",
  "authoringQuestions": [{
    "id": "storage", "role": "architecture",
    "question": "Which storage setting is declared, and what does it control?",
    "requirements": [{ "id": "storage-value", "sourceRef": "settings.json",
      "jsonPointer": "/storage", "contentKind": "json-value" }]
  }]
}
```

The returned versioned `exchange` contains sanitized evidence and previous knowledge.
The already-running agent authors a complete proposal, using
`compiler.createProposedKnowledgeRecord` for fact IDs and
`compiler.createKnowledgeProposal` for canonical submission JSON. It must bind every
sentence, title and section to supporting facts. Refer to
[knowledge contracts](schemas/project-knowledge.schema.json) and
[workflow contracts](schemas/project-knowledge-workflow.schema.json).

Purpose v3 emits exchange v2 with generic project instructions and the frozen questions.
Submit `{ schemaVersion: "buildlore.knowledge-question-submission.v1", projectId,
proposal, questionAnswers: [{ id: "storage", claimIds: ["storage-setting"] }] }`.
The named claims must be in the question's assigned page and cite its required evidence.
Start/status expose `sourceCoverage`; submit/review expose `questionCoverage`, including
`semanticReviewRequired: true`. Missing mappings, wrong pages or uncited details block submission.
Requirements and answer mappings survive restart and are rechecked before finalize/approval;
editing the original purpose file cannot relax an existing run. `reviewViewDigest` binds the
answer mapping as well as the proposal. The reviewer must assess whether the mapped claims
actually answer each question: source coverage alone does not establish that.
Purpose v2 and old runs retain their original input and exchange bytes for replay compatibility.

Before drafting, purpose v3 runs support read-only, question-bound code inspection:

```sh
node dist/cli/bin.js compile hierarchy inspect --project example --run <run-id> --input inspection.json --expect-exchange <exchange-digest> --json
```

```json
{
  "schemaVersion": "buildlore.knowledge-authoring-inspection-request.v1",
  "projectId": "example",
  "questionId": "storage",
  "operation": "find",
  "contains": "storage"
}
```

Start/status also return `inspectionArgs`; append `--input <request.json>`. Use `sources`
to list selected source paths (optional `contains` filters paths), `find` for case-sensitive
literal matches in evidence (optional exact `sourceRef`), and `read` with `sourceRef` to read
that file's evidence in order. Unused `sourceRef`, `contains` and `cursor` may be omitted or
`null`; `read` still requires a path and `find` still requires a non-empty search string.
The public `compiler.parseKnowledgeAuthoringInspectionRequest` result can be passed directly
to `session.inspect` or serialized as a CLI request. Follow entry points, named
callees/callers, configuration, error handling and related tests with successive requests.
This is an inspection aid, not an AST/call-graph analyzer, semantic search or code execution.

Only previously selected, sanitized sources in the run's matching snapshot are disclosed.
Undeclared paths, unknown questions, cross-project requests and source/authority drift fail
without modifying the run. Additional source selection requires re-sync and a new authoring
run; this command never expands collection. Results preserve evidence IDs, content digests
and locators; line numbers refer to the sanitized projection unless explicit origin metadata
exists. Code inspection and test definitions do not prove execution or a current test pass.

The current AI compares documented intent with implementation and writes concise explanations
of responsibilities, behavior, disagreements and unknowns, binding them through proposal
facts and `questionAnswers`. Add relevant implementation/config/test paths to the question's
requirements before start when those sources must be cited. A lookup receipt is not semantic
approval: independent review still checks the explanation and both sides of disagreements.
Missing decision reasons must not be invented from code. Inspection is available before
finalization, does not modify the exchange, and is not a mandatory logged tool-call protocol.

Pagination uses `cursor`, `limit` (1–50, default 10), and `maxBytes` (8,192–1,048,576,
default 65,536). The byte limit covers the compact JSON inspection result, excluding the CLI
envelope/pretty printing. No evidence is clipped or silently skipped: `item-too-large` returns
an empty page, a retry cursor and `minimumRequiredBytes`; increase `maxBytes` and retry.
Cursors bind the snapshot, question, operation and filter; changing a filter starts a new read.
If the question/response metadata itself exceeds the budget, the CLI fails with
`KNOWLEDGE_INSPECTION_BUDGET_EXCEEDED` and compact `data` containing `byteBudget`,
`minimumRequiredBytes`, `maximumBytes` and `retryable`. The SDK throws the exported
`compiler.KnowledgeAuthoringInspectionBudgetError` with the same `details`. When retryable,
resend the same request/cursor with `maxBytes: minimumRequiredBytes`. Otherwise the complete
question cannot fit the supported limit; revise the question grouping and start a new
authoring run. No question requirements or evidence are silently dropped. Security checks
still take precedence over budget recovery. This failure data uses
`buildlore.knowledge-authoring-inspection-budget.v1`; successful result contracts are unchanged.
The schema is also exported as `buildlore/schemas/project-knowledge-inspection.schema.json`.
See [inspection contracts](schemas/project-knowledge-inspection.schema.json).


### Inspect change impact before updating the Wiki

A verified, previously approved knowledge generation is required. After selecting changed
sources, run `sync`, start a new authoring run, and read its `status`. Save the previous
`wiki memory` snapshot identifiers before updating: the request uses the baseline generation
and snapshot digests, plus the new exchange and snapshot digests. A first-generation run
without a baseline rejects the request with `KNOWLEDGE_INVALID`.

```json
{
  "schemaVersion": "buildlore.knowledge-change-impact-request.v1",
  "operation": "change-impact",
  "projectId": "example",
  "expectExchangeDigest": "<new exchange.exchangeDigest>",
  "expectSnapshotDigest": "<new exchange.snapshot.snapshotDigest>",
  "expectBaselineGenerationDigest": "<previous generationDigest>",
  "expectBaselineSnapshotDigest": "<previous snapshotDigest>",
  "limit": 10,
  "maxBytes": 65536
}
```

Replace each placeholder with its complete `sha256:…` digest and save as `impact.json`:

```sh
buildlore compile hierarchy inspect --project example --run <run-id> --input impact.json --expect-exchange <new-exchange-digest> --json
```

SDK callers use `session.inspectChangeImpact(request, session.exchange.exchangeDigest)`;
`compiler.parseKnowledgeChangeImpactRequest` accepts raw JSON data and normalizes defaults.
This operation also works on existing authoring runs without questions. It is available in
`awaiting-proposal` and `review-ready`, and preserves existing exchange/status/run bytes.
The standalone schema is exported as
`buildlore/schemas/project-knowledge-change-impact.schema.json`.

The report connects changed evidence to baseline current facts and their baseline Wiki claim
locations. It retains all sibling evidence, including exact matches. Even a partial loss
makes the fact stale under existing reconciliation unless it is re-proposed and reviewed.
`summary` covers the full comparison, independent of pagination; evidence-link counts cover
baseline current records, while historical/superseded/stale records have separate exclusions.

`revision-metadata-changed` means the aligned excerpt and source content match but identity
or revision metadata differs. `same-excerpt-source-changed` preserves the distinction between
a matching excerpt and changed source bytes/location. Neither proves semantic equivalence or
a passing test. `content-changed` identifies a changed structurally aligned excerpt, not a new
accepted fact. `source-unselected` and `aligned-evidence-unavailable` are unknowns within the
selection, not proof of deletion. Multiple structural candidates remain ambiguous. No lexical
or semantic similarity, rename inference or checkout-wide discovery is performed.

Use `cursor`, `limit` (1–50) and `maxBytes` (8,192–1,048,576) to paginate whole facts.
`item-too-large` returns no clipped fact and keeps the same offset. When `retryable` is true,
resend that cursor with `maxBytes: minimumRequiredBytes`; page size may change too. If false,
the whole fact exceeds the supported maximum and cannot be skipped by this operation.
The byte budget includes `resultDigest` in compact UTF-8 report JSON; it excludes the CLI
envelope, pretty printing and trailing newline. Metadata overflow uses the value-free
`KNOWLEDGE_CHANGE_IMPACT_BUDGET_EXCEEDED` error (`compiler.KnowledgeChangeImpactBudgetError.details`
in the SDK). Wrong expected bindings or a stale cursor fail with `KNOWLEDGE_DRIFT`.

Read actual sanitized evidence using the existing exchange/authoring inspection and canonical
fact/evidence lookup. Write supported replacements and scoped supersessions/conflicts, then
`submit` → independent `review`/`finalize` → explicit `approve` → `activationArgs`.
The report neither edits knowledge nor grants approval. Ordinary `wiki memory` continues to
describe the last approved snapshot until an updated generation is approved and activated.

For this mode the sequence is `sync` → `start` → question-specific `inspect`/authoring → `submit` → `review` → `finalize` →
`approve` → the returned `activationArgs`. `submit` uses `exchange.exchangeDigest`;
`finalize` imports an independent `buildlore.knowledge-semantic-review.v1` and uses
the returned `reviewViewDigest`. The reviewer must use a different session or be an
explicit human reviewer, judging support, scope, classification and currentness for
every `reviewTargets` entry. A checksum binds that judgment; it does not prove truth.
Claim IDs must not use the reserved `sha256:`, `title:`, `section:`, `supersession:`
or `conflict:` prefixes. Review targets and judgments must be unique.
Correct the whole proposal with `submit` before finalization; the legacy per-page
`resubmit` and `child-review` commands do not apply. BuildLore does not spawn AI.

After explicit activation, files are in
`knowledge/projects/example/wiki/buildlore-hierarchy/`:
`overview.md`, `architecture.md`, `decisions.md`, `knowledge.json`, `evidence.json`,
and `manifest.json`. JSON and Markdown are regenerable projections of the single
`.llmwiki/buildlore-hierarchy/approved-authority.json`, not independent authorities.
The first legacy migration preserves an immutable authority backup in that store's
`archives/<authority-digest>.json`; archives are never active search inputs.

New project-knowledge approvals use `buildlore.approved-wiki-authority.v3` with a
`knowledge-authority-extension.v2` reference. Each immutable generation lives in
`.llmwiki/buildlore-hierarchy/knowledge-history/objects/<generation-digest>.json`
inside the selected project. A small reference binds the head, genesis and canonical
decimal count; there is no aggregate 16 MiB or 64-generation lifetime quota in this
path. Each generation still has its own 16 MiB size and structural limits. Full
history verification uses bounded records and a temporary digest-only spool; disk
and verification time can grow with retained history.

Approval stages screened immutable objects and writes an activation-input v2 bundle
containing one candidate, its exact baseline and the approval proof. Activation is
still explicit. Existing v1/v2 authorities remain readable without migration. During
an explicit v2-to-v3 replacement, the original authority record bytes are preserved
at `archives/<record-digest>.record.json`. Failed staging or pre-commit activation
keeps the prior authority and Wiki; the existing publication journal handles retry.
Activation does not rebuild the semantic index: run `index rebuild` explicitly.

Reads recheck the active record and every referenced history object's actual bytes
and confined file identity, including on cache hits. Historical semantic replay and
current-policy screening cannot be replaced by stored digest or “verified” flags.
Reads do not migrate, collect garbage, embed or rebuild an index. Missing, altered,
cross-project and invalid history is rejected with structured, value-free errors.

SDK consumers use `prepareCurrentApprovedWikiPublication` or the asynchronous
publication reader for the `CurrentApprovedWikiAuthority` union, then
`latestKnowledgeGeneration` and `knowledgeAuthorityHistory` for resolved access.
Legacy synchronous parsers deliberately reject unresolved v3 pointers. Authoring
accepts `previousHistory`; answer evaluation accepts `history`. These capabilities
must come from the confined store and cannot be combined with legacy generation
array inputs or recreated from serialized JSON.

Regeneration replays the complete retained generation chain and screens all of its
decoded text and metadata under the current security policy, including old source
snapshots and review rationales no longer shown in the current Wiki. Field boundaries
and real line breaks are preserved during screening; JSON serialization must not turn
unrelated fields into one instruction. Individual values are never truncated, masked
or split to pass this check. A rejected value blocks generation and leaves the active
Wiki unchanged.

```sh
node dist/cli/bin.js wiki read --project example --page overview --json
node dist/cli/bin.js wiki citations --project example --page decisions --json
node dist/cli/bin.js search --project example --query "storage decision" --mode lexical
```

Project-knowledge search returns `buildlore.project-knowledge-search.v2` with
`supportScope: "matched-section"`: each hit carries only that section's claims, facts and
evidence. Child-summary support is attached only to the overview's first section, where those
summaries occur. `wiki read`/`citations` still return the full page. After explicit index rebuilding,
semantic/hybrid requests use the compatible local index. An unavailable or incompatible index/model
causes a structured semantic error or an explicit hybrid lexical/graph fallback.

Project-knowledge semantic candidates are filtered before fusion by the reported
`semanticRelevancePolicy`. For the pinned multilingual-e5-small profile, the cosine floors are
0.820646121668 for the same/unknown writing script and 0.765124142709 for detected cross-script prose (V2, calibration version 2); mixed technical
prose retains substantial non-Latin text despite Latin identifiers. These are calibrated topical
heuristics, not answerability guarantees or probabilities. Korean/English fixtures cover two generic
projects; other languages and domains need evaluation. All-rejected semantic searches return empty
hits, not a provider fallback; valid hybrid lexical/graph candidates remain. Legacy hierarchy search
is unchanged. Reader instances reuse a deeply frozen verified publication only after checking confined
paths and hashing the complete current file bytes; changed authority or security policy cannot reuse
old approval. A new CLI process still pays the initial verification and model startup costs.

Facts distinguish `observed` source literals, `declared` statements and `inferred`
interpretations. Only reviewed `accepted` + `current` claims are current explanations;
historical, superseded, stale and disputed knowledge remains explicitly marked.
A JSON `passed`/`done` value is not proof of current code verification. Repository HEAD
metadata and tracking status are separate from proven source/code revisions, which
remain `null` when unavailable. Missing evidence does not prove a feature was removed;
changed selection is not deletion, and unreadable input blocks generation.
Re-proposing a superseded fact cannot restore it to current or erase its replacement
link; historical re-review retains that link. Further changes extend the replacement chain.

New authoring runs use `knowledge-markdown-v2`: each cited source includes its exact escaped
excerpt, original location and `heading` / `json-value` / `text` kind. Cite source assertions as
`[evidence:sha256:<64 hex>]` and recorded knowledge state as `[fact:sha256:<64 hex>]`.
The state section names replacement facts and evidence present/absent in the bound snapshot;
this is provenance, not proof of running code or why an input disappeared.
Existing v1 authorities, pending v1 runs and v1 evaluation records retain their original
renderer/bytes. New v2 rendering needs a new reviewed generation and explicit activation;
reading or upgrading the package does not rewrite the active Wiki.

For authoring diagnostics, `compiler.createKnowledgeEvidenceCoverage(snapshot, requirements, projectId)`
checks caller-declared `{ id, sourceRef, jsonPointer, contentKind }` requirements against the exact
sanitized snapshot. `jsonPointer: null` matches the file; `contentKind` is `any`, `json-value`, or `text`.
It reports `available`, `heading-only`, or `unavailable` plus matching evidence IDs. A missing
field does not mean an empty array, and this helper neither collects omitted inputs nor changes adapters.
For example, `{ id: "storage", sourceRef: "settings.json", jsonPointer: "/storage", contentKind: "json-value" }`
requires the value, not just its heading. `compiler.inspectKnowledgeProposalGrounding(snapshot, proposal,
projectId, previousGenerations?)` exposes the existing lexical-overlap check per claim before finalization.
It does not change the threshold or replace semantic review; do not pad claims or unrelated evidence
to satisfy it. Both helpers are pure codecs, not sanitizer or persistence boundaries: use the session's
sanitized exchange as input. No producer-specific fields are hardcoded in these helpers.

For each authoring question, `compiler.inspectKnowledgeQuestionCoverage(snapshot, proposal,
questions, projectId, previousGenerations?)` checks the required sources against the claims assigned
to that question. Each input is `{ id, claimIds, requirements }`, using the source requirements above.
The report distinguishes `unavailable` / `heading-only` from `uncited` (source present, but not cited by
those claims) and `covered`. A citation attached to a different question does not fill this gap.
The report binds the snapshot, proposal and requirements digests. `covered` means the mapping exists;
independent review still checks whether the prose actually explains the required knowledge.
When calling the SDK directly, `session.submit(proposal, exchangeDigest, questions)` refuses incomplete
coverage before accepting the proposal. This optional SDK diagnostic and purpose v2 remain supported;
use purpose v3 above to enforce frozen question requirements throughout the public CLI workflow.
Keep authoring requirements separate from the hidden evaluation oracle and never send the oracle to readers.

If a summary adapter omits needed JSON fields, select the existing `buildlore.json` adapter with a
user-defined extraction profile for those files. The executable [detail-profile example](test/fixtures/project-knowledge/source-details-example.json)
retains verification arrays, task status and specification approval using ordinary JSON Pointers.
Its field names are configuration, not knowledge-core vocabulary. The same file cannot be selected
through both the summary adapter's input closure and a second generic declaration; choose one collection
binding. Profile `required` pointers reject absent fields. Explicitly empty arrays remain `_Empty array._`
with an origin pointer (a `text` excerpt); an omitted field is `unavailable`. All raw fields are still
screened even when the profile does not display them.

Reads and citations return generation-bound facts and evidence. After activation and
an explicit `index rebuild --project <id>`, project-knowledge `search --mode semantic`
and `--mode hybrid` use the same compatible project-local index as hierarchical Wiki search.
Semantic mode reports a structured failure for a missing, stale or incompatible index/provider;
hybrid mode explicitly falls back to lexical/graph retrieval without mixing old caches.
Search honors the existing intent option. Overview search hits identify inherited
child claims separately. Ranking uses reviewed fact states for each cited section,
including inherited summaries, without rewriting the stored corpus or changing the
legacy ranking policy. Shared evidence does not transfer currentness between sections.
On first activation, an absent or empty namespace is required; pre-existing files
without a bound authority are not overwritten, even if their filenames match generated files.
Direct edits to managed Markdown cause drift and block
overwriting. Restore reviewed bytes from Git/backup before retrying activation; do not
edit or rehash authority records to repair them. Rebinding fresh-clone source inputs
is needed for new authoring, not for reading portable approved knowledge.

The SDK also provides [answer evaluation audit contracts](schemas/project-knowledge-answers.schema.json).
Freeze independently reviewed questions/criteria with `compiler.createAnswerEvaluationContract`
before authoring. `compiler.createKnowledgeAnswerEvaluationService({ knowledgeRoot }).prepare`
accepts that contract, the same-project generation chain and optional `runtimeContext`.
It screens decoded text before returning a reader packet containing instructions, five questions
and the three actual Markdown pages; oracle criteria and writing history are not included.
`session.lookup(questionId, evidenceIds)` returns only generation-bound sanitized evidence and
enforces 10 lookups / 16,384 cumulative UTF-8 bytes, including repeated requests.
With v2 generations, `session.lookupFacts(questionId, factIds)` returns the fact record, generation lineage
and current-snapshot evidence membership under that same shared budget. `retrieval.createKnowledgeWikiReader`
also exposes `fact(projectId, expectedGenerationDigest, factId)` for screened active-generation state lookup.
V2 answer claims require separate `evidenceIds` and `factIds` arrays matching the exact typed citations
in their text; a fact ID cannot stand in for a source ID. Source and state lookups each request one kind.
The five questions and byte limits are unchanged. V1 reports keep their original citation rules.
`session.serializeReport(input)` checks the actual lookup history and returns screened audit JSON;
the caller owns any local audit-file write. These are SDK methods, not a new CLI command or AI launcher.

For a new evaluation, opt into `compiler.createReaderAnswerEvaluationContract` using the same contract
inputs, frozen before authoring. This creates a different contract digest (`knowledge-answer-contract.v2`,
`contextFormat: "knowledge-reader-v1"`), requiring `knowledge-markdown-v2` generations. Initial input retains
all authored Wiki prose, fact scope/state and typed citation IDs; complete source excerpts and full fact
provenance are fetched on demand. Stored Wiki Markdown and old contracts/reports are unchanged. Do not
retroactively switch an existing evaluation's contract and call it a pass under its old benchmark.
Under this contract, `session.lookup` returns `knowledge-evidence-context.v1`: exact evidence plus enclosing
ATX/Setext Markdown headings from the same sanitized snapshot. Fenced examples are excluded. Missing
historical source context or redacted headings are explicitly unavailable/partial, not reconstructed.
This is heading context, not full surrounding paragraphs or semantic proof. The entire response, including
headings and metadata, consumes the shared lookup budget. A source citation without a source lookup for
that question or an earlier one makes the evaluation fail; a listed ID or fact lookup is not source access.

### Development memory for a coding agent

`buildlore wiki memory --project example --json` returns the approved project's Wiki prose,
fact state, source references and revision context as `buildlore.knowledge-development-memory.v1`.
The SDK equivalent is `retrieval.createKnowledgeWikiReader(knowledgeRoot).readMemory('example')`.
It works without embeddings, model calls, reindexing or knowledge writes. Detailed fact records
and source excerpts use the existing `wiki lookup --expect-generation` command; an evidence ID
in the memory does not mean the source has been read. Development guidance permits code inspection,
changes and tests within the host's authorization and keeps historical results distinct from current
verification. It grants no tool permissions or automatic source collection.

For authoring, opt into five explicit knowledge axes with `compiler.createDevelopmentMemoryQuestions`:

```js
import { compiler } from 'buildlore';

const authoringQuestions = compiler.createDevelopmentMemoryQuestions({
  purpose: [{ id: 'purpose-source', sourceRef: 'docs/README.md', jsonPointer: null, contentKind: 'text' }],
  architecture: [],
  decisions: [],
  'current-state': [],
  'failures-open-work': [],
});
```

Pass these questions in the existing purpose v3 input. Replace empty lists with explicit requirements
from your selected sources as appropriate. Each question carries a `development-memory-v1` profile
marker. An empty axis stays **unassessed** and must map zero claims; it does not assert missing project
knowledge. Selected axes require grounded claim mappings and complete declared-source coverage.
The source-coverage view uses `coverage: null` for unassessed axes.

Submission and review expose `developmentMemoryInspection` with all five axes, exact page/claim
locations and fact/evidence links. Its digest is bound into the existing review view, including after
resume. The SDK also exposes `inspectDevelopmentMemoryContent` and its verified-history counterpart.
The report checks declared structure; `semanticReviewRequired` always remains true. Source-support
review and separate content/task evaluation must assess correctness and sufficiency. The report stays
in the authoring/review flow and is not inferred for old generations. Existing generic questions,
evaluation packets and generation formats retain their behavior.

### Development handoff and CLI reader evaluation

`compiler.createDevelopmentHandoffQuestions(requirements)` creates five ordinary authoring questions:
`purpose`, `architecture`, `current-state`, `decisions`, and `changes`. Supply an object with those five
keys, each holding the existing `{ id, sourceRef, jsonPointer, contentKind }` requirement array, and put
the returned questions into a purpose v3 `authoringQuestions`. Source selection stays caller-owned;
there is no required producer, language or P2A adapter. Custom question sets remain supported.

New handoff questions require actors and pre-transfer/persistence checks in the relevant answer,
changed **and preserved** normal/error behavior, and version-specific verification scope.
Inspection guidance asks independent reviewers to check these details against the selected evidence;
it does not automatically certify their meaning. Fresh factory calls use the improved wording;
previously saved questions, exchange instructions/digests and caller-defined questions are not rewritten.
The per-answer topic check includes supported documentation, authoring-guidance and development-process
changes, not only runtime features. Authors inventory relevant topics, map them to cited sentences in
that answer, and reconcile omissions before submission; mentioning a topic in another answer is insufficient.
This guidance supports independent review, not automatic semantic acceptance.

Before drafting, use the existing inspection request with `operation: "coverage"` and a question ID
(omit `sourceRef` and `contains`). It returns paginated requirement statuses: `available`, `heading-only`,
`source-not-selected`, or `detail-unavailable`. These describe the sanitized snapshot, not the raw
repository or the cause of an omission. They neither prove semantic support nor attest that an author
read an excerpt. Post-submission `questionCoverage` separately identifies uncited requirements.
Inspection guidance asks the author to connect previous/current behavior, recorded reasons, impact,
verification and unresolved work, and to follow relevant code contracts, callers, failure paths and tests.
Read supplementary selected evidence where needed. Unknowns must not be invented or counted as fully
answering a mandatory question whose answer is available. Safety and existing submission gates remain.

```sh
node dist/cli/bin.js wiki read --project example --page architecture --view reader --json
node dist/cli/bin.js wiki lookup --project example --kind evidence --id <evidence-digest> --expect-generation <generation-digest> --json
node dist/cli/bin.js wiki lookup --project example --kind fact --id <fact-digest> --expect-generation <generation-digest> --json
```

The opt-in reader returns all authored prose, fact state/scope and lookup IDs without duplicating raw
excerpts. Omit `--view` or use `--view full` for the unchanged full response. Reader mode requires an
active project-knowledge generation; it never silently falls back to legacy pages. Each lookup requests
one ID, includes exact evidence and heading context or full fact state, and rejects a changed generation.
No source synchronization, regeneration or activation occurs during reading.

For new evaluations, `compiler.createCliReaderAnswerEvaluationContract` freezes
`contextFormat: "knowledge-cli-reader-v1"`. Initial Wiki and lookup context are canonical JSON of the
same complete CLI `data` objects, including generation metadata. The existing questions, byte budgets,
evidence-read checks and independent judgment requirements are unchanged. CLI/tool envelopes and known
session framing belong in `runtimeContext`; do not omit them and claim a measured total. Legacy evaluation
formats retain their original bytes/digests. Passing protocol tests is not a live Wiki quality result.
See [reader data schema](schemas/project-knowledge-reader.schema.json).

`compiler.createKnowledgeAnswerEvaluationService({ knowledgeRoot }).inspect` accepts the same input as
`prepare` and returns screened byte contributions, known initial bytes, whether runtime context is known,
the initial limit and `exceedsBudget`, without disclosing content. It works for over-budget inputs;
`prepare` still rejects them without truncation. This is an input-size diagnostic, not a quality judgment.
The 32,768 bytes are a fixed comparison budget, not a model context-window size, a token count, or a limit
on the complete stored Wiki. Suitability for real AI answers still needs independent evaluation.

Retained history is structurally replayed and security-screened separately from reader context.
All snapshots, reviews and metadata remain in scope, including decoded JSON source keys and values.
Whole fields are deduplicated and scanned in bounded batches; individual values are never split to
evade a detector or size limit. The sanitizer's 8 MiB per-scan cap and existing structural limits remain
unchanged. Actual initial context, lookups and reports still require their own security screening.
Value-free errors distinguish `KNOWLEDGE_SECURITY_INPUT_TOO_LARGE`, `KNOWLEDGE_SECURITY_BLOCKED`
and `KNOWLEDGE_CONTEXT_BUDGET_EXCEEDED`; malformed or structurally oversized inputs remain
`KNOWLEDGE_INVALID`. No partial context or size diagnostics escape a failed security check.

All answer text must be covered by ordered UTF-8 byte spans with independent claim/criterion
judgments. Valid evidence IDs do not establish semantic support. Context has a 32,768-byte budget;
each answer has an 8,192-byte budget. Oversized answer records fail without silent truncation.
`runtimeContext` accounts for known additional session instructions/framing. If it is unavailable,
the full initial-context total is `null`, the known provided bytes remain visible, and live evaluation
is incomplete. Do not export private/hidden provider instructions to fill that gap.
Token counts are separately `measured` or `unavailable` with null counts and a reason, never estimated
from bytes. `recorded-pass` only summarizes supplied judgments and session attestations; it is not
proof that independent AI sessions ran. `fixture-only` cannot satisfy real AI quality acceptance.
An initial independent two-sample evaluation found citation and coverage failures. The v2 code changes
have not yet passed a fresh independent AI evaluation; codec tests are not a quality acceptance result.

#### Recommended legacy hierarchical CLI workflow

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

### Complete reader packet

Use `buildlore wiki packet --project <id> --json` for the opt-in `buildlore.knowledge-reader-packet.v1` data surface. It preserves all Wiki prose and fact scope/state while deduplicating references. Resolve display aliases through the registries to obtain canonical IDs. Each entry advertises the complete single-ID lookup cost in compact UTF-8 JSON with a final newline; a listed source has not been read. Existing `wiki read` and `wiki lookup --expect-generation` responses are unchanged.

The SDK provides `readPacket(projectId)` and `createPacketAnswerEvaluationContract`. The latter binds `knowledge-reader-packet-v1` to answer contract v3 with the existing 32,768-byte initial context, 16,384-byte/10-call lookup and 8,192-byte per-answer limits. The entire data object and question text count toward the budget. Source citations require an actual lookup for the same or an earlier question. Unmeasured runtime framing remains unavailable; content completeness is reported separately from full live certification. Older contract/report encodings remain supported. Packets require a `knowledge-markdown-v2` generation.

The pinned local embedding profile uses a versioned topical admission policy (`semanticRelevancePolicy` in search results). V2 was selected by a deterministic midpoint between the weakest required positive and strongest unrelated candidate for each script relationship, using frozen calibration and known regressions. Scores are not answer probabilities. Independent holdout results must be reported separately; an infeasible interval or failed holdout is a failed calibration attempt, not permission to relabel queries. Calibration fixtures and profile provenance are in `test/fixtures/semantic-relevance-*-v2.json`. The offline `calibrateSemanticRelevance` helper rejects missing classes, invalid scores and overlapping intervals.

### Completeness authoring and knowledge limits

The opt-in `completeness-v1` workflow maps reviewed inventory items to exact Wiki claims and requires both source/currentness review and omission review. A known unknown must be explained in the mapped prose; a citation or inventory label alone is insufficient.

A supported current statement such as “the selected evidence does not establish production performance” uses `current` presentation. The unknown concerns the measurement, while the statement of the evidence limit is supported. `uncertainty` presentation remains reserved for claims referencing uncertain facts; do not fabricate stale or disputed records to use it. Stage views provide this guidance without changing stored exchange bindings.

Missing declared required sources still block finalization. Scope limits supported by selected sources may be recorded as known unknowns. Review all categories without inventing complete project history or repeating identical propositions within a question and category. These instructions and automated checks do not establish higher document or reader scores; independent evaluation is required.

The question’s own prose should carry documented decision reasons, revision-specific changes, defaults, exceptions and compatibility obligations. Distinguish generated output, implemented behavior and executed verification. Omission reviewers assess those substantive qualifiers, not just item IDs or citations.

After prose submission, author and omission-review stage views may include a read-only `material.reviewPacket` joining each frozen question and required item to its exact current claims, with shared prose, fact and evidence records. It carries proposal, inventory and mapping bindings, but grants no verdict or approval. The source reviewer does not receive it. If the complete packet exceeds 256 KiB of compact JSON or would exceed the existing stage-view limit, it is omitted in full; the original separately accessible material remains available. Reads do not alter stored runs or history.

Inventory admission errors retain `KNOWLEDGE_INVALID` and include a bounded, zero-based question/category/item location with a fixed rule and whole-draft digest. Each requirement link needs matching current-source evidence; history alone does not satisfy it. `compiler.repairKnowledgeCompletenessInventoryDraft(draft, exchange, role, { draftDigest, questionIndex, categoryIndex, itemIndex, replacement })` replaces one caller-owned draft item, preserves its identity, and validates the complete result. Submit that result through the existing shadow/inventory command with the current stage digest. The helper does not write session state or edit accepted inventories. Role guidance includes the existing coverage inspection request shape.

### Task-focused development memory

`buildlore wiki memory --project <id> --task "describe the coding task" --max-bytes 8192 --json`
returns opt-in `buildlore.knowledge-task-memory.v1`. Without `--task`, the existing full
memory response is unchanged. The SDK exposes `readTaskMemory(projectId, { task, maxBytes? })`.

The default budget is 8192 bytes (allowed: 2048–65536). It counts the complete compact
JSON **data object plus its final newline**, including metadata and digest. CLI envelopes,
pretty printing and tool framing are extra. `budget.serializedBytes` reports the measured
size; insufficient metadata space produces `TASK_MEMORY_BUDGET_TOO_SMALL` with recovery size.
Tasks must be nonempty and at most 2048 UTF-8 bytes after trimming/NFC normalization.

Selection uses distinct lexical tokens: title matches ×4, claim text ×2, source path ×1.
Ties follow generation page/section order. Whole sections, their fact states, scope,
currentness and canonical evidence links remain intact; no model or embedding is invoked.
Sections that do not fit are skipped and smaller relevant sections may still be included.
This is partial context, not a guarantee that all necessary knowledge was found.

Inspect `coverage` and `recovery`. An oversized section is not truncated: the response
identifies the highest-ranked omitted section and the size of that section alone with
metadata. Narrow the task, increase the budget, or use `wiki list`/`wiki read` for full page
context. Use canonical fact/evidence IDs with `wiki lookup --expect-generation` for details.
Check page-read generations before combining responses; restart memory lookup after drift.
The approved-generation, project and sanitizer boundaries are shared with the full reader.

In task memory, identical currentness/provenance tuples share `evidenceContext.values`
entries. Resolve an evidence alias through `evidenceContext.aliases`, then interpret the
tuple using `evidenceContext.fields`. Every original context value is retained; the
existing full-memory format is unchanged.

### Progressive development memory

`buildlore wiki memory --project <id> --task "describe the coding task" --progressive --json`
returns `buildlore.knowledge-progressive-memory.v1`. The SDK equivalent is
`readProgressiveMemory(projectId, { task, maxBytes?, cursor? })`. Existing full memory and
whole-section task memory calls retain their original contracts.

New progressive reads use `lexical-claim-v2`: within the same original page and section,
claims with exactly identical text, presentation and canonical fact sets form a group.
Each group's first claim is ranked before its repetitions; lexical relevance and original
position break ties within each repetition tier. Different contexts, facts or wording stay
distinct. Every claim remains available through continuation; nothing is deleted or merged.
New `pwm2` cursors bind this strategy as well as project, generation and task. Existing `pwm1`
cursors continue using `lexical-claim-v1` and return `pwm1` continuations and recovery cursors.
Start without a cursor to use the new strategy. A cursor's version must not be rewritten.

The default budget is 8192 UTF-8 bytes (2048–65536 allowed), counting compact JSON data plus
one final newline, excluding CLI envelopes, pretty printing and tool framing. Ranked original
claims retain conditions, exceptions, original page/section/claim positions, fact state and
reachable evidence/currentness registries. A partial section is explicitly marked: read its
page for sibling context and check the generation before combining information.

For more ranked claims, repeat the same project and task with
`--progressive --cursor <recovery.nextCursor>` while needed and within your cumulative context/time
budget; `nextCursor: null` ends normal continuation. Cursors bind project, generation,
normalized task and ranked position; a changed generation requires a fresh read. Budget may change.
Normal continuation does not repeat delivered claims. Oversized claims are counted separately:
`recovery.oversized` identifies the first skipped position, a recovery cursor and a conservative
`requiredBytes` budget. Recovery can replay later claims; deduplicate by original positions.
For a required budget above 65536, use the existing page reader and canonical fact/evidence lookup.
No original text is clipped, no full Wiki is automatically attached, and no new model or index runs.
`no_match` means no lexical match; `budget_limited` means relevant material remains or was skipped.
Metadata alone exceeding the limit produces a structured budget error. Listed evidence identifies
available excerpts; only successful canonical lookup establishes that an excerpt was read.

Before submitting an answer or development summary, the calling agent checks each requested
explanation against its draft. Keep independent changes separate: explaining one decision does
not explain every related decision. Check recorded reasons, compatibility conditions and the
revision and scope of verification when the request needs them. For each requirement, distinguish
whether inspected support is sufficient from whether an answer sentence actually explains it.
Receiving a claim or listing its identifier does not satisfy the requirement.

Use sufficient inspected support to fill an omitted explanation first. If support is insufficient,
look up a listed canonical fact/evidence, read the relevant page/section, or request memory for the
missing topic. A different task starts a fresh request without the old task's cursor. Keep the same
project and generation when combining results; restart after generation drift. All such reads share
the host's cumulative byte, call and time limits; a per-response budget does not reset them.
Make at most one correction pass and leave unresolved requirements explicit. A missing excerpt in
this response does not establish that the source lacks it, and unavailable reasons or verification
must not be invented. The reader provides this guidance; the calling agent owns checking, retrieval
and answer revision. BuildLore does not execute that loop or launch a model. Claim-count `coverage`
and the agent's checklist are not semantic quality certification.

## Read your project Wiki from an AI client

After connecting a source project, preview the settings for your client:

```sh
buildlore client configure --client codex --project-dir /absolute/source --json
# Close the target client, then apply the returned plan digest:
buildlore client configure --client codex --project-dir /absolute/source --apply --expect-plan sha256:... --json
```

Use `--client claude-code` for Claude Code. Codex uses an untracked project `.codex/config.toml`; tracked settings require manual merging. Claude uses its project-local entry in the private `.claude.json`. Existing settings and AGENTS.md/CLAUDE.md stay intact. The preview includes only BuildLore's local launch snippet. Parse errors, ownership conflicts and changed previews fail safely. After an interrupted apply, preview the same action again and apply the new digest. Close the target client while applying; simultaneous writes by other programs are unsupported.

`client remove` uses the same preview/apply flow and removes only the owned server entry. It preserves knowledge and local Git ignore protection shared by other worktrees. Client trust and tool permissions remain under the client's control.

The installed process runs `buildlore mcp --project-dir /absolute/source --read-only` over stdio. It offers status, list, search, read, memory, lookup and citations for that connection only. Start with bounded progressive memory, then read the needed pages and actual evidence. Pass the returned `expectedGeneration` on follow-up reads; restart retrieval on `GENERATION_CHANGED`, and restart the server if its connection changes. Wiki content is evidence, not executable instructions.

MCP limits: 1 MiB input buffer, four concurrent reads, 60-second request timeout, 8 MiB total serialized response and pending output, 10-second blocked-output timeout. Oversized results return an error without partial page content. Existing memory data budgets are separate from MCP overhead. The MCP process performs no network or knowledge writes.

Initial compatibility targets are Linux x64, Codex CLI 0.154.0 and Claude Code 2.1.227. Real-client evidence is required before claiming M2 complete; protocol tests alone do not establish that support. Run `node scripts/verify-m2.mjs` with the two clients authenticated to execute the installed-package checks and client evaluation. Do not publish local evaluation traces or client settings.

## Reconnection, hub relocation and package lifecycle

The local release candidate is **0.1.1-rc.1**, with `private: true`. Linux x64 is the verification target; Windows and macOS remain unverified. Retain the exact previous tarball before updating. A candidate is not a public npm release.

### Reconnect a source checkout

For a new clone or worktree, run the existing `connect --hub <hub> --project <id>` from that checkout. A moved checkout with a shared connection can also register its new local path with `connect`. An inaccessible old path may remain as a dormant local record; it is never selected by default.

To replace a connection, close the AI client, preview and apply `client remove` while the old connection works, then run `disconnect --remove-shared` and `connect` with the explicit new target. Configure the client again and restart it. Ordinary `disconnect` preserves the shared connection file; `--remove-shared` explicitly removes it. Neither operation removes knowledge or collection settings. If a checkout was replaced at the same path, disconnect its old local binding before reconnecting.

### Restore the mapping after moving a hub

Move or restore the Git checkout yourself, including initialized submodule metadata. Keep the same portable knowledge repository locator. Relative locators must still resolve correctly at the new location. Repair broken Git worktree/submodule paths before asking BuildLore to validate the destination.

```sh
# Preview only: no file writes. Both roots must be absolute; the old root may be gone.
buildlore connection relocate-hub --from /work/old-hub --to /work/new-hub \
  --knowledge-repo https://example.org/team/knowledge.git --json

# Copy planDigest from that preview, with otherwise identical arguments.
buildlore connection relocate-hub --from /work/old-hub --to /work/new-hub \
  --knowledge-repo https://example.org/team/knowledge.git \
  --apply --expect-plan sha256:<preview-digest> --json
```

This changes only the local path for that known knowledge repository. All its source connections use the new mapping; their project identities and shared files stay intact. The preview reports the number of affected bindings without listing other projects. A changed registry, destination or stale preview is rejected. After an interruption, preview again: an already-applied mapping returns `changed: false`. Restart every MCP session using that hub. Read/status commands do not repair connections automatically.

`CONNECTION_BUSY` means a registry operation or a leftover lock is present. Stop all BuildLore processes before manual recovery. Back up the private configuration directory (`BUILDLORE_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/buildlore` or `~/.config/buildlore`). Remove only confirmed abandoned regular lock files in its `locks` directory, then preview again. Do not delete `connections.json`, active locks, or knowledge data. Locks are never stolen automatically.

### Update, roll back and remove

Close clients before replacing an installation. Install the exact tarball into the same prefix:

**Upgrading from a version that bundled the embedding runtime:** the update removes
the previously automatic runtime dependency. To keep existing semantic/hybrid search,
explicitly install it into the same prefix **before updating** (or afterwards to restore it):

```sh
npm install --prefix "$HOME/.local/buildlore" --omit=dev --save-exact @huggingface/transformers@4.2.0
```

This records your choice in the installation prefix so updates preserve it. Skip this
step for a lightweight installation using lexical search. Model files and existing
indexes remain; `model verify` checks model files and does not install the runtime.
After updating, run a semantic search from the hub to verify recovery if you use it.

```sh
npm install --prefix "$HOME/.local/buildlore" --omit=dev /path/buildlore-0.1.1-rc.1.tgz
buildlore --version
buildlore doctor --json
buildlore wiki list --json
```

Use the returned generation for a page read and its evidence lookup. If the Node or installed package path changed, preview/apply `client configure` again, then restart the client. To roll back, install the retained `buildlore-0.1.0.tgz` into the same prefix and repeat the reads. The v1 connection format remains readable; `relocate-hub` and `--version` are new in the candidate. Check the older package version with `npm ls --prefix "$HOME/.local/buildlore" buildlore`.

For removal, first preview/apply `client remove` for each configured client, then disconnect the intended source checkout(s), and finally run `npm uninstall --prefix "$HOME/.local/buildlore" buildlore`. Knowledge repositories, source documents, other clients' settings and unrelated worktree bindings remain. If you removed the program first, reinstall the same version to perform client cleanup. If the hub moved first, restore its mapping before removing client settings.

Developers can run `npx --yes --package=npm@11.19.0 --call 'node scripts/verify-m3.mjs'` with `bwrap` and `strace` available. It preserves tarballs, hashes, timing/size measurements and results in a local evidence directory. It exercises 0.1.0 → candidate → 0.1.0 → candidate and removal in a disposable installation, including isolated CLI/MCP reads and settings preservation. Measurements describe the actual cache conditions of one Linux run, not a cold-install guarantee. M3 does not invoke AI clients: paid Claude testing is excluded by user decision and remains unverified, while its integration and original M2 test path remain available for later testing.

### Reusing support and batching missing evidence

Start with progressive memory, then check which reasons, compatibility conditions and verification claims still lack support. A listed ID, an inspected excerpt and sufficient support are different things. Reuse a source range already read only when it is bound to the current project, generation and source digest. Cite that source location; do not claim canonical evidence was inspected unless it was. Read additional page context or canonical relationships when needed, and preserve unknowns.

The existing single-ID lookup is unchanged. For missing IDs of the same kind, use:

```sh
buildlore wiki lookup --kind evidence --ids <digest-1>,<digest-2> --expect-generation <generation-digest> --max-bytes 32768 --json
```

Add `--project <id>` in the hub. MCP `lookup` accepts `ids: [digest1, digest2]` instead of `id`; the SDK provides `reader.lookupBatch(projectId, expectedGeneration, kind, ids, { maxBytes })`.

A batch accepts 1–16 IDs (counted before deduplication), returns exact duplicates once in first-seen order, and retains each complete single-lookup result. The default data budget is 32768 bytes, with an allowed range of 2048–65536. `budget.usedBytes` counts compact UTF-8 JSON including the final newline; CLI/MCP framing is additional. `LOOKUP_BATCH_TOO_LARGE` means split the batch or use single lookup. Invalid or missing IDs, security failures and generation changes fail the entire request without partial items. `id` and `ids` are mutually exclusive; `maxBytes` applies only to batches.

Carry `expectedGeneration` on follow-ups. Discard prior read bindings when the generation or connection changes. Check the final explanation once for missing support. This is a caller procedure; BuildLore does not run an automatic reasoning loop or store a persistent read history.

For local profiling, `ReadServiceHooks.observer`, reader options `observer`, and `CliRuntime.readObserver` accept an optional synchronous callback. It receives only `{ phase, durationMs, count }`, never queries, IDs, paths or source text. Phase durations are inclusive, so do not sum nested intervals as exclusive work. Profiling is off by default and does not change response schemas or send telemetry.
