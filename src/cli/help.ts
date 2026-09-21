export const HELP_TEXT = `BuildLore — local-first, Git-backed development wiki tooling

Usage:
  buildlore --version
  buildlore mcp --project-dir <absolute-source-root> --read-only
  buildlore client configure|remove --client codex|claude-code --project-dir <absolute-source-root> [--apply --expect-plan <digest>] [--json]
  buildlore workspace guide [--project <id>] [--client codex] [--json]
  buildlore workspace init [--knowledge-repo <portable-locator>] [--json]
  buildlore workspace connect --project <id> --client codex [--apply] [--json]
  buildlore workspace check --project <id> --client codex [--json]
  buildlore connect --workspace <knowledge-repository-path> --project <id> [--source-repo <locator>] [--json]
  buildlore setup --hub <path> --knowledge-repo <portable-locator> [--json]
  buildlore connect --hub <path> --project <id> [--source-repo <locator>] [--json]
  buildlore disconnect [--remove-shared] [--json]
  buildlore connection status [--project <id>] [--json]
  buildlore connection relocate-hub --from <absolute-old-root> --to <absolute-new-root> --knowledge-repo <locator> [--apply --expect-plan <digest>] [--json]
  buildlore doctor [--project <id>] [--json]

Connected source reads may omit --project. read/lookup/citations require --expect-generation <sha256:...>; list/search/memory accept it optionally.

  buildlore init --knowledge-repo <url-or-path> [--branch <name>] [--json]
  buildlore init --project <project-id> --source-repo <portable-id> --source-root <absolute-path> [--knowledge-repo <url-or-path>] [--branch <name>] [--name <display-name>] [--json]
  buildlore project add --id <project-id> --source-repo <portable-id> --source-root <absolute-path> [--name <display-name>] [--json]
  buildlore project bind --project <project-id> --source-root <absolute-path> [--json]
  buildlore project list [--json]
  buildlore project show --project <project-id> [--json]
  buildlore source add --project <project-id> --id <declaration-id> --kind markdown|text|code|json --path <relative-directory-or-file> [--recursive|--no-recursive] [--json]
  buildlore source list --project <project-id> [--json]
  buildlore source diff --project <project-id> [--json]
  buildlore wiki list --project <project-id> [--cursor <opaque-cursor>] [--limit <1-100>] [--json]
  buildlore wiki curate --project <project-id> [--json]
  buildlore wiki read --project <project-id> --page <page-type/slug|page-sha256-id|overview|architecture|decisions> [--view full|reader] [--json]
  buildlore wiki packet --project <project-id> [--json]
  buildlore wiki memory --project <project-id> [--task <text> [--max-bytes <2048-65536>] [--progressive [--cursor <cursor>]]] [--json]
  buildlore wiki lookup --project <project-id> --kind evidence|fact --id <sha256:id> --expect-generation <sha256:generation> [--json]
  buildlore wiki lookup --project <project-id> --kind evidence|fact --ids <sha256:id,...> --expect-generation <sha256:generation> [--max-bytes <2048-65536>] [--json]
  buildlore wiki citations --project <project-id> --page <page-type/slug|page-sha256-id> [--json]
  buildlore export --project <project-id> --format json|okf --output <directory> [--json]
  buildlore sync --project <project-id> [--dry-run] [--json]
  buildlore compile --project <project-id> [--review] [--json]
  buildlore compile plan --project <project-id> [--json]
  buildlore compile apply --project <project-id> --page <proposal.json> [--page <proposal.json> ...] [--json]
  buildlore compile candidates --project <project-id> [--json]
  buildlore compile approve --project <project-id> --candidate <candidate-id> [--json]
  buildlore compile activate --project <project-id> --confirm-approval <sha256:...> [--input <approved-bundle.json>] [--json]
  buildlore compile activate --project <project-id> --rematerialize [--json]
  buildlore compile wiki start --project <project-id> --purpose <relative.json> [--json]
  buildlore compile wiki status --project <project-id> --run <run-id> [--json]
  buildlore compile wiki inspect|submit|review|revise --project <project-id> --run <run-id> --input <relative.json> --expect-stage <sha256:...> [--json]
  buildlore compile wiki finalize --project <project-id> --run <run-id> --expect-stage <sha256:...> [--json]
  buildlore compile wiki approve --project <project-id> --run <run-id> --expect-ledger <sha256:...> --confirm-approval [--json]
  buildlore compile hierarchy start --project <project-id> --purpose <relative.json> [--allow-legacy-authoring] [--json]
  buildlore compile hierarchy status --project <project-id> --run <run-id> [--role author|completeness-reviewer|source-reviewer] [--json]
  buildlore compile hierarchy inspect --project <project-id> --run <run-id> --input <relative.json> --expect-exchange <sha256:...> [--json]
  buildlore compile hierarchy submit --project <project-id> --run <run-id> --input <relative.json> --expect-exchange <sha256:...> [--json]
  buildlore compile hierarchy resubmit --project <project-id> --run <run-id> --page <page-id> --input <relative.json> --expect-exchange <sha256:...> [--json]
  buildlore compile hierarchy child-review --project <project-id> --run <run-id> --input <relative.json> --expect-review <sha256:...> [--json]
  buildlore compile hierarchy review --project <project-id> --run <run-id> [--role author|completeness-reviewer|source-reviewer] [--json]
  buildlore compile hierarchy finalize --project <project-id> --run <run-id> --input <relative.json> --expect-review <sha256:...> [--json]
  buildlore compile hierarchy finalize --project <project-id> --run <run-id> --input <relative.json> --expect-stage <sha256:...> [--json]
  buildlore compile hierarchy completeness shadow|inventory|inventory-review|reconcile|submit|review|source-review|correct|correct-inventory --project <project-id> --run <run-id> --input <relative.json> --expect-stage <sha256:...> [--json]
  buildlore compile hierarchy approve --project <project-id> --run <run-id> --expect-ledger <sha256:...> --confirm-approval [--json]
  buildlore check --project <project-id> [--json]
  buildlore index status --project <project-id> [--json]
  buildlore index rebuild --project <project-id> [--full] [--json]
  buildlore search --project <project-id> --query <text> [--mode lexical|graph|semantic|hybrid] [--intent auto|current|historical|neutral] [--json]
  buildlore query --project <project-id> --question <text> [--json]
  buildlore context --project <project-id> --prompt <text> [--json]
  buildlore model bind --profile multilingual-e5-small [--directory <path>] [--json]
  buildlore model inspect --profile multilingual-e5-small [--json]
  buildlore model verify --profile multilingual-e5-small [--json]
  buildlore publish plan --project <project-id> --source-revision <full-oid> [--include-policy-track] [--registration] [--json]
  buildlore publish commit --project <project-id> --source-revision <full-oid> --expect-plan <sha256> [--include-policy-track] [--registration] [--json]
  buildlore publish push --project <project-id> --knowledge-revision <full-oid> [--json]
  buildlore knowledge pin plan --knowledge-revision <full-oid> --iteration <id> --intent iteration-close [--json]
  buildlore knowledge pin commit --knowledge-revision <full-oid> --iteration <id> --intent iteration-close --expect-plan <sha256> [--json]
  buildlore --help

Common options:
  --json      Emit one buildlore.cli-envelope.v1 JSON object instead of human-readable text
  -h, --help  Show this help message

Source registration:
  Prefer one declaration per selected directory and kind, rather than enumerating files.
  New directories include subdirectories by default; --no-recursive selects only direct files.
  Existing declarations retain their scope when re-added without a recursion option.
  Files remain supported for individual documents. New matching files in a selected directory
  are included on the next sync without editing the manifest. Preview with sync --dry-run.
  Example: buildlore source add --project my-project --id docs --kind markdown --path docs

Provider requirements:
  None         init, project, source, sync, wiki, export, check, index status, lexical/graph search, compile plan/apply/candidates/approve/activate/hierarchy
  Conditional  index rebuild, semantic/hybrid search, context
  Required     legacy compile, query

Session compilation:
  compile plan   Emits a deterministic sanitized plan for the current agent session
  compile apply  Validates canonical proposal files and stages review-only candidates
  compile candidates  Lists project-confined review candidates without exposing page bodies
  compile approve  Promotes exactly one bound candidate without provider or Git publication
  compile activate Validates approval and stores authority plus deterministic tracked Markdown
                   (default input: .buildlore/approved-wiki.json)
  compile wiki  Writes free-topic Wiki pages, independently reviews and corrects them; preserves open issues.
  compile hierarchy  Exchanges confined JSON handoffs with the current agent session.
  hierarchy approve  Records explicit human approval and stages the activation bundle.
                     Project knowledge stores generations separately; activation remains explicit.
                     Existing history is retained. Rebuild the semantic index after activation.
  BuildLore never launches a Claude or Codex CLI process; it never launches any agent process.
  The caller session owns generation.

Local semantic index:
  wiki curate    Emits bounded, read-only review suggestions from the clean active Wiki;
                 it never calls a model or mutates, merges, approves, or deletes a page.
  index status   Inspects approved projection, Markdown materialization, and semantic generation
  index rebuild  Explicitly rebuilds changed vectors; --full disables vector reuse
  Search never downloads a model, starts a server, or rebuilds an index implicitly.

Evidence reading:
  Reuse inspected excerpts bound to the current project, generation and source digest.
  Listed IDs alone are not inspected support. Retrieve missing support with lookup.
  --ids accepts 1-16 IDs of one kind; default batch budget is 32768 bytes.
  Split oversized batches; cite only material actually read and preserve unknowns.

Compatibility aliases:
  knowledge clone, knowledge init, knowledge status, project validate

Source roots are explicit local-only bindings and are never written to knowledge or command output.
Project-scoped commands require --project and never infer a default project.
Output never includes credentials, source bodies, or stack traces.
`;
