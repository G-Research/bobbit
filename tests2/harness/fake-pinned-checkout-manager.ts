import fs from "node:fs";
import path from "node:path";

import { PinnedCheckoutError, type PinnedCheckout } from "../../src/server/agent/verification-pinned-checkout.ts";

export const TEST_PINNED_COMMIT = "a".repeat(40);
export const TEST_PINNED_DIGEST = Object.freeze({
	algorithm: "sha256" as const,
	version: 1 as const,
	digest: "b".repeat(64),
	fileCount: 0,
});

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

	async acquire({ signal, sourceRoot }: { signal: { id: string }; sourceRoot: string }): Promise<PinnedCheckout> {
		this.acquiredSourceRoots.push(sourceRoot);
		return this.seed(signal.id, sourceRoot);
	}

	seed(signalId: string, sourceRoot = this.root): PinnedCheckout {
		const checkout: PinnedCheckout = {
			id: signalId,
			sourceRoot,
			repoRoot: sourceRoot,
			path: path.join(this.root, signalId),
			commitSha: TEST_PINNED_COMMIT,
			contentDigest: { ...TEST_PINNED_DIGEST },
		};
		fs.mkdirSync(checkout.path, { recursive: true });
		this.leases.set(signalId, checkout);
		return checkout;
	}

	async assertUnchanged(checkout: PinnedCheckout): Promise<void> {
		this.assertionCount++;
		if (this.leases.get(checkout.id)?.path !== checkout.path) {
			throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout is unavailable");
		}
	}

	async release(signalId: string): Promise<void> {
		this.releasedSignalIds.push(signalId);
		this.leases.delete(signalId);
	}

	async recover(activeSignalIds: ReadonlySet<string>): Promise<void> {
		this.recoveredActiveSets.push([...activeSignalIds].sort());
		for (const signalId of this.leases.keys()) {
			if (!activeSignalIds.has(signalId)) this.leases.delete(signalId);
		}
	}

	async resume(signalId: string): Promise<PinnedCheckout> {
		this.resumedSignalIds.push(signalId);
		const checkout = this.leases.get(signalId);
		if (!checkout) throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout is unavailable");
		await this.assertUnchanged(checkout);
		return checkout;
	}
}

export function pinnedCheckoutReference(checkout: PinnedCheckout) {
	return {
		id: checkout.id,
		path: checkout.path,
		commitSha: checkout.commitSha,
		contentDigest: { ...checkout.contentDigest },
	};
}
