export const HELP_TEXT = `BuildLore — local-first, Git-backed development wiki tooling

Usage:
  buildlore knowledge clone --repository <locator> [--branch <name>] [--revision <object-id>]
  buildlore knowledge init
  buildlore knowledge status [--project-id <id>]
  buildlore project add --project-id <id> --display-name <name> --source-repository <identity>
  buildlore project list
  buildlore project show --project-id <id>
  buildlore project validate [--project-id <id>]
  buildlore --help

Options:
  -h, --help  Show this help message

Knowledge commands emit deterministic JSON and never include credentials or absolute workspace paths.
`;
