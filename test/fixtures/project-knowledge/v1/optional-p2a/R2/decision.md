# Link policy

R1 decision: accept case-insensitive local links for compatibility with imported documentation. Strict matching was considered but deferred to reduce migration disruption.

R2 decision: supersede case-insensitive matching with strict case-sensitive matching. Portable Linux builds must not hide broken links. The cost is fixing older mixed-case references; automatic repair is still not verified.
