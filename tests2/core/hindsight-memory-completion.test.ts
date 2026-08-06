import { describe, expect, it } from "vitest";
import {
	decodePendingKey, documentId, pendingKey, pendingPrefix, type HindsightIdentity,
} from "../../market-packs/hindsight/src/shared.ts";

describe("Hindsight v2 identity codec", () => {
	it("keeps adversarial project prefixes and target tuples disjoint", () => {
		const a: HindsightIdentity = { projectId: "p/a", goalId: "g:1", sessionId: "same", bank: "bank/a", namespace: "ns:a", kind: "pending" };
		const b: HindsightIdentity = { ...a, projectId: "p/ab" };
		const aKey = pendingKey(a);
		const bKey = pendingKey(b);
		expect(aKey).not.toBe(bKey);
		expect(bKey.startsWith(pendingPrefix(a.projectId))).toBe(false);
		expect(decodePendingKey(aKey)).toEqual(a);
		expect(documentId(a)).not.toBe(documentId({ ...a, bank: "other-bank" }));
	});

	it("does not decode malformed or near-match pending keys", () => {
		const identity: HindsightIdentity = { projectId: "project", sessionId: "session", bank: "bank", namespace: "namespace", kind: "pending" };
		const key = pendingKey(identity);
		expect(decodePendingKey(`${key}/extra`)).toBeUndefined();
		expect(decodePendingKey(key.replace("/pending", "/outcome"))).toBeUndefined();
	});
});
