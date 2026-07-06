#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const BUILD_GLOBS = [
	"src/**", "defaults/**", "market-packs/**", "scripts/**", "public/**",
	"index.html", "package.json", "package-lock.json",
	"tsconfig.json", "tsconfig.server.json", "tsconfig.web.json", "vite.config.ts",
];
const CHECK_GLOBS = [
	"src/**", "tsconfig.json", "tsconfig.server.json", "tsconfig.web.json",
	"package.json", "package-lock.json",
];
const UNIT_GLOBS = [
	"src/**", "tests/**", "defaults/**", "market-packs/**", "scripts/**",
	"index.html", "vite.config.ts", "package.json", "package-lock.json",
];

const CORE_STEPS = [
	{ name: "Build", type: "command", cacheInputGlobs: BUILD_GLOBS, runtimeMs: 60_000 },
	{ name: "Type check passes", type: "command", cacheInputGlobs: CHECK_GLOBS, runtimeMs: 45_000 },
	{ name: "Unit tests", type: "command", cacheInputGlobs: UNIT_GLOBS, runtimeMs: 90_000 },
	{ name: "E2E tests", type: "command", runtimeMs: 120_000 },
];

const BASE_FILES = new Map([
	["src/app.ts", "export const app = 1;\n"],
	["src/util.ts", "export const util = 1;\n"],
	["tests/app.test.ts", "import 'node:test';\n"],
	["defaults/tools/example.yaml", "name: example\n"],
	["market-packs/example/pack.yaml", "id: example\n"],
	["scripts/build.mjs", "console.log('build');\n"],
	["public/app.css", "body { color: black; }\n"],
	["index.html", "<div id=\"app\"></div>\n"],
	["package.json", "{\"name\":\"fixture\",\"version\":\"1.0.0\"}\n"],
	["package-lock.json", "{\"lockfileVersion\":3}\n"],
	["tsconfig.json", "{}\n"],
	["tsconfig.server.json", "{\"extends\":\"./tsconfig.json\"}\n"],
	["tsconfig.web.json", "{\"extends\":\"./tsconfig.json\"}\n"],
	["vite.config.ts", "export default {};\n"],
	["README.md", "readme\n"],
	["docs/readme.md", "docs\n"],
]);

const CORPUS = [
	{
		id: "exact-sha-resignal",
		description: "Same commit SHA re-signalled; both arms should reuse every prior passed step.",
		steps: CORE_STEPS,
		edits: [],
	},
	{
		id: "docs-only-change",
		description: "Docs-only commit outside the declared command-step input globs.",
		steps: CORE_STEPS,
		edits: [["docs/readme.md", "docs updated\n"]],
	},
	{
		id: "source-change",
		description: "Source commit invalidates Build, Type check, and Unit tests.",
		steps: CORE_STEPS,
		edits: [["src/app.ts", "export const app = 2;\n"]],
	},
	{
		id: "test-only-change",
		description: "Test-only commit invalidates Unit tests but not Build or Type check.",
		steps: CORE_STEPS,
		edits: [["tests/app.test.ts", "import 'node:test';\nexport const changed = true;\n"]],
	},
	{
		id: "dependency-change",
		description: "Dependency metadata commit invalidates Build, Type check, and Unit tests.",
		steps: CORE_STEPS,
		edits: [["package-lock.json", "{\"lockfileVersion\":3,\"packages\":{\"\":\"fixture\"}}\n"]],
	},
	{
		id: "public-asset-change",
		description: "Public asset commit invalidates Build only among the content-keyed command steps.",
		steps: CORE_STEPS,
		edits: [["public/app.css", "body { color: blue; }\n"]],
	},
	{
		id: "no-cache-input-globs",
		description: "Review-like step without cacheInputGlobs remains SHA-exact under content mode.",
		steps: [{ name: "Risk review", type: "llm-review", runtimeMs: 180_000 }],
		edits: [["src/util.ts", "export const util = 2;\n"]],
	},
	{
		id: "glob-matches-no-tracked-path",
		description: "Declared glob matches no tracked files; content mode must fail closed.",
		steps: [{ name: "Custom stale glob step", type: "command", cacheInputGlobs: ["missing/**"], runtimeMs: 30_000 }],
		edits: [["README.md", "readme updated\n"]],
	},
	{
		id: "earliest-prior-passed-result",
		description: "The earliest prior passed result is selected even when a later passed result would be reusable.",
		steps: [{ name: "Build", type: "command", cacheInputGlobs: BUILD_GLOBS, runtimeMs: 60_000 }],
		edits: [["docs/readme.md", "docs after source change\n"]],
		beforeCurrent({ repo, git, commit }) {
			fs.writeFileSync(path.join(repo, "src/app.ts"), "export const app = 3;\n");
			git(["add", "-A"]);
			const sourceSha = commit("source-prior");
			return [{
				id: "sig-prior-later",
				commitSha: sourceSha,
				timestamp: 2,
				verification: {
					status: "passed",
					steps: this.steps.map(step => passedStep(step)),
				},
			}];
		},
	},
];

