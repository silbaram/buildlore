# Storage decision

R1 decision: use a SQLite database for local manifests. The rationale is transaction support without a server. Plain files were considered but deferred because updating several records consistently needs extra care.

This is a declared design decision, not an execution result or installation inspection.
