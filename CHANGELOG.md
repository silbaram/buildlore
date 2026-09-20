# Changelog

## Unreleased

- Connect a registered project and configure its owned Codex MCP entry from the
  knowledge checkout with `workspace connect --project <id> --client codex --apply`.
- Inspect installation, client settings and actual generation-bound MCP search/read
  with `workspace check`; distinguish readiness from current client-session activation.
- Add configuration guidance with `workspace guide --client codex`, preserving the
  existing guide contract without that option.
- Clean build output before packaging, reject obsolete compiled files, verify public
  exports and deliverable hashes, and inspect the exact supplied release archive.
- Use the package version for both the CLI and MCP handshake.
- Update vulnerable compatible transitive dependencies in the development lockfile.
- Document local installation, recovery, supported platforms and stable contract policy.

No npm registry release has been performed for these changes.
