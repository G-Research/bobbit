import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	ExtensionGrantAuditStore,
	ExtensionGrantAuditStoreError,
	type ExtensionGrantAuditEntry,
	type ExtensionHookGrantAuditEntry,
	type ExtensionPackGrantAuditEntry,
} from "../../src/server/agent/extension-grant-audit-store.js";
import { createMemFs } from "../harness/mem-fs.js";

const stateDir = path.resolve("/memfs/extension-grant-audit");
const auditFile = path.join(stateDir, "extension-capability-audit.jsonl");
const outboxFile = path.join(stateDir, "extension-capability-audit.outbox.json");

function entry(number: number, overrides: Partial<ExtensionHookGrantAuditEntry> = {}): ExtensionHookGrantAuditEntry {
	return {
		at: `2025-02-03T04:05:0${number}.000Z`,
		actor: "admin",
		action: number % 2 ? "granted" : "revoked",
		packId: "pack-a",
		hookId: `hook-${number}`,
		capability: "decide",
		...overrides,
	};
}

function packEntry(number: number, overrides: Partial<ExtensionPackGrantAuditEntry> = {}): ExtensionPackGrantAuditEntry {
	return {
		at: `2025-02-03T04:06:0${number}.000Z`,
		actor: "admin",
		action: number % 2 ? "granted" : "revoked",
		packId: "pack-a",
		principal: "pack",
		capability: "decide",
		...overrides,
	};
}

function isHookEntry(entry: ExtensionGrantAuditEntry): entry is ExtensionHookGrantAuditEntry {
	return !("principal" in entry);
}

function hookRows(rows: readonly ExtensionGrantAuditEntry[]): ExtensionHookGrantAuditEntry[] {
	expect(rows.every(isHookEntry)).toBe(true);
	return rows.filter(isHookEntry);
}

