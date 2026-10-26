# bb-download

Download **all** the content of a Blackboard (Anthology LMS) course into a local workspace:
every content area, every folder, every attachment — deduped against what you already have,
indexed in a README, and verified against the live site when it finishes.

Built for the "Original" Blackboard experience (`listContent.jsp` course content), which is still
what a lot of universities run. It drives your **already logged-in** Edge profile over the
DevTools protocol (CDP), so no credentials are ever typed, stored, or transmitted anywhere.

```
workspace/
├── course_content/          <- the archive (mirrors the course menu)
│   ├── Content/
│   │   ├── Week 1/
│   │   │   ├── Example 1/
│   │   │   └── ...
│   │   └── ...
│   ├── Assessment Scheme/
│   └── README.md            <- auto-generated index: tree + per-item status
└── _bb_sync/                <- state: course.json, tree.json, results.json, verify_fetch.json
```

## Why this exists

There are two annoyances the usual "just use a browser automation script" approach does not cover:

1. **In-app / embedded browsers often cannot be driven.** Many desktop agent hosts embed a
   sidebar browser whose host process registers no tools for the model, denies downloads
   (`will-download` → `preventDefault()`), and disables DevTools in packaged builds. The only
   practical route is to take over the user's *own* browser profile with
   `--remote-debugging-port`.
2. **Re-downloading the same 30 files every week is worse than useless.** This tool hashes what is
   already on disk, skips it, extracts course zip packages instead of keeping both the zip and its
   contents, and can *file existing copies into the archive* instead of leaving duplicates scattered
   around the disk.

## Features

- **Course resolution** from your enrolled course list (no guessing course ids).
- **Recursive crawl** of every content area/folder, including attachments on items whose titles
  differ from the stored filename.
- **md5 dedupe** across the whole workspace, plus filename+size, plus extracted-zip-folder matching.
  Re-runs are idempotent.
- **Zip packages** are extracted and the zip removed; a package you already extracted is detected
  as a duplicate.
- **Item grouping** for multi-file items (`Example 1/`, `Example 2/`, …).
- **Archive mode**: move pre-existing copies of the same files into the archive, log every move.
- **Verified coverage**: `verify` re-crawls and re-downloads every attachment and compares md5;
  `bb_verify_local.py` checks the archive byte-for-byte (and compares zip entries against the
  extracted folders).

## Requirements

| | |
|---|---|
| OS | Windows (the CDP helper uses PowerShell + Edge) |
| Browser | Microsoft Edge, with a profile already logged in to Blackboard |
| Node | 18+ and `puppeteer-core` (`npm i puppeteer-core`, or set `PUPPETEER_CORE_PATH`) |
| Python | 3.x, stdlib only |

## Install

As a skill for an agent harness that scans `skills/<name>/SKILL.md` (DeepSeek Harness, Claude-style
skill dirs):

```powershell
git clone <this repo> <your-skills-dir>\bb-download
```

Standalone: clone anywhere and call the scripts directly.

## Quick start

```powershell
$SKILL = "<this repo>"
$HOST  = "https://bb.your-university.edu"
$NODE  = "node";  $PY = "python"

# 1) give Edge a debugging port (keeps your profile: logins survive; tabs may need Ctrl+Shift+T)
powershell -NoProfile -File "$SKILL\scripts\ensure-edge-cdp.ps1"

# 2) find the course
& $NODE "$SKILL\scripts\bb.mjs" resolve --dir . --course-code 6244 --host $HOST

# 3) look before you leap
& $NODE "$SKILL\scripts\bb.mjs" crawl --dir .

# 4) download (dedupe on), extract packages
& $NODE "$SKILL\scripts\bb.mjs" download --dir . --dest course_content

# 5) optional: move already-on-disk copies into the archive + group multi-file items
& $PY "$SKILL\scripts\bb_archive.py" --dir . --dest course_content

# 6) index
& $PY "$SKILL\scripts\bb_manifest.py" --dir . --dest course_content

# 7) prove it is complete
& $NODE "$SKILL\scripts\bb.mjs" verify --dir .
& $PY "$SKILL\scripts\bb_verify_local.py" --dir . --dest course_content
```

A run looks like this:

```
summary: 29 downloaded, 2 extracted, 10 skipped, 0 errors  (total 39)
...
检查 39 个附件
 无：39 个附件全部在归档内且内容一致
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `BB_HOST` | — | default Blackboard base URL (otherwise pass `--host`) |
| `DSH_CDP_URL` | `http://127.0.0.1:9222` | CDP endpoint of the logged-in browser |
| `PUPPETEER_CORE_PATH` | auto-detect | path to `puppeteer-core` |
| `PYTHON` | auto-detect | python used for zip unpacking |

Note: `ensure-edge-cdp.ps1` restarts Edge. Your logins/cookies survive because the same profile is
reused; the debug port lasts until you close Edge.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/ensure-edge-cdp.ps1` | attach to, or relaunch Edge with `--remote-debugging-port=9222` |
| `scripts/bb.mjs` | `resolve` / `crawl` / `download` / `verify` |
| `scripts/bb_archive.py` | file pre-existing copies into the archive, group items, log moves |
| `scripts/bb_manifest.py` | generate `<dest>/README.md` |
| `scripts/bb_verify_local.py` | local + zip-extraction verification |

## Limitations

- Blackboard **Ultra** courses (`/ultra/course` SPA) are not covered; the crawler targets the
  Original experience. For Ultra, render the outline in the CDP page and collect attachment links
  from the DOM.
- Tested on one deployment; menu markup varies between Blackboard versions. If `crawl` finds no
  content areas, inspect `_bb_sync/tree.json` and adjust the menu selector in `bb.mjs`.
- Downloads happen sequentially (deliberately gentle on the LMS).

## Safety and ethics

- Only use this on **your own** account and courses you are enrolled in.
- No credentials are handled: the tool reuses your existing browser session, reads cookies over
  CDP, and never writes them to disk.
- Respect your institution's rules and the course material's copyright — do not redistribute
  slides, datasets or assessments.

## License

MIT — see [LICENSE](LICENSE).
