# Register source directories

Run these commands with the installed BuildLore CLI from the knowledge checkout.
Use the explicitly selected project and its bound source checkout.

1. Inspect `source list --project <id> --json`. Keep the user's chosen scope and
   existing JSON extraction profiles. Sync uses these declarations; it does not
   discover or register the whole repository automatically.
2. For new selections, prefer one declaration per directory and document kind.
   Choose actual folders relevant to the user's purpose: documentation, research,
   policies, operational notes or code. `src` and `test` are examples for code
   projects, not required folders or a Wiki template. Do not enumerate hundreds
   of files when the user selected their containing directory.
3. Register the selected folder with
   `source add --project <id> --id <selection-id> --kind <markdown|text|code|json> --path <relative-directory> --json`.
   A new directory includes subdirectories by default and stores `recursive: true`.
   Only supported files of that kind are selected. Use a separate declaration per
   kind for a mixed directory. Use `--no-recursive` when only direct files are wanted.
   Code filenames such as `tokens.ts` are allowed; their contents still undergo
   credential checks. Credential storage paths and credential values in paths
   remain blocked.
   Existing directory declarations retain their previous recursion setting when
   re-added without an option; conflicting changes to the same ID are rejected.
4. Individual files such as a root README or a specifically selected document
   remain valid. Avoid overlapping file and folder selections. Replacing a file
   list with a directory expands scope and changes source identities: do this
   only within the user's authorized selection, preserve custom metadata, and
   validate the resulting manifest. Do not silently rewrite existing declarations.
5. Run `source list --project <id> --json` and `sync --project <id> --dry-run --json`
   before applying sync. New matching files added inside a selected directory are
   picked up on later syncs without changing the manifest. Existing approvals and
   Wiki pages remain unchanged until a new generation is reviewed and activated.
