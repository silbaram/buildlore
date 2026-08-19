# ADR 0003: Project-scoped compiler adapter

- Status: Accepted
- Date: 2026-08-19
- Decision owner: Plan2Agent Gate B for GitHub issue #4

## Context

BuildLore must expose the supported `llm-wiki-compiler` operations without allowing
callers to choose a workspace path, bypass project isolation, or accidentally send
content to a provider. The upstream public SDK does not expose active cancellation,
an operation-wide timeout, or progress callbacks.

## Decision

1. BuildLore exact-pins `llm-wiki-compiler@1.1.0` and imports only its package-root
   SDK. The accepted package has npm integrity
   `sha512-LJslVmSt8tng8n3t0tw1QEqZJKKD0ualJ/WupdZMCtCzmCNarkP999k6hiNIg5ezvE8B/JQ1C1bUi6eY88Q79A==`
   and release commit `6963a7f8374282de5d4084a324be69b50f62a32d`.
2. The adapter exposes compile, status, lint, fast evaluation, full evaluation,
   search, query, and context-pack capabilities through the public SDK. It has no
   subprocess, stdout parsing, deep import, fork, or CLI fallback.
   Before compile, a public `status()` preflight may return a true no-op only when
   state is healthy, pending changes are exactly zero, and no recovery warning is
   present. This avoids the upstream 1.1.0 clean-compile path rewriting only the
   generated timestamp in `wiki/index.md`; every uncertain state still invokes
   `compile()`.
3. Every public operation accepts a `projectId`, never a workspace path. A fresh
   manifest/descriptor lookup plus lexical and realpath validation resolves the
   selected `projects/<projectId>` workspace before execution. Operations for one
   project are serialized in-process; different projects remain independent.
4. Compile, full evaluation, search, query, and semantic context deny provider
   egress by default. They require an opaque, project-and-capability-bound,
   single-use permit from an injected authorizer. Context is conditional because
   upstream embeds the prompt when semantic chunks are enabled; `topChunks: 0`
   disables that path and remains local. Provider configuration and secrets stay
   in the environment or external provider configuration and are not included in
   results or errors.
5. Status, lint, fast evaluation, and local context-pack generation do not require
   a provider. Lint and search are read-only. Compile writes wiki content. Full
   evaluation can write citation cache even when evaluation records are disabled.
   Query disables answer-page persistence but upstream still appends the question
   and selected pages to `log.md`, so query is explicitly a log-writing capability.
6. Results and failures use bounded, language-neutral BuildLore contracts. Raw
   provider messages, response bodies, prompts, reasoning, judgements, credentials,
   and absolute paths are never forwarded. Semantic-context provider/retrieval
   failure warnings are promoted to terminal failures; store-missing, stale, and
   other explicit degraded-read warnings remain bounded warning codes.
7. Cancellation before SDK invocation fails without side effects. Cancellation
   requested after invocation waits for the SDK operation to settle, suppresses a
   success result, and reports that side effects may have occurred. BuildLore does
   not claim active interruption, progress, or an overall deadline. Documented
   provider-request timeout settings are validated and provider timeouts map to a
   safe recovery-oriented failure. A host process may translate `SIGINT` or
   `SIGTERM` into the supplied `AbortSignal`; the adapter does not install global
   signal handlers, call `process.exit`, or detach the in-flight SDK operation.
8. `SearchResult` and other runtime shapes follow the exact shipped package-root
   TypeScript declarations when prose examples differ.

## Capability matrix

| Capability | Provider | Workspace effect | Egress |
| --- | --- | --- | --- |
| compile | Required | Wiki content write | Sanitized source |
| status | None | None | None |
| lint | None | None | None |
| eval-fast | None | None | None |
| eval-full | Required | Citation cache write | Citation evidence |
| search | Required | None | Question and wiki |
| query | Required | `log.md` write | Question and wiki |
| context | Conditional (`topChunks !== 0`) | None | Prompt embedding |

## Consequences

- Callers must explicitly authorize every provider-backed operation.
- Post-start cancellation and provider timeouts require a status check before a
  retry when workspace side effects are possible.
- The adapter can be replaced or upgraded behind one boundary, but any package
  version, integrity, public-type, or capability change requires a new review.
- No new end-user compiler CLI commands are introduced by this decision.
