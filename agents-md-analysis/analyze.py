#!/usr/bin/env python3
"""Analyze AGENTS.md keyword usage across all bobbit-cwd session jsonls.

Inspired by cost-analysis/analyze.py: parallel scan over jsonl files,
aggregate, write JSON + HTML.

Goal: identify which AGENTS.md sections / keywords are actually referenced
by agents during real work, and which are dead weight.
"""

import json, os, re, sys, time
from concurrent.futures import ProcessPoolExecutor, as_completed
from collections import Counter, defaultdict

STATE   = r"C:\Users\jsubr\w\bobbit\.bobbit\state"
AGENTS  = "AGENTS.md"
OUTDIR  = "agents-md-analysis"
os.makedirs(OUTDIR, exist_ok=True)


# ---------- 1. parse AGENTS.md into sections ----------

def parse_sections(path: str):
    """Return list of (section_id, title, body) tuples.

    Each "section" is a top-level bullet `- **Title** — body...`
    plus any indented continuation lines.
    Also include the toplevel ## headers as sections.
    """
    with open(path, "r", encoding="utf-8") as f:
        lines = f.read().split("\n")

    sections = []
    cur_id = None
    cur_title = None
    cur_body = []
    counter = 0

    def flush():
        nonlocal cur_id, cur_title, cur_body
        if cur_id is not None:
            sections.append((cur_id, cur_title, "\n".join(cur_body)))
        cur_id = cur_title = None
        cur_body = []

    for line in lines:
        m = re.match(r"^- \*\*([^*]+)\*\*(.*)$", line)
        if m:
            flush()
            counter += 1
            cur_id = f"b{counter:03d}"
            cur_title = m.group(1).strip()
            cur_body = [m.group(2).strip()]
            continue
        m2 = re.match(r"^(##+) (.+)$", line)
        if m2:
            flush()
            counter += 1
            cur_id = f"h{counter:03d}"
            cur_title = m2.group(2).strip()
            cur_body = []
            continue
        if cur_id is not None:
            # continuation: indented line OR blank line keeps section open
            if line.startswith("  ") or line.startswith("\t") or line == "":
                cur_body.append(line)
            else:
                # toplevel non-bullet content - belongs to current header section
                cur_body.append(line)
    flush()
    return sections


def extract_signals(title: str, body: str):
    """Pull identifiable keyword signals from a section:

    - backticked spans `like_this`
    - file paths (containing /)
    - CamelCase identifiers
    - bare words >= 6 chars from title

    Returns (specific_signals, all_signals, doc_links).
    Specific = high-precision (file paths, dotted ids).
    """
    text = title + "\n" + body
    spans = re.findall(r"`([^`]+)`", text)
    spans = [s.strip() for s in spans if s.strip()]

    # Doc links don't count as signals — they're escape hatches, not what
    # agents grep for in practice. But record them so we can show them.
    doc_links = re.findall(r"\(docs/[^)]+\)", text)

    specific, generic = [], []
    for s in spans:
        if len(s) < 3:
            continue
        if "/" in s and len(s) >= 8:
            specific.append(s)
        elif "." in s and len(s) >= 6 and not s.startswith("."):
            specific.append(s)
        elif re.match(r"^[A-Z][a-zA-Z]+[A-Z]", s) and len(s) >= 8:
            specific.append(s)
        else:
            generic.append(s)

    # title-derived camelcase / hyphenated tokens
    tw = re.findall(r"[A-Za-z][A-Za-z0-9_./-]{5,}", title)
    for w in tw:
        if "/" in w or "." in w or "-" in w:
            specific.append(w)
        else:
            generic.append(w)

    # de-dupe, preserving order
    def uniq(seq):
        seen = set(); out = []
        for x in seq:
            k = x.lower()
            if k not in seen:
                seen.add(k); out.append(x)
        return out
    return uniq(specific), uniq(specific + generic), doc_links


# ---------- 2. enumerate target jsonl files ----------

def load_target_files():
    with open(os.path.join(STATE, "sessions.json"), "r", encoding="utf-8") as f:
        sessions = json.load(f)
    files = []
    for s in sessions:
        cwd = (s.get("cwd") or "").lower()
        if "bobbit" not in cwd:
            continue
        f_ = s.get("agentSessionFile")
        if not f_:
            continue
        if os.path.exists(f_):
            files.append((s.get("id"), f_, s.get("createdAt", 0)))
    files.sort(key=lambda t: t[2], reverse=True)
    return files


# ---------- 3. per-file scanner (worker) ----------

