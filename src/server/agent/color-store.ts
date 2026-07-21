import path from "node:path";
import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";

/**
 * Migration mappings between palette versions. Each maps old index → new index.
 *
 * V1 (20 colours): [0,25,50,75,100,125,150,175,200,225,-135,-110,-85,-60,-35,-10,15,40,65,250]
 * V3 (17 colours): [0,25,50,75,100,125,150,175,-135,-110,-85,-60,-35,-10,15,40,65]
 * V4 (14 colours): [-110,-85,-60,-35,-10,0,15,25,40,50,65,75,100,125]
 */

// V1 (original 20) → V4 (current 14)
const V1_TO_CURRENT: number[] = [
	5, 7, 9, 11, 12, 13, // 0-5: 0→5, 25→7, 50→9, 75→11, 100→12, 125→13
	13, 13,               // 6-7: 150°,175° removed → 13 (125°)
	13, 13,               // 8-9: 200°,225° removed → 13 (125°)
	0, 0, 1, 2, 3, 4, 6, 8, 10, // 10-18: -135→0(-110), -110→0, -85→1, -60→2, -35→3, -10→4, 15→6, 40→8, 65→10
	0,                    // 19: 250° removed → 0 (-110°)
];

// V2 (18 colours) → V4 (current 14) — same as V1 but without indices 8(200°) and 19(250°)
// V2: [0,25,50,75,100,125,150,175,225,-135,-110,-85,-60,-35,-10,15,40,65]
const V2_TO_CURRENT: number[] = [
	5, 7, 9, 11, 12, 13, // 0-5: same hue mapping as V1
	13, 13,               // 6-7: 150°,175° removed → 13 (125°)
	13,                   // 8: 225° removed → 13 (125°)
	0, 0, 1, 2, 3, 4, 6, 8, 10, // 9-17: -135→0, -110→0, -85→1, -60→2, -35→3, -10→4, 15→6, 40→8, 65→10
];

// V3 (17 colours) → V4 (current 14)
// V3: [0,25,50,75,100,125,150,175,-135,-110,-85,-60,-35,-10,15,40,65]
const V3_TO_CURRENT: number[] = [
	5, 7, 9, 11, 12, 13, // 0-5: 0→5, 25→7, 50→9, 75→11, 100→12, 125→13
	13, 13,               // 6-7: 150°,175° removed → 13 (125°)
	0,                    // 8: -135° removed → 0 (-110°)
	0, 1, 2, 3, 4, 6, 8, 10, // 9-16: -110→0, -85→1, -60→2, -35→3, -10→4, 15→6, 40→8, 65→10
];

/** Current palette version. Bump when palette changes require migration. */
const PALETTE_VERSION = 4;

/**
 * Persists session → palette index mapping to disk.
 * Ensures bobbit colors are stable across refreshes and devices.
 */
export class ColorStore {
	private colors: Map<string, number> = new Map();
	private readonly storeDir: string;
	private readonly storeFile: string;
	private readonly fs: FsLike;
	private asyncSaveInFlight: Promise<void> | null = null;
	private asyncSaveRequested = false;

	constructor(stateDir: string, fsImpl: FsLike = realFs) {
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "session-colors.json");
		this.fs = fsImpl;
		this.load();
	}

	private load(): void {
		try {
			if (this.fs.existsSync(this.storeFile)) {
				const data = JSON.parse(this.fs.readFileSync(this.storeFile, "utf-8"));
				if (data && typeof data === "object" && !Array.isArray(data)) {
					for (const [id, idx] of Object.entries(data)) {
						if (id.startsWith("_")) continue; // skip metadata keys
						if (typeof idx === "number") this.colors.set(id, idx);
					}
					// Migrate from old palette if needed
					const storedVersion = typeof data._paletteVersion === "number" ? data._paletteVersion : 1;
					if (storedVersion < PALETTE_VERSION) {
						this.migrateFromOldPalette(storedVersion);
					}
				}
			}
		} catch (err) {
			console.error("[color-store] Failed to load session colors:", err);
		}
	}

	/** Remap all indices from an old palette version to the current 14-colour palette. */
	private migrateFromOldPalette(fromVersion: number): void {
		const mapping = fromVersion < 2 ? V1_TO_CURRENT
			: fromVersion < 3 ? V2_TO_CURRENT
			: V3_TO_CURRENT;
		let changed = false;
		for (const [id, idx] of this.colors) {
			if (idx >= 0 && idx < mapping.length) {
				const newIdx = mapping[idx];
				if (newIdx !== idx) {
					this.colors.set(id, newIdx);
					changed = true;
				}
			} else if (idx > 13) {
				// Any index out of new range → clamp to max
				this.colors.set(id, 13);
				changed = true;
			}
		}
		if (changed) {
			console.log(`[color-store] Migrated session colors from palette v${fromVersion} to v${PALETTE_VERSION}`);
		}
		this.save();
	}

	private save(): void {
		// A synchronous mutation cannot await an active purge write. Fold it into
		// the async drain instead so the older purge snapshot cannot overwrite it.
		if (this.asyncSaveInFlight) {
			this.asyncSaveRequested = true;
			return;
		}
		try {
			if (!this.fs.existsSync(this.storeDir)) {
				this.fs.mkdirSync(this.storeDir, { recursive: true });
			}
			const data: Record<string, number> = { _paletteVersion: PALETTE_VERSION, ...Object.fromEntries(this.colors) };
			this.fs.writeFileSync(this.storeFile, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[color-store] Failed to save session colors:", err);
		}
	}

	private async saveAsyncOnce(): Promise<void> {
		try {
			await this.fs.promises.mkdir(this.storeDir, { recursive: true });
			const data: Record<string, number> = { _paletteVersion: PALETTE_VERSION, ...Object.fromEntries(this.colors) };
			await this.fs.promises.writeFile(this.storeFile, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[color-store] Failed to save session colors:", err);
		}
	}

	private async drainAsyncSaves(): Promise<void> {
		try {
			do {
				this.asyncSaveRequested = false;
				await this.saveAsyncOnce();
			} while (this.asyncSaveRequested);
		} finally {
			// Clear before this promise settles. A mutation cannot then observe a
			// settled writer, enqueue against it, and lose its requested save in a
			// later promise reaction.
			this.asyncSaveInFlight = null;
			if (this.asyncSaveRequested) {
				this.asyncSaveInFlight = this.drainAsyncSaves();
			}
		}
	}

	private requestAsyncSave(): Promise<void> {
		this.asyncSaveRequested = true;
		if (!this.asyncSaveInFlight) {
			this.asyncSaveInFlight = this.drainAsyncSaves();
		}
		return this.asyncSaveInFlight;
	}

	get(sessionId: string): number | undefined {
		return this.colors.get(sessionId);
	}

	set(sessionId: string, paletteIndex: number): void {
		this.colors.set(sessionId, paletteIndex);
		this.save();
	}

	getAll(): Record<string, number> {
		return Object.fromEntries(this.colors);
	}

	remove(sessionId: string): void {
		this.colors.delete(sessionId);
		this.save();
	}

	/** Promise-based, serialized removal used by archive purge. */
	async removeAsync(sessionId: string): Promise<void> {
		this.colors.delete(sessionId);
		await this.requestAsyncSave();
	}
}
