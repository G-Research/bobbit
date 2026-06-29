// src/app/surface-token-bridge.ts
//
// Trusted CLIENT transport for pack-bound Extension Host surface-token minting.
// Pack code receives only the HostApi object built by host-api.ts; it cannot import
// this module or access the RemoteAgent WebSocket that services these requests.

import type { SurfaceRef } from "./host-api.js";

export type PackSurfaceRef = Extract<SurfaceRef, { kind: "pack" }>;

export type WsSurfaceTokenMinter = (surface: PackSurfaceRef) => Promise<string>;

const minters = new Map<string, WsSurfaceTokenMinter>();

export function registerSurfaceTokenMinter(sessionId: string, minter: WsSurfaceTokenMinter): void {
	if (sessionId) minters.set(sessionId, minter);
}

export function unregisterSurfaceTokenMinter(sessionId: string): void {
	if (sessionId) minters.delete(sessionId);
}

export async function mintPackSurfaceTokenOverWs(sessionId: string | undefined, surface: PackSurfaceRef): Promise<string> {
	if (!sessionId) throw new Error("pack surface-token mint requires a bound session");
	const minter = minters.get(sessionId);
	if (!minter) throw new Error("pack surface-token transport unavailable (no trusted WebSocket)");
	return minter(surface);
}
