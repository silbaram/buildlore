# Provider Confinement and Write Boundaries

Read this reference immediately before a write-capable owner starts or resumes implementation. It defines authority and workspace boundaries; it is not optional for a write run.

## Provider confinement

- Codex write-capable runs use native `workspace-write` sandbox confinement inside the assigned run workspace or isolated worktree.
- Claude write-capable runs may continue autonomously inside scaffold confinement only when deny rules, the PreToolUse hook, and the supported macOS/Linux OS sandbox are active.
- Gemini remains read-only. Hand write execution to a confined Codex or Claude owner.
- Use one write-capable provider per batch. Do not mix providers in one write batch.
- When independent confinement is unavailable, use the single-owner path.

The approved Gate B execution envelope authorizes in-scope implementation and verification retries. External writes, new credentials, costs, deployment, irreversible actions, or broader authority still require user authorization. Prefer repository and approved-source evidence; use live web research only when version-sensitive facts are necessary and network reads are authorized.

## Workspace ownership

- Write only inside the run `workspaceRef` or assigned worktree.
- Preserve unrelated user changes. Do not rewrite or delete files merely because they are outside the current task.
- Require an isolated worktree only for concurrent write owners, batch execution, explicit project policy, or a concrete rollback/isolation risk.
- In batch mode, the owner may also write to the approved canonical integration worktree and the owner-only integration-candidate worktree described in `batch-execution.md`.
- Do not mark an isolated-worktree task done until its accepted result is present on the approved canonical integration branch.

When the target product is the Plan2Agent repository, canonical `.agents/`, scripts, schemas, tests, and docs are product files. Generated provider mirrors must still be produced from their canonical source. In an application repository, installed Plan2Agent harness and integration files are outside application implementation scope.

## Prohibitions

- Do not change Gate artifacts or requirements to make implementation easier.
- Do not install dependencies without evidence from the approved task, existing project conventions, or explicit user approval.
- Do not run interactive scaffolders that may overwrite a non-empty co-located project.
- Do not access, print, or exfiltrate `.env` files, credentials, or tokens.
- Do not hide failing verification or manufacture passing evidence.
- Do not perform remote push, PR creation, remote merge, deployment, or other external writes as part of an implementation run. A separate explicit request is handled by the foreground assistant within its existing tool/provider permissions and the requested targets, not delegated to an implementer or treated as implicit development approval.
- Do not modify `.plan2agent/constitution.json` or `.plan2agent/style.md` during implementation.
- Do not self-modify skills or agents as a retrospective side effect. A skill change is allowed only when it is the approved product objective itself.

## Constitution and style

Before implementation, check for `.plan2agent/constitution.json`. When present, validate and read the complete approved constitution. Validator prohibitions are hard constraints; review and advisory prohibitions guide implementation judgment. If no constitution exists, infer ordinary repository conventions from inspected project files and treat them as advisory guidance. A legacy `.plan2agent/style.md` may supplement that guidance, but it is not required and does not trigger migration or a new approval. The approved spec and explicit task constraints take precedence over conflicting legacy style.
