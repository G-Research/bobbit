import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ToolResultFilterAuditStore } from "../../src/server/agent/tool-result-filter-audit-store.js";
import { createMemFs } from "../harness/mem-fs.js";

const stateDir = path.resolve("/memfs/tool-result-filter-audit");
const auditFile = path.join(stateDir, "tool-result-filter-audit.jsonl");
const at = "2025-02-03T04:05:06.000Z";
const canary = "EP14_REJECTED_RESULT_CANARY_must_never_persist";

function entry(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: "session-1", toolCallId: "call-1", toolName: "bash",
		packId: "fixture", hookId: "filter", action: "reject", outcome: "applied",
		reasonCode: "filter-rejected", ruleId: "filter", inputBytes: 1024, outputBytes: 72, latencyMs: 4,
		at, ...overrides,
	};
}

describe("ToolResultFilterAuditStore", () => {
	it("persists and returns only closed metadata, never a result payload", () => {
		const fs = createMemFs();
		const store = new ToolResultFilterAuditStore(stateDir, fs);
		const saved = store.append(entry() as any);
		expect(saved).toMatchObject({ action: "reject", outcome: "applied", ruleId: "filter" });
		const disk = String(fs.readFileSync(auditFile, "utf-8"));
		expect(disk).not.toContain(canary);
		expect(JSON.stringify(store.list())).not.toContain(canary);
		expect(store.append({ ...entry(), result: canary } as any)).toBeUndefined();
		expect(store.append({ ...entry(), reasonCode: `${canary} raw` } as any)).toBeUndefined();
		expect(store.append({ ...entry(), reasonCode: "worker-controlled-code" } as any)).toBeUndefined();
		expect(store.append({ ...entry(), ruleId: "worker-rule" } as any)).toBeUndefined();
		expect(store.append({ ...entry(), inputBytes: 256 * 1024 + 1 } as any)).toBeUndefined();
		expect(String(fs.readFileSync(auditFile, "utf-8"))).not.toContain(canary);
	});

	it("persists dispatcher-owned abort and admission-rejection reasons as metadata only", () => {
		const fs = createMemFs();
		const store = new ToolResultFilterAuditStore(stateDir, fs);
		for (const [id, reasonCode] of [["aborted", "filter-aborted"], ["admission", "filter-admission-rejected"]] as const) {
			const saved = store.append(entry({ id, action: "reject", outcome: "denied", reasonCode }) as any);
			expect(saved).toMatchObject({ id, action: "reject", outcome: "denied", reasonCode });
		}
		const rows = store.list();
		expect(rows.map(row => row.reasonCode)).toEqual(["filter-aborted", "filter-admission-rejected"]);
		expect(JSON.stringify(rows)).not.toContain(canary);
		expect(String(fs.readFileSync(auditFile, "utf-8"))).not.toContain(canary);
	});

	it("skips corrupt or content-bearing historical rows before exposing them", () => {
		const fs = createMemFs();
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(auditFile, [
			JSON.stringify(entry({ id: "valid" })),
			JSON.stringify({ ...entry({ id: "leak" }), content: canary }),
			"{truncated",
		].join("\n") + "\n", "utf-8");
		const rows = new ToolResultFilterAuditStore(stateDir, fs).list();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe("valid");
		expect(JSON.stringify(rows)).not.toContain(canary);
	});

	it("rotates newest normalized rows and filters sessions", () => {
		const fs = createMemFs();
		fs.mkdirSync(stateDir, { recursive: true });
		const prior = `${JSON.stringify(entry({ id: "prior", sessionId: "session-2" }))}\n`;
		fs.writeFileSync(auditFile, prior.repeat(Math.ceil((2 * 1024 * 1024 + 1) / Buffer.byteLength(prior))), "utf-8");
		const store = new ToolResultFilterAuditStore(stateDir, fs);
		store.append(entry({ id: "newest", sessionId: "session-1" }) as any);
		expect(fs.statSync(auditFile).size).toBeLessThanOrEqual(2 * 1024 * 1024);
		expect(store.list(2).map(row => row.id)).toEqual(["prior", "newest"]);
		expect(store.listForSession("session-1", 2).map(row => row.id)).toEqual(["newest"]);
		expect(store.listForSession("../../invalid")).toEqual([]);
	});

	it("swallows storage failures and logs only a fixed label", () => {
		const fs = createMemFs();
		const store = new ToolResultFilterAuditStore(stateDir, fs);
		fs.appendFileSync = (() => { throw new Error(canary); }) as typeof fs.appendFileSync;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			expect(store.append(entry() as any)).toBeUndefined();
			expect(warn).toHaveBeenCalledWith("[tool-result-filter-audit] write failed");
			expect(warn.mock.calls.flat().join(" ")).not.toContain(canary);
		} finally { warn.mockRestore(); }
	});
});
