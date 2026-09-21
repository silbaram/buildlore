# Changelog

## Unreleased

- Prefer directory source registration in setup guidance and authoring instructions.
  New directories include subdirectories by default; `--no-recursive` limits depth.
  Existing declarations retain their scope when re-added without a recursion option.
- Allow ordinary code filenames such as `tokens.ts` across selection and provenance
  validation while preserving credential-directory, credential-value and content checks.

- Preserve long Markdown, text, and code with bounded source fragments, original
  positions, and complete-input security checks. Resync retires obsolete fragments
  and recovers interrupted writes without changing approved Wiki history.
- Carry every source fragment through Wiki authoring and MCP evidence reads;
  reject incomplete fragment sets and preserve original citation locations.

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
