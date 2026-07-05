#!/usr/bin/env node
/**
 * codemod.mjs — mechanical, reversible migration of legacy tests into tests2/
 * (design §4). Legacy files are COPIED and transformed; originals are never
 * moved or edited, so both suites run during migration. Idempotent: re-running
 * produces byte-identical outputs and an identical report.
 *
 * Transforms (design §4 mapping table):
 *   • `node:test` named imports -> `vitest` (before→beforeAll, after→afterAll,
 *     mock→vi; describe/it/test/beforeEach/afterEach/suite preserved).
 *   • hook call sites: before(→beforeAll(, after(→afterAll( (imported only).
 *   • mock.* -> vi.* (imported only); non-`mock.fn` usage flags needs-manual.
 *   • `node:assert/strict` left untouched.
 *   • relative import specifiers rewritten so the copy still resolves from its
 *     new tests2/<bucket>/ location (this is what makes copies runnable).
 *   • dist/server|app|ui specifiers -> src/* (and flagged needs-manual).
 *   • process.env mutation -> flagged needs-withEnv (wrap in withEnv() by hand).
 *
 * Classification per file: clean | needs-withEnv | needs-manual (precedence
 * manual > withEnv > clean). Report: tests2/codemod-report.json + stdout summary.
 *
 * ─── CLI ───
 *   node scripts/testing-v2/codemod.mjs                 # all `codemod`-method entries
 *   node scripts/testing-v2/codemod.mjs --dry-run       # report only, no writes
 *   node scripts/testing-v2/codemod.mjs --all-methods   # also copy adapter/rewrite/etc (needs-manual)
 *   node scripts/testing-v2/codemod.mjs --method=codemod,rewrite
 *   node scripts/testing-v2/codemod.mjs --limit=50      # pilot subset
 *   node scripts/testing-v2/codemod.mjs tests/foo.test.ts 'tests/api-*.test.ts'  # target subset
 *   node scripts/testing-v2/codemod.mjs --report=path --out=tests2
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MAP_PATH = join(REPO_ROOT, "tests2", "tests-map.json");

const BUCKET_DIR = {
	"v2-core": "core",
	"v2-dom": "dom",
	"v2-integration": "integration",
	"v2-browser": "browser",
	daily: "daily",
};

const toPosix = (p) => p.replace(/\\/g, "/");

// ───────────────────────────── CLI parsing ─────────────────────────────

function parseCli(argv) {
	const opts = { dryRun: false, allMethods: false, methods: ["codemod"], limit: Infinity, out: "tests2", report: null, targets: [] };
	for (const a of argv) {
		if (a === "--dry-run") opts.dryRun = true;
		else if (a === "--all-methods") opts.allMethods = true;
		else if (a.startsWith("--method=")) opts.methods = a.slice(9).split(",").map((s) => s.trim()).filter(Boolean);
		else if (a.startsWith("--limit=")) opts.limit = Number(a.slice(8)) || Infinity;
		else if (a.startsWith("--out=")) opts.out = a.slice(6);
		else if (a.startsWith("--report=")) opts.report = a.slice(9);
		else if (a.startsWith("-")) throw new Error(`codemod: unknown flag ${a}`);
		else opts.targets.push(toPosix(a));
	}
	if (!opts.report) opts.report = join(opts.out, "codemod-report.json");
	return opts;
}

/** Minimal glob matcher supporting * (segment) and ** (any). */
function globToRegex(glob) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
			} else re += "[^/]*";
		} else if (".+?^${}()|[]\\".includes(c)) re += "\\" + c;
		else re += c;
	}
	return new RegExp(`^${re}$`);
}

function matchesTargets(file, targets) {
	if (targets.length === 0) return true;
	for (const t of targets) {
		if (t.includes("*")) {
			if (globToRegex(t).test(file)) return true;
		} else if (file === t || file.startsWith(t.endsWith("/") ? t : t + "/")) return true;
	}
	return false;
}

// ───────────────────────────── transforms ─────────────────────────────

