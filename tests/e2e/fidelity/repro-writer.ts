/**
 * Reproducer writer.
 *
 * When a fidelity-harness iteration fails, this module dumps everything
 * needed to deterministically re-trigger the bug from a stand-alone
 * Playwright test:
 *
 *   test-results/fidelity-repros/<scriptName>-iter-<NN>-<ts>/
 *     script.json       — the script the bridge replayed
 *     observed.json     — the full DOM/recorder trace at fail time
 *     verdict.json      — the oracle's structured anomalies
 *     repro.spec.ts     — a self-contained Playwright spec that re-runs
 *                         this exact shot. Drop this into tests/e2e/ui/
 *                         (or tests/e2e/fidelity/regressions/) once the
 *                         bug is confirmed.
 *     README.md         — anomaly summary + run instructions
 *
 * Once a regression test exists for the underlying bug, the dir can be
 * deleted; the regression test inherits the script via a sibling JSON
 * copy.
 *
 * The generated repro deliberately does NOT depend on the repeat-loop
 * harness — it imports the same scripted-bridge fixture and runs ONE
 * iteration, asserting `verdict.pass === true`. If the bug is real and
 * deterministic the repro fails. If the bug is intermittent, the repro
 * may need its own loop wrapper, which the operator adds by hand.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Verdict } from "./oracle.js";
import type { ObservedEvent } from "./dom-recorder.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPRO_ROOT = join(__dirname, "..", "..", "..", "test-results", "fidelity-repros");

export interface ReproContext {
	scriptName: string;
	scriptPath: string;
	scriptJson: unknown;
	prompts: string[];
	iteration: number | null;     // null = single-shot
	verdict: Verdict;
	observed: ObservedEvent[];
	/** Where in the test lifecycle the failure occurred (label only). */
	stage: string;
}

export interface ReproResult {
	dir: string;
	specPath: string;
}

/** Generate a slugged directory name for the reproducer. */
function slug(scriptName: string, iter: number | null): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const iterPart = iter !== null ? `-iter-${String(iter).padStart(3, "0")}` : "";
	return `${scriptName}${iterPart}-${ts}`;
}

/** Render the anomaly list as a short bullet section for the README / spec comment. */
function anomalyBullets(verdict: Verdict): string {
	if (verdict.anomalies.length === 0) return "(none)";
	return verdict.anomalies.map((a) => `  - ${JSON.stringify(a)}`).join("\n");
}

/**
 * Render a stand-alone Playwright spec that re-triggers the same script
 * once, with the same prompts, against the real gateway. It uses the
 * fidelity harness fixture (the bridge replays the embedded script) and
 * fails if the oracle reports any anomaly.
 *
 * Embedding the script JSON directly into the spec makes it portable —
 * the spec is self-contained and survives even if scripts/ is deleted.
 */
