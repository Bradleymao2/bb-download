#!/usr/bin/env python
"""Generate <dest>/README.md - the archive index.

Sections: directory tree, per-item table (item -> archived file -> status -> size),
archive notes (what was moved / extracted / skipped), and integrity checks.
"""
import argparse
import datetime
import json
import os
import sys
import zipfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def human(n):
    n = float(n or 0)
    if n < 1024:
        return f"{n:.0f} B"
    for unit in ("KB", "MB", "GB"):
        n /= 1024.0
        if n < 1024:
            return f"{n:.1f} {unit}"
    return f"{n:.1f} TB"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=".")
    ap.add_argument("--dest", default="course_content")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    ws = os.path.abspath(args.dir)
    state = os.path.join(ws, "_bb_sync")
    dest_root = os.path.join(ws, args.dest)
    tree_p = os.path.join(state, "tree.json")
    res_p = os.path.join(state, "results.json")
    for p in (tree_p, res_p):
        if not os.path.exists(p):
            sys.exit(f"missing {p} - run crawl/download first")

    manifest = json.load(open(tree_p, encoding="utf-8"))
    results = json.load(open(res_p, encoding="utf-8"))
    moves = []
    moves_p = os.path.join(state, "moves.json")
    if os.path.exists(moves_p):
        moves = json.load(open(moves_p, encoding="utf-8")).get("moves", [])
    src2dst = {m["src"]: m["dst"] for m in moves if m.get("dst")}
    dst2src = {m["dst"]: m["src"] for m in moves if m.get("dst")}

    def absp(rel):
        return os.path.join(ws, rel.replace("/", os.sep))

    def exists(rel):
        return bool(rel) and os.path.exists(absp(rel))

    def dir_stats(rel):
        n = 0
        for _root, _dirs, files in os.walk(absp(rel)):
            n += len(files)
        return n

    def describe(rec):
        """Return (display_name, status_text, size_text)."""
        status = rec.get("status") or "?"
        fname = rec.get("filename") or rec.get("item") or ""
        f = (rec.get("file") or "").rstrip("/")

        # already relocated by bb_archive.py?
        for key in (f, rec.get("file"), rec.get("reason")):
            if key and key in src2dst and exists(src2dst[key]):
                dst = src2dst[key]
                p = absp(dst)
                if os.path.isdir(p):
                    return os.path.basename(dst) + "/", f"已归档（解包目录，移动自 `{key}`）", f"{dir_stats(dst)} 个文件"
                return os.path.basename(dst), f"已归档（移动自 `{key}`）", human(os.path.getsize(p))

        if status in ("downloaded", "downloaded-extracted"):
            if f and exists(f):
                p = absp(f)
                if os.path.isdir(p):
                    return os.path.basename(f) + "/", "已下载并解包为同名目录（zip 已删除，避免同内容双份）", f"{dir_stats(f)} 个文件"
                return os.path.basename(f), "已下载", human(os.path.getsize(p))
            # a downloaded zip that later got extracted next to it
            if f.lower().endswith(".zip") and exists(f[:-4]):
                return os.path.basename(f[:-4]) + "/", "已下载并解包为同名目录（zip 已删除，避免同内容双份）", f"{dir_stats(f[:-4])} 个文件"
            return fname, "已下载（本地已移动或清理，见归档说明）", human(rec.get("bytes") or 0)

        if status == "skipped-already-in-workspace":
            reason = rec.get("reason") or ""
            if exists(reason):
                return fname, f"已在工作区 `{reason}`", human(os.path.getsize(absp(reason)))
            return fname, f"已在工作区（原始位置 `{reason}` 已被归档整理）", human(rec.get("bytes") or 0)

        if status == "skipped-duplicate-in-course":
            return fname, f"跳过（课程内重复，见 `{rec.get('reason')}`）", human(rec.get("bytes") or 0)

        if status == "error":
            return fname, f"下载失败：{rec.get('reason')}", "-"

        return fname, status, human(rec.get("bytes") or 0)

    by_url = {}
    for r in results:
        by_url.setdefault(r["url"], []).append(r)

    # ---- integrity checks
    problems = []
    for root, _dirs, files in os.walk(dest_root):
        for fn in files:
            p = os.path.join(root, fn)
            if os.path.getsize(p) == 0:
                problems.append(("empty file", p))
                continue
            head = open(p, "rb").read(8)
            ext = os.path.splitext(fn)[1].lower()
            if ext == ".pdf" and not head.startswith(b"%PDF"):
                problems.append(("bad pdf header", p))
            if ext in (".zip", ".pptx", ".xlsx", ".docx"):
                try:
                    with zipfile.ZipFile(p) as z:
                        if z.testzip() is not None:
                            problems.append(("corrupt zip", p))
                except Exception as exc:
                    problems.append((f"zip error {exc}", p))

    # ---- build markdown
    L = []
    A = L.append
    course = manifest.get("course", {})
    A(f"# {course.get('name') or args.dest} - Blackboard 课程内容归档")
    A("")
    A(f"课程：**{course.get('name', '')}**　来源：{course.get('host', '')}　课程 id：`{course.get('courseId', '')}`")
    try:
        dt = datetime.datetime.fromisoformat(manifest["generatedAt"].replace("Z", "+00:00")).astimezone(
            datetime.timezone(datetime.timedelta(hours=8)))
        A(f"抓取时间：{dt.strftime('%Y-%m-%d %H:%M')} (Asia/Shanghai)")
    except Exception:
        pass
    A("")
    areas = manifest.get("areas") or []
    A("归档范围：" + "、".join(a.get("title", "?") for a in areas) +
      " 下的全部条目与附件。重复内容只保留一份；原先散落在工作区其他目录的副本若已归档，会标注来源。")
    A("")
    A("## 目录结构")
    A("")
    A("```")
    for root, dirs, files in os.walk(dest_root):
        dirs.sort()
        rel = os.path.relpath(root, dest_root)
        if rel == ".":
            continue
        depth = rel.count(os.sep)
        A("  " * depth + os.path.basename(root) + "/")
        for fn in sorted(files):
            if fn.startswith("README") or fn.startswith("_"):
                continue
            A("  " * (depth + 1) + fn)
    A("```")
    A("")
    A("## 逐项来源")
    A("")
    for node in sorted(manifest["tree"], key=lambda n: n["path"]):
        A(f"### {node['path']}")
        A("")
        A(f"页面：{node['url']}")
        A("")
        A("| 课程条目 | 文件（归档内位置） | 状态 | 大小 |")
        A("|---|---|---|---|")
        for it in node["items"]:
            if not it.get("files"):
                if it.get("links"):
                    A(f"| {it['title']} | _（无附件，仅链接/作业入口）_ | — | — |")
                continue
            for f in it["files"]:
                recs = by_url.get(f["href"]) or [{}]
                name, status_text, size = describe(recs[0])
                A(f"| {it['title']} | {name} | {status_text} | {size} |")
        A("")

    A("## 归档说明")
    A("")
    if moves:
        A(f"- 从工作区其他位置移动归档了 **{len(moves)}** 项（原位置不再保留副本，明细见 `_bb_sync/moves.json`）。")
    A("- 多文件的课程条目（如 Example 1/2/3）按条目分文件夹归档；单文件条目直接放在所属周/区目录下。")
    A("- 课程 zip 包解包为同名目录后删除 zip，避免同一份内容在磁盘上存两次。")
    A("- Assessment 类目录中，只有提交入口（uploadAssignment）而无附件的 Quiz 不在归档内。")
    A("- Announcements / Discussions / Groups 属工具区，不含课程文件，未抓取。")
    A("")
    A("## 文件完整性")
    A("")
    if problems:
        for kind, p in problems:
            A(f"- {kind}: `{os.path.relpath(p, ws)}`")
    else:
        A("- 所有文件非空，PDF 头 / Office / zip 结构校验通过。")
    A("")
    A("## 复核方法")
    A("")
    A("```powershell")
    A("node <skill>/scripts/bb.mjs verify --dir .              # 重新抓取并逐个比对 MD5")
    A("python <skill>/scripts/bb_verify_local.py --dir . --dest " + args.dest + "   # 本地/解包内容核对")
    A("```")

    out = args.out or os.path.join(dest_root, "README.md")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w", encoding="utf-8").write("\n".join(L) + "\n")

    total = sum(len(f) for _r, _d, f in os.walk(dest_root))
    size = 0
    for root, _dirs, files in os.walk(dest_root):
        for fn in files:
            size += os.path.getsize(os.path.join(root, fn))
    print(f"README written: {os.path.relpath(out, ws)}")
    print(f"archive: {total} files, {human(size)}")
    if problems:
        print(f"integrity problems: {len(problems)}")
        for kind, p in problems:
            print(f"  - {kind}: {p}")


if __name__ == "__main__":
    main()