def scan_file(args):
    """Worker: count keyword hits in one jsonl file.

    Returns (file_size, hits_dict) where hits_dict[kw] = count.
    """
    path, keywords_lower = args
    counts = {}
    try:
        size = os.path.getsize(path)
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            text = f.read().lower()
    except OSError:
        return (0, counts, 0)

    # one pass per keyword via str.count is fast enough at this scale
    # (5MB × ~600 keywords × ~1500 files would be 4.5B ops — too much)
    # Instead: tokenize once, build a substring-presence bitmap.
    # Simpler optimization: only scan with keywords that have a chance
    # of being present (cheap pre-filter on first 4 chars).
    seen_files = 0
    for kw in keywords_lower:
        if kw in text:
            counts[kw] = text.count(kw)
            seen_files = 1
    return (size, counts, seen_files)


# ---------- 4. main ----------

def main():
    print(f"[load] AGENTS.md sections from {AGENTS}")
    sections = parse_sections(AGENTS)
    print(f"[load] {len(sections)} sections")

    # build the master keyword list — every signal in every section,
    # tagged back to its section id(s).
    kw_to_sections = defaultdict(list)
    section_signals = {}  # section_id -> (title, body, specific, all)
    for sid, title, body in sections:
        spec, allk, links = extract_signals(title, body)
        section_signals[sid] = {
            "title": title,
            "body_len": len(body),
            "specific": spec,
            "all": allk,
            "doc_links": links,
        }
        for kw in allk:
            kw_to_sections[kw.lower()].append(sid)

    keywords = sorted(kw_to_sections.keys())
    print(f"[load] {len(keywords)} unique keywords across all sections")

    files = load_target_files()
    total_bytes = sum(os.path.getsize(f[1]) for f in files if os.path.exists(f[1]))
    print(f"[load] {len(files)} bobbit-cwd jsonl files, {total_bytes/1e6:.1f} MB total")

    # parallel scan
    t0 = time.time()
    global_counts = Counter()
    files_per_kw = Counter()
    sessions_per_kw = defaultdict(set)  # kw -> {session_ids}

    args_list = [(p, keywords) for (_sid, p, _ts) in files]
    done = 0
    with ProcessPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(scan_file, a): files[i][0] for i, a in enumerate(args_list)}
        for fut in as_completed(futs):
            sid = futs[fut]
            size, counts, _ = fut.result()
            for kw, c in counts.items():
                global_counts[kw] += c
                files_per_kw[kw] += 1
                sessions_per_kw[kw].add(sid)
            done += 1
            if done % 100 == 0:
                print(f"[scan] {done}/{len(files)}  elapsed {time.time()-t0:.1f}s")

    elapsed = time.time() - t0
    print(f"[scan] done {len(files)} files in {elapsed:.1f}s")

    # aggregate per-section scores
    section_scores = []
    for sid, info in section_signals.items():
        title = info["title"]
        keywords_sec = info["all"]
        specific_sec = info["specific"]

        total_hits = sum(global_counts.get(k.lower(), 0) for k in keywords_sec)
        total_files = max((files_per_kw.get(k.lower(), 0) for k in keywords_sec), default=0)
        total_sessions = len(set().union(*[sessions_per_kw.get(k.lower(), set()) for k in keywords_sec])) if keywords_sec else 0

        # specific-only (high precision)
        spec_hits = sum(global_counts.get(k.lower(), 0) for k in specific_sec)
        spec_files = max((files_per_kw.get(k.lower(), 0) for k in specific_sec), default=0)
        spec_sessions = len(set().union(*[sessions_per_kw.get(k.lower(), set()) for k in specific_sec])) if specific_sec else 0

        # best individual signal
        best = ("", 0, 0)
        for k in keywords_sec:
            kl = k.lower()
            c = global_counts.get(kl, 0)
            if c > best[1]:
                best = (k, c, files_per_kw.get(kl, 0))

        section_scores.append({
            "id": sid,
            "title": title,
            "body_len": info["body_len"],
            "specific_hits": spec_hits,
            "specific_files": spec_files,
            "specific_sessions": spec_sessions,
            "total_hits": total_hits,
            "total_files": total_files,
            "total_sessions": total_sessions,
            "best_kw": best[0],
            "best_kw_hits": best[1],
            "best_kw_files": best[2],
            "specific_count": len(specific_sec),
            "all_count": len(keywords_sec),
        })

    summary = {
        "agents_md_path": AGENTS,
        "agents_md_bytes": os.path.getsize(AGENTS),
        "section_count": len(sections),
        "keyword_count": len(keywords),
        "files_scanned": len(files),
        "bytes_scanned": total_bytes,
        "elapsed_seconds": elapsed,
        "sections": section_scores,
        "top_keywords": global_counts.most_common(80),
        "zero_keywords": [k for k in keywords if global_counts.get(k, 0) == 0][:200],
    }
    out_json = os.path.join(OUTDIR, "summary.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print(f"[write] {out_json}")
    return summary


if __name__ == "__main__":
    main()
