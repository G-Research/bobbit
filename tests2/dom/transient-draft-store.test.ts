import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/transient-draft-store.spec.ts (v2-dom tier).
// The legacy file:// fixture bundled the REAL TransientDraftStore and exercised
// it against the browser's sessionStorage/localStorage. happy-dom provides both,
// so we import the real module directly and drive it under vitest — no bundle.
// Same invariants (docs/design/transient-draft-state.md §5.1) and assertions.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createTransientDraftStore,
	type TransientDraftStoreOptions,
} from "../../src/ui/storage/transient-draft-store.js";

// ── Raw inspection helpers (mirror the legacy entry) ────────────────────
const rawSession = (storageKey: string) => window.sessionStorage.getItem(storageKey);
const rawLocal = (storageKey: string) => window.localStorage.getItem(storageKey);

function listKeys(backend: "session" | "local", prefix: string): string[] {
	const storage = backend === "local" ? window.localStorage : window.sessionStorage;
	const out: string[] = [];
	for (let i = 0; i < storage.length; i++) {
		const k = storage.key(i);
		if (k != null && k.startsWith(prefix)) out.push(k);
	}
	return out;
}

function clearAll() {
	try { window.sessionStorage.clear(); } catch { /* ignore */ }
	try { window.localStorage.clear(); } catch { /* ignore */ }
}

// Install / restore throwing Storage methods to simulate disabled/quota storage.
// Record every patched target and its effective descriptor. Deleting overrides is
// not sufficient: happy-dom's Storage proxy rejects deletion, and another test shim
// may already have supplied an own method. Retaining the original target also avoids
// missing an object whose global alias changes while the fault is installed.
type StorageMethod = "setItem" | "getItem";
type StorageOverride = {
	target: Storage;
	method: StorageMethod;
	original: PropertyDescriptor;
};
let storageOverrides: StorageOverride[] = [];
function effectiveDescriptor(target: Storage, method: StorageMethod): PropertyDescriptor {
	let current: object | null = target;
	while (current) {
		const descriptor = Object.getOwnPropertyDescriptor(current, method);
		if (descriptor) return descriptor;
		current = Object.getPrototypeOf(current);
	}
	throw new Error(`Storage.${method} has no descriptor`);
}
function targets(): Storage[] {
	// The store resolves storage via `globalThis.{session,local}Storage`; patch
	// those exact instances (and the window aliases, which may or may not be the
	// same object under vitest's populateGlobal).
	return Array.from(new Set<Storage>([
		(globalThis as any).sessionStorage, (globalThis as any).localStorage,
		window.sessionStorage, window.localStorage,
	].filter(Boolean)));
}
function breakStorage() {
	if (storageOverrides.length > 0) return;
	const throwingMethods: Record<StorageMethod, () => never> = {
		setItem: () => { throw new Error("QuotaExceededError (simulated)"); },
		getItem: () => { throw new Error("SecurityError (simulated)"); },
	};
	try {
		for (const target of targets()) {
			for (const method of Object.keys(throwingMethods) as StorageMethod[]) {
				storageOverrides.push({
					target,
					method,
					original: effectiveDescriptor(target, method),
				});
				Object.defineProperty(target, method, {
					configurable: true,
					writable: true,
					value: throwingMethods[method],
				});
			}
		}
	} catch (error) {
		restoreStorage();
		throw error;
	}
}
function restoreStorage() {
	const overrides = storageOverrides.splice(0).reverse();
	let cleanupError: unknown;
	for (const { target, method, original } of overrides) {
		try {
			// Define the effective method as an own property. happy-dom's Storage proxy
			// returns false from deleteProperty, so delete-based cleanup leaves the
			// throwing fault installed for the rest of the worker.
			Object.defineProperty(target, method, original);
		} catch (error) {
			cleanupError ??= error;
		}
	}
	if (cleanupError) throw cleanupError;
}

