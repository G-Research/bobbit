/**
 * Render a static HTML report from a recorded timeline.
 *
 * Layout: a horizontal scrubber (one cell per tick) coloured by status,
 * plus the screenshot + state JSON for the selected tick. Findings are
 * pinned at the top with "jump to tick" links.
 *
 * No external assets — single self-contained file.
 */

import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Timeline } from "./types.ts";

export async function writeReport(outDir: string): Promise<string> {
	const tl = JSON.parse(await readFile(join(outDir, "timeline.json"), "utf-8")) as Timeline;
	const reportPath = join(outDir, "report.html");
	const html = renderHtml(tl);
	await writeFile(reportPath, html);
	return reportPath;
}

function renderHtml(tl: Timeline): string {
	const ticks = tl.ticks;
	const findings = tl.findings;
	const ticksJson = JSON.stringify(
		ticks.map((t) => ({
			t: t.t,
			kind: t.kind,
			action: t.action,
			screenshot: t.screenshot,
			stateSnapshot: t.stateSnapshot,
			domSnapshot: t.domSnapshot,
			status: t.session?.status ?? "?",
			msgCount: t.session?.messages.length ?? 0,
			domCount: t.dom.length,
		})),
	);
	const findingsJson = JSON.stringify(findings);

	return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>observe — ${escape(tl.meta.scenario)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background:#111; color:#eee; }
  header { padding: 8px 12px; background:#1d1d1d; border-bottom:1px solid #333; }
  header h1 { font-size:14px; margin:0; font-weight:500; }
  header .meta { font-size:11px; color:#aaa; }
  #findings { padding: 6px 12px; background:#2a1010; border-bottom:1px solid #511;}
  #findings ul { margin: 4px 0; padding-left: 18px; font-size:12px; }
  #findings .ok { color:#9c9; }
  #scrubber { display:flex; flex-wrap:wrap; gap:1px; padding:6px; background:#181818; border-bottom:1px solid #333; }
  .cell { width:8px; height:18px; cursor:pointer; }
  .cell.tick { background:#2c4; } .cell.before-action { background:#48f; } .cell.after-action { background:#fa3; }
  .cell.streaming { outline:1px solid #ff5; }
  .cell.hang { background:#f33 !important; }
  .cell.ooo { background:#f0f !important; }
  .cell.selected { outline:2px solid #fff; }
  main { display:grid; grid-template-columns: 1fr 360px; gap:8px; padding:8px; height:calc(100vh - 160px); }
  #shot { background:#000; display:flex; align-items:flex-start; justify-content:center; overflow:auto; }
  #shot img { max-width:100%; }
  #side { overflow:auto; font-family: ui-monospace, monospace; font-size:11px; background:#161616; padding:8px; }
  pre { white-space: pre-wrap; word-break: break-word; }
  .kv { color:#9cf; }
  button { background:#333; color:#eee; border:1px solid #555; padding:2px 8px; cursor:pointer; }
</style></head><body>
<header>
  <h1>observe — ${escape(tl.meta.scenario)}</h1>
  <div class="meta">
    started ${escape(tl.meta.startedAt)} · ${ticks.length} ticks ·
    hangMs=${tl.meta.thresholds.hangMs} tickMs=${tl.meta.thresholds.tickMs} ·
    ${escape(tl.meta.exitReason ?? "running")}
  </div>
</header>
<div id="findings">
  ${
		findings.length === 0
			? '<div class="ok">No findings — agent stayed responsive and message order matched DOM order.</div>'
			: `<strong>${findings.length} finding(s):</strong><ul>${findings
					.map(
						(f) =>
							`<li><a href="#" data-jump="${f.tickIndex}">[${f.kind} @ ${f.atMs}ms]</a> ${escape(f.detail)}</li>`,
					)
					.join("")}</ul>`
	}
</div>
<div id="scrubber"></div>
<main>
  <div id="shot"><img id="img" alt=""/></div>
  <div id="side">
    <div><button id="prev">◀</button> <button id="next">▶</button> tick <span id="i">0</span> / ${ticks.length}</div>
    <div class="kv" id="hdr"></div>
    <h3>state.messages (sorted)</h3><pre id="state"></pre>
    <h3>DOM transcript</h3><pre id="dom"></pre>
  </div>
</main>
<script>
const ticks = ${ticksJson};
const findings = ${findingsJson};
const hangSet = new Set(findings.filter(f=>f.kind==="hang").map(f=>f.tickIndex));
const oooSet  = new Set(findings.filter(f=>f.kind==="out-of-order").map(f=>f.tickIndex));
const scrub = document.getElementById("scrubber");
ticks.forEach((t,i)=>{
  const c=document.createElement("div");
  c.className="cell "+t.kind;
  if (t.status==="streaming"||t.status==="pending"||t.status==="preparing") c.classList.add("streaming");
  if (hangSet.has(i)) c.classList.add("hang");
  if (oooSet.has(i)) c.classList.add("ooo");
  c.title=\`#\${i} \${t.kind} \${t.action??""} status=\${t.status} msgs=\${t.msgCount} dom=\${t.domCount} t=\${t.t}ms\`;
  c.onclick=()=>show(i);
  scrub.appendChild(c);
});
let cur=0;
async function show(i){
  if (i<0||i>=ticks.length) return;
  cur=i;
  document.querySelectorAll(".cell.selected").forEach(e=>e.classList.remove("selected"));
  scrub.children[i]?.classList.add("selected");
  const t=ticks[i];
  document.getElementById("img").src=t.screenshot;
  document.getElementById("i").textContent=String(i);
  document.getElementById("hdr").textContent=
    \`t=\${t.t}ms kind=\${t.kind} action=\${t.action??""} status=\${t.status} msgs=\${t.msgCount} dom=\${t.domCount}\`;
  try {
    const [s,d]=await Promise.all([
      fetch(t.stateSnapshot).then(r=>r.text()),
      fetch(t.domSnapshot).then(r=>r.text()),
    ]);
    document.getElementById("state").textContent=s;
    document.getElementById("dom").textContent=d;
  } catch (e) {
    document.getElementById("state").textContent="(open via http server to load JSON)";
    document.getElementById("dom").textContent="";
  }
}
document.getElementById("prev").onclick=()=>show(cur-1);
document.getElementById("next").onclick=()=>show(cur+1);
document.body.addEventListener("click",(e)=>{
  const a=e.target.closest("a[data-jump]");
  if (a){ e.preventDefault(); show(Number(a.dataset.jump)); }
});
show(0);
</script>
</body></html>`;
}

function escape(s: string): string {
	return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
}