/** Rewrite relative import specifiers so the copy resolves from newAbs. */
function rewriteRelativeImports(source, originalAbs, newAbs) {
	const fromDir = dirname(newAbs);
	const origDir = dirname(originalAbs);
	const specRe = /((?:from|import)\s+|require\s*\(\s*|import\s*\(\s*)(["'])(\.\.?\/[^"'\n]*)\2/g;
	return source.replace(specRe, (whole, lead, quote, spec) => {
		const abs = resolve(origDir, spec);
		let rel = toPosix(relative(fromDir, abs));
		if (!rel.startsWith(".")) rel = "./" + rel;
		return `${lead}${quote}${rel}${quote}`;
	});
}

const NODE_TEST_IMPORT_RE = /import\s*(type\s*)?\{([^}]*)\}\s*from\s*["']node:test["'];?/g;
const NAME_MAP = { before: "beforeAll", after: "afterAll", mock: "vi" };

function parseImportNames(inner) {
	// entries may be `name` or `name as alias`; keep simple bare names.
	return inner
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => {
			const m = s.match(/^([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/);
			return m ? { name: m[1], alias: m[2] || null } : { name: s, alias: null, raw: true };
		});
}

/**
 * Apply the node:test -> vitest transform. Returns { code, imported, hadNodeTest,
 * defaultOrNamespace }.
 */
function transformNodeTestImports(source) {
	let hadNodeTest = false;
	const imported = new Set();
	let sawRaw = false;

	const code = source.replace(NODE_TEST_IMPORT_RE, (_whole, typeKw, inner) => {
		hadNodeTest = true;
		const names = parseImportNames(inner);
		const out = [];
		const seen = new Set();
		for (const { name, alias, raw } of names) {
			if (raw) sawRaw = true;
			imported.add(name);
			const mapped = NAME_MAP[name] || name;
			const token = alias ? `${mapped} as ${alias}` : mapped;
			if (!seen.has(token)) {
				seen.add(token);
				out.push(token);
			}
		}
		const typePrefix = typeKw ? "type " : "";
		return `import ${typePrefix}{ ${out.join(", ")} } from "vitest";`;
	});

	// Detect default/namespace node:test imports we can't mechanically map.
	const defaultOrNamespace = /import\s+(?:\*\s+as\s+\w+|\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']node:test["']/.test(source) && !hadNodeTest;

	return { code, imported, hadNodeTest, defaultOrNamespace, sawRaw };
}

function rewriteHookCalls(source, imported) {
	let out = source;
	if (imported.has("before")) out = out.replace(/(^|[^.\w])before(\s*\()/g, "$1beforeAll$2");
	if (imported.has("after")) out = out.replace(/(^|[^.\w])after(\s*\()/g, "$1afterAll$2");
	if (imported.has("mock")) out = out.replace(/(^|[^.\w])mock(\s*\.)/g, "$1vi$2");
	return out;
}

function rewriteDistImports(source) {
	let changed = false;
	const code = source.replace(/(["'][^"']*?)\/dist\/(server|app|ui)\//g, (m, pre, area) => {
		changed = true;
		return `${pre}/src/${area}/`;
	});
	return { code, changed };
}

// ─────────────────────────────── classify ───────────────────────────────

function detectFlags(originalSource, transformed, ctx) {
	const reasons = [];
	let manual = false;
	let withEnv = false;

	if (ctx.method === "codemod") {
		if (ctx.defaultOrNamespace) {
			manual = true;
			reasons.push("default/namespace `node:test` import — map hooks/vi by hand");
		} else if (!ctx.hadNodeTest) {
			manual = true;
			reasons.push("no `node:test` named import found in a codemod-method file");
		}
		if (ctx.sawRaw) {
			manual = true;
			reasons.push("unparsed import name in `node:test` import list");
		}
	} else {
		manual = true;
		reasons.push(`method=${ctx.method}: not a mechanical codemod — copied as a starting point, finish by hand`);
	}

	// mock.* usage that is not the 1:1 mock.fn.
	if (ctx.imported.has("mock")) {
		const props = new Set();
		for (const m of originalSource.matchAll(/(?:^|[^.\w])mock\s*\.\s*([A-Za-z0-9_$]+)/g)) props.add(m[1]);
		const nonFn = [...props].filter((p) => p !== "fn");
		if (nonFn.length) {
			manual = true;
			reasons.push(`mock.${nonFn.join("/mock.")} has no 1:1 vi.* mapping — review timers/module/method/reset semantics`);
		}
	}

	// node:test context helpers (t.skip/t.todo/t.diagnostic/t.plan) don't map to vitest.
	if (/\bt\s*\.\s*(skip|todo|diagnostic|plan|runOnly)\b/.test(originalSource)) {
		manual = true;
		reasons.push("test-context helper (t.skip/t.todo/...) — vitest has no per-context equivalent");
	}

	if (ctx.distChanged) {
		manual = true;
		reasons.push("dist/* import rewritten to src/* — verify extension/paths resolve under vitest");
	}

	// process.env mutation -> needs-withEnv.
	if (/process\.env\.[A-Za-z0-9_$]+\s*=(?!=)/.test(originalSource) || /delete\s+process\.env\b/.test(originalSource)) {
		withEnv = true;
		reasons.push("mutates process.env — wrap in withEnv(patch, fn) to restore in finally");
	}

	let classification = "clean";
	if (manual) classification = "needs-manual";
	else if (withEnv) classification = "needs-withEnv";
	return { classification, reasons };
}

// ─────────────────────────────── per-file ───────────────────────────────

function targetPath(file, bucket, outBase) {
	const dir = BUCKET_DIR[bucket] || "misc";
	const relUnderTests = file.startsWith("tests/") ? file.slice("tests/".length) : file;
	return toPosix(join(outBase, dir, relUnderTests));
}

function processEntry(entry, opts) {
	const file = entry.file;
	const originalAbs = join(REPO_ROOT, file);
	if (!existsSync(originalAbs)) {
		return { file, target: null, method: entry.method, bucket: entry.bucket, classification: "needs-manual", reasons: ["source file does not exist (phantom map entry)"], transforms: [], written: false };
	}

	const source = readFileSync(originalAbs, "utf8");
	const outRel = targetPath(file, entry.bucket, opts.out);
	const newAbs = join(REPO_ROOT, outRel);
	const transforms = [];

	// 1) node:test -> vitest imports.
	const nt = transformNodeTestImports(source);
	let code = nt.code;
	if (nt.hadNodeTest) transforms.push("node:test→vitest imports");

	// 2) hook + mock call sites.
	const beforeHooks = code;
	code = rewriteHookCalls(code, nt.imported);
	if (code !== beforeHooks) transforms.push("hook/mock call sites");

	// 3) dist/* -> src/*.
	const dist = rewriteDistImports(code);
	code = dist.code;
	if (dist.changed) transforms.push("dist/*→src/*");

	// 4) relative import path fixup for the new location.
	const beforeRel = code;
	code = rewriteRelativeImports(code, originalAbs, newAbs);
	if (code !== beforeRel) transforms.push("relative import paths");

	const { classification, reasons } = detectFlags(source, code, {
		method: entry.method,
		imported: nt.imported,
		hadNodeTest: nt.hadNodeTest,
		defaultOrNamespace: nt.defaultOrNamespace,
		sawRaw: nt.sawRaw,
		distChanged: dist.changed,
	});

	// Deterministic header (no timestamp -> idempotent output).
	const header =
		`// AUTO-GENERATED by scripts/testing-v2/codemod.mjs — do not edit the legacy source.\n` +
		`// Source: ${file}\n` +
		`// Bucket: ${entry.bucket} | Method: ${entry.method} | Classification: ${classification}\n` +
		(reasons.length ? `// Review: ${reasons.join(" | ")}\n` : "") +
		`\n`;
	const finalCode = header + code;

	let written = false;
	if (!opts.dryRun) {
		mkdirSync(dirname(newAbs), { recursive: true });
		// Idempotent: only write when content differs.
		if (!existsSync(newAbs) || readFileSync(newAbs, "utf8") !== finalCode) {
			writeFileSync(newAbs, finalCode);
		}
		written = true;
	}

	return { file, target: outRel, method: entry.method, bucket: entry.bucket, classification, reasons, transforms, written };
}

// ─────────────────────────────── main ───────────────────────────────

function loadEntries() {
	const raw = JSON.parse(readFileSync(MAP_PATH, "utf8"));
	const entries = Array.isArray(raw) ? raw : raw.entries;
	if (!Array.isArray(entries)) throw new Error("codemod: tests-map.json has no entries[]");
	return entries;
}

function main() {
	const opts = parseCli(process.argv.slice(2));
	const entries = loadEntries();
	const methodSet = new Set(opts.methods);

	let selected = entries.filter((e) => matchesTargets(e.file, opts.targets));
	if (!opts.allMethods) selected = selected.filter((e) => methodSet.has(e.method));
	if (Number.isFinite(opts.limit)) selected = selected.slice(0, opts.limit);

	const results = [];
	for (const entry of selected) results.push(processEntry(entry, opts));

	const counts = { total: results.length, clean: 0, needsWithEnv: 0, needsManual: 0, written: 0 };
	for (const r of results) {
		if (r.classification === "clean") counts.clean++;
		else if (r.classification === "needs-withEnv") counts.needsWithEnv++;
		else counts.needsManual++;
		if (r.written) counts.written++;
	}

	const report = {
		generatedBy: "scripts/testing-v2/codemod.mjs",
		generatedAt: new Date().toISOString(),
		argv: process.argv.slice(2),
		dryRun: opts.dryRun,
		methods: opts.allMethods ? "all" : opts.methods,
		counts,
		files: results.sort((a, b) => a.file.localeCompare(b.file)),
	};

	if (!opts.dryRun) {
		const reportAbs = join(REPO_ROOT, opts.report);
		mkdirSync(dirname(reportAbs), { recursive: true });
		writeFileSync(reportAbs, `${JSON.stringify(report, null, 2)}\n`);
	}

	console.log(`codemod: ${counts.total} file(s) processed${opts.dryRun ? " (dry-run)" : ""}`);
	console.log(`  clean          ${counts.clean}`);
	console.log(`  needs-withEnv  ${counts.needsWithEnv}`);
	console.log(`  needs-manual   ${counts.needsManual}`);
	if (!opts.dryRun) console.log(`  written        ${counts.written} -> ${opts.out}/<bucket>/`);
	console.log(`  report         ${opts.dryRun ? "(dry-run, not written)" : opts.report}`);

	// A few manual examples to guide review.
	const manuals = results.filter((r) => r.classification === "needs-manual").slice(0, 5);
	if (manuals.length) {
		console.log("\n  sample needs-manual:");
		for (const m of manuals) console.log(`   - ${m.file}: ${m.reasons[0]}`);
	}
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	try {
		main();
	} catch (e) {
		console.error("codemod: FAIL —", e.message);
		process.exit(1);
	}
}
