# ADR 0002: Mode A knowledge repository and project workspaces

- Status: Accepted
- Date: 2026-08-19
- Decision owner: Plan2Agent Gate B for GitHub issue #3

## Context

BuildLore keeps product code and durable development knowledge on different Git
lifecycles. One knowledge repository must support multiple projects without using
the repository root as a compiler workspace or allowing one project to read another.

## Decision

1. The code repository binds exactly one `knowledge/` Git submodule. `.gitmodules`
   carries the credential-free repository locator and optional branch; the Git
   index entry carries the pinned commit.
2. `knowledge/manifest.json` uses `buildlore.knowledge.v1`. Its entries are sorted
   by immutable lowercase-kebab `projectId` and use the canonical path
   `projects/<projectId>`.
3. Each workspace contains `project.json`, `sources/`, `wiki/`, `.llmwiki/`, and
   `log.md`. `project.json` uses `buildlore.project.v1`. The top-level `knowledge/`
   directory is never passed to the compiler.
4. Registry replacement uses an exclusive mutation lock and a same-directory
   temporary file followed by sync and rename. Workspace creation is staged before
   the registry points to it.
5. Project resolution combines canonical lexical paths with `lstat` and `realpath`.
   Symlinks, junctions, absolute paths, traversal, malformed manifests, and
   descriptor mismatches fail closed.
6. Git subprocesses use argv without a shell. HTTPS, SSH/SSH-scp, and explicit
   relative local locators are supported; credentials, query strings, fragments,
   absolute personal paths, and custom remote helpers are rejected.
7. `llm-wiki-compiler@1.1.0` is exact-pinned. BuildLore imports only its package-root
   `createWiki` export and uses read-only `status()` for direct `sources/*.md`
   change detection. Compile, provider, retrieval, and query integration remain a
   later step.

## Provisional `.llmwiki` tracking matrix

| Class | Step 2 policy |
| --- | --- |
| `manifest.json`, `project.json`, `sources/*.md`, `wiki/`, `log.md` | Track |
| `.llmwiki/state.json`, candidates, workflows, eval output | Review before Step 10 |
| `.env`, credentials, embedding caches, locks, journals, temp/backup files | Ignore |

The initializer creates safe ignore defaults only when the knowledge repository has
no `.gitignore`; it never overwrites a repository-owned policy. Step 10 will make the
final publish decision for compiler state.

## Consequences

- Git-native pins and offline bare repositories make lifecycle tests deterministic,
  but callers must handle uninitialized, mismatched, and conflicted submodules.
- Strict paths and metadata reduce flexibility in exchange for enforceable project
  isolation and portable manifests.
- Crash-safe registry writes can leave a valid but unregistered staged workspace;
  an exact descriptor match can be resumed, while any mismatch requires explicit
  operator cleanup.
- The compiler adapter proves source compatibility without credentials, but it does
  not yet generate or retrieve Wiki content.
