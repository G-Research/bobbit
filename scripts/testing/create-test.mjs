#!/usr/bin/env node
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_LAYOUT, TEST_SEMANTICS, normalizeTestPath } from "./layout-policy.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..", "..");

function conventionFor(semantic) {
	return TEST_LAYOUT.find((entry) => entry.semantic === semantic);
}

function normalizeTestName(name) {
	if (typeof name !== "string" || name.trim() === "") throw new Error("Test name is required.");
	if (name.includes("\0")) throw new Error("Unsafe test name: NUL bytes are forbidden.");
	const normalized = normalizeTestPath(name.trim());
	if (/^(?:[A-Za-z]:\/|\/)/.test(normalized) || normalized.split("/").some((part) => part === "." || part === "..")) {
		throw new Error(`Unsafe test name "${name}": use repository-relative name segments without traversal.`);
	}
	const segments = normalized.split("/").filter(Boolean).map((segment) => segment
		.toLocaleLowerCase("en-US")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, ""));
	if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
		throw new Error(`Invalid test name "${name}": each segment must contain a letter or number.`);
	}
	return segments.join("/");
}

export function scaffoldTestPath(semantic, name) {
	const convention = conventionFor(semantic);
	if (!convention) throw new Error(`Unknown test semantic "${semantic}". Choose one of: ${TEST_SEMANTICS.join(", ")}.`);
	return `${convention.directory}/${normalizeTestName(name)}${convention.suffix}`;
}

export function scaffoldTestSource(semantic, name) {
	const convention = conventionFor(semantic);
	if (!convention) throw new Error(`Unknown test semantic "${semantic}". Choose one of: ${TEST_SEMANTICS.join(", ")}.`);
	const title = normalizeTestName(name).split("/").at(-1).replace(/-/g, " ");
	if (convention.runner === "vitest") {
		return `import { describe, it } from "vitest";\n\ndescribe(${JSON.stringify(title)}, () => {\n\tit("adds focused coverage", () => {\n\t\tthrow new Error("Implement this scaffolded test before committing it.");\n\t});\n});\n`;
	}
	if (convention.runner === "node") {
		return `import { describe, it } from "node:test";\n\ndescribe(${JSON.stringify(title)}, () => {\n\tit("adds focused coverage", () => {\n\t\tthrow new Error("Implement this scaffolded test before committing it.");\n\t});\n});\n`;
	}
	return `import { test } from "@playwright/test";\n\ntest(${JSON.stringify(`${title} adds focused coverage`)}, async () => {\n\tthrow new Error("Implement this scaffolded test before committing it.");\n});\n`;
}

/** Create one canonical test exclusively; no registry or inventory is updated. */
export function createTestFile(semantic, name, { root = REPO_ROOT } = {}) {
	const relativePath = scaffoldTestPath(semantic, name);
	const absolutePath = resolve(root, ...relativePath.split("/"));
	mkdirSync(dirname(absolutePath), { recursive: true });
	let descriptor;
	try {
		descriptor = openSync(absolutePath, "wx");
		writeFileSync(descriptor, scaffoldTestSource(semantic, name), "utf8");
	} catch (error) {
		if (error && typeof error === "object" && error.code === "EEXIST") {
			throw new Error(`Refusing to overwrite existing test: ${relativePath}`);
		}
		throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
	return relativePath;
}

export function main(argv = process.argv.slice(2)) {
	if (argv.length !== 2) {
		console.error(`Usage: npm run test:new -- <semantic> <name>\nSemantics: ${TEST_SEMANTICS.join(", ")}`);
		return 2;
	}
	try {
		const relativePath = createTestFile(argv[0], argv[1]);
		console.log(`Created ${relativePath}`);
		return 0;
	} catch (error) {
		console.error(`test-new: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
	process.exitCode = main();
}
