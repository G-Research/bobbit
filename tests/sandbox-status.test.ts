import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveSandboxDockerContext } from "../src/server/agent/sandbox-status.js";

describe("sandbox Docker context resolution", () => {
	it("falls back to Bobbit's bundled docker/ directory when the project cwd has none", () => {
		const projectDir = mkdtempSync(join(tmpdir(), "bobbit-sandbox-project-without-docker-"));
		try {
			const context = resolveSandboxDockerContext(projectDir);
			assert.equal(context, resolve(import.meta.dirname, ".."));
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("prefers Bobbit's bundled Dockerfile over an unrelated project Dockerfile", () => {
		const projectDir = mkdtempSync(join(tmpdir(), "bobbit-sandbox-project-with-docker-"));
		try {
			mkdirSync(join(projectDir, "docker"), { recursive: true });
			writeFileSync(join(projectDir, "docker", "Dockerfile"), "FROM scratch\n", "utf-8");

			const context = resolveSandboxDockerContext(projectDir);
			assert.equal(context, resolve(import.meta.dirname, ".."));
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});
});
