import fs from "node:fs";
import path from "node:path";

import { PinnedCheckoutError, type PinnedCheckout } from "../../src/server/agent/verification-pinned-checkout.ts";
import { verificationCheckoutProjectDir } from "../../src/server/agent/verification-checkout-scope.ts";

export const TEST_PINNED_COMMIT = "a".repeat(40);
export const TEST_PINNED_DIGEST = Object.freeze({
	algorithm: "sha256" as const,
	version: 1 as const,
	digest: "b".repeat(64),
	fileCount: 0,
});

/** Deliberately tiny frozen-source witness used by harness command steps. */
const FROZEN_SOURCE_SENTINEL = ".bobbit-frozen-source-sentinel";
const FROZEN_SOURCE_BYTES = "frozen fixture source\n";

/**
 * Lifecycle-faithful pinned-checkout seam for core harness tests. It models
 * distinct frozen paths, signal-owned leases, restart recovery, and immutable
 * attestations; raw-byte/Git materialization belongs to the manager suite.
 */
export class FakePinnedCheckoutManager {
	readonly acquiredSourceRoots: string[] = [];
	readonly releasedSignalIds: string[] = [];
	readonly resumedSignalIds: string[] = [];
	readonly recoveredActiveSets: string[][] = [];
	assertionCount = 0;
	private readonly leases = new Map<string, PinnedCheckout>();

	constructor(private readonly root: string) {}

	async acquire({ signal, sourceRoot, projectId }: { signal: { id: string }; sourceRoot: string; projectId: string }): Promise<PinnedCheckout> {
		this.acquiredSourceRoots.push(sourceRoot);
		return this.seed(signal.id, sourceRoot, projectId);
	}

	/** Snapshot ownership for integration tests that must prove exact release before tearing down a source fixture. */
	getLease(signalId: string): PinnedCheckout | undefined {
		const checkout = this.leases.get(signalId);
		return checkout ? {
			...checkout,
			contentDigest: { ...checkout.contentDigest },
			writableIgnoredDirectories: [...checkout.writableIgnoredDirectories],
		} : undefined;
	}

	seed(signalId: string, sourceRoot = this.root, projectId = "test-project-id"): PinnedCheckout {
		const projectRoot = verificationCheckoutProjectDir(this.root, projectId)!;
		const checkout: PinnedCheckout = {
			id: signalId,
			projectId,
			sourceRoot,
			repoRoot: sourceRoot,
			path: path.join(projectRoot, signalId),
			commitSha: TEST_PINNED_COMMIT,
			contentDigest: { ...TEST_PINNED_DIGEST },
			writableIgnoredDirectories: [],
		};
		fs.mkdirSync(checkout.path, { recursive: true });
		fs.writeFileSync(path.join(checkout.path, FROZEN_SOURCE_SENTINEL), FROZEN_SOURCE_BYTES);
		this.leases.set(signalId, checkout);
		return checkout;
	}

	async assertUnchanged(checkout: PinnedCheckout): Promise<void> {
		this.assertionCount++;
		if (this.leases.get(checkout.id)?.path !== checkout.path) {
			throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout is unavailable");
		}
		try {
			if (fs.readFileSync(path.join(checkout.path, FROZEN_SOURCE_SENTINEL), "utf8") !== FROZEN_SOURCE_BYTES) {
				throw new PinnedCheckoutError("PINNED_CHECKOUT_MUTATED", "fixture internal /private/frozen-source docker://gate-container-deadbeef secret=do-not-expose");
			}
		} catch (error) {
			if (error instanceof PinnedCheckoutError) throw error;
			throw new PinnedCheckoutError("PINNED_CHECKOUT_MUTATED", "fixture internal /private/frozen-source docker://gate-container-deadbeef secret=do-not-expose");
		}
	}

	async release(signalId: string, projectId: string): Promise<void> {
		const checkout = this.leases.get(signalId);
		if (checkout && checkout.projectId !== projectId) throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout is unavailable");
		this.releasedSignalIds.push(signalId);
		this.leases.delete(signalId);
	}

	async recover(activeSignals: ReadonlyMap<string, string>): Promise<void> {
		this.recoveredActiveSets.push([...activeSignals.keys()].sort());
		for (const [signalId, checkout] of this.leases) {
			if (activeSignals.get(signalId) !== checkout.projectId) this.leases.delete(signalId);
		}
	}

	async resume(signalId: string, projectId: string): Promise<PinnedCheckout> {
		this.resumedSignalIds.push(signalId);
		const checkout = this.leases.get(signalId);
		if (!checkout || checkout.projectId !== projectId) throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout is unavailable");
		await this.assertUnchanged(checkout);
		return checkout;
	}
}

export function pinnedCheckoutReference(checkout: PinnedCheckout) {
	return {
		id: checkout.id,
		projectId: checkout.projectId,
		path: checkout.path,
		commitSha: checkout.commitSha,
		contentDigest: { ...checkout.contentDigest },
	};
}
