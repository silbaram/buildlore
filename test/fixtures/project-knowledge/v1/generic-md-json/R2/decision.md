# Storage decision

R1 decision: use a SQLite database for local manifests. The rationale is transaction support without a server. Plain files were considered but deferred because updating several records consistently needs extra care.

This is a declared design decision, not an execution result or installation inspection.

R2 decision: replace the SQLite design with plain JSON manifest files. The operator needs readable Git diffs and no database setup. The trade-off is explicit staging and recovery for multi-file updates. The prior SQLite decision is superseded, not silently erased.
