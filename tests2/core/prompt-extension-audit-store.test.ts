import path from "node:path";
import { describe, expect, it } from "vitest";
import { PromptExtensionAuthoringAuditStore } from "../../src/server/agent/prompt-extension-audit-store.js";
import { createMemFs } from "../harness/mem-fs.js";

const stateDir = path.resolve("/memfs/prompt-extension-audit");
const auditFile = path.join(stateDir, "prompt-extension-authoring-audit.jsonl");

function rawEntry(index: number): Record<string, unknown> {
	const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
	return {
		id: `audit-${index}`,
		at,
		status: "requested",
		packId: "fixture-pack",
		hookId: "author-hook",
		event: "proposal",
		sectionId: "policy",
		actor: "agent",
		sessionId: "session-a",
		trigger: "proposal-seed",
		baselineDigest: "a".repeat(64),
		baselineBytes: 1,
		startedAt: at,
		// Each retained row must be normalized again: an old raw audit file must
		// never preserve credentials merely because it was rotated forward.
		diff: `password=rotation-secret-${index}\n${"x".repeat(240 * 1024)}`,
	};
}

describe("PromptExtensionAuthoringAuditStore", () => {
	it("rotates over-cap history to recent normalized snapshots", () => {
		const fs = createMemFs();
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(auditFile, Array.from({ length: 10 }, (_, index) => JSON.stringify(rawEntry(index))).join("\n") + "\n", "utf-8");

		const store = new PromptExtensionAuthoringAuditStore(stateDir, fs, () => new Date("2026-01-01T00:01:00.000Z"));
		store.create({
			id: "newest", packId: "fixture-pack", hookId: "author-hook", event: "proposal", sectionId: "policy",
			actor: "agent", sessionId: "session-a", trigger: "proposal-seed", baselineDigest: "a".repeat(64), baselineBytes: 1,
		});

		const persisted = String(fs.readFileSync(auditFile, "utf-8"));
		expect(Buffer.byteLength(persisted, "utf-8")).toBeLessThanOrEqual(2 * 1024 * 1024);
		expect(persisted).not.toContain("audit-0");
		expect(persisted).toContain("audit-9");
		expect(persisted).not.toContain("rotation-secret-");
		expect(store.list(200).at(-1)?.id).toBe("newest");
	});
});
