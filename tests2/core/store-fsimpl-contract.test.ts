import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FsLike } from "../../src/server/gateway-deps.js";
import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import { PrStatusStore } from "../../src/server/agent/pr-status-store.js";
import { ReviewAnnotationStore } from "../../src/server/review-annotation-store.js";

function createMemoryFs(): FsLike & { files: Map<string, string> } {
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	const norm = (p: fs.PathLike) => path.resolve(String(p));
	const ensureParent = (p: string) => dirs.add(path.dirname(p));
	const api = {
		files,
		existsSync(p: fs.PathLike) { const n = norm(p); return files.has(n) || dirs.has(n); },
		mkdirSync(p: fs.PathLike) { dirs.add(norm(p)); return undefined as any; },
		readFileSync(p: fs.PathLike) { const n = norm(p); if (!files.has(n)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files.get(n)!; },
		writeFileSync(p: fs.PathLike, data: string | NodeJS.ArrayBufferView) { const n = norm(p); ensureParent(n); files.set(n, typeof data === "string" ? data : Buffer.from(data).toString("utf-8")); },
		appendFileSync(p: fs.PathLike, data: string | NodeJS.ArrayBufferView) { const n = norm(p); ensureParent(n); files.set(n, (files.get(n) ?? "") + (typeof data === "string" ? data : Buffer.from(data).toString("utf-8"))); },
		readdirSync(p: fs.PathLike) { const n = norm(p); const prefix = n.endsWith(path.sep) ? n : n + path.sep; return [...files.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length).split(path.sep)[0]); },
		statSync(p: fs.PathLike) { const n = norm(p); if (!files.has(n) && !dirs.has(n)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return { isDirectory: () => dirs.has(n), isFile: () => files.has(n), mtimeMs: Date.now(), size: files.get(n)?.length ?? 0 } as fs.Stats; },
		lstatSync(p: fs.PathLike) { return this.statSync(p); },
		renameSync(from: fs.PathLike, to: fs.PathLike) { const a = norm(from); const b = norm(to); const data = files.get(a); if (data === undefined) throw new Error("ENOENT"); files.delete(a); ensureParent(b); files.set(b, data); },
		rmSync(p: fs.PathLike) { files.delete(norm(p)); dirs.delete(norm(p)); },
		unlinkSync(p: fs.PathLike) { files.delete(norm(p)); },
		copyFileSync(from: fs.PathLike, to: fs.PathLike) { const data = files.get(norm(from)); if (data === undefined) throw new Error("ENOENT"); const b = norm(to); ensureParent(b); files.set(b, data); },
		promises: {
			access: async (p: fs.PathLike) => { if (!api.existsSync(p)) throw new Error("ENOENT"); },
			mkdir: async (p: fs.PathLike) => { api.mkdirSync(p); undefined as any; },
			readFile: async (p: fs.PathLike) => api.readFileSync(p),
			writeFile: async (p: fs.PathLike, data: string | NodeJS.ArrayBufferView) => { api.writeFileSync(p, data); },
			appendFile: async (p: fs.PathLike, data: string | NodeJS.ArrayBufferView) => { api.appendFileSync(p, data); },
			readdir: async (p: fs.PathLike) => api.readdirSync(p) as any,
			stat: async (p: fs.PathLike) => api.statSync(p),
			lstat: async (p: fs.PathLike) => api.lstatSync(p),
			rename: async (from: fs.PathLike, to: fs.PathLike) => { api.renameSync(from, to); },
			rm: async (p: fs.PathLike) => { api.rmSync(p); },
			unlink: async (p: fs.PathLike) => { api.unlinkSync(p); },
			copyFile: async (from: fs.PathLike, to: fs.PathLike) => { api.copyFileSync(from, to); },
		},
	} as FsLike & { files: Map<string, string> };
	return api;
}

describe("store fsImpl contract", () => {
	it("writes selected stores through the injected fs", () => {
		const memfs = createMemoryFs();
		const stateDir = path.join(os.tmpdir(), "memfs-state");

		new PreferencesStore(stateDir, memfs).set("theme", "dark");
		new PrStatusStore(stateDir, memfs).set("goal-1", { state: "OPEN", url: "https://example.invalid/pr/1" });
		new ReviewAnnotationStore(stateDir, memfs).addAnnotation("session-1", "Doc", { id: "a1", quote: "q", comment: "c" });

		expect(memfs.files.has(path.join(stateDir, "preferences.json"))).toBe(true);
		expect(memfs.files.has(path.join(stateDir, "pr-status-cache.json"))).toBe(true);
		expect(memfs.files.has(path.join(stateDir, "review-annotations-session-1.json"))).toBe(true);
		expect(fs.existsSync(path.join(stateDir, "preferences.json"))).toBe(false);
	});

	it("uses real fs when fsImpl is omitted", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-real-fs-store-"));
		new PreferencesStore(stateDir).set("theme", "light");
		expect(fs.existsSync(path.join(stateDir, "preferences.json"))).toBe(true);
	});
});
