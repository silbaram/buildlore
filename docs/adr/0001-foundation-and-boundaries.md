# ADR 0001: Repository foundation and product boundaries

- Status: Accepted
- Date: 2026-08-19
- Decision owner: Plan2Agent Gate B for GitHub issue #2

## Context

BuildLore starts as a local-first product, not as an extension of the server and
PostgreSQL architecture used by `plan2agent-memory`. The first repository step must
make the intended deployment, knowledge, isolation, and upstream-integration
boundaries difficult to erode accidentally.

## Decision

1. The v0.1 reference implementation uses Node.js 24+, native ESM, TypeScript
   6.0.3, npm 11.19.0, `tsc`, Vitest, and type-aware ESLint. Direct development
   dependencies and the npm lockfile are exact; the license is MIT.
2. The product is local-first and Git-backed. Normal operation requires neither a
   central database nor a long-running server. Git commits, review, and history are
   the collaboration and provenance mechanism.
3. Compilation is file-oriented and compile-first. The knowledge contract remains
   language-neutral even though the reference CLI is TypeScript.
4. Mode A associates one code repository with one knowledge repository checked out
   as a submodule. Knowledge is partitioned by `projects/<project-id>/`, and project
   boundaries are enforced on every read and write.
5. Source moves through projector, sanitizer, compiler adapter, then knowledge and
   retrieval boundaries. Secret handling is fail-closed and occurs before external
   compilation or persistence.
6. `llm-wiki-compiler` will not be forked. A later step may add an exact-pinned
   upstream package behind the replaceable `src/compiler` adapter. Step 1 has no
   runtime dependency on it.

## Consequences

- A clean clone has one reproducible npm toolchain and four standard verification
  commands, at the cost of deliberately constraining supported Node/npm versions.
- Git works offline and makes knowledge changes reviewable, but real-time editing
  and central query services are outside v0.1.
- Submodule and `project-id` isolation keeps ownership explicit, but callers must
  handle missing or mismatched knowledge checkouts as errors.
- The adapter avoids an upstream fork and keeps replacement possible, but BuildLore
  must absorb compatibility work at that boundary.
- Fail-closed sanitization can reject uncertain inputs. This is preferred to
  leaking credentials or silently crossing project boundaries.
