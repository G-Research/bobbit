/**
 * Persistence layer for background processes — mirrors {@link SessionStore}.
 *
 * `BgProcessManager` is otherwise in-memory only; this store lets bg processes
 * (their metadata + the path to their durable log/status files) survive a
 * gateway restart and be re-attached. The on-disk shape and write discipline
 * are copied verbatim from `session-store.ts`:
 *   - atomic tmp + fsync + rename writes,
 *   - 5-deep backup rotation,
 *   - version-2 envelope `{ version, epoch, processes }`,
 *   - epoch stale-snapshot guard.
 *
 * The metadata index lives at `<stateDir>/bg-processes.json`; the per-process
 * durable files (combined projection, status snapshot, host spools/pid) live
 * under `<stateDir>/bg-processes/<sessionId>/<bgId>.*` — see
 * `docs/design/persistent-bg-processes.md` §3.
 */
import fs from "node:fs";
import path from "node:path";

/** Persisted metadata for a single background process. See design §5.1. */
export interface PersistedBgProcess {
	sessionId: string;
	/** bgId, e.g. "bg-3" */
	id: string;
	name: string;
	command: string;
	/**
	 * Host-side child.pid; for docker this is the `docker exec` handle pid —
	 * valid ONLY while the original gateway lives, NOT usable after restart.
	 * Liveness/kill must NOT use this.
	 */
	hostPid: number;
	/**
	 * The signalable wrapper pid in its OWN namespace — host: equals child.pid;
	 * docker: the in-container wrapper pid read from the pidfile post-spawn.
	 * Liveness/kill use THIS. 0 = pending (not yet resolved).
	 */
	processPid: number;
	cwd: string;
	/** present for sandboxed/docker spawns */
	containerId?: string;
	status: "running" | "exited" | "unrecoverable";
	/** null while running, when killed-without-status, OR unrecoverable */
	exitCode: number | null;
	/** why the process reached a terminal state; null while running. Authoritative. */
	terminalReason: "normal" | "killed" | "unrecoverable" | null;
	/**
	 * A user-requested kill was issued for this process (Fix 1). PERSISTED + sync-
	 * flushed at kill time so the intent survives a restart in the kill→exit window:
	 * on restore an ALIVE process is re-killed (escalation re-armed) and a DEAD-with-
	 * no-status process becomes `terminalReason="killed"` (the user asked to kill it),
	 * NOT `"unrecoverable"`. Default false.
	 */
	killRequested: boolean;
	/** epoch ms of the kill request (Fix 1); undefined when never killed. */
	killRequestedAt?: number;
	startTime: number;
	endTime: number | null;
	// HOST-owned, gateway-written — ALWAYS host for BOTH host and docker spawns:
	/** durable COMBINED capped projection <bgId>.log; authoritative retained log */
	logFile: string;
	/** HOST terminal status snapshot <bgId>.status */
	statusSnapshot: string;
	// LIVE SOURCE — host spawns: host paths; docker spawns: empty (use container* fields):
	outSpool: string;
	errSpool: string;
	/** host wrapper/helper-written processPid+nonce */
	pidFile: string;
	// LIVE SOURCE — docker spawns only, container-internal (/tmp/bobbit-bg/...):
	containerOutSpool?: string;
	containerErrSpool?: string;
	containerStatus?: string;
	containerPid?: string;
	/** per-spawn random token; written into the pidfile, re-checked on restore to detect pid reuse */
	nonce: string;
	/** true => docker: live source is container-internal; gateway mirrors into logFile + statusSnapshot */
	inContainer: boolean;
	/** bytes of each spool already consumed by the tailer — lets re-attach resume */
	outOffset: number;
	errOffset: number;
}

/** Fields `update()` is permitted to mutate after creation. */
export type UpdatableBgFields = Pick<
	PersistedBgProcess,
	| "status"
	| "exitCode"
	| "terminalReason"
	| "endTime"
	| "outOffset"
	| "errOffset"
	| "hostPid"
	| "processPid"
	| "killRequested"
	| "killRequestedAt"
