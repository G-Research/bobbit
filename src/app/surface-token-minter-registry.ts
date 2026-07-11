export interface PackSurfaceRef {
	kind: "pack";
	packId: string;
	contributionKind: string;
	contributionId: string;
}

export type WsSurfaceTokenMinter = (surface: PackSurfaceRef) => Promise<string>;

const minters = new Map<string, WsSurfaceTokenMinter>();
const minterWaiters = new Map<string, Array<(minter: WsSurfaceTokenMinter | undefined) => void>>();
const MINTER_WAIT_MS = 150;

export function registerSurfaceTokenMinter(sessionId: string, minter: WsSurfaceTokenMinter): void {
	if (!sessionId) return;
	minters.set(sessionId, minter);
	const waiters = minterWaiters.get(sessionId);
	if (waiters) {
		minterWaiters.delete(sessionId);
		for (const resolve of waiters) resolve(minter);
	}
}

export function unregisterSurfaceTokenMinter(sessionId: string, minter?: WsSurfaceTokenMinter): void {
	if (!sessionId) return;
	if (minter && minters.get(sessionId) !== minter) return;
	minters.delete(sessionId);
}

export async function waitForSurfaceTokenMinter(sessionId: string): Promise<WsSurfaceTokenMinter | undefined> {
	const existing = minters.get(sessionId);
	if (existing) return existing;
	return new Promise((resolve) => {
		const waiters = minterWaiters.get(sessionId) ?? [];
		waiters.push(resolve);
		minterWaiters.set(sessionId, waiters);
		setTimeout(() => {
			const current = minterWaiters.get(sessionId);
			if (current) {
				const idx = current.indexOf(resolve);
				if (idx >= 0) current.splice(idx, 1);
				if (current.length === 0) minterWaiters.delete(sessionId);
			}
			resolve(undefined);
		}, MINTER_WAIT_MS);
	});
}
