# Entry Reference Bundle

Read this only when the validated entry has a sibling `p2a-reference-bundle.json` and
one or more declared references may materially affect Gate B.

The entry document remains the human-readable scope source. Use the bundle as a
conditional index: inspect `id`, `path`, `kind`, `sha256`, `load_when`, and
`description` first, then open only references whose load condition matches a current
spec decision or verification need. Never bulk-inject the bundle contents.

Before relying on a selected file, validate the Gate A snapshot and open the captured
path under `gate-a-intake/reference-sources/`, not a mutable original working file.
Add the inspected captured file as `LOCAL-n` evidence and include its `REF-n` id,
declared hash, and supported decision in `used_for`.

Gate A creates `gate-a-intake/reference-bundle-snapshot.json` with
`p2a reference snapshot`; do not hand-author that sidecar. Before Gate B approval,
write the sibling
`gate-b-spec/reference-bundle-usage.json` using `p2a.reference_bundle_usage.v1`.
Its snapshot and bundle hashes must match Gate A exactly, and every inspected `REF-n`
must map one-to-one to the matching `LOCAL-n` evidence. Conversely, every `LOCAL-n`
whose URL identifies a captured declared reference must appear exactly once in the
usage sidecar. Record `supported_decision` as an existing structured spec field path,
such as `spec.product.screens_or_interfaces`, rather than as free-form rationale.
Write an empty `inspected_references` list when no bundled reference was opened so
non-use is explicit. `p2a decide` binds each sidecar path and SHA-256 into the relevant
approval audit; do not edit an approved sidecar in place.

A reference that was not inspected stays context and cannot support a claim,
technology choice, acceptance criterion, or approval.

Missing files, stale hashes, duplicate ids or paths, unsupported kinds, and paths that
escape the project root block the entry contract. Resolve the bundle error instead of
silently dropping the reference.
