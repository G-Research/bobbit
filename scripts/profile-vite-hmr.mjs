#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer, loadConfigFromFile } from "vite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DEFAULT_FIXTURE_ROOT = path.join(REPO_ROOT, ".bobbit-qa", "vite-hmr-profile");
const DEFAULT_RESULTS_ROOT = path.join(REPO_ROOT, ".bobbit-qa", "vite-hmr-results");
const DEFAULT_PORT = 5174;
const DEFAULT_ITERATIONS = 5;

export function parseArgs(argv) {
	const options = {
		fixtureRoot: DEFAULT_FIXTURE_ROOT,
		resultsRoot: DEFAULT_RESULTS_ROOT,
		port: DEFAULT_PORT,
		iterations: DEFAULT_ITERATIONS,
		clients: 1,
		exerciseLazy: false,
		maxP95Ms: null,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const valueAfter = (flag) => {
			const value = argv[++i];
			if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
			return value;
		};
		if (arg === "--port") options.port = Number(valueAfter(arg));
		else if (arg.startsWith("--port=")) options.port = Number(arg.slice(7));
		else if (arg === "--clients") options.clients = Number(valueAfter(arg));
		else if (arg.startsWith("--clients=")) options.clients = Number(arg.slice(10));
		else if (arg === "--exercise-lazy") options.exerciseLazy = true;
		else if (arg === "--iterations") options.iterations = Number(valueAfter(arg));
		else if (arg.startsWith("--iterations=")) options.iterations = Number(arg.slice(13));
		else if (arg === "--max-p95-ms") options.maxP95Ms = Number(valueAfter(arg));
		else if (arg.startsWith("--max-p95-ms=")) options.maxP95Ms = Number(arg.slice(13));
		else if (arg === "--fixture-root") options.fixtureRoot = path.resolve(REPO_ROOT, valueAfter(arg));
		else if (arg.startsWith("--fixture-root=")) options.fixtureRoot = path.resolve(REPO_ROOT, arg.slice(15));
		else if (arg === "--results-root") options.resultsRoot = path.resolve(REPO_ROOT, valueAfter(arg));
		else if (arg.startsWith("--results-root=")) options.resultsRoot = path.resolve(REPO_ROOT, arg.slice(15));
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("--port must be an integer from 1 to 65535");
	if (!Number.isInteger(options.clients) || options.clients < 1 || options.clients > 20) throw new Error("--clients must be an integer from 1 to 20");
	if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > 50) throw new Error("--iterations must be an integer from 1 to 50");
	if (options.maxP95Ms !== null && (!Number.isFinite(options.maxP95Ms) || options.maxP95Ms <= 0)) throw new Error("--max-p95-ms must be positive");
	return options;
}

export function percentile(values, percentileValue) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
	return sorted[index];
}

export function validateReport(report, maxP95Ms) {
	if (report.overlappingTwoFileEdit?.delivered !== true) {
		throw new Error("Overlapping two-file edit was not delivered");
	}
	if (maxP95Ms !== null && report.singleFileP95Ms > maxP95Ms) {
		throw new Error(`Warm single-file p95 ${report.singleFileP95Ms} ms exceeded ${maxP95Ms} ms`);
	}
}

export function usage() {
	return `Usage: npm run profile:hmr -- [options]\n\nRuns a real bundled-development Vite server and Chromium against an isolated copy of Bobbit, then measures source-write to app-paint latency. The live dev server and working tree are not modified.\n\nOptions:\n  --iterations N       Warm single-file reload samples (default: ${DEFAULT_ITERATIONS})\n  --clients N          Connected browser pages contributing HMR clients (default: 1)\n  --exercise-lazy      Import representative lazy application routes before sampling\n  --port N             Isolated Vite port (default: ${DEFAULT_PORT})\n  --max-p95-ms N       Exit non-zero when warm single-file p95 exceeds N ms\n  --fixture-root PATH  Disposable fixture directory\n  --results-root PATH  JSON result directory\n  -h, --help           Show this help`;
}

function copyFixture(fixtureRoot) {
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
	fs.mkdirSync(fixtureRoot, { recursive: true });
	for (const directory of ["src", "public", "docs", "tests"]) {
		fs.cpSync(path.join(REPO_ROOT, directory), path.join(fixtureRoot, directory), { recursive: true });
	}
	for (const file of ["index.html", "tsconfig.json", "tsconfig.web.json", "tsconfig.server.json", "tsconfig.tests.json"]) {
		fs.copyFileSync(path.join(REPO_ROOT, file), path.join(fixtureRoot, file));
	}

	// src/ui/app.css explicitly scans this package. Copy only its source surface;
	// JavaScript package resolution still walks up to the repository node_modules.
	const miniLitSource = path.join(REPO_ROOT, "node_modules", "@mariozechner", "mini-lit", "dist");
	const miniLitTarget = path.join(fixtureRoot, "node_modules", "@mariozechner", "mini-lit", "dist");
	fs.mkdirSync(path.dirname(miniLitTarget), { recursive: true });
	fs.cpSync(miniLitSource, miniLitTarget, { recursive: true });
}

