import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-transcript-agent-dir-"));
const projectRoot = path.join(tmpRoot, "project");
const tmpHome = path.join(tmpRoot, "home");
const activeAgentDir = path.join(tmpRoot, "active-agent");
const historicalAgentDir = path.join(tmpRoot, "historical-agent");
const previousEnv = {
	BOBBIT_AGENT_DIR: process.env.BOBBIT_AGENT_DIR,
	BOBBIT_DIR: process.env.BOBBIT_DIR,
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
};

fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(tmpHome, { recursive: true });
process.env.BOBBIT_AGENT_DIR = activeAgentDir;
process.env.BOBBIT_DIR = path.join(tmpRoot, ".bobbit");
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const bobbitDirModule = await import("../src/server/bobbit-dir.ts");
bobbitDirModule.setProjectRoot(projectRoot);
const sanitizer = await import("../src/server/agent/transcript-sanitizer.ts");

const {
	isWithinAgentSessionsDir,
	resolveSafeSessionsPath,
	sanitizeAgentTranscriptFile,
} = sanitizer;

const POISONED = JSON.stringify({
	type: "message",
	id: "poisoned",
	message: { role: "user", content: [{ type: "text", text: "" }, { type: "image", source: { data: "AAAA" } }] },
});

function sessionsRoot(agentDir: string): string {
	return path.join(agentDir, "sessions");
}

function writePoisonedTranscript(agentDir: string, name: string): string {
	const dir = path.join(sessionsRoot(agentDir), "--cwd--");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.jsonl`);
	fs.writeFileSync(file, POISONED, "utf-8");
	return file;
}

function assertSanitized(file: string): void {
	assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).message.content[0].text, "Attachments:");
}

async function recordHistoryIfAvailable(agentDir: string): Promise<boolean> {
	const fn = (bobbitDirModule as any).recordAgentDirHistory;
	if (typeof fn !== "function") return false;
	await Promise.resolve(fn(agentDir));
	return true;
}

function assertHistoryRecorderAvailable(): void {
	assert.equal(
		typeof (bobbitDirModule as any).recordAgentDirHistory,
		"function",
		"recordAgentDirHistory(dir) must be exported so transcript guards can trust historical sessions roots",
	);
}

before(async () => {
	fs.mkdirSync(sessionsRoot(activeAgentDir), { recursive: true });
	fs.mkdirSync(sessionsRoot(historicalAgentDir), { recursive: true });
	await recordHistoryIfAvailable(activeAgentDir);
	await recordHistoryIfAvailable(historicalAgentDir);
});

after(() => {
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("transcript sanitizer trusted agent directory roots", () => {
	it("accepts and rewrites transcripts under the startup active sessions root", async () => {
		const file = writePoisonedTranscript(activeAgentDir, "active");

		assert.equal(isWithinAgentSessionsDir(file), true);
		assert.equal(resolveSafeSessionsPath(file), fs.realpathSync(file));
		assert.equal(await sanitizeAgentTranscriptFile({ sandboxed: false }, file, null), 1);
		assertSanitized(file);
	});

	it("accepts and rewrites transcripts under a recorded historical sessions root", async () => {
		assertHistoryRecorderAvailable();
		const file = writePoisonedTranscript(historicalAgentDir, "historical");

		assert.equal(isWithinAgentSessionsDir(file), true, "historical sessions roots must remain trusted after agent-dir migration");
		assert.equal(resolveSafeSessionsPath(file), fs.realpathSync(file));
		assert.equal(await sanitizeAgentTranscriptFile({ sandboxed: false }, file, null), 1);
		assertSanitized(file);
	});

	it("keeps traversal and outside paths rejected even when historical roots are trusted", async () => {
		assertHistoryRecorderAvailable();
		const outside = path.join(tmpRoot, "outside.jsonl");
		fs.writeFileSync(outside, POISONED, "utf-8");
		const traversal = path.join(sessionsRoot(historicalAgentDir), "..", "outside.jsonl");

		assert.equal(isWithinAgentSessionsDir(traversal), false);
		assert.equal(resolveSafeSessionsPath(traversal), null);
		assert.equal(await sanitizeAgentTranscriptFile({ sandboxed: false }, outside, null), 0);
		assert.equal(fs.readFileSync(outside, "utf-8"), POISONED);
	});

	it("rejects a final symlink inside a historical sessions root", async (t) => {
		assertHistoryRecorderAvailable();
		const target = path.join(tmpRoot, "external-target.jsonl");
		fs.writeFileSync(target, POISONED, "utf-8");
		const dir = path.join(sessionsRoot(historicalAgentDir), "--links--");
		fs.mkdirSync(dir, { recursive: true });
		const link = path.join(dir, "link.jsonl");
		try {
			fs.symlinkSync(target, link);
		} catch {
			t.skip("symlink creation not permitted on this platform");
			return;
		}

		assert.equal(resolveSafeSessionsPath(link), null);
		assert.equal(await sanitizeAgentTranscriptFile({ sandboxed: false }, link, null), 0);
		assert.equal(fs.readFileSync(target, "utf-8"), POISONED);
	});

	it("trusts legacy ~/.bobbit/agent and ~/.pi/agent sessions roots for old absolute transcripts", async () => {
		const legacyBobbitFile = writePoisonedTranscript(path.join(tmpHome, ".bobbit", "agent"), "legacy-bobbit");
		const legacyPiFile = writePoisonedTranscript(path.join(tmpHome, ".pi", "agent"), "legacy-pi");

		for (const file of [legacyBobbitFile, legacyPiFile]) {
			assert.equal(isWithinAgentSessionsDir(file), true, `legacy transcript root should be trusted: ${file}`);
			assert.equal(resolveSafeSessionsPath(file), fs.realpathSync(file));
			assert.equal(await sanitizeAgentTranscriptFile({ sandboxed: false }, file, null), 1);
			assertSanitized(file);
		}
	});
});
