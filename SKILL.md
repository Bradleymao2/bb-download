---
name: bb-download
description: >-
  Sync or archive ALL content of a Blackboard (LMS) course into the workspace — resolve the
  course from an already-logged-in browser session over CDP, crawl every content area and folder,
  download every attachment with md5 dedupe, skip what is already on disk, extract course zip
  packages, file pre-existing copies into the archive, regroup multi-file items into folders,
  write a README index, and verify 100% coverage against the live site. Use this whenever the user
  wants to download, sync, back up or archive a course's slides, materials, files or assignments
  from Blackboard - e.g. "download all the content of course 6244", "把课程资料都抓下来",
  "sync my course files", "download all course materials", "BB download", even when they don't
  name Blackboard but give a course code together with 资料/课件/content. Also load it when an
  embedded/in-app browser is the logged-in one and cannot be driven: it explains how to take over
  the user's own browser session over the DevTools protocol instead.
---

# BB Download

Download a whole Blackboard course (content areas + assessment area) into a workspace, dedupe
against what is already on disk, extract course zip packages, index everything, and verify
coverage against the live site.

Typical request: 「帮我下载 6244 课程的所有 content 到工作区，重复的不用下载，工作区已经有的不用下载」.

## Requirements

- Windows, Microsoft Edge (the scripts relaunch it with `--remote-debugging-port`).
- Node.js 18+ (uses global `fetch`), plus `puppeteer-core` (`npm i puppeteer-core`, or point
  `PUPPETEER_CORE_PATH` at an existing install).
- Python 3 (stdlib only) for zip unpacking and the local/md5 checks. Not needed if the course has
  no zip packages, but almost every course does.
- A browser profile already logged in to Blackboard. Cookies are read over CDP and kept in
  memory only — nothing is written to disk.

Set these once per shell (adjust to your machine):

```powershell
$SKILL = "<path to this skill>"      # e.g. ~/.dsh/skills/bb-download  or  <repo>
$NODE  = "node"                      # or an explicit path if node is not on PATH
$PY    = "python"                    # or python3
$HOST  = "https://bb.your-university.edu"
```

## Workflow

```powershell
# 1) Make sure Edge exposes CDP (idempotent: attaches if already up, restarts Edge only if needed)
powershell -NoProfile -File "$SKILL\scripts\ensure-edge-cdp.ps1"

# 2) Resolve the course id from the logged-in session -> _bb_sync/course.json
& $NODE "$SKILL\scripts\bb.mjs" resolve --dir . --course-code 6244 --host $HOST

# 3) Crawl structure only -> _bb_sync/tree.json. Read the printed tree before downloading.
& $NODE "$SKILL\scripts\bb.mjs" crawl --dir .

# 4) Download with dedupe; course zips are extracted and the zip removed
& $NODE "$SKILL\scripts\bb.mjs" download --dir . --dest course_content

# 5) OPTIONAL - file pre-existing copies into the archive / regroup multi-file items
& $PY "$SKILL\scripts\bb_archive.py" --dir . --dest course_content

# 6) Index -> <dest>/README.md (tree + per-item status + archive notes)
& $PY "$SKILL\scripts\bb_manifest.py" --dir . --dest course_content

# 7) Verify against the live site, then check what is on disk
& $NODE "$SKILL\scripts\bb.mjs" verify --dir .
& $PY "$SKILL\scripts\bb_verify_local.py" --dir . --dest course_content
```

`resolve` prints every enrolled course and never guesses: the course id is read from the
launcher links of the logged-in Home page. If it reports a login page instead of
`Welcome, <name>`, ask the user to log in once in that Edge window and rerun.

**Do not claim the archive is complete before step 7 passes.** Verification re-crawls and
re-downloads every attachment, so it catches both "a file was missed" and "a file changed after
we copied it".

## What the scripts already handle

**Course discovery.** The Home tab lists `<a href=".../launcher?type=Course&id=_NNNN_1&url=">ACT6244:…</a>`.
Match `--course-code` against that text. Then read the course menu and crawl every
`listContent.jsp?...&content_id=_X_1` entry (typically `Content` and `Assessment Scheme`),
recursing into folders (depth ≤ 6). Tools (`launchLink.jsp`), assignment dropboxes
(`uploadAssignment`), announcements and discussions carry no course files and are skipped.

**Filename resolution**, in order: `Content-Disposition` (handles `filename*=UTF-8''…`,
iso-8859-1, quoted, RFC2047) → last URL segment when it has an extension → anchor text when it
looks like a filename → item title plus an extension from `Content-Type`. Blackboard often serves
extension-less `xid-`/`pid-` URLs, and it may redirect to a canonical name that differs from the
link text (e.g. `slides(1).html`), so the URL alone is not enough and the anchor text is not
always the stored name.