function appendProbe(file, source) {
	fs.appendFileSync(file, `\n${source}\n`, "utf8");
}

async function waitForProbePaint(page, marker, timeout = 180_000) {
	await page.waitForFunction(
		(expected) => globalThis.__BOBBIT_HMR_PROFILE__ === expected,
		marker,
		{ timeout },
	);
	await page.waitForFunction(() => document.querySelector("#app")?.children.length > 0, null, { timeout: 180_000 });
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function rounded(value) {
	return Math.round(value * 10) / 10;
}

async function runProfile(options) {
	copyFixture(options.fixtureRoot);
	const lazyModuleCount = 10;
	if (options.exerciseLazy) {
		appendProbe(
			path.join(options.fixtureRoot, "src", "app", "main.ts"),
			`Promise.allSettled([\n${[
				"dialogs.js",
				"goal-dashboard.js",
				"settings-page.js",
				"role-manager-page.js",
				"tool-manager-page.js",
				"workflow-page.js",
				"skills-page.js",
				"marketplace-page.js",
				"staff-page.js",
				"proposal-panels.js",
			].map((module) => `\timport(${JSON.stringify(`./${module}`)})`).join(",\n")}\n]).then(() => { (globalThis as any).__BOBBIT_HMR_LAZY_READY__ = true; });`,
		);
	}

	const previousNord = process.env.BOBBIT_NORD;
	const previousHost = process.env.VITE_HOST;
	process.env.BOBBIT_NORD = "0";
	process.env.VITE_HOST = "localhost";
	const configEnv = { command: "serve", mode: "development", isSsrBuild: false, isPreview: false };
	const loaded = await loadConfigFromFile(configEnv, path.join(REPO_ROOT, "vite.config.ts"), REPO_ROOT);
	if (!loaded) throw new Error("Unable to load vite.config.ts");
	if (previousNord === undefined) delete process.env.BOBBIT_NORD;
	else process.env.BOBBIT_NORD = previousNord;
	if (previousHost === undefined) delete process.env.VITE_HOST;
	else process.env.VITE_HOST = previousHost;

	// The main Vite instance ignores .bobbit-qa, isolating these writes from the
	// developer's browser. Remove that one ancestor ignore inside the fixture.
	const rawConfig = loaded.config;
	const ignored = Array.isArray(rawConfig.server?.watch?.ignored)
		? rawConfig.server.watch.ignored.filter((pattern) => !String(pattern).includes(".bobbit"))
		: rawConfig.server?.watch?.ignored;
	const config = {
		...rawConfig,
		configFile: false,
		root: options.fixtureRoot,
		logLevel: "info",
		server: {
			...rawConfig.server,
			host: "127.0.0.1",
			port: options.port,
			strictPort: true,
			https: undefined,
			watch: { ...rawConfig.server?.watch, ignored },
		},
	};

	let server;
	let browser;
	try {
		server = await createServer(config);
		await server.listen();
		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();
		let navigationCount = 0;
		page.on("domcontentloaded", () => { navigationCount += 1; });
		page.on("pageerror", (error) => console.error(`[browser] ${error.message}`));

		const coldStarted = performance.now();
		await page.goto(`http://localhost:${options.port}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });
		await page.waitForFunction(() => document.querySelector("#app")?.children.length > 0, null, { timeout: 180_000 });
		const coldPaintMs = performance.now() - coldStarted;
		console.log(`Cold app paint: ${rounded(coldPaintMs)} ms`);
		for (let client = 1; client < options.clients; client++) {
			const extraPage = await browser.newPage();
			await extraPage.goto(`http://localhost:${options.port}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });
			await extraPage.waitForFunction(() => document.querySelector("#app")?.children.length > 0, null, { timeout: 180_000 });
		}
		if (options.clients > 1) console.log(`Connected HMR clients: ${options.clients}`);
		if (options.exerciseLazy) {
			await page.waitForFunction(() => globalThis.__BOBBIT_HMR_LAZY_READY__ === true, null, { timeout: 180_000 });
			console.log(`Exercised lazy modules: ${lazyModuleCount}`);
		}

		const singleFileMs = [];
		const singleTarget = path.join(options.fixtureRoot, "src", "app", "render-helpers.ts");
		for (let iteration = 1; iteration <= options.iterations; iteration++) {
			const marker = `single-${iteration}`;
			const started = performance.now();
			appendProbe(singleTarget, `(globalThis as any).__BOBBIT_HMR_PROFILE__ = ${JSON.stringify(marker)};`);
			await waitForProbePaint(page, marker);
			const elapsed = performance.now() - started;
			singleFileMs.push(elapsed);
			console.log(`Single-file ${iteration}/${options.iterations}: ${rounded(elapsed)} ms`);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}

		// Rolldown bundled-dev has historically lost a second application change
		// that lands while the first rebuild is running. Keep this correctness
		// probe separate from Tailwind noise so a CSS rebuild cannot mask it.
		const overlapMarker = `overlap-${Date.now()}`;
		const overlapStarted = performance.now();
		appendProbe(singleTarget, `(globalThis as any).__BOBBIT_HMR_PROFILE_STAGE__ = "overlap-1";`);
		await new Promise((resolve) => setTimeout(resolve, 150));
		appendProbe(
			path.join(options.fixtureRoot, "src", "app", "sidebar.ts"),
			`(globalThis as any).__BOBBIT_HMR_PROFILE__ = ${JSON.stringify(overlapMarker)};`,
		);
		let overlapDelivered = true;
		try {
			await waitForProbePaint(page, overlapMarker, 10_000);
		} catch {
			overlapDelivered = false;
		}
		const overlapMs = performance.now() - overlapStarted;
		console.log(`Overlapping two-file edit: delivered=${overlapDelivered} elapsed=${rounded(overlapMs)} ms`);

		const burstMarker = `burst-${Date.now()}`;
		const burstStartNavigations = navigationCount;
		const burstStarted = performance.now();
		appendProbe(singleTarget, `(globalThis as any).__BOBBIT_HMR_PROFILE_STAGE__ = "app-1";`);
		await new Promise((resolve) => setTimeout(resolve, 150));
		appendProbe(
			path.join(options.fixtureRoot, "tests", "browser", "fixtures", "session-actions.fixture.spec.ts"),
			`// staggered HMR noise: class="bg-[#123456]"`,
		);
		await new Promise((resolve) => setTimeout(resolve, 150));
		appendProbe(path.join(options.fixtureRoot, "docs", "internals.md"), `<!-- staggered HMR noise: class="text-[#654321]" -->`);
		await new Promise((resolve) => setTimeout(resolve, 150));
		const finalWriteStarted = performance.now();
		appendProbe(
			path.join(options.fixtureRoot, "src", "app", "sidebar.ts"),
			`(globalThis as any).__BOBBIT_HMR_PROFILE__ = ${JSON.stringify(burstMarker)};`,
		);
		await waitForProbePaint(page, burstMarker);
		const burstTotalMs = performance.now() - burstStarted;
		const burstFinalWriteMs = performance.now() - finalWriteStarted;
		const burstNavigations = navigationCount - burstStartNavigations;
		console.log(`Staggered burst: first-write-to-paint=${rounded(burstTotalMs)} ms final-write-to-paint=${rounded(burstFinalWriteMs)} ms navigations=${burstNavigations}`);

		const roundedSingles = singleFileMs.map(rounded);
		const report = {
			createdAt: new Date().toISOString(),
			commit: process.env.GITHUB_SHA || null,
			viteVersion: (await import("vite/package.json", { with: { type: "json" } })).default.version,
			iterations: options.iterations,
			clients: options.clients,
			exercisedLazyModules: options.exerciseLazy,
			coldPaintMs: rounded(coldPaintMs),
			singleFileMs: roundedSingles,
			singleFileP50Ms: rounded(percentile(singleFileMs, 0.5)),
			singleFileP95Ms: rounded(percentile(singleFileMs, 0.95)),
			overlappingTwoFileEdit: {
				delivered: overlapDelivered,
				elapsedMs: rounded(overlapMs),
			},
			staggeredBurst: {
				firstWriteToPaintMs: rounded(burstTotalMs),
				finalWriteToPaintMs: rounded(burstFinalWriteMs),
				navigations: burstNavigations,
			},
		};
		// Keep latest.json as the last known-good comparison. A failed correctness
		// or latency gate must not replace it with a run the profiler rejects.
		validateReport(report, options.maxP95Ms);

		fs.mkdirSync(options.resultsRoot, { recursive: true });
		const timestamp = report.createdAt.replace(/[:.]/g, "-");
		const reportPath = path.join(options.resultsRoot, `${timestamp}.json`);
		fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		fs.writeFileSync(path.join(options.resultsRoot, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
		console.log(`Result: ${path.relative(REPO_ROOT, reportPath)}`);
		console.log(`Warm p50=${report.singleFileP50Ms} ms p95=${report.singleFileP95Ms} ms`);
		return report;
	} finally {
		await browser?.close().catch(() => {});
		await server?.close().catch(() => {});
	}
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) console.log(usage());
		else await runProfile(options);
	} catch (error) {
		console.error(error instanceof Error ? error.stack || error.message : error);
		process.exitCode = 1;
	}
}