describe("ExtensionGrantAuditStore", () => {
	it("appends normalized tuple records and reads newest rows in chronological order", () => {
		const fs = createMemFs();
		const store = new ExtensionGrantAuditStore(stateDir, fs);
		store.append({ ...entry(1), ignoredRequestDetail: "secret-not-persisted" } as ExtensionGrantAuditEntry);
		store.append(entry(2));
		store.append(entry(3));

		expect(hookRows(store.list()).map(row => row.hookId)).toEqual(["hook-1", "hook-2", "hook-3"]);
		expect(hookRows(store.list(2)).map(row => row.hookId)).toEqual(["hook-2", "hook-3"]);
		expect(String(fs.readFileSync(auditFile, "utf-8"))).not.toContain("secret-not-persisted");
	});

	it("preserves legacy hook rows while accepting only unmixed pack-principal rows", () => {
		const fs = createMemFs();
		const store = new ExtensionGrantAuditStore(stateDir, fs);
		const legacy = entry(1);
		const pack = packEntry(2, { capability: "store" });
		store.append(legacy);
		store.append({ ...pack, ignoredRequestDetail: "secret-not-persisted" } as ExtensionGrantAuditEntry);

		const rows = store.list();
		expect(rows).toEqual([legacy, pack]);
		expect(rows[0]).not.toHaveProperty("principal");
		expect(rows[1]).toMatchObject({ principal: "pack", packId: "pack-a", capability: "store" });
		expect(String(fs.readFileSync(auditFile, "utf-8"))).not.toContain("secret-not-persisted");

		fs.appendFileSync(auditFile, [
			JSON.stringify({ ...entry(3), principal: "hook" }),
			JSON.stringify({ ...packEntry(4), hookId: "must-not-mix" }),
			JSON.stringify({ ...packEntry(5), principal: "unknown" }),
		].join("\n") + "\n", "utf-8");
		expect(store.list()).toEqual([legacy, pack]);
	});

	it("bounds audit reads and treats missing audit files as an empty history", () => {
		const fs = createMemFs();
		const store = new ExtensionGrantAuditStore(stateDir, fs);
		expect(store.list()).toEqual([]);
		for (let index = 1; index <= 205; index++) {
			store.append(entry(index % 10, { hookId: `hook-${index}` }));
		}

		expect(store.list(999).length).toBe(200);
		expect(hookRows(store.list(0)).map(row => row.hookId)).toEqual(["hook-205"]);
		expect(store.list(Number.NaN).length).toBe(100);
	});

	it("rotates over-cap history to newest valid rows without disturbing the recovery outbox", () => {
		const fs = createMemFs();
		fs.mkdirSync(stateDir, { recursive: true });
		const prior = Array.from({ length: 16_000 }, (_, index) => JSON.stringify(entry((index % 9) + 1, {
			hookId: `rotated-${String(index).padStart(5, "0")}`,
		}))).join("\n") + "\n";
		fs.writeFileSync(auditFile, prior, "utf-8");
		const pending = entry(9, { hookId: "pending-recovery" });
		fs.writeFileSync(outboxFile, JSON.stringify([pending]), "utf-8");

		const store = new ExtensionGrantAuditStore(stateDir, fs);
		store.append(entry(9, { hookId: "newest" }));

		const persisted = String(fs.readFileSync(auditFile, "utf-8"));
		expect(Buffer.byteLength(persisted, "utf-8")).toBeLessThanOrEqual(2 * 1024 * 1024);
		expect(persisted).not.toContain("rotated-00000");
		expect(persisted).toContain("rotated-15999");
		expect(hookRows(store.list(200)).at(-1)?.hookId).toBe("newest");
		expect(String(fs.readFileSync(outboxFile, "utf-8"))).toBe(JSON.stringify([pending]));
	});

	it("skips corrupt and secret-bearing historical rows while retaining valid entries", () => {
		const fs = createMemFs();
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(auditFile, [
			JSON.stringify(entry(1)),
			"{truncated-json",
			JSON.stringify({ ...entry(2), reason: "RAW_REQUEST_SECRET" }),
			JSON.stringify({ ...entry(3), actor: "actor with spaces" }),
			JSON.stringify({ ...entry(4), capability: "unknown" }),
		].join("\n") + "\n", "utf-8");

		const rows = new ExtensionGrantAuditStore(stateDir, fs).list();
		expect(rows).toEqual([entry(1), entry(2)]);
		expect(JSON.stringify(rows)).not.toContain("RAW_REQUEST_SECRET");
	});

	it("persists a failed append for exact retry after restart without duplicate rows", () => {
		const fs = createMemFs();
		const first = new ExtensionGrantAuditStore(stateDir, fs);
		const revoked = entry(2, { action: "revoked" });
		const originalAppend = fs.appendFileSync.bind(fs);
		let failOnce = true;
		fs.appendFileSync = ((file, data, options) => {
			if (failOnce && String(file) === auditFile) {
				failOnce = false;
				throw new Error("AUDIT_WRITE_SECRET=must-not-leak");
			}
			return originalAppend(file, data, options as any);
		}) as typeof fs.appendFileSync;
		try {
			expect(() => first.appendOrQueue(revoked)).toThrow(ExtensionGrantAuditStoreError);
		} finally {
			fs.appendFileSync = originalAppend;
		}
		expect(first.list()).toEqual([]);
		expect(String(fs.readFileSync(outboxFile, "utf-8"))).not.toContain("AUDIT_WRITE_SECRET=must-not-leak");

		// A fresh instance represents the next gateway process after a restart.
		const restarted = new ExtensionGrantAuditStore(stateDir, fs);
		const ref = { action: "revoked" as const, packId: revoked.packId, hookId: revoked.hookId, capability: revoked.capability };
		// Simulate a crash/failure after JSONL append but before outbox cleanup.
		const originalUnlink = fs.unlinkSync.bind(fs);
		let failClearOnce = true;
		fs.unlinkSync = ((file) => {
			if (failClearOnce && String(file) === outboxFile) {
				failClearOnce = false;
				throw new Error("AUDIT_OUTBOX_CLEAR_SECRET=must-not-leak");
			}
			return originalUnlink(file);
		}) as typeof fs.unlinkSync;
		try {
			expect(() => restarted.recoverPending(ref)).toThrow(ExtensionGrantAuditStoreError);
		} finally {
			fs.unlinkSync = originalUnlink;
		}
		expect(restarted.list()).toEqual([revoked]);
		// The retained outbox is deduplicated against the audit row, then cleared.
		expect(restarted.recoverPending(ref)).toBe(true);
		expect(restarted.list()).toEqual([revoked]);
		expect(restarted.recoverPending(ref)).toBe(false);
	});

	it("recovers only the exact pending pack-principal ref", () => {
		const fs = createMemFs();
		const pending = packEntry(2, { action: "revoked", capability: "store" });
		const store = new ExtensionGrantAuditStore(stateDir, fs);
		const originalAppend = fs.appendFileSync.bind(fs);
		let failOnce = true;
		fs.appendFileSync = ((file, data, options) => {
			if (failOnce && String(file) === auditFile) {
				failOnce = false;
				throw new Error("AUDIT_PACK_WRITE_SECRET=must-not-leak");
			}
			return originalAppend(file, data, options as any);
		}) as typeof fs.appendFileSync;
		try {
			expect(() => store.appendOrQueue(pending)).toThrow(ExtensionGrantAuditStoreError);
		} finally {
			fs.appendFileSync = originalAppend;
		}

		// A hook named "pack" must not drain a pack-principal event.
		expect(store.recoverPending({ action: "revoked", packId: pending.packId, hookId: "pack", capability: pending.capability })).toBe(false);
		expect(store.recoverPending({ action: "revoked", packId: pending.packId, principal: "pack", capability: pending.capability })).toBe(true);
		expect(store.list()).toEqual([pending]);
		expect(store.recoverPending({ action: "revoked", packId: pending.packId, principal: "pack", capability: pending.capability })).toBe(false);
	});

	it("rejects malformed append data and redacts filesystem error details", () => {
		const fs = createMemFs();
		const store = new ExtensionGrantAuditStore(stateDir, fs);
		expect(() => store.append({ ...entry(1), packId: "../../bad" })).toThrow(ExtensionGrantAuditStoreError);

		const originalAppend = fs.appendFileSync.bind(fs);
		fs.appendFileSync = (() => { throw new Error("AUDIT_WRITE_SECRET=must-not-leak"); }) as typeof fs.appendFileSync;
		let error: unknown;
		try {
			store.append(entry(2));
		} catch (caught) {
			error = caught;
		} finally {
			fs.appendFileSync = originalAppend;
		}
		expect(error).toBeInstanceOf(ExtensionGrantAuditStoreError);
		expect(String(error)).not.toContain("AUDIT_WRITE_SECRET=must-not-leak");
	});
});
