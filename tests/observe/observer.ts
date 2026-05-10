/**
 * Browser-side observer.
 *
 * Wraps a Playwright `Page` with:
 *   - `tick()`            — periodic 1 Hz capture (screenshot + DOM + state)
 *   - `beforeAction(name)`/`afterAction(name)` — pre/post action capture
 *
 * Everything is appended to a `Timeline` in-memory and to disk as it goes,
 * so a crash / hang still leaves a usable record.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Page } from "@playwright/test";
import type { Timeline, TickRecord, RunMeta, DomMessageRef, SessionState } from "./types.ts";

interface ObserverOpts {
	page: Page;
	outDir: string;
	tickMs: number;
	meta: RunMeta;
}

export class Observer {
	private page: Page;
	private outDir: string;
	private tickMs: number;
	private startWall: number;
	private timer: NodeJS.Timeout | null = null;
	private capturing = false;
	private seq = 0;
	timeline: Timeline;

	constructor(opts: ObserverOpts) {
		this.page = opts.page;
		this.outDir = opts.outDir;
		this.tickMs = opts.tickMs;
		this.startWall = Date.now();
		this.timeline = { meta: opts.meta, ticks: [], findings: [] };
	}

	async init(): Promise<void> {
		await mkdir(join(this.outDir, "screens"), { recursive: true });
		await mkdir(join(this.outDir, "state"), { recursive: true });
		await mkdir(join(this.outDir, "dom"), { recursive: true });
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.capture("tick").catch((err) => {
				// Don't kill the loop on transient errors — log & continue.
				// eslint-disable-next-line no-console
				console.warn("[observer] tick capture failed:", (err as Error).message);
			});
		}, this.tickMs);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async beforeAction(name: string): Promise<void> {
		await this.capture("before-action", name);
	}
	async afterAction(name: string): Promise<void> {
		await this.capture("after-action", name);
	}

	private async capture(kind: TickRecord["kind"], action?: string): Promise<void> {
		if (this.capturing) return; // skip overlapping ticks
		this.capturing = true;
		const idx = this.seq++;
		const t = Date.now() - this.startWall;
		const stem = `${String(idx).padStart(5, "0")}-${kind}${action ? "-" + sanitize(action) : ""}`;
		const screenRel = join("screens", `${stem}.jpg`);
		const stateRel = join("state", `${stem}.json`);
		const domRel = join("dom", `${stem}.json`);

		try {
			// Screenshot first — captures the actual visual state at this instant.
			await this.page
				.screenshot({
					path: join(this.outDir, screenRel),
					type: "jpeg",
					quality: 60,
					fullPage: false,
				})
				.catch(() => undefined);

			// Pull DOM transcript order + bobbitState in one round-trip.
			const probe = await this.page.evaluate(() => probeBobbit()).catch((e) => ({
				error: String(e),
				dom: [] as DomMessageRef[],
				session: null as SessionState | null,
			}));

			const tick: TickRecord = {
				t,
				wallMs: Date.now(),
				kind,
				action,
				screenshot: screenRel,
				stateSnapshot: stateRel,
				domSnapshot: domRel,
				session: probe.session ?? undefined,
				dom: probe.dom ?? [],
				notes: (probe as any).error ? [`probe error: ${(probe as any).error}`] : undefined,
			};

			this.timeline.ticks.push(tick);
			await writeFile(join(this.outDir, stateRel), JSON.stringify(probe.session ?? null, null, 2));
			await writeFile(join(this.outDir, domRel), JSON.stringify(probe.dom ?? [], null, 2));
			// Always re-write the timeline so a crash leaves the latest version.
			await writeFile(
				join(this.outDir, "timeline.json"),
				JSON.stringify(this.timeline, null, 2),
			);
		} finally {
			this.capturing = false;
		}
	}

	relPath(p: string): string {
		return relative(this.outDir, p);
	}
}

function sanitize(s: string): string {
	return s.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40);
}

/* ------------------------------------------------------------------ */
/* In-page probe — must be self-contained (Playwright stringifies it). */
/* ------------------------------------------------------------------ */

declare global {
	interface Window {
		bobbitState?: any;
	}
	function probeBobbit(): { dom: DomMessageRef[]; session: SessionState | null };
}

// Inject the probe by evaluating its source as a string. We attach it once
// per page in run.ts via addInitScript().
export const PROBE_SOURCE = `
(function () {
	function fingerprint(text) {
		text = (text || "").trim().slice(0, 200);
		var h = 0;
		for (var i = 0; i < text.length; i++) {
			h = ((h << 5) - h + text.charCodeAt(i)) | 0;
		}
		return text.slice(0, 40).replace(/\\s+/g, " ") + "#" + (h >>> 0).toString(16);
	}
	function readDom() {
		var nodes = document.querySelectorAll("user-message, assistant-message, [data-msg-role]");
		var out = [];
		for (var i = 0; i < nodes.length; i++) {
			var el = nodes[i];
			var tag = el.tagName.toLowerCase();
			out.push({
				domIndex: i,
				tag: tag,
				fingerprint: fingerprint(el.textContent || ""),
			});
		}
		return out;
	}
	function readState() {
		var s = window.bobbitState;
		if (!s) return null;
		var msgs = Array.isArray(s.messages) ? s.messages.slice() : [];
		// Sort by (_order, _insertionTick) — same order the renderer trusts.
		msgs.sort(function (a, b) {
			var ao = a && a._order != null ? a._order : 0;
			var bo = b && b._order != null ? b._order : 0;
			if (ao !== bo) return ao - bo;
			var at = a && a._insertionTick != null ? a._insertionTick : 0;
			var bt = b && b._insertionTick != null ? b._insertionTick : 0;
			return at - bt;
		});
		var compact = msgs.map(function (m, i) {
			var content = "";
			var toolBlocks = [];
			if (typeof m.content === "string") content = m.content;
			else if (Array.isArray(m.content)) {
				for (var j = 0; j < m.content.length; j++) {
					var c = m.content[j];
					if (!c || typeof c !== "object") continue;
					if (typeof c.text === "string") content += c.text;
					if (c.type === "tool_use" || c.type === "tool_result") {
						toolBlocks.push({
							type: c.type,
							tool_use_id: c.tool_use_id || c.id || c.toolCallId,
							tool_name: c.name || c.tool_name || c.toolName,
							isError: c.is_error === true || c.isError === true,
						});
					}
				}
			}
			return {
				stateIndex: i,
				role: m.role || "?",
				_order: m._order != null ? m._order : -1,
				_insertionTick: m._insertionTick,
				timestamp: m.timestamp,
				id: m.id,
				fingerprint: fingerprint(content),
				toolBlocks: toolBlocks.length ? toolBlocks : undefined,
			};
		});
		return {
			id: s.sessionId || (s.session && s.session.id) || undefined,
			status: s.status || (s.session && s.session.status) || undefined,
			messages: compact,
		};
	}
	window.probeBobbit = function () {
		try { return { dom: readDom(), session: readState() }; }
		catch (e) { return { dom: [], session: null, error: String(e) }; }
	};
})();
`;
