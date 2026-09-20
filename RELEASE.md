# Release checks and compatibility

BuildLore is currently a prerelease. The package remains private until an explicit
registry release. The installation default is one local dependency in the knowledge
Git checkout. Source projects connect to it; they do not need their own installation.

## Supported scope

- Linux/WSL with Node.js 24 is the tested runtime. Node 24+ is required; later Node
  majors need their own compatibility check. npm 11 is supported; maintainers use
  the repository-pinned npm 11.19.0 for lockfiles and release verification.
- Wiki generation, review, approval, activation and local read-only MCP are the core
  workflow. Embeddings are optional and are not installed with a production package.
- Native Windows authoring is not yet supported: POSIX permission checks remain a
  known limitation. macOS and paid Claude execution are not verified by this gate.
- MCP protocol readiness and activation in a particular AI client session are
  separate checks. Start a new trusted Codex source-project session and inspect
  `/mcp` after applying its configuration.
- `workspace check` allows 60 seconds per MCP request and five minutes overall.
  Validating approved history can make an initial read slow; timeout still fails
  the check and terminates its child process.

## Before distributing a candidate

Use npm 11.19.0. The following commands perform local builds and checks; none publish:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run lint
npm run typecheck
npm audit --omit=dev
npm run pack:local -- --output /path/to/release
npm run verify:installed-workspace -- --archive /path/to/release/buildlore-0.1.1-rc.1.tgz
```

`build` removes old `dist` outputs. `pack:local` validates compiled file coverage,
exports, skills and release assets and reports SHA-256 and npm integrity. Plain
`npm pack` also runs the clean-build hook. Keep the tested archive and its hashes;
do not rebuild a different archive for publication.

Installed verification uses Linux `bwrap`, a delivered tarball, two separate source
projects, deterministic authoring/review inputs, explicit fixture approval,
activation and publication, clone/reinstallation, owned Codex setup, and real MCP
search/read/isolation. The product source is hidden, network is disabled during the
workflow, and direct MCP reads use read-only mounts. This is not an AI writing or
productivity benchmark. Consumer dependencies are installed separately from the
development lockfile and audited too. Missing verification tools fail the gate.

Before a registry release, choose the version and tag, confirm package-name/account
permissions, review license/metadata and the exact archive, and explicitly remove
`private: true`. Rebuild and reverify that changed candidate. A metadata change is
not permission to publish. Account authentication and publication are separate
release actions; never put tokens in repository files.

## Stable contract policy

At 1.0, the supported public surface consists of documented CLI commands and flags,
versioned JSON envelopes and exported schemas, MCP tools, declared package exports,
and the stored knowledge formats needed to read existing approved generations.
Generated `dist` internals and unpublished deep imports are not public APIs.

- Patch releases fix behavior while retaining supported command/input and stored
  data compatibility. Minor releases add compatible capabilities.
- Breaking changes to a supported public contract require a major release, a
  documented migration path, and preservation of existing knowledge and approvals.
- New serialized meanings use explicit schema versions. Existing schema identifiers
  must not silently acquire incompatible meanings. A CLI version is distinct from
  a knowledge generation digest; upgrading the package does not approve new content.
- Before upgrading an existing knowledge checkout, record its Git state, retain
  the previous package artifact/version, install the candidate and run workspace
  setup/check. Inspect package metadata changes before committing them. Directory
  relocation requires explicit binding/connection repair.
- Automatic schema migrations, automatic Wiki approval and automatic package
  updates are not part of the current workflow.

The prerelease may still evolve. A final 1.0 decision requires the candidate checks
above and the actual installation-to-Codex-reading flow on the declared platform.
See [Semantic Versioning](https://semver.org/) for version increment rules.
