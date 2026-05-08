#!/usr/bin/env python3
"""Render an HTML report from agents-md-analysis/summary.json."""
import json, os, html

OUT = "agents-md-analysis"
S = json.load(open(os.path.join(OUT, "summary.json")))

def esc(s): return html.escape(str(s))
def fmt(n): return f"{n:,}"

sec = S["sections"]
total_body = sum(x["body_len"] for x in sec)

# bucket each section by specific_sessions
def bucket(x):
    v = x["specific_sessions"]
    if v == 0: return ("dead", "Dead", "Zero specific-keyword hits in any session")
    if v <= 50: return ("rare", "Rare", "≤50 sessions")
    if v <= 200: return ("occasional", "Occasional", "51–200 sessions")
    if v <= 500: return ("common", "Common", "201–500 sessions")
    return ("hot", "Hot", "501+ sessions")

for x in sec:
    x["bucket"], x["bucket_label"], x["bucket_desc"] = bucket(x)

bucket_summary = {}
for x in sec:
    b = x["bucket"]
    bucket_summary.setdefault(b, {"count":0, "bytes":0, "label":x["bucket_label"], "desc":x["bucket_desc"]})
    bucket_summary[b]["count"] += 1
    bucket_summary[b]["bytes"] += x["body_len"]

bucket_order = ["hot","common","occasional","rare","dead"]
bucket_color = {
    "hot":"var(--positive)", "common":"var(--chart-2)", "occasional":"var(--chart-4)",
    "rare":"var(--warning)", "dead":"var(--negative)"
}

# tokens (rough: 4 chars/token)
def to_tokens(b): return b // 4

est_total_tokens = to_tokens(S["agents_md_bytes"])
hot_common_bytes = bucket_summary.get("hot",{}).get("bytes",0) + bucket_summary.get("common",{}).get("bytes",0)
target_tokens = 5000
target_bytes  = target_tokens * 4

zero_sections = [x for x in sec if x["specific_sessions"] == 0]
zero_bytes = sum(x["body_len"] for x in zero_sections)

low_traffic = [x for x in sec if x["specific_sessions"] <= 50 and x["specific_count"] > 0]
low_traffic_bytes = sum(x["body_len"] for x in low_traffic)

top_kw = S["top_keywords"][:30]

# build the section table
def row(x):
    color = bucket_color[x["bucket"]]
    title = esc(x["title"])
    best = esc(x["best_kw"]) if x["best_kw"] else "<span style='color:var(--muted-foreground)'>—</span>"
    return f"""<tr>
<td><span class="dot" style="background:{color}"></span>{x['bucket_label']}</td>
<td class="title">{title}</td>
<td class="num">{x['specific_sessions']}</td>
<td class="num">{x['specific_files']}</td>
<td class="num">{x['specific_hits']}</td>
<td class="num">{x['body_len']}</td>
<td class="kw">{best} <span class="muted">×{x['best_kw_hits']}</span></td>
</tr>"""

sec_sorted = sorted(sec, key=lambda x: (bucket_order.index(x["bucket"]), x["specific_sessions"]))

html_out = f"""<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AGENTS.md keyword usage analysis</title>
<style>
:root {{
  --background: #fafafa; --foreground: #18181b; --card: #ffffff;
  --muted-foreground: #71717a; --border: #e4e4e7;
  --primary: #18181b; --positive: #16a34a; --warning: #eab308;
  --negative: #dc2626; --info: #2563eb;
  --chart-1: #2563eb; --chart-2: #0891b2; --chart-3: #16a34a;
  --chart-4: #eab308; --chart-5: #f97316; --chart-6: #dc2626;
}}
@media (prefers-color-scheme: dark) {{
  :root {{ --background:#0a0a0a; --foreground:#fafafa; --card:#18181b;
    --muted-foreground:#a1a1aa; --border:#27272a; }}
}}
* {{ box-sizing: border-box; }}
body {{ font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  background: var(--background); color: var(--foreground); margin: 0; padding: 24px; }}
h1 {{ font-size: 22px; margin: 0 0 4px; }}
h2 {{ font-size: 16px; margin: 32px 0 12px; }}
.muted {{ color: var(--muted-foreground); }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: 12px; }}
.card {{ background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }}
.metric .v {{ font-size: 24px; font-weight: 600; }}
.metric .l {{ font-size: 12px; color: var(--muted-foreground); text-transform: uppercase; letter-spacing: .03em; }}
.bar {{ height: 22px; border-radius: 4px; display: flex; overflow: hidden; margin: 8px 0; }}
.bar > div {{ display: flex; align-items: center; justify-content: center; color: white; font-size: 11px; font-weight: 600; min-width: 0; }}
table {{ width: 100%; border-collapse: collapse; font-size: 12px; }}
th, td {{ padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); }}
th {{ position: sticky; top: 0; background: var(--card); font-weight: 600; }}
td.num {{ text-align: right; font-variant-numeric: tabular-nums; font-family: monospace; }}
td.title {{ max-width: 380px; }}
td.kw {{ font-family: monospace; font-size: 11px; }}
.dot {{ display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }}
.tbl {{ overflow: auto; max-height: 70vh; border: 1px solid var(--border); border-radius: 8px; background: var(--card); }}
.kw-list {{ display: flex; flex-wrap: wrap; gap: 6px; font-family: monospace; font-size: 11px; }}
.kw-list code {{ background: color-mix(in oklch, var(--muted-foreground) 12%, transparent); padding: 2px 6px; border-radius: 3px; }}
.headline {{ background: color-mix(in oklch, var(--info) 10%, transparent); border-left: 3px solid var(--info); padding: 12px 16px; border-radius: 4px; margin: 12px 0; }}
.savings {{ background: color-mix(in oklch, var(--positive) 12%, transparent); border-left: 3px solid var(--positive); padding: 12px 16px; border-radius: 4px; margin: 12px 0; }}
</style></head><body>

<h1>AGENTS.md keyword usage analysis</h1>
<div class="muted">Scanned {fmt(S['files_scanned'])} session jsonl files
({S['bytes_scanned']/1e6:.0f} MB) in {S['elapsed_seconds']:.1f}s ·
{fmt(S['section_count'])} sections · {fmt(S['keyword_count'])} unique keywords</div>

<div class="headline">
<b>Headline:</b> AGENTS.md is {S['agents_md_bytes']:,} bytes (~{est_total_tokens:,} tokens).
Target: ≤5,000 tokens (≤{target_bytes:,} bytes). Need to cut <b>~{S['agents_md_bytes']-target_bytes:,} bytes</b>.
{zero_bytes:,} bytes ({100*zero_bytes/S['agents_md_bytes']:.1f}%) live in <b>{len(zero_sections)} sections whose specific identifiers were never referenced</b> by any agent in any session.
{low_traffic_bytes:,} bytes more live in {len(low_traffic)} rare-traffic sections (≤50 sessions).
</div>

<h2>Bucketed by traffic</h2>
<div class="bar">"""

