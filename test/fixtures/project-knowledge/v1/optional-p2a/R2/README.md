# Lantern

Lantern checks local documentation links for an offline maintainer. It reports broken links and writes a review report; it does not publish documentation or fetch remote sites.

The documented flow is CLI -> link resolver -> report writer. Link behavior belongs in src/links and report formatting in src/report. The documentation is a declared responsibility map, not a current implementation audit.

Automatic repairs remain unverified. The P2A artifacts in this fixture are synthetic history for testing knowledge interpretation, not real production verification.

An unresolved operations note still prescribes a maximum depth of 4, without establishing precedence over settings.json.
