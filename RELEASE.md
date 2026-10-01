# Release checks and compatibility

BuildLore is currently a prerelease. Distribution uses versioned prebuilt npm
archives attached to GitHub Releases; npm registry publication is not required.
The candidate is 0.1.1-rc.2 and remains `private: true`. Until its assets are
published, URL examples are proposals, not available downloads. The installation default is one local dependency in the knowledge
Git checkout. Source projects connect to it; they do not need their own installation.

## Supported scope

- Linux/WSL with Node.js 24 is the tested runtime. Node 24+ is required; later Node
  majors need their own compatibility check. npm 11 is supported; maintainers use
  the repository-pinned npm 11.19.0 for lockfiles and release verification.
- Wiki generation, review, approval, activation and local read-only MCP are the core
  workflow. Embeddings are optional and are not installed with a production package.
- State storage uses OS-specific permission checks, retaining POSIX `0700`/`0600`
  enforcement on Linux. Native Windows authoring still needs executed validation;
  do not claim support from a Linux run or simulated Windows mode bits. Windows
  access uses the existing folder ACL; use a folder restricted to the current user.
  BuildLore does not rewrite ACLs or promise exclusive access from mode bits.
  macOS and paid Claude execution are not verified by this gate.
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
npm run test:release-packaging
npm run release:prepare -- --output /path/to/empty-release-directory
npm run verify:installed-workspace -- --archive /path/to/empty-release-directory/buildlore-0.1.1-rc.2.tgz
npm run verify:release-install -- --archive /path/to/empty-release-directory/buildlore-0.1.1-rc.2.tgz --previous-archive /path/to/previous/buildlore-0.1.1-rc.1.tgz
```

`release:prepare` writes the tarball, SHA256SUMS and release-notes.md, using an empty
output directory and refusing replacement. Its `verified: false`/`published: false`
result is not a claim of passing verification or actual publication.

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

For native Windows, run the separate check with Node 24+, npm 11.19.0 and Git:

```sh
npm run verify:windows-authoring -- --archive /path/to/release/buildlore-0.1.1-rc.2.tgz
```

Use a real Windows path with quotes when it contains spaces. This check installs
the supplied archive into a temporary knowledge repository, exercises both state
store persistence and generic Wiki drafting/review/explicit fixture approval/
activation, and reads it through the installed MCP. It checks stale generations
and wrong-project requests. It uses temporary client settings and no paid AI.
Linux/WSL cannot satisfy its native-platform check. Its summary records the archive
hash and completed stages; it does not claim network or filesystem-mount isolation.

Before a registry release, choose the version and tag, confirm package-name/account
permissions, review license/metadata and the exact archive, and explicitly remove
`private: true`. Rebuild and reverify that changed candidate. A metadata change is
not permission to publish. Account authentication and publication are separate
release actions; never put tokens in repository files.

## Publish the verified GitHub assets

After the required checks pass and publication is explicitly approved, commit the
reviewed source/metadata and create/push the matching version tag through the normal
Git review process. Verify that the tag points to the tested source. Upload the
**identical** tarball and SHA256SUMS in GitHub’s release UI with the generated notes,
or run this from the prepared release directory after the tag already exists:

```sh
gh release create v0.1.1-rc.2 --repo silbaram/buildlore --verify-tag --prerelease --title "BuildLore 0.1.1-rc.2" --notes-file release-notes.md buildlore-0.1.1-rc.2.tgz SHA256SUMS
```

This is an external publication command, not part of `release:prepare`. Do not replace
an existing tag’s assets; issue a new version. Retain old releases for reproducible
installation and rollback. GitHub’s automatic source-code archives are not the npm
package. npm `private: true` does not prevent this archive distribution.

After publication, install the real HTTPS asset URL in a disposable knowledge checkout
and repeat CLI version, initialization and MCP read checks; compare the downloaded
archive to SHA256SUMS. Local HTTP URL verification does not establish that GitHub
published or serves the intended bytes. URL installation records the dependency and
integrity in npm metadata; dependencies may still require registry access.

## URL installation and upgrade

Run `npm install --save-exact "<versioned-release-tgz-URL>"` inside the knowledge
checkout; runtime files live in `node_modules/buildlore/`. Execute them with
`npx --no buildlore ...`. Upgrade with a different explicit version URL, then check the
version and every project’s `workspace check` and restart clients/MCP. Do not routinely
reinitialize on upgrade. Installation does not migrate or approve Wiki data. Keep npm
metadata commits separate from project publication.

For rollback, explicitly reinstall a compatible previous URL/archive and repeat read
checks. For a fresh clone with committed URL metadata, `npm ci` restores the package
while that URL is accessible; `workspace init`, source binding and client configuration
still require the existing documented restore steps. A local-file dependency requires
separate delivery if its old path is unavailable. `npm update` does not discover new
GitHub Release asset URLs.

`verify:release-install` requires both the candidate and a compatible previous archive
with different real versions. It uses local HTTP versioned endpoints, fresh npm caches
for clone/ci and integrity rejection, two authored/approved projects and installed
MCP reads across upgrade and rollback. It compares existing knowledge, approval history
and connection byte hashes. It retains Linux source-hidden/network-disabled runtime
and read-only MCP checks; it does not start a product HTTP server or contact a model.

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