**Dedupe (defaults).**
- md5 match against every file already in the workspace → skip, even when the filename differs.
- same filename + same size → skip.
- `.zip` whose extracted sibling folder already exists → skip.
- identical bytes twice inside the course → keep one.
- Otherwise download. The destination is part of the index, which makes re-runs idempotent.

**Zip policy.** Course packages are extracted into a sibling folder with the zip's base name and
the zip is then deleted, so the same bytes are not stored twice. Packages the user already
extracted are caught by the folder rule.

**Layout.** `<dest>/<area>/<item folder?>/<file>` mirrors Blackboard. By default multi-file items
are grouped into a folder named after the item (e.g. `Example 1/`, `Example 2/`, `Example 3/`);
pass `--group-items none` to keep everything flat or `all` to group even single-file items.
`bb_archive.py` performs those moves (also for files downloaded before) and records every move in
`_bb_sync/moves.json` so the operation is reversible.

**Manifest.** `<dest>/README.md` holds the directory tree, a per-item table
(`item → archived file → status → size`) where status reads downloaded / already in workspace /
moved from an old location / archived from an extracted zip, plus caveats (quiz dropboxes with no
files, Announcements/Discussions/Groups not being course content, packages that were already
extracted).

**Verification.** `bb.mjs verify` re-crawls and re-downloads all attachments and compares md5
against the crawl that built the archive; `bb_verify_local.py` then resolves each record to its
on-disk counterpart — plain md5 for files, hash-multiset of zip entries against the extracted
folder for packages. A good run reports full coverage (e.g. `39/39`) and zero problems.

## Judgement calls that matter

- Index the destination *into* dedupe. Excluding it makes the next run write `file (1).ext`
  duplicates.
- A `.zip` whose base name matches an existing folder is a duplicate even though no file name
  matches — check directory names too.
- Per-example folders often contain exact copies of another example's data files. After
  archiving, compare md5 before deleting leftovers, then state clearly what was removed.
- Browser "save page" copies are not byte-identical to the original file. Compare normalised
  visible text first; a 100% text match plus the original being in the archive is the signal to
  delete.
- Ask before restarting the user's browser, and tell them logins survive while tabs may need
  `Ctrl+Shift+T`.
- Never persist cookies to disk.
- **Ultra courses** (`/ultra/course` SPA) are **not** covered by the `listContent.jsp` crawler.
  For those, render the outline in the CDP page, pull attachment links from the DOM, and download
  with in-page `fetch` — the same cookie/CDP plumbing applies.
- Only download content the user is entitled to (their own enrolled courses) and respect your
  institution's terms of use. Do not republish course material.

## Notes for DeepSeek Harness (DSH) desktop

- The DSH sidebar browser (`@deepseek-ai/dsh-client-ui-sidebar-browser`) registers no tool,
  prompt section or session event, its host cancels every download
  (`browserSession.on("will-download", e => e.preventDefault())`), denies guest permissions, and
  sets `devTools: !app.isPackaged`. It cannot be driven by the agent — use the CDP route.
- Its login lives in an in-memory partition (`dsh-sidebar-browser-<uuid>`), so those cookies are
  not on disk. Take over the user's own Edge profile instead (step 1).
- Chromium holds an exclusive OS lock on its `Cookies` SQLite while running, so reading the DB
  never works — restarting Edge with the debug port *is* the mechanism.
- On this setup `node` may not be on PATH; the bundled interpreters live under
  `%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\` (`node\bin\node.exe`,
  `python\python.exe`). `puppeteer-core` ships in `%DSH_HOME%\profiles\desktop\node_modules`.
- Some deployments' TLS handshake fails from Python's urllib while Node's fetch works, which is
  why all HTTP runs in `bb.mjs`.

## Files

| Path | Purpose |
|---|---|
| `scripts/ensure-edge-cdp.ps1` | Attach to or restart Edge with `--remote-debugging-port=9222` |
| `scripts/bb.mjs` | `resolve` / `crawl` / `download` / `verify` (Node + puppeteer-core + CDP) |
| `scripts/bb_archive.py` | Move pre-existing duplicates into the archive, group items, log `moves.json` |
| `scripts/bb_manifest.py` | Generate `<dest>/README.md` |
| `scripts/bb_verify_local.py` | Local + zip-extraction verification against `verify_fetch.json` |

State lives in `<workspace>/_bb_sync/`: `course.json`, `tree.json`, `results.json`, `moves.json`,
`verify_fetch.json`.
