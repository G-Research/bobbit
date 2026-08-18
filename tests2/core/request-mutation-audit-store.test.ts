import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	RequestMutationAuditStore,
	RequestMutationAuditStoreError,
	type RequestMutationAuditInput,
} from "../../src/server/agent/request-mutation-audit-store.js";
import { createMemFs } from "../harness/mem-fs.js";

const stateDir = path.resolve("/memfs/request-mutation-audit");
const auditFile = path.join(stateDir, "request-mutation-audit.jsonl");
const at = "2025-02-03T04:05:06.000Z";

function promptEntry(overrides: Partial<RequestMutationAuditInput> = {}): RequestMutationAuditInput {
	return {
		sessionId: "session-1",
		event: "beforePrompt",
		packId: "pack-1",
		hookId: "hook-1",
		outcome: "applied",
		reason: "Lower-priority proposal",
		before: "original request",
		after: "replacement request",
		at,
		...overrides,
	};
}

describe("RequestMutationAuditStore", () => {
	it("redacts secret-shaped prompt evidence before JSONL persistence and response", () => {
		const fs = createMemFs();
		const store = new RequestMutationAuditStore(stateDir, fs);
		const secret = "sk-super-secret-value-123456";
		const entry = store.append(promptEntry({
			before: `api_key=${secret}; ordinary prompt prose`,
			after: `Bearer ${secret} and password=do-not-store`,
		}));

		expect(entry.before).toContain("[REDACTED]");
		expect(entry.after).toContain("[REDACTED]");
		expect(entry.beforeBytes).toBe(Buffer.byteLength(`api_key=${secret}; ordinary prompt prose`));
		expect(entry.afterBytes).toBe(Buffer.byteLength(`Bearer ${secret} and password=do-not-store`));
		const disk = String(fs.readFileSync(auditFile, "utf-8"));
		expect(disk).not.toContain(secret);
		expect(disk).not.toContain("do-not-store");
		expect(JSON.stringify(store.list())).not.toContain(secret);
	});

	it("clips redacted evidence on UTF-8 boundaries while retaining original bounded byte counts", () => {
		const fs = createMemFs();
		const store = new RequestMutationAuditStore(stateDir, fs);
		const prompt = "🙂".repeat(7_000); // 28 KiB, intentionally above the 16 KiB evidence cap.
		const entry = store.append(promptEntry({ before: prompt, after: prompt }));

		expect(entry.beforeBytes).toBe(Buffer.byteLength(prompt));
		expect(entry.afterBytes).toBe(Buffer.byteLength(prompt));
		expect(entry.before).toMatch(/\[TRUNCATED\]$/);
		expect(entry.after).toMatch(/\[TRUNCATED\]$/);
		expect(Buffer.byteLength(entry.before!)).toBeLessThanOrEqual(16 * 1024);
		expect(Buffer.byteLength(entry.after!)).toBeLessThanOrEqual(16 * 1024);
	});

	it("accepts only fixed metadata, and excludes prompt evidence from tool safety rows", () => {
		const fs = createMemFs();
		const store = new RequestMutationAuditStore(stateDir, fs);
		const tool = store.append({
			sessionId: "session-1", event: "beforeToolCall", outcome: "denied", reason: "Tool denied", toolName: "dangerous-tool", at,
		});
		expect(tool).toMatchObject({ event: "beforeToolCall", outcome: "denied", reason: "Tool denied", toolName: "dangerous-tool" });
		expect(() => store.append(promptEntry({ reason: "raw extension rationale" as any }))).toThrow(RequestMutationAuditStoreError);
		expect(() => store.append({ ...tool, before: "tool arguments must never persist" } as any)).toThrow(RequestMutationAuditStoreError);
		expect(String(fs.readFileSync(auditFile, "utf-8"))).not.toContain("tool arguments must never persist");
	});

	it("skips corrupt rows and re-redacts historical prompt evidence before exposing it", () => {
		const fs = createMemFs();
		fs.mkdirSync(stateDir, { recursive: true });
		const secret = "sk-historical-secret-98765";
		const raw = {
			id: "row-1", at, sessionId: "session-1", event: "beforePrompt", outcome: "applied", reason: "Grant required",
			before: `token=${secret}`, beforeBytes: Buffer.byteLength(`token=${secret}`),
		};
		fs.writeFileSync(auditFile, [JSON.stringify(raw), "{truncated", JSON.stringify({ ...raw, id: "bad", reason: "raw error text" })].join("\n") + "\n", "utf-8");

		const rows = new RequestMutationAuditStore(stateDir, fs).list();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.before).toContain("[REDACTED]");
		expect(JSON.stringify(rows)).not.toContain(secret);
	});

	it("returns newest valid rows in chronological order and bounds the JSONL file", () => {
		const fs = createMemFs();
		const store = new RequestMutationAuditStore(stateDir, fs);
		for (let index = 0; index < 160; index++) {
			store.append(promptEntry({ id: `entry-${index}`, sessionId: index % 2 ? "session-1" : "session-2", before: "x".repeat(16_000), after: "y".repeat(16_000) }));
		}

		expect(fs.statSync(auditFile).size).toBeLessThanOrEqual(2 * 1024 * 1024);
		expect(store.list(2).map(row => row.id)).toEqual(["entry-158", "entry-159"]);
		expect(store.listForSession("session-1", 2).map(row => row.id)).toEqual(["entry-157", "entry-159"]);
		expect(store.listForSession("../../not-a-session")).toEqual([]);
	});

	it("uses a safe store error when persistence fails", () => {
		const fs = createMemFs();
		const store = new RequestMutationAuditStore(stateDir, fs);
		fs.appendFileSync = (() => { throw new Error("AUDIT_WRITE_SECRET=must-not-leak"); }) as typeof fs.appendFileSync;
		let error: unknown;
		try {
			store.append(promptEntry());
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(RequestMutationAuditStoreError);
		expect(String(error)).not.toContain("AUDIT_WRITE_SECRET=must-not-leak");
	});
});