const makeStore = (options: TransientDraftStoreOptions) => createTransientDraftStore<any>(options);

beforeEach(() => clearAll());
afterEach(() => { restoreStorage(); clearAll(); });

describe("TransientDraftStore round-trip + isolation", () => {
	it("save/load round-trips a structured value", () => {
		const store = makeStore({ namespace: "ask" });
		const value = { selections: [{ option: "a" }, { otherText: "hello" }], activeTab: 1 };
		store.save("s1::tool1", value);
		expect(store.load("s1::tool1")).toEqual({ selections: [{ option: "a" }, { otherText: "hello" }], activeTab: 1 });
	});

	it("load returns null for an absent key", () => {
		const store = makeStore({ namespace: "ask" });
		expect(store.load("missing")).toBeNull();
	});

	it("distinct namespaces never collide", () => {
		const a = makeStore({ namespace: "ask" });
		const b = makeStore({ namespace: "review" });
		a.save("k", { from: "ask" });
		b.save("k", { from: "review" });
		expect(a.load("k")).toEqual({ from: "ask" });
		expect(b.load("k")).toEqual({ from: "review" });
	});

	it("distinct scope keys never collide", () => {
		const store = makeStore({ namespace: "ask" });
		store.save("s1::t1", { x: 1 });
		store.save("s2::t1", { x: 2 });
		expect(store.load("s1::t1")).toEqual({ x: 1 });
		expect(store.load("s2::t1")).toEqual({ x: 2 });
	});

	it("opaque composite key with '|' is preserved verbatim (not split/normalised)", () => {
		const store = makeStore({ namespace: "ask" });
		const scopeKey = "sess-123::call_abc|fc_def";
		store.save(scopeKey, { v: 42 });
		const raw = rawSession("bobbit_draft/ask/" + scopeKey);
		expect(store.load(scopeKey)).toEqual({ v: 42 });
		expect(raw != null).toBe(true);
	});
});

describe("TransientDraftStore tombstone + forget", () => {
	it("clear removes value and load returns null", () => {
		const store = makeStore({ namespace: "ask" });
		store.save("k", { x: 1 });
		store.clear("k");
		expect(store.load("k")).toBeNull();
	});

	it("save after clear is rejected while the tombstone is live (no resurrection)", () => {
		const store = makeStore({ namespace: "ask", tombstoneTtlMs: 60_000 });
		store.save("k", { x: 1 });
		store.clear("k");
		// A late save (e.g. a debounced write scheduled before submit) must not resurrect.
		store.save("k", { x: 2 });
		expect(store.load("k")).toBeNull();
	});

	it("tombstone expires and fresh saves are accepted again", async () => {
		const store = makeStore({ namespace: "ask", tombstoneTtlMs: 30 });
		store.save("k", { x: 1 });
		store.clear("k");
		await new Promise((r) => setTimeout(r, 60));
		store.save("k", { x: 2 });
		expect(store.load("k")).toEqual({ x: 2 });
	});

	it("forget removes the tombstone and allows immediate fresh writes", () => {
		const store = makeStore({ namespace: "ask", tombstoneTtlMs: 60_000 });
		store.save("k", { x: 1 });
		store.clear("k");
		store.forget("k");
		store.save("k", { x: 2 });
		expect(store.load("k")).toEqual({ x: 2 });
	});

	it("forget on a live value hard-deletes it", () => {
		const store = makeStore({ namespace: "ask" });
		store.save("k", { x: 1 });
		store.forget("k");
		expect(store.load("k")).toBeNull();
		expect(rawSession("bobbit_draft/ask/k")).toBeNull();
	});
});