function git(repo, args) {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function writeFixtureFiles(repo) {
	for (const [rel, content] of BASE_FILES) {
		const file = path.join(repo, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
}

function createScenarioRepo(scenario) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-exp001-${scenario.id}-`));
	const runGit = args => git(repo, args);
	runGit(["init", "-q"]);
	runGit(["config", "user.email", "exp001@example.test"]);
	runGit(["config", "user.name", "EXP-001"]);
	writeFixtureFiles(repo);
	runGit(["add", "-A"]);
	runGit(["commit", "-qm", "base"]);
	const baseSha = runGit(["rev-parse", "HEAD"]);
	const commit = msg => {
		runGit(["commit", "-qm", msg]);
		return runGit(["rev-parse", "HEAD"]);
	};

	let extraPriorSignals = [];
	if (scenario.beforeCurrent) {
		extraPriorSignals = scenario.beforeCurrent({ repo, git: runGit, commit }) ?? [];
	}

	for (const [rel, content] of scenario.edits) {
		const file = path.join(repo, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	let currentSha = baseSha;
	if (scenario.edits.length > 0) {
		runGit(["add", "-A"]);
		currentSha = commit(`current-${scenario.id}`);
	}

	const priorSignals = [{
		id: "sig-prior-base",
		commitSha: baseSha,
		timestamp: 1,
		verification: {
			status: "passed",
			steps: scenario.steps.map(step => passedStep(step)),
		},
	}, ...extraPriorSignals];

	return { repo, baseSha, currentSha, priorSignals };
}

function passedStep(step) {
	return {
		name: step.name,
		type: step.type,
		passed: true,
		status: "passed",
		duration_ms: step.runtimeMs,
		output: "ok",
	};
}

function buildStepCache(signals, currentSignalId, commitSha) {
	const cache = new Map();
	if (!commitSha) return cache;
	for (const prev of signals) {
		if (prev.id === currentSignalId) continue;
		if (prev.commitSha !== commitSha) continue;
		if (!prev.verification?.status || prev.verification.status === "running") continue;
		for (const step of prev.verification.steps) {
			if (step.type === "human-signoff") continue;
			if (step.passed && !cache.has(step.name)) cache.set(step.name, step);
		}
	}
	return cache;
}

function globToRegExp(glob) {
	let pattern = "";
	for (let i = 0; i < glob.length; i++) {
		if (glob[i] === "*" && glob[i + 1] === "*") {
			pattern += ".*";
			i += 1;
		} else if (glob[i] === "*") {
			pattern += "[^/]*";
		} else if (glob[i] === "?") {
			pattern += "[^/]";
		} else if (/[.+^${}()|[\]\\]/.test(glob[i])) {
			pattern += `\\${glob[i]}`;
		} else {
			pattern += glob[i];
		}
	}
	return new RegExp(`^${pattern}$`);
}

function pathMatchesAnyGlob(rel, globs) {
	return globs.some(glob => globToRegExp(glob).test(rel));
}

function anyPathMatchesGlobs(trackedPaths, globs) {
	return trackedPaths.some(rel => pathMatchesAnyGlob(rel, globs));
}

function listTrackedPaths(repo, sha) {
	return git(repo, ["ls-tree", "-r", "--name-only", sha]).split(/\r?\n/).filter(Boolean);
}

function diffIsClean(repo, priorSha, currentSha, globs) {
	try {
		execFileSync("git", ["diff", "--quiet", priorSha, currentSha, "--", ...globs], { cwd: repo });
		return true;
	} catch (err) {
		if (err?.status === 1) return false;
		throw err;
	}
}

async function buildContentStepCache(signals, currentSignalId, commitSha, activeSteps, repo) {
	const decisions = [];
	const exact = buildStepCache(signals, currentSignalId, commitSha);
	const cache = new Map(exact);
	const activeStepNames = new Set(activeSteps.map(step => step.name));
	for (const name of exact.keys()) {
		if (activeStepNames.has(name)) decisions.push({ stepName: name, keyKind: "sha", result: "hit" });
	}
	if (!commitSha) return { cache, decisions };

	let trackedPaths;
	for (const step of activeSteps) {
		if (cache.has(step.name)) continue;
		if (step.type === "human-signoff") continue;

		const globs = step.cacheInputGlobs;
		if (!globs || globs.length === 0) {
			decisions.push({ stepName: step.name, keyKind: "sha", result: "miss", reason: "no cacheInputGlobs declared on step - sha-exact only" });
			continue;
		}

		let matchedStep;
		let matchedFromSha;
		for (const prev of signals) {
			if (prev.id === currentSignalId) continue;
			if (!prev.verification?.status || prev.verification.status === "running") continue;
			const priorStep = prev.verification.steps.find(candidate => candidate.name === step.name);
			if (!priorStep?.passed) continue;
			matchedStep = priorStep;
			matchedFromSha = prev.commitSha;
			break;
		}
		if (!matchedStep || !matchedFromSha) {
			decisions.push({ stepName: step.name, keyKind: "content", result: "miss", reason: "no prior passed result found" });
			continue;
		}
		if (matchedFromSha === commitSha) {
			cache.set(step.name, matchedStep);
			decisions.push({ stepName: step.name, keyKind: "sha", result: "hit" });
			continue;
		}

		try {
			trackedPaths ??= listTrackedPaths(repo, commitSha);
			if (!anyPathMatchesGlobs(trackedPaths, globs)) {
				decisions.push({ stepName: step.name, keyKind: "content", result: "miss", reason: "cacheInputGlobs matched no tracked paths - cannot verify" });
				continue;
			}
			const unchanged = diffIsClean(repo, matchedFromSha, commitSha, globs);
			if (unchanged) {
				cache.set(step.name, matchedStep);
				decisions.push({ stepName: step.name, keyKind: "content", result: "hit" });
			} else {
				decisions.push({ stepName: step.name, keyKind: "content", result: "miss" });
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			decisions.push({ stepName: step.name, keyKind: "content", result: "miss", reason: `git lookup failed: ${msg}` });
		}
	}
	return { cache, decisions };
}

function inputChangedForHit(repo, signals, currentSha, decision, steps) {
	const step = steps.find(candidate => candidate.name === decision.stepName);
	if (!step?.cacheInputGlobs?.length) return false;
	const prior = signals.find(signal => signal.verification?.steps?.some(priorStep => priorStep.name === step.name && priorStep.passed));
	if (!prior?.commitSha) return false;
	if (prior.commitSha === currentSha) return false;
	return !diffIsClean(repo, prior.commitSha, currentSha, step.cacheInputGlobs);
}

async function evaluateScenarioArm(scenario, fixture, arm) {
	const start = performance.now();
	const cacheResult = arm === "content"
		? await buildContentStepCache(fixture.priorSignals, "sig-current", fixture.currentSha, scenario.steps, fixture.repo)
		: (() => {
			const cache = buildStepCache(fixture.priorSignals, "sig-current", fixture.currentSha);
			const decisions = scenario.steps
				.filter(step => step.type !== "human-signoff")
				.map(step => ({ stepName: step.name, keyKind: "sha", result: cache.has(step.name) ? "hit" : "miss" }));
			return { cache, decisions };
		})();
	const decisionWallClockMs = performance.now() - start;
	const cacheHits = cacheResult.decisions.filter(decision => decision.result === "hit").length;
	const cacheableSteps = cacheResult.decisions.length;
	const estimatedWallClockMs = scenario.steps
		.filter(step => step.type !== "human-signoff")
		.filter(step => !cacheResult.cache.has(step.name))
		.reduce((sum, step) => sum + step.runtimeMs, 0);
	const falseHitRiskProxy = cacheResult.decisions
		.filter(decision => decision.result === "hit")
		.filter(decision => inputChangedForHit(fixture.repo, fixture.priorSignals, fixture.currentSha, decision, scenario.steps))
		.length;
	const hitKeyKinds = { sha: 0, content: 0 };
	for (const decision of cacheResult.decisions) {
		if (decision.result === "hit") hitKeyKinds[decision.keyKind]++;
	}
	return {
		scenarioId: scenario.id,
		arm,
		cacheableSteps,
		cacheHits,
		cacheMisses: cacheableSteps - cacheHits,
		hitKeyKinds,
		falseHitRiskProxy,
		estimatedWallClockMs,
		decisionWallClockMs,
		decisions: cacheResult.decisions,
	};
}

function median(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function summarizeArmRecords(records) {
	const arms = {};
	for (const arm of ["sha", "content"]) {
		const armRecords = records.filter(record => record.arm === arm);
		const cacheableSteps = armRecords.reduce((sum, record) => sum + record.cacheableSteps, 0);
		const cacheHits = armRecords.reduce((sum, record) => sum + record.cacheHits, 0);
		const estimatedWallClockMs = armRecords.reduce((sum, record) => sum + record.estimatedWallClockMs, 0);
		const decisionWallClockMs = armRecords.reduce((sum, record) => sum + record.decisionWallClockMs, 0);
		const falseHitRiskProxy = armRecords.reduce((sum, record) => sum + record.falseHitRiskProxy, 0);
		arms[arm] = {
			scenarios: armRecords.length,
			cacheableSteps,
			cacheHits,
			cacheMisses: cacheableSteps - cacheHits,
			cacheHitRate: cacheableSteps === 0 ? 0 : cacheHits / cacheableSteps,
			hitKeyKinds: armRecords.reduce((acc, record) => {
				acc.sha += record.hitKeyKinds?.sha ?? 0;
				acc.content += record.hitKeyKinds?.content ?? 0;
				return acc;
			}, { sha: 0, content: 0 }),
			falseHitRiskProxy,
			estimatedWallClockMs,
			medianEstimatedWallClockMs: median(armRecords.map(record => record.estimatedWallClockMs)),
			decisionWallClockMs,
		};
	}

	const scenarioIds = [...new Set(records.map(record => record.scenarioId))].sort();
	const paired = scenarioIds.map(scenarioId => {
		const sha = records.find(record => record.scenarioId === scenarioId && record.arm === "sha");
		const content = records.find(record => record.scenarioId === scenarioId && record.arm === "content");
		const savingsMs = sha && content ? sha.estimatedWallClockMs - content.estimatedWallClockMs : null;
		return {
			scenarioId,
			shaEstimatedWallClockMs: sha?.estimatedWallClockMs ?? null,
			contentEstimatedWallClockMs: content?.estimatedWallClockMs ?? null,
			savingsMs,
			reductionPct: savingsMs !== null && sha?.estimatedWallClockMs > 0 ? savingsMs / sha.estimatedWallClockMs : null,
		};
	});
	const validReductionPcts = paired.map(pair => pair.reductionPct).filter(value => value !== null);
	const totalSavingsMs = arms.sha.estimatedWallClockMs - arms.content.estimatedWallClockMs;
	const summary = {
		generatedAt: new Date().toISOString(),
		sampleSize: {
			pairedScenarios: scenarioIds.length,
			cacheableStepsPerArm: {
				sha: arms.sha.cacheableSteps,
				content: arms.content.cacheableSteps,
			},
		},
		arms,
		paired,
		effects: {
			cacheHitRateDeltaPctPoints: (arms.content.cacheHitRate - arms.sha.cacheHitRate) * 100,
			totalEstimatedWallClockSavingsMs: totalSavingsMs,
			medianEstimatedWallClockReductionPct: arms.sha.medianEstimatedWallClockMs > 0
				? (arms.sha.medianEstimatedWallClockMs - arms.content.medianEstimatedWallClockMs) / arms.sha.medianEstimatedWallClockMs
				: null,
			medianPairedReductionPct: median(validReductionPcts),
			contentOverheadShareOfSavings: totalSavingsMs > 0 ? arms.content.decisionWallClockMs / totalSavingsMs : null,
		},
	};
	summary.recommendation = decideRecommendation(summary);
	return summary;
}

export function decideRecommendation(summary) {
	const sha = summary.arms.sha;
	const content = summary.arms.content;
	const effects = summary.effects;
	if (sha.falseHitRiskProxy !== 0 || content.falseHitRiskProxy !== 0) return "keep-sha";
	if (content.medianEstimatedWallClockMs > sha.medianEstimatedWallClockMs) return "keep-sha";
	if (
		effects.cacheHitRateDeltaPctPoints >= 20
		&& effects.medianEstimatedWallClockReductionPct !== null
		&& effects.medianEstimatedWallClockReductionPct >= 0.2
		&& effects.contentOverheadShareOfSavings !== null
		&& effects.contentOverheadShareOfSavings < 0.05
	) {
		return "recommend-content-for-next-lane";
	}
	return "inconclusive";
}

function pct(value) {
	if (value === null || Number.isNaN(value)) return "n/a";
	return `${(value * 100).toFixed(1)}%`;
}

function ms(value) {
	return `${Math.round(value).toLocaleString("en-US")} ms`;
}

export function formatMarkdownSummary(summary) {
	const sha = summary.arms.sha;
	const content = summary.arms.content;
	return `# EXP-001 Gate Cache Keying Results

Generated: ${summary.generatedAt}
Recommendation: \`${summary.recommendation}\`

| Metric | sha | content |
|---|---:|---:|
| Paired scenarios | ${sha.scenarios} | ${content.scenarios} |
| Cacheable step decisions | ${sha.cacheableSteps} | ${content.cacheableSteps} |
| Cache hits | ${sha.cacheHits} | ${content.cacheHits} |
| Cache hit rate | ${pct(sha.cacheHitRate)} | ${pct(content.cacheHitRate)} |
| SHA-key hits | ${sha.hitKeyKinds.sha} | ${content.hitKeyKinds.sha} |
| Content-key hits | ${sha.hitKeyKinds.content} | ${content.hitKeyKinds.content} |
| False-hit risk proxy | ${sha.falseHitRiskProxy} | ${content.falseHitRiskProxy} |
| Estimated wall-clock total | ${ms(sha.estimatedWallClockMs)} | ${ms(content.estimatedWallClockMs)} |
| Estimated wall-clock median | ${ms(sha.medianEstimatedWallClockMs)} | ${ms(content.medianEstimatedWallClockMs)} |
| Decision engine wall-clock | ${ms(sha.decisionWallClockMs)} | ${ms(content.decisionWallClockMs)} |

Effect summary:

- Cache hit-rate delta: ${summary.effects.cacheHitRateDeltaPctPoints.toFixed(1)} percentage points.
- Total estimated wall-clock savings: ${ms(summary.effects.totalEstimatedWallClockSavingsMs)}.
- Median estimated wall-clock reduction: ${pct(summary.effects.medianEstimatedWallClockReductionPct)}.
- Median paired reduction: ${pct(summary.effects.medianPairedReductionPct)}.
- Content decision overhead share of savings: ${pct(summary.effects.contentOverheadShareOfSavings)}.

Scenario pairs:

| Scenario | sha estimated wall-clock | content estimated wall-clock | savings | reduction |
|---|---:|---:|---:|---:|
${summary.paired.map(pair => `| ${pair.scenarioId} | ${ms(pair.shaEstimatedWallClockMs)} | ${ms(pair.contentEstimatedWallClockMs)} | ${ms(pair.savingsMs)} | ${pct(pair.reductionPct)} |`).join("\n")}
`;
}

function parseArgs(argv) {
	const opts = {
		json: path.join(projectRoot, "docs", "experiments", "EXP-001-gate-cache-keying-results.json"),
		markdown: path.join(projectRoot, "docs", "experiments", "EXP-001-gate-cache-keying-summary.md"),
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") opts.json = path.resolve(argv[++i]);
		else if (arg === "--markdown" || arg === "--md") opts.markdown = path.resolve(argv[++i]);
		else if (arg === "--no-write") opts.noWrite = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	return opts;
}

export async function runExperiment() {
	const records = [];
	const corpus = [];
	for (const scenario of [...CORPUS].sort((a, b) => a.id.localeCompare(b.id))) {
		const fixture = createScenarioRepo(scenario);
		try {
			corpus.push({
				id: scenario.id,
				description: scenario.description,
				steps: scenario.steps.map(step => ({
					name: step.name,
					type: step.type,
					cacheInputGlobs: step.cacheInputGlobs ?? null,
					runtimeMs: step.runtimeMs,
				})),
			});
			for (const arm of ["content", "sha"]) {
				records.push(await evaluateScenarioArm(scenario, fixture, arm));
			}
		} finally {
			fs.rmSync(fixture.repo, { recursive: true, force: true });
		}
	}
	const summary = summarizeArmRecords(records);
	return { experimentId: "EXP-001-gate-cache-keying", corpus, records, summary };
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const result = await runExperiment();
	const markdown = formatMarkdownSummary(result.summary);
	const jsonText = `${JSON.stringify(result, null, 2)}\n`;
	if (!opts.noWrite) {
		fs.mkdirSync(path.dirname(opts.json), { recursive: true });
		fs.mkdirSync(path.dirname(opts.markdown), { recursive: true });
		fs.writeFileSync(opts.json, jsonText);
		fs.writeFileSync(opts.markdown, markdown);
		console.log(`Wrote ${path.relative(projectRoot, opts.json)}`);
		console.log(`Wrote ${path.relative(projectRoot, opts.markdown)}`);
	}
	console.log(markdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch(err => {
		console.error(err);
		process.exitCode = 1;
	});
}
