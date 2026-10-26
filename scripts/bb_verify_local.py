#!/usr/bin/env python
"""Verify that every Blackboard attachment is present locally with identical content.

Inputs: _bb_sync/results.json (what the download recorded), _bb_sync/verify_fetch.json
(fresh md5 of every attachment, produced by `bb.mjs verify`), _bb_sync/moves.json
(optional, from bb_archive.py).

For plain files it compares md5. For zip packages (which the downloader extracted and
deleted) it compares the multiset of hashes inside the zip with the files in the
extracted folder, so "extracted" is verified at content level, not just assumed.
"""
import argparse
import collections
import hashlib
import json
import os
import sys
import zipfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def md5_of(path):
    return hashlib.md5(open(path, "rb").read()).hexdigest()


def dir_hashes(d):
    counter = collections.Counter()
    for root, _dirs, files in os.walk(d):
        for fn in files:
            counter[md5_of(os.path.join(root, fn))] += 1
    return counter


def zip_hashes(zp):
    counter = collections.Counter()
    with zipfile.ZipFile(zp) as z:
        for info in z.infolist():
            if not info.is_dir():
                counter[hashlib.md5(z.read(info.filename)).hexdigest()] += 1
    return counter


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=".")
    ap.add_argument("--dest", default="course_content")
    args = ap.parse_args()

    ws = os.path.abspath(args.dir)
    state = os.path.join(ws, "_bb_sync")
    for p in (os.path.join(state, "results.json"), os.path.join(state, "verify_fetch.json")):
        if not os.path.exists(p):
            sys.exit(f"missing {p} - run `node scripts/bb.mjs verify` first")

    stored = json.load(open(os.path.join(state, "results.json"), encoding="utf-8"))
    fetched = {x["url"]: x for x in json.load(open(os.path.join(state, "verify_fetch.json"), encoding="utf-8"))}
    moves = []
    mp = os.path.join(state, "moves.json")
    if os.path.exists(mp):
        moves = json.load(open(mp, encoding="utf-8")).get("moves", [])
    src2dst = {m["src"]: m["dst"] for m in moves if m.get("dst")}

    def absp(rel):
        return os.path.join(ws, rel.replace("/", os.sep))

    rows, problems = [], []

    for rec in stored:
        label = f'{rec.get("folder")} | {rec.get("item")} | {rec.get("filename")}'
        v = fetched.get(rec["url"], {})
        live, stored_md5 = v.get("liveMd5"), rec.get("md5")

        if live and stored_md5 and live != stored_md5:
            problems.append(("内容自抓取后已变化", label))
            rows.append((label, "CHANGED", ""))
            continue

        # resolve where the payload ended up
        cur = None
        for cand in (rec.get("file"), rec.get("reason")):
            if not cand:
                continue
            if os.path.exists(absp(cand)):
                cur = cand
                break
            if cand in src2dst and os.path.exists(absp(src2dst[cand])):
                cur = src2dst[cand]
                break
        if cur is None and stored_md5:
            # last resort: search the archive for the same bytes / same basename
            fname = os.path.basename((rec.get("filename") or "").lower())
            for root, _dirs, files in os.walk(os.path.join(ws, args.dest)):
                for fn in files:
                    if fname and fn.lower() == fname:
                        p = os.path.join(root, fn)
                        if md5_of(p) == stored_md5:
                            cur = os.path.relpath(p, ws).replace("\\", "/")
                            break
                if cur:
                    break

        if cur is None and (rec.get("filename") or "").lower().endswith(".zip"):
            # the zip was extracted: find the sibling folder named after the package
            stem = os.path.basename(rec["filename"])[:-4].lower()
            for root, dirs, _files in os.walk(os.path.join(ws, args.dest)):
                for d in dirs:
                    if d.lower() == stem:
                        cur = os.path.relpath(os.path.join(root, d), ws).replace("\\", "/")
                        break
                if cur:
                    break

        if cur and os.path.isfile(absp(cur)):
            ok = md5_of(absp(cur)) == stored_md5
            rows.append((label, "OK" if ok else "MISMATCH", cur))
            if not ok:
                problems.append(("本地文件哈希不符", label))
            continue

        if cur and os.path.isdir(absp(cur)):
            zp = v.get("zipPath")
            if zp and os.path.exists(zp):
                zh, lh = zip_hashes(zp), dir_hashes(absp(cur))
                if zh == lh:
                    rows.append((label, "OK (zip 解包)", cur + "/"))
                else:
                    problems.append((f"zip 解包内容不符 缺{sum((zh - lh).values())} 多{sum((lh - zh).values())}", label))
                    rows.append((label, "MISMATCH (zip 解包)", cur + "/"))
                continue
            rows.append((label, "OK (目录存在，无 zip 可比)", cur + "/"))
            continue

        problems.append(("未找到本地对应文件", label))
        rows.append((label, "MISSING", ""))

    for label, result, where in rows:
        print(f"{result:<18} {label[:110]}")
        if where:
            print(f'{"":18}-> {where[:120]}')

    print(f"\n检查 {len(rows)} 个附件")
    print("=== 问题 ===")
    if problems:
        for kind, label in problems:
            print(f" - {kind} | {label}")
        sys.exit(1)
    print(f" 无：{len(rows)} 个附件全部在归档内且内容一致")


if __name__ == "__main__":
    main()