>;

function bgKey(sessionId: string, id: string): string {
	return `${sessionId}\u0000${id}`;
}

/**
 * JSON file store for background-process metadata. One instance per project
 * (constructed in `ProjectContext`), writing `<stateDir>/bg-processes.json`.
 */
export class BgProcessStore {
	private readonly storeDir: string;
	private readonly storeFile: string;
	private readonly filesRoot: string;
	private processes: Map<string, PersistedBgProcess> = new Map();
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private static SAVE_DEBOUNCE_MS = 1000;
	private static BACKUP_COUNT = 5;
	private loadedEpoch = 0;
	private writtenEpoch = 0;
	private staleGuardTripped = false;

	constructor(stateDir: string) {
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "bg-processes.json");
		this.filesRoot = path.join(stateDir, "bg-processes");
		this.load();
	}

	/** Directory holding the per-process durable files for a session. */
	filesDir(sessionId: string): string {
		return path.join(this.filesRoot, sessionId);
	}

	private bakPath(n: number): string {
		return `${this.storeFile}.bak.${n}`;
	}

	private seedFromArray(rows: unknown[]): void {
		for (const row of rows) {
			if (!row || typeof row !== "object") continue;
			const p = row as PersistedBgProcess;
			if (!p.id || !p.sessionId) continue;
			this.processes.set(bgKey(p.sessionId, p.id), p);
		}
	}

	private load(): void {
		this.loadedEpoch = 0;
		this.writtenEpoch = 0;

		const candidates = [this.storeFile];
		for (let i = 1; i <= BgProcessStore.BACKUP_COUNT; i++) candidates.push(this.bakPath(i));

		for (const file of candidates) {
			try {
				if (!fs.existsSync(file)) continue;
				const raw = fs.readFileSync(file, "utf-8");
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && (parsed as { version?: number }).version === 2 && Array.isArray((parsed as { processes?: unknown[] }).processes)) {
					const obj = parsed as { version: number; epoch?: number; processes: unknown[] };
					this.seedFromArray(obj.processes);
					this.loadedEpoch = typeof obj.epoch === "number" ? obj.epoch : 0;
					if (file !== this.storeFile) {
						console.warn(`[bg-process-store] Loaded from backup ${path.basename(file)} (epoch ${this.loadedEpoch}) — primary missing/corrupt`);
					}
					return;
				}
				console.warn(`[bg-process-store] ${file}: unrecognised shape, skipping`);
			} catch (err) {
				console.warn(`[bg-process-store] Failed to parse ${file}:`, err);
			}
		}
		// No file readable — start empty.
	}

	private peekDiskEpoch(): number {
		try {
			if (!fs.existsSync(this.storeFile)) return -1;
			const raw = fs.readFileSync(this.storeFile, "utf-8");
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && typeof (parsed as { epoch?: unknown }).epoch === "number") {
				return (parsed as { epoch: number }).epoch;
			}
			return -1;
		} catch {
			return -1;
		}
	}

	private rotateBackups(): void {
		try {
			if (!fs.existsSync(this.storeFile)) return;
			const N = BgProcessStore.BACKUP_COUNT;
			try { if (fs.existsSync(this.bakPath(N))) fs.unlinkSync(this.bakPath(N)); } catch { /* non-fatal */ }
			for (let i = N - 1; i >= 1; i--) {
				try {
					if (fs.existsSync(this.bakPath(i))) {
						fs.renameSync(this.bakPath(i), this.bakPath(i + 1));
					}
				} catch { /* non-fatal */ }
			}
			try { fs.copyFileSync(this.storeFile, this.bakPath(1)); } catch { /* non-fatal */ }
		} catch {
			// Backup failure must never block a save.
		}
	}

	isStaleGuardTripped(): boolean {
		return this.staleGuardTripped;
	}

	getLoadedEpoch(): number {
		return this.loadedEpoch;
	}

	getWrittenEpoch(): number {
		return this.writtenEpoch;
	}

	private saveNow(): void {
		if (this.staleGuardTripped) return;
		try {
			if (!fs.existsSync(this.storeDir)) {
				fs.mkdirSync(this.storeDir, { recursive: true });
			}

			const onDiskEpoch = this.peekDiskEpoch();
			if (onDiskEpoch > this.loadedEpoch && this.writtenEpoch === 0) {
				console.error(
					`[bg-process-store] REFUSING to save: on-disk epoch ${onDiskEpoch} is ` +
					`newer than loaded epoch ${this.loadedEpoch}. Possible stale-snapshot ` +
					`recovery. Manual intervention required: inspect ${this.storeFile} and ${this.storeFile}.bak.*`,
				);
				this.staleGuardTripped = true;
				return;
			}

			const nextEpoch = Math.max(this.loadedEpoch, this.writtenEpoch, onDiskEpoch < 0 ? 0 : onDiskEpoch) + 1;
			const payload = {
				version: 2 as const,
				epoch: nextEpoch,
				processes: Array.from(this.processes.values()),
			};
			const json = JSON.stringify(payload, null, 2);

			this.rotateBackups();

			const tmp = `${this.storeFile}.tmp`;
			const fd = fs.openSync(tmp, "w");
			try {
				fs.writeFileSync(fd, json, "utf-8");
				try { fs.fsyncSync(fd); } catch { /* fsync may fail on Windows network shares — non-fatal */ }
			} finally {
				fs.closeSync(fd);
			}
			fs.renameSync(tmp, this.storeFile);
			this.writtenEpoch = nextEpoch;
		} catch (err) {
			console.error("[bg-process-store] Failed to save processes:", err);
			try {
				const tmp = `${this.storeFile}.tmp`;
				if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
			} catch { /* ignore */ }
		}
	}

	private save(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.saveNow();
		}, BgProcessStore.SAVE_DEBOUNCE_MS);
	}

	getAll(): PersistedBgProcess[] {
		return Array.from(this.processes.values());
	}

	getForSession(sessionId: string): PersistedBgProcess[] {
		return Array.from(this.processes.values()).filter(p => p.sessionId === sessionId);
	}

	get(sessionId: string, id: string): PersistedBgProcess | undefined {
		return this.processes.get(bgKey(sessionId, id));
	}

	/** Insert/replace a record. Structural change → immediate synchronous save. */
	put(p: PersistedBgProcess): void {
		this.processes.set(bgKey(p.sessionId, p.id), p);
		this.saveNow();
	}

	/**
	 * Update mutable fields. Recovery-critical fields (status / exitCode /
	 * terminalReason / endTime / processPid / hostPid) flush synchronously;
	 * offset advances are debounced (high-frequency, loss-tolerant).
	 */
	update(sessionId: string, id: string, updates: Partial<UpdatableBgFields>): void {
		const existing = this.processes.get(bgKey(sessionId, id));
		if (!existing) return;
		Object.assign(existing, updates);

		const onlyOffsets = Object.keys(updates).every(k => k === "outOffset" || k === "errOffset");
		if (onlyOffsets) {
			this.save(); // debounced
		} else {
			if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
			this.saveNow(); // recovery-critical
		}
	}

	/** Remove a single index entry (does NOT delete the per-process files). */
	remove(sessionId: string, id: string): void {
		if (this.processes.delete(bgKey(sessionId, id))) {
			this.saveNow();
		}
	}

	/** Remove all index entries for a session. */
	removeForSession(sessionId: string): void {
		let changed = false;
		for (const [key, p] of this.processes) {
			if (p.sessionId === sessionId) { this.processes.delete(key); changed = true; }
		}
		if (changed) this.saveNow();
	}

	flush(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
			this.saveNow();
		}
	}
}