describe("TransientDraftStore last-write-wins (gen)", () => {
	it("an out-of-order stale write does not overwrite a newer value", () => {
		const a = makeStore({ namespace: "ask" });
		a.save("k", { v: "first" });
		a.save("k", { v: "second" });
		// A fresh store instance reads the on-disk record (seeding its gen) so
		// its own next save must still out-gen it.
		const fresh = makeStore({ namespace: "ask" });
		const loaded = fresh.load("k"); // seeds gen from the on-disk record
		fresh.save("k", { v: "third" });
		expect(loaded).toEqual({ v: "second" });
		expect(fresh.load("k")).toEqual({ v: "third" });
	});

	it("gen increments monotonically across saves", () => {
		const store = makeStore({ namespace: "ask" });
		const read = () => JSON.parse(rawSession("bobbit_draft/ask/k")!).gen;
		store.save("k", { n: 1 });
		const g1 = read();
		store.save("k", { n: 2 });
		const g2 = read();
		store.save("k", { n: 3 });
		const g3 = read();
		expect(g1).toBeLessThan(g2);
		expect(g2).toBeLessThan(g3);
	});
});

describe("TransientDraftStore bounds", () => {
	it("exceeding maxEntries evicts the oldest, never the just-written key", async () => {
		const store = makeStore({ namespace: "ask", maxEntries: 3 });
		// Write 4 keys with strictly increasing updatedAt by spacing them out.
		for (const k of ["k1", "k2", "k3", "k4"]) {
			store.save(k, { k });
			await new Promise((r) => setTimeout(r, 5));
		}
		// k1 was oldest → evicted. The just-written k4 must survive.
		expect(store.load("k1")).toBeNull();
		expect(store.load("k2")).toEqual({ k: "k2" });
		expect(store.load("k3")).toEqual({ k: "k3" });
		expect(store.load("k4")).toEqual({ k: "k4" });
		expect(listKeys("session", "bobbit_draft/ask/").length).toBeLessThanOrEqual(3);
	});

	it("a write over maxEntryBytes is dropped without throwing", () => {
		const store = makeStore({ namespace: "ask", maxEntryBytes: 64 });
		let threw = false;
		try {
			store.save("big", { blob: "x".repeat(5000) });
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(store.load("big")).toBeNull();
	});

	it("a small write under maxEntryBytes still succeeds", () => {
		const store = makeStore({ namespace: "ask", maxEntryBytes: 4096 });
		store.save("small", { ok: true });
		expect(store.load("small")).toEqual({ ok: true });
	});
});

describe("TransientDraftStore backend selection", () => {
	it("session backend writes to sessionStorage, not localStorage", () => {
		const store = makeStore({ namespace: "ask", backend: "session" });
		store.save("k", { x: 1 });
		expect(rawSession("bobbit_draft/ask/k")).not.toBeNull();
		expect(rawLocal("bobbit_draft/ask/k")).toBeNull();
	});

	it("local backend writes to localStorage, not sessionStorage", () => {
		const store = makeStore({ namespace: "ask", backend: "local" });
		store.save("k", { x: 1 });
		expect(rawSession("bobbit_draft/ask/k")).toBeNull();
		expect(rawLocal("bobbit_draft/ask/k")).not.toBeNull();
	});
});

describe("TransientDraftStore storage failures degrade safely", () => {
	it("throwing storage never lets an exception escape any method", () => {
		const store = makeStore({ namespace: "ask" });
		breakStorage();
		let threw = false;
		let loaded: unknown = "unset";
		try {
			store.save("k", { x: 1 });
			loaded = store.load("k");
			store.clear("k");
			store.forget("k");
		} catch {
			threw = true;
		} finally {
			restoreStorage();
		}
		expect(threw).toBe(false);
		// With storage throwing, load degrades to null.
		expect(loaded).toBeNull();

		// Regression: happy-dom's Storage proxy rejects deleteProperty. Cleanup
		// must restore working methods rather than leave the injected faults behind.
		const recoveredStore = makeStore({ namespace: "cleanup" });
		recoveredStore.save("k", { restored: true });
		expect(recoveredStore.load("k")).toEqual({ restored: true });
	});
});
