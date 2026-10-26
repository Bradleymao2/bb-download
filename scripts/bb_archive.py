#!/usr/bin/env python
"""File pre-existing workspace copies into the archive and regroup multi-file items.

Reads _bb_sync/{results,tree}.json (produced by bb.mjs download), then for every
course attachment decides where it should live inside <dest>:

    <dest>/<area path>/<item folder?>/<file>

and MOVES the copy that is already on disk there (instead of downloading again).
By default only multi-file items get their own folder (--group-items multi);
use `none` to keep everything flat or `all` to group every item.

Every move is appended to _bb_sync/moves.json so the operation is reversible and
so bb_manifest.py can report "moved from ...".
"""
import argparse
import json
import os
import shutil
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def norm(p):
    return os.path.normcase(os.path.abspath(p))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=".")
    ap.add_argument("--dest", default="course_content")
    ap.add_argument("--group-items", choices=["multi", "all", "none"], default="multi")
    args = ap.parse_args()

    ws = os.path.abspath(args.dir)
    state = os.path.join(ws, "_bb_sync")
    tree_p = os.path.join(state, "tree.json")
    res_p = os.path.join(state, "results.json")
    moves_p = os.path.join(state, "moves.json")
    for p in (tree_p, res_p):
        if not os.path.exists(p):
            sys.exit(f"missing {p} - run `node scripts/bb.mjs download` first")

    tree = json.load(open(tree_p, encoding="utf-8"))["tree"]
    results = json.load(open(res_p, encoding="utf-8"))
    dest_root = os.path.join(ws, args.dest)

    # item -> number of attachments, to implement --group-items multi
    item_file_count = {}
    for node in tree:
        for it in node["items"]:
            item_file_count[(node["path"], it["title"])] = len(it.get("files") or [])

    # workspace file index (hash + basename), excluding state dir and node_modules
    by_hash, by_name = {}, {}
    for root, dirs, files in os.walk(ws):
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "_bb_sync")]
        for fn in files:
            p = os.path.join(root, fn)
            rel = os.path.relpath(p, ws).replace("\\", "/")
            try:
                import hashlib
                h = hashlib.md5(open(p, "rb").read()).hexdigest()
            except OSError:
                continue
            by_hash.setdefault(h, []).append(rel)
            by_name.setdefault(fn.lower(), []).append(rel)

    def is_inside_dest(rel):
        return norm(os.path.join(ws, rel)).startswith(norm(dest_root) + os.sep)

    def locate(rec):
        """Best existing location of a record's payload (file or extracted dir)."""
        for cand in (rec.get("file"), rec.get("reason")):
            if not cand:
                continue
            p = os.path.join(ws, cand.replace("/", os.sep).rstrip("/\\"))
            if os.path.exists(p):
                return p
        md5v = rec.get("md5")
        if md5v and md5v in by_hash:
            for rel in by_hash[md5v]:
                p = os.path.join(ws, rel.replace("/", os.sep))
                if os.path.exists(p):
                    return p
        stem = os.path.splitext(rec.get("filename") or "")[0].lower()
        if stem and stem in by_name_dir_cache:
            return by_name_dir_cache[stem]
        return None

    # extracted-directory candidates (zip base name -> folder path)
    by_name_dir_cache = {}
    for root, dirs, _files in os.walk(ws):
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "_bb_sync")]
        for d in dirs:
            by_name_dir_cache.setdefault(d.lower(), os.path.join(root, d))

    moves = []
    missing = []
    kept = []

    for rec in results:
        if rec.get("status") == "error":
            continue
        is_zip = bool(rec.get("filename", "").lower().endswith(".zip")) or rec.get("status") == "downloaded-extracted"
        area = rec.get("folder") or "Content"
        item_folder = None
        if args.group_items == "all":
            item_folder = rec.get("item")
        elif args.group_items == "multi" and item_file_count.get((area, rec.get("item")), 0) > 1:
            item_folder = rec.get("item")

        cur = locate(rec)
        if cur is None:
            # already extracted folder sitting in dest and payload known by name?
            if is_zip:
                stem = os.path.splitext(rec.get("filename") or "")[0].lower()
                cand = by_name_dir_cache.get(stem)
                if cand:
                    cur = cand
            if cur is None:
                missing.append(rec.get("filename") or rec.get("item"))
                continue

        cur_is_dir = os.path.isdir(cur)
        target_dir = os.path.join(dest_root, *[sanitize_segment(s) for s in area.split("/")])
        desired = target_dir
        if item_folder:
            desired = os.path.join(desired, sanitize_segment(item_folder))
        if cur_is_dir:
            name = os.path.basename(cur.rstrip("\\/"))
        else:
            name = os.path.basename(cur)  # keep the existing filename: archive moves, never renames
        desired = os.path.join(desired, name)

        if norm(cur) == norm(desired):
            kept.append(os.path.relpath(cur, ws))
            continue
        if is_inside_dest(os.path.relpath(cur, ws)) and os.path.exists(desired):
            kept.append(os.path.relpath(cur, ws))
            continue

        os.makedirs(os.path.dirname(desired), exist_ok=True)
        n = 1
        base, ext = os.path.splitext(desired)
        while os.path.exists(desired):
            desired = f"{base} ({n}){ext}"
            n += 1
        shutil.move(cur, desired)
        moves.append({"src": os.path.relpath(cur, ws).replace("\\", "/"),
                      "dst": os.path.relpath(desired, ws).replace("\\", "/"),
                      "kind": "dir" if cur_is_dir else "file"})
        print(f"moved  {os.path.relpath(cur, ws)}  ->  {os.path.relpath(desired, ws)}")

    # drop directories that the moves emptied
    for _ in range(4):
        removed = 0
        for root, dirs, files in os.walk(ws, topdown=False):
            if norm(root) == norm(ws) or norm(root).startswith(norm(os.path.join(ws, "_tools"))):
                continue
            if norm(root) == norm(state):
                continue
            if not os.listdir(root):
                os.rmdir(root)
                removed += 1
        if not removed:
            break

    prior = {}
    if os.path.exists(moves_p):
        try:
            prior = json.load(open(moves_p, encoding="utf-8"))
        except Exception:
            prior = {}
    hist = prior.get("moves", [])
    hist.extend(moves)
    json.dump({"moves": hist, "skipped": prior.get("skipped", [])}, open(moves_p, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    print(f"\nmoved {len(moves)}  already in place {len(kept)}  not found {len(missing)}")
    if missing:
        for m in missing[:20]:
            print("  missing:", m)
    print(f"log: {os.path.relpath(moves_p, ws)}")


def sanitize_segment(s):
    bad = '<>:"/\\|?*'
    out = "".join("_" if c in bad else c for c in str(s)).strip()
    return (out[:120] or "_")


if __name__ == "__main__":
    main()
