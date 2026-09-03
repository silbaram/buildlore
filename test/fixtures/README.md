# Test fixtures

Place deterministic, non-secret fixtures for compiler and projection tests in this directory.
Do not copy credentials, private repositories, or unredacted source content into fixtures.

Git lifecycle tests create disposable local bare repositories under temporary test
directories. They must never use hosted remotes, real credentials, or a permanent
`knowledge/` gitlink in the BuildLore checkout.

`hierarchical-approved-authority-v22.json.gz.base64` is a deterministic, synthetic
two-page approved-authority compatibility fixture generated from repository commit
`490a3bef2e1ca49a419392811143d4a41a02fb78`. Decode Base64, then gunzip it; the
canonical JSON SHA-256 is
`7dcedaf34331559d4e418095205c6d47b6f77eb0086e3ad2862fdd76c32b0a56`.