function renderSpec(ctx: ReproContext): string {
	const promptsLit = JSON.stringify(ctx.prompts);
	const scriptLit = JSON.stringify(ctx.scriptJson, null, 2);
	const anomalies = anomalyBullets(ctx.verdict);
	const iterStr = ctx.iteration !== null ? ` (iteration ${ctx.iteration})` : "";
	const expectedIdleCount = ctx.prompts.length + 1;
	// Use plain string concatenation so we don't have to escape `${...}` for
	// the inner template-literal expressions in the generated source.
	const lines: string[] = [];
	lines.push("/**");
	lines.push(" * Auto-generated fidelity reproducer.");
	lines.push(" *");
	lines.push(` * Captured: ${new Date().toISOString()}`);
	lines.push(` * Script:   ${ctx.scriptName}${iterStr}`);
	lines.push(` * Stage:    ${ctx.stage}`);
	lines.push(" *");
	lines.push(" * Anomalies at capture time:");
	lines.push(anomalies);
	lines.push(" *");
	lines.push(" * Run:");
	lines.push(" *   npx playwright test --config playwright-e2e.config.ts --project=browser \\");
	lines.push(" *     <relative-path-to-this-spec>");
	lines.push(" *");
	lines.push(" * If this spec fails, the underlying bug is reproducible deterministically");
	lines.push(" * with the embedded script. Move this file (and the sibling script.json)");
	lines.push(" * into tests/e2e/fidelity/regressions/ and add a descriptive name once");
	lines.push(" * triaged.");
	lines.push(" */");
	lines.push("import { test, expect } from \"../../tests/e2e/fidelity/harness.js\";");
	lines.push("import { openApp, createSessionViaUI, sendMessage } from \"../../tests/e2e/ui/ui-helpers.js\";");
	lines.push("import { installRecorder, dumpRecorder, markUserSend } from \"../../tests/e2e/fidelity/dom-recorder.js\";");
	lines.push("import { diff, formatVerdict, type Script } from \"../../tests/e2e/fidelity/oracle.js\";");
	lines.push("import { writeFileSync, mkdtempSync } from \"node:fs\";");
	lines.push("import { join } from \"node:path\";");
	lines.push("import { tmpdir } from \"node:os\";");
	lines.push("");
	lines.push(`const SCRIPT: Script = ${scriptLit} as unknown as Script;`);
	lines.push(`const PROMPTS = ${promptsLit} as string[];`);
	lines.push("");
	lines.push("test.beforeAll(() => {");
	lines.push("\t// Write the embedded script to a temp file so the bridge factory can");
	lines.push("\t// pick it up via BOBBIT_FIDELITY_SCRIPT.");
	lines.push("\tconst dir = mkdtempSync(join(tmpdir(), \"fidelity-repro-\"));");
	lines.push("\tconst path = join(dir, SCRIPT.name + \".json\");");
	lines.push("\twriteFileSync(path, JSON.stringify(SCRIPT, null, 2));");
	lines.push("\tprocess.env.BOBBIT_FIDELITY_SCRIPT = path;");
	lines.push("});");
	lines.push("");
	lines.push(`test("reproducer \u2014 ${ctx.scriptName}", async ({ page }, testInfo) => {`);
	lines.push("\ttest.setTimeout(60_000);");
	lines.push("\tawait installRecorder(page);");
	lines.push("\tawait openApp(page);");
	lines.push("\tawait createSessionViaUI(page);");
	lines.push("\tawait page.evaluate(() => window.__fidelity__?.start());");
	lines.push("");
	lines.push("\tfor (const text of PROMPTS) {");
	lines.push("\t\tawait markUserSend(page, text);");
	lines.push("\t\tawait sendMessage(page, text);");
	lines.push("\t}");
	lines.push("");
	lines.push("\tawait page.waitForFunction(() => {");
	lines.push("\t\tconst events = window.__fidelity__?.dump() ?? [];");
	lines.push("\t\tconst idleCount = events.filter((e: any) => e.kind === \"status\" && e.status === \"idle\").length;");
	lines.push(`\t\treturn idleCount >= ${expectedIdleCount};`);
	lines.push("\t}, undefined, { timeout: 15_000 }).catch(() => { /* let oracle report */ });");
	lines.push("");
	lines.push("\tconst observed = await dumpRecorder(page);");
	lines.push("\tconst verdict = diff(SCRIPT, observed);");
	lines.push("\tawait testInfo.attach(\"observed.json\", { body: JSON.stringify(observed, null, 2), contentType: \"application/json\" });");
	lines.push("\tawait testInfo.attach(\"verdict.txt\",   { body: formatVerdict(verdict), contentType: \"text/plain\" });");
	lines.push("\texpect(verdict.pass, formatVerdict(verdict)).toBe(true);");
	lines.push("});");
	return lines.join("\n") + "\n";
}

/**
 * Generate the README that explains what this directory holds.
 */
function renderReadme(ctx: ReproContext): string {
	return `# Fidelity reproducer — ${ctx.scriptName}${ctx.iteration !== null ? ` (iter ${ctx.iteration})` : ""}

Captured: **${new Date().toISOString()}**

## Anomalies

${ctx.verdict.anomalies.length === 0 ? "_(none — likely a precondition failure)_" : ctx.verdict.anomalies.map((a) => `- \`${JSON.stringify(a)}\``).join("\n")}

## Stats

- Slots observed / expected: **${ctx.verdict.stats.observedSlotCount} / ${ctx.verdict.stats.expectedSlotCount}**
- First-paint: **${ctx.verdict.stats.firstPaintMs ?? "?"} ms**
- Idle-settle: **${ctx.verdict.stats.idleSettleMs ?? "?"} ms**

## Files

| File | Purpose |
|------|---------|
| \`script.json\` | The script the bridge replayed. |
| \`observed.json\` | Full DOM-recorder trace at fail time. |
| \`verdict.json\` | Oracle output (structured anomalies). |
| \`repro.spec.ts\` | Stand-alone Playwright spec that re-runs this shot. |

## Run the reproducer

\`\`\`bash
npx playwright test --config playwright-e2e.config.ts --project=browser \\
  test-results/fidelity-repros/<this-dir>/repro.spec.ts
\`\`\`

If it fails deterministically, the bug is real and reproducible. Promote
the spec to \`tests/e2e/fidelity/regressions/\` (or wherever fits) with a
descriptive filename once triaged.

If it passes (i.e. the bug only fires intermittently), wrap the body in
a 50× loop and re-run.
`;
}

export function writeRepro(ctx: ReproContext): ReproResult {
	const dir = join(REPRO_ROOT, slug(ctx.scriptName, ctx.iteration));
	mkdirSync(dir, { recursive: true });
	void dirname; // referenced for completeness
	writeFileSync(join(dir, "script.json"), JSON.stringify(ctx.scriptJson, null, 2));
	writeFileSync(join(dir, "observed.json"), JSON.stringify(ctx.observed, null, 2));
	writeFileSync(join(dir, "verdict.json"), JSON.stringify(ctx.verdict, null, 2));
	writeFileSync(join(dir, "repro.spec.ts"), renderSpec(ctx));
	writeFileSync(join(dir, "README.md"), renderReadme(ctx));
	return { dir, specPath: join(dir, "repro.spec.ts") };
}
