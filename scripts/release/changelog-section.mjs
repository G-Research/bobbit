#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CHANGELOG_PATH, changelogSectionFor } from "./release-contract.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	const argv = process.argv.slice(2);
	const index = argv.indexOf("--version");
	const version = index === -1 ? undefined : argv[index + 1];
	if (!version) {
		console.error("::error::--version is required");
		process.exit(1);
	}
	const section = changelogSectionFor(readFileSync(join(REPO_ROOT, CHANGELOG_PATH), "utf8"), version);
	if (section === null) {
		console.error(`::error::${CHANGELOG_PATH} has no \`## v${version}\` section`);
		process.exit(1);
	}
	process.stdout.write(`${section}\n`);
}
