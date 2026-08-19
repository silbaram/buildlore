# Test fixtures

Place deterministic, non-secret fixtures for compiler and projection tests in this directory.
Do not copy credentials, private repositories, or unredacted source content into fixtures.

Git lifecycle tests create disposable local bare repositories under temporary test
directories. They must never use hosted remotes, real credentials, or a permanent
`knowledge/` gitlink in the BuildLore checkout.
