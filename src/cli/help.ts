export const HELP_TEXT = `BuildLore — local-first, Git-backed development wiki tooling

Usage:
  buildlore init --knowledge-repo <url-or-path> [--branch <name>] [--json]
  buildlore project add --id <project-id> --source-repo <path-or-url> [--name <display-name>] [--json]
  buildlore project list [--json]
  buildlore project show --project <project-id> [--json]
  buildlore sync --project <project-id> [--dry-run] [--json]
  buildlore compile --project <project-id> [--review] [--json]
  buildlore check --project <project-id> [--json]
  buildlore search --project <project-id> --query <text> [--mode lexical|semantic|hybrid] [--json]
  buildlore query --project <project-id> --question <text> [--json]
  buildlore context --project <project-id> --prompt <text> [--json]
  buildlore --help

Common options:
  --json      Emit one buildlore.cli-envelope.v1 JSON object instead of human-readable text
  -h, --help  Show this help message

Provider requirements:
  None         init, project, sync, check, lexical search
  Conditional  semantic/hybrid search, context
  Required     compile, query

Compatibility aliases:
  knowledge clone, knowledge init, knowledge status, project validate

Project-scoped commands require --project and never infer a default project.
Output never includes credentials, source bodies, or stack traces.
`;
