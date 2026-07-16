#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ensureServerTestPrebundle,
	serverPrebundleResolver,
} from "./server-prebundle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SUPPORT_ENTRIES = [
	"tests/helpers/tmp.ts",
	"tests/helpers/agent-dir.ts",
	"tests/helpers/run-subgoal-step-fixture.ts",
	"tests/e2e/test-utils/cleanup.ts",
];
const DOM_WEB_ENTRIES = [
	"src/app/state.ts",
	"src/ui/lazy/safe-markdown-block.ts",
	"src/ui/components/GitStatusWidget.ts",
];
// Regression chain from the node-only plan suite. A DOM transform cached for
// this graph used to redirect state.ts to the eager browser bundle; that bundle
// could then reach the side-panel/proposal workspace cycle and evaluate window
// before the node test installed its mocks/shims.
const NODE_WINDOW_IMPORT_CHAIN = [
	["src/app/state.ts", "src/app/goal-dashboard-plan-tab.ts"],
	["src/app/proposal-workspace-actions.ts", "src/app/proposal-registry.ts"],
	["src/app/side-panel-workspace.ts", "src/app/proposal-workspace-actions.ts"],
	["src/app/state.ts", "src/app/side-panel-workspace.ts"],
];
const TOOL_ENTRIES = [
	"defaults/tools/proposals/extension.ts",
	"defaults/tools/agent/extension.ts",
	"defaults/tools/html/snapshot.ts",
	"defaults/tools/skills/extension.ts",
	"defaults/tools/ask/extension.ts",
	"defaults/tools/browser/extension.ts",
	"defaults/tools/images/extension.ts",
	"defaults/tools/html/extension.ts",
	"defaults/tools/team/extension.ts",
	"defaults/tools/_shared/gateway.ts",
];

function toPosix(file) {
	return file.replace(/\\/g, "/");
}

function walkTestFiles(root) {
	const files = [];
	const pending = [root];
	while (pending.length > 0) {
		const dir = pending.pop();
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) pending.push(full);
			else if (entry.name.endsWith(".test.ts")) files.push(full);
		}
	}
	return files;
}

function graphSourceMapContains(manifest, cacheDir, sourceEntry) {
	return Object.keys(manifest.files).some((relativeFile) => {
		if (!relativeFile.endsWith(".mjs.map")) return false;
		const mapPath = join(cacheDir, ...relativeFile.split("/"));
		const map = JSON.parse(readFileSync(mapPath, "utf8"));
		return Array.isArray(map.sources) && map.sources.some((source) => {
			const normalized = toPosix(resolve(dirname(mapPath), source));
			return normalized.endsWith(`/${sourceEntry}`);
		});
	});
}

function resolverCacheKey(plugin) {
	let generator;
	plugin.configureVitest({
		experimental_defineCacheKeyGenerator(value) {
			generator = value;
		},
	});
	assert.equal(typeof generator, "function", `${plugin.name} must define a Vitest cache key`);
	return generator();
}

const testSources = walkTestFiles(join(REPO_ROOT, "tests2")).map((testFile) => ({
	testFile,
	source: readFileSync(testFile, "utf8"),
}));

function countImportEdges(sourceEntries) {
	let count = 0;
	for (const { testFile, source } of testSources) {
		for (const sourceEntry of sourceEntries) {
			const relativeImport = toPosix(relative(dirname(testFile), join(REPO_ROOT, sourceEntry)));
			const withoutExtension = relativeImport.slice(0, -extname(relativeImport).length);
			if (source.includes(relativeImport)
				|| source.includes(`${withoutExtension}.js`)
				|| source.includes(`${withoutExtension}.ts`)) count++;
		}
	}
	return count;
}

const supportImportEdges = countImportEdges(SUPPORT_ENTRIES);
const webImportEdges = countImportEdges(DOM_WEB_ENTRIES);
const toolImportEdges = countImportEdges(TOOL_ENTRIES);
assert.ok(supportImportEdges >= 50, `shared-support panel shrank below 50 import edges (${supportImportEdges})`);
assert.ok(webImportEdges >= 40, `DOM web panel shrank below 40 import edges (${webImportEdges})`);
assert.ok(toolImportEdges >= 12, `mock-free tool panel shrank below 12 import edges (${toolImportEdges})`);

const prebundle = await ensureServerTestPrebundle();
const manifest = JSON.parse(readFileSync(prebundle.manifestPath, "utf8"));
const domResolver = serverPrebundleResolver(prebundle);
const nodeResolver = serverPrebundleResolver(prebundle, { webEntries: false });

assert.notEqual(nodeResolver.name, domResolver.name, "Node and DOM resolver profiles must be distinct");
assert.notEqual(
	resolverCacheKey(nodeResolver),
	resolverCacheKey(domResolver),
	"Node transforms must never reuse DOM transforms that eagerly resolve browser entries",
);

for (const [sourceEntry, importerEntry] of NODE_WINDOW_IMPORT_CHAIN) {
	const request = join(REPO_ROOT, sourceEntry.replace(/\.ts$/, ".js"));
	const importer = join(REPO_ROOT, importerEntry);
	assert.equal(
		nodeResolver.resolveId(request, importer),
		null,
		`${importerEntry} -> ${sourceEntry} must stay in Vitest's node runner for mocks and window safety`,
	);
}

for (const sourceEntry of [...SUPPORT_ENTRIES, ...DOM_WEB_ENTRIES, ...TOOL_ENTRIES]) {
	const output = manifest.entries[sourceEntry];
	assert.equal(typeof output, "string", `${sourceEntry} must remain a prebundle entry`);
	assert.ok(manifest.files[output], `${sourceEntry} emitted entry must be hashed`);
	assert.ok(manifest.files[`${output}.map`], `${sourceEntry} emitted entry must retain a source map`);
	assert.ok(
		graphSourceMapContains(manifest, prebundle.cacheDir, sourceEntry),
		`${sourceEntry} coverage mapping must point to repository source`,
	);
}

for (const sourceEntry of [...SUPPORT_ENTRIES, ...TOOL_ENTRIES]) {
	const resolved = nodeResolver.resolveId(join(REPO_ROOT, sourceEntry.replace(/\.ts$/, ".js")));
	assert.ok(resolved && typeof resolved === "object", `${sourceEntry} must resolve in node projects`);
	assert.equal(resolved.external, true, `${sourceEntry} must share the worker's Node ESM namespace`);
}

for (const sourceEntry of DOM_WEB_ENTRIES) {
	const request = join(REPO_ROOT, sourceEntry.replace(/\.ts$/, ".js"));
	const resolved = domResolver.resolveId(request);
	assert.ok(resolved && typeof resolved === "object", `${sourceEntry} must resolve in the DOM project`);
	assert.equal(resolved.external, false, `${sourceEntry} must execute in the isolated DOM runner`);
	assert.equal(nodeResolver.resolveId(request), null, `${sourceEntry} must remain source-mockable in node projects`);
}

const domSetup = domResolver.resolveId(join(REPO_ROOT, "tests2", "dom", "_setup", "custom-elements.js"));
assert.ok(domSetup && typeof domSetup === "object", "DOM setup must resolve through the prebundle");
assert.equal(domSetup.external, false, "DOM decorators must execute in every isolated happy-dom runner");

console.log(
	`[server-prebundle-perf-pin] ${SUPPORT_ENTRIES.length + DOM_WEB_ENTRIES.length + TOOL_ENTRIES.length} entries, `
	+ `${supportImportEdges + webImportEdges + toolImportEdges} repeated tier-1 import edges, `
	+ `node/DOM cache isolation, window-safe node import chain, and source maps pinned`,
);
