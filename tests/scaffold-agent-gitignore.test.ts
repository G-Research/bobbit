import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { scaffoldBobbitDir } from "../src/server/scaffold.js";

function tmpProject(label: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-scaffold-${label}-`));
}

function readGitignore(projectRoot: string): string {
	return fs.readFileSync(path.join(projectRoot, ".bobbit", ".gitignore"), "utf-8");
}

function withProjectLocalBobbitDir(fn: () => void): void {
	const prevBobbitDir = process.env.BOBBIT_DIR;
	const prevPiDir = process.env.BOBBIT_PI_DIR;
	delete process.env.BOBBIT_DIR;
	delete process.env.BOBBIT_PI_DIR;
	try {
		fn();
	} finally {
		if (prevBobbitDir === undefined) delete process.env.BOBBIT_DIR;
		else process.env.BOBBIT_DIR = prevBobbitDir;
		if (prevPiDir === undefined) delete process.env.BOBBIT_PI_DIR;
		else process.env.BOBBIT_PI_DIR = prevPiDir;
	}
}

describe("scaffoldBobbitDir .bobbit/.gitignore", () => {
	it("ignores gateway state and the project-local default agent dir for new scaffolds", () => {
		const projectRoot = tmpProject("new");
		try {
			withProjectLocalBobbitDir(() => scaffoldBobbitDir(projectRoot));

			const content = readGitignore(projectRoot);
			assert.match(content, /^state\/\s*$/m);
			assert.match(content, /^agent\/\s*$/m);
		} finally {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	it("safely updates existing scaffolds that only ignored state", () => {
		const projectRoot = tmpProject("existing");
		try {
			const dotBobbit = path.join(projectRoot, ".bobbit");
			fs.mkdirSync(path.join(dotBobbit, "config"), { recursive: true });
			fs.writeFileSync(path.join(dotBobbit, ".gitignore"), "state/\n# user rule\n");

			withProjectLocalBobbitDir(() => scaffoldBobbitDir(projectRoot));

			const content = readGitignore(projectRoot);
			assert.match(content, /^state\/\s*$/m);
			assert.match(content, /^agent\/\s*$/m);
			assert.match(content, /^# user rule\s*$/m);
			assert.equal((content.match(/^agent\/\s*$/gm) ?? []).length, 1);
		} finally {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});
});