total = sum(b["bytes"] for b in bucket_summary.values())
for b in bucket_order:
    if b not in bucket_summary: continue
    bs = bucket_summary[b]
    pct = 100 * bs["bytes"] / total
    lbl=bs['label']; byt=bs['bytes']; cnt=bs['count']
    html_out += f'<div style="background:{bucket_color[b]};width:{pct}%" title="{lbl}: {byt} bytes, {cnt} sections">{lbl} {pct:.0f}%</div>'
html_out += "</div>"

html_out += '<div class="grid">'
for b in bucket_order:
    if b not in bucket_summary: continue
    bs = bucket_summary[b]
    html_out += f"""
<div class="card metric">
<div class="l"><span class="dot" style="background:{bucket_color[b]}"></span>{bs['label']}</div>
<div class="v">{bs['count']}</div>
<div class="muted">{bs['bytes']:,} bytes · {bs['desc']}</div>
</div>"""
html_out += "</div>"

# top keywords
html_out += "<h2>Top 30 referenced AGENTS.md keywords (across all sessions)</h2>"
html_out += '<div class="card"><div class="kw-list">'
for kw, c in top_kw:
    html_out += f'<code>{esc(kw)}</code><span class="muted">×{fmt(c)}</span>'
html_out += "</div></div>"

# savings projection
html_out += f"""
<div class="savings">
<b>Compression plan, evidence-based:</b>
<ul style="margin:8px 0 0 20px">
<li><b>Drop {len(zero_sections)} dead sections</b> ({zero_bytes:,} bytes, {100*zero_bytes/S['agents_md_bytes']:.0f}% of file). Their specific identifiers (file paths, function names, code refs) appear in <b>zero</b> sessions out of {fmt(S['files_scanned'])}.</li>
<li><b>Compress {len(low_traffic)} rare sections to one-line links</b> (~{low_traffic_bytes:,} → ~{len(low_traffic)*80:,} bytes). Each cited ≤50 times across {fmt(S['files_scanned'])} sessions; full detail already lives in <code>docs/debugging.md</code> / <code>docs/design/*.md</code>.</li>
<li><b>Keep all {bucket_summary.get('hot',{}).get('count',0) + bucket_summary.get('common',{}).get('count',0)} hot+common sections</b> ({hot_common_bytes:,} bytes) verbatim — their identifiers are referenced 200–1,500+ times.</li>
</ul>
Estimated outcome: ~{(S['agents_md_bytes']-zero_bytes-low_traffic_bytes+len(low_traffic)*80)//4:,} tokens (target: 5,000).
</div>
"""

# section table
html_out += "<h2>Per-section traffic (sorted: dead first)</h2>"
html_out += '<div class="tbl"><table>'
html_out += "<tr><th>Bucket</th><th>Section</th><th>Sessions</th><th>Files</th><th>Hits</th><th>Body bytes</th><th>Best keyword</th></tr>"
for x in sec_sorted:
    html_out += row(x)
html_out += "</table></div>"

html_out += f"""
<h2>Methodology</h2>
<div class="card muted">
Each AGENTS.md section was parsed and its identifying signals extracted:
backticked spans, file paths (containing <code>/</code>), CamelCase identifiers,
and hyphenated tokens from the title. "Specific" signals (file paths, dotted
identifiers, CamelCase) are high-precision — a hit means an agent literally
typed or referenced that exact string. Each of {fmt(S['files_scanned'])} jsonl
session files (cwd contains "bobbit") was lowercased once and substring-counted
for every keyword, in parallel across 8 processes. <code>specific_sessions</code>
is the count of distinct sessions where <em>any</em> of the section's specific
signals appeared at least once.
</div>

</body></html>
"""

out_path = os.path.join(OUT, "report.html")
with open(out_path, "w", encoding="utf-8") as f:
    f.write(html_out)
print(f"[write] {out_path} ({len(html_out)} bytes)")
