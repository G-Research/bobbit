import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GateSignal } from "../../../src/server/agent/gate-store.js";
import { PinnedCheckoutError, type PinnedCheckout } from "../../../src/server/agent/verification-pinned-checkout.js";
import { verificationCheckoutProjectDir } from "../../../src/server/agent/verification-checkout-scope.js";

const DIGEST_ALGORITHM = "sha256" as const;

function snapshotDigest(root: string): PinnedCheckout["contentDigest"] {
	const hash = createHash(DIGEST_ALGORITHM);
	let fileCount = 0;
	const visit = (directory: string): void => {
		for (const name of fs.readdirSync(directory).sort()) {
			const entry = path.join(directory, name);
			const relative = path.relative(root, entry).split(path.sep).join("/");
			const stat = fs.lstatSync(entry);
			if (stat.isDirectory()) {
				hash.update(`d\0${relative}\0`);
				visit(entry);
				continue;
			}
			if (stat.isFile()) {
				hash.update(`f\0${relative}\0`);
				hash.update(fs.readFileSync(entry));
				fileCount++;
				continue;
			}
			if (stat.isSymbolicLink()) {
				hash.update(`l\0${relative}\0${fs.readlinkSync(entry)}\0`);
				fileCount++;
				continue;
			}
			throw new Error(`unsupported fixture source entry: ${relative}`);
		}
	};
	visit(root);
	return { algorithm: DIGEST_ALGORITHM, version: 1, digest: hash.digest("hex"), fileCount };
}

/**
 * Lifecycle-faithful pinned checkout seam for direct VerificationHarness tests.
 * Gateway tests deliberately exercise VerificationPinnedCheckoutManager itself;
 * this fixture snapshots a private copy so direct tests retain the same frozen
 * cwd, lease, post-step attestation, recovery, and cleanup contract.
 */
export class InjectedPinnedCheckoutManager {
	private readonly root = fs.mkdtempSync(path.join(os.tmpdir(), "verification-pinned-fixture-"));
	private readonly leases = new Map<string, PinnedCheckout>();

	async acquire({ signal, sourceRoot, projectId }: { signal: GateSignal; sourceRoot: string; projectId: string }): Promise<PinnedCheckout> {
		const source = fs.realpathSync(sourceRoot);
		const checkoutPath = path.join(verificationCheckoutProjectDir(this.root, projectId)!, String(this.leases.size));
		fs.cpSync(source, checkoutPath, { recursive: true, dereference: false, verbatimSymlinks: true });
		const checkout: PinnedCheckout = {
			id: signal.id,
			projectId,
			sourceRoot: source,
			repoRoot: source,
			path: checkoutPath,
			commitSha: signal.commitSha,
			contentDigest: snapshotDigest(checkoutPath),
			writableIgnoredDirectories: [],
		};
		this.leases.set(signal.id, checkout);
		return checkout;
	}

	async assertUnchanged(checkout: PinnedCheckout): Promise<void> {
		const lease = this.leases.get(checkout.id);
		if (!lease || lease.path !== checkout.path) {
			throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout is unavailable");
		}
		const actual = snapshotDigest(checkout.path);
		if (actual.digest !== checkout.contentDigest.digest || actual.fileCount !== checkout.contentDigest.fileCount) {
			throw new PinnedCheckoutError("PINNED_CHECKOUT_MUTATED", "Pinned checkout changed during verification");
		}
	}

	async resume(signalId: string, projectId: string): Promise<PinnedCheckout> {
		const checkout = this.leases.get(signalId);
		if (!checkout || checkout.projectId !== projectId) throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout is unavailable");
		await this.assertUnchanged(checkout);
		return checkout;
	}

	async release(signalId: string, projectId: string): Promise<void> {
		const checkout = this.leases.get(signalId);
		if (!checkout) return;
		if (checkout.projectId !== projectId) throw new PinnedCheckoutError("PINNED_CHECKOUT_UNREADABLE", "Pinned checkout is unavailable");
		fs.rmSync(checkout.path, { recursive: true, force: true });
		this.leases.delete(signalId);
	}

	async recover(activeSignals: ReadonlyMap<string, string>): Promise<void> {
		for (const [signalId, checkout] of this.leases) {
			if (activeSignals.get(signalId) !== checkout.projectId) await this.release(signalId, checkout.projectId);
		}
	}

	dispose(): void {
		fs.rmSync(this.root, { recursive: true, force: true });
		this.leases.clear();
	}
}
