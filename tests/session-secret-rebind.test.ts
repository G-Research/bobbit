/**
 * Unit tests for `SessionSecretStore.rebind` — added for warm-pool wave 1
 * (docs/design/warm-pi-process-pool.md). A claimed pool entry's child
 * process is already running with a secret minted for the pool's own
 * placeholder id; `rebind` re-points that secret at the claiming session's
 * real id so orchestration authz (`resolveSessionIdBySecret`) resolves the
 * live session, not the placeholder — and cleans up both stale directions
 * so no dangling map entry survives.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionSecretStore } from "../src/server/auth/session-secret.ts";

describe("SessionSecretStore.rebind", () => {
	it("re-points the secret so it now resolves to the new session id", () => {
		const store = new SessionSecretStore();
		const secret = store.getOrCreateSecret("pool-placeholder-1");
		store.rebind(secret, "real-session-1");
		assert.equal(store.resolveSessionIdBySecret(secret), "real-session-1");
	});

	it("the placeholder id no longer resolves via getOrCreateSecret to the same (now-stale) secret", () => {
		const store = new SessionSecretStore();
		const secret = store.getOrCreateSecret("pool-placeholder-2");
		store.rebind(secret, "real-session-2");
		// getOrCreateSecret is idempotent per session id — the placeholder's
		// entry must have been cleared, so asking again mints a DIFFERENT secret
		// rather than returning the one that now belongs to the real session.
		const placeholderSecretAgain = store.getOrCreateSecret("pool-placeholder-2");
		assert.notEqual(placeholderSecretAgain, secret, "placeholder id must not still own the rebound secret");
	});

	it("cleans up a secret PREVIOUSLY registered for the new session id (no dangling old mapping)", () => {
		const store = new SessionSecretStore();
		const oldSecretForReal = store.getOrCreateSecret("real-session-3");
		const poolSecret = store.getOrCreateSecret("pool-placeholder-3");

		store.rebind(poolSecret, "real-session-3");

		assert.equal(store.resolveSessionIdBySecret(poolSecret), "real-session-3", "new secret should resolve to the real session");
		assert.equal(store.resolveSessionIdBySecret(oldSecretForReal), undefined, "the real session's OLD secret must no longer resolve to anything (no leaked dual-secret window)");
	});

	it("remove() after a rebind cleans up the CURRENT (rebound) secret, not a stale one", () => {
		const store = new SessionSecretStore();
		const poolSecret = store.getOrCreateSecret("pool-placeholder-4");
		store.rebind(poolSecret, "real-session-4");
		store.remove("real-session-4");
		assert.equal(store.resolveSessionIdBySecret(poolSecret), undefined);
	});

	it("is a no-op for a blank/whitespace-only secret", () => {
		const store = new SessionSecretStore();
		const secret = store.getOrCreateSecret("session-x");
		store.rebind("   ", "session-y");
		assert.equal(store.resolveSessionIdBySecret(secret), "session-x", "unrelated existing mapping must be untouched");
		// "session-y" must not have been silently given a secret by the no-op
		// rebind call — a fresh mint for it should still produce a NEW secret,
		// not something already resolvable.
		const freshSecretForY = store.getOrCreateSecret("session-y");
		assert.equal(store.resolveSessionIdBySecret(freshSecretForY), "session-y");
	});
});
