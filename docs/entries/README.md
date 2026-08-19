# Plan2Agent entry snapshots

Each GitHub issue used to start Plan2Agent work is captured as an immutable Markdown
snapshot in this directory. The snapshot lets Gate decisions refer to reviewed
bytes instead of to a remote issue that may later change.

## Required frontmatter

Use a lowercase, hyphenated name such as `github-issue-2.md` and record:

- `source_type`, normally `github_issue`
- canonical `source_url`
- `repository`, `issue_number`, and observed `issue_state`
- source creation/update time and `snapshot_fetched_at`
- `source_content_sha256`

After the closing `---` line, preserve the captured issue title and body exactly.
The SHA-256 value is calculated over every byte after that closing delimiter and
its newline, including the leading blank line before the Markdown heading. Do not
silently edit a captured body; fetch a new snapshot and update all provenance fields.

This Node.js command checks the recorded body hash:

```sh
node --input-type=module -e "import{createHash}from'node:crypto';import{readFileSync}from'node:fs';const p=process.argv[1],s=readFileSync(p,'utf8'),i=s.indexOf('\\n---\\n',4),m=Object.fromEntries(s.slice(4,i).split('\\n').map(l=>l.split(': '))),h=createHash('sha256').update(s.slice(i+5)).digest('hex');if(h!==m.source_content_sha256)process.exit(1)" docs/entries/github-issue-2.md
```

Validate and enter the example snapshot with:

```sh
p2a validate --entry docs/entries/github-issue-2.md
p2a next --entry docs/entries/github-issue-2.md
```

Do not put credentials, private issue bodies, access tokens, or unrelated user data
in a snapshot intended for the repository.
