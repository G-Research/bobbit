import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Unit tests for the PURE shouldReloadOnResume() decision function from
 * src/app/pwa-lifecycle.ts (the iOS PWA grey-screen recovery logic).
 *
 * Uses a file:// fixture that inlines the function (kept in sync with source).
 *
 * Run with:
 *   npx playwright test tests/pwa-lifecycle.spec.ts --config tests/playwright.config.ts
 */

const FIXTURE = "file://" + path.resolve("tests/fixtures/pwa-lifecycle.html").replace(/\\/g, "/");

const STALE = 30 * 60 * 1000; // 30 min
const COOLDOWN = 10_000; // 10 s
const T0 = 1_000_000_000_000; // arbitrary epoch base

type Args = {
	appMounted: boolean;
	hiddenAtMs: number | null;
	resumeAtMs: number;
	lastAliveMs: number | null;
	nowMs: number;
	lastReloadAtMs: number | null;
	staleThresholdMs: number;
	reloadCooldownMs: number;
};

function args(overrides: Partial<Args> = {}): Args {
	return {
		appMounted: true,
		hiddenAtMs: null,
		resumeAtMs: T0,
		lastAliveMs: null,
		nowMs: T0 + 1500,
		lastReloadAtMs: null,
		staleThresholdMs: STALE,
		reloadCooldownMs: COOLDOWN,
		...overrides,
	};
}

test.describe("shouldReloadOnResume", () => {
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		page = await browser.newPage();
		await page.goto(FIXTURE);
	});

	test.afterAll(async () => {
		await page.close();
	});

	const decide = (a: Args): Promise<boolean> =>
		page.evaluate((x) => (window as any).shouldReloadOnResume(x), a);

	test("loop guard overrides all — within cooldown never reloads, even when unmounted", async () => {
		// Not mounted (would otherwise reload) but within cooldown → false.
		const a = args({ appMounted: false, lastReloadAtMs: T0 + 1000, nowMs: T0 + 1500 });
		expect(await decide(a)).toBe(false);
	});

	test("loop guard does NOT block once the cooldown has elapsed", async () => {
		const a = args({ appMounted: false, lastReloadAtMs: T0, nowMs: T0 + COOLDOWN });
		expect(await decide(a)).toBe(true);
	});

	test("dead bootstrap — !appMounted reloads", async () => {
		expect(await decide(args({ appMounted: false }))).toBe(true);
	});

	test("live mounted page — heartbeat advanced after resume never reloads, regardless of gap", async () => {
		// Very long suspend, but heartbeat advanced past resume → alive → no reload.
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - 10 * STALE,
			resumeAtMs: T0,
			lastAliveMs: T0 + 16, // ticked ~one frame after resume
			nowMs: T0 + 1500,
		});
		expect(await decide(a)).toBe(false);
	});

	test("mounted-but-frozen — long gap + stale (null) heartbeat reloads", async () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - STALE,
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0 + 1500,
		});
		expect(await decide(a)).toBe(true);
	});

	test("mounted-but-frozen — long gap + heartbeat not advanced (<= resume) reloads", async () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - STALE,
			resumeAtMs: T0,
			lastAliveMs: T0, // exactly at resume — not advanced
			nowMs: T0 + 1500,
		});
		expect(await decide(a)).toBe(true);
	});

	test("short suspend — stale heartbeat but gap below threshold never reloads (quick switch)", async () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - 1000, // 1s suspend
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0 + 1500,
		});
		expect(await decide(a)).toBe(false);
	});

	test("boundary — gap exactly at staleThreshold counts as long (reloads with stale heartbeat)", async () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - STALE, // gap === threshold at nowMs = resume; use nowMs = hiddenAt + STALE
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0, // nowMs - hiddenAtMs === STALE exactly
		});
		expect(await decide(a)).toBe(true);
	});

	test("boundary — gap one ms below threshold does not reload", async () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: T0 - (STALE - 1),
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0,
		});
		expect(await decide(a)).toBe(false);
	});

	test("boundary — hiddenAtMs null never qualifies as a long suspend", async () => {
		const a = args({
			appMounted: true,
			hiddenAtMs: null,
			resumeAtMs: T0,
			lastAliveMs: null,
			nowMs: T0 + 10 * STALE,
		});
		expect(await decide(a)).toBe(false);
	});

	test("loop guard at the exact cooldown boundary does not block (>= cooldown allowed)", async () => {
		// nowMs - lastReloadAtMs === reloadCooldownMs → NOT within cooldown → may reload.
		const a = args({ appMounted: false, lastReloadAtMs: T0, nowMs: T0 + COOLDOWN });
		expect(await decide(a)).toBe(true);
	});
});

/**
 * Drift guard (Finding 2): the fixture hand-copies shouldReloadOnResume() from
 * src/app/pwa-lifecycle.ts. The "keep in sync" comment is not self-enforcing,
 * so this test extracts the function from BOTH files, canonicalizes away
 * formatting / `export` / TS types / destructuring-vs-var-binding / local
 * renames (e.g. source `hiddenAtMs: hiddenAt` vs fixture `hiddenAtMs`) by
 * rewriting every binding back to its `args.<field>` origin, and asserts the
 * resulting core logic is identical. A logic change in source that isn't
 * mirrored in the fixture fails here; pure reformatting does not.
 */
test.describe("source/fixture drift guard", () => {
	const SOURCE = path.resolve("src/app/pwa-lifecycle.ts");
	const FIXTURE_FILE = path.resolve("tests/fixtures/pwa-lifecycle.html");

	/** Extract the body (between the outer braces) of `function shouldReloadOnResume`. */
	function extractFnBody(src: string): string {
		const sig = src.indexOf("function shouldReloadOnResume");
		if (sig < 0) throw new Error("function shouldReloadOnResume not found");
		const open = src.indexOf("{", sig);
		if (open < 0) throw new Error("function body open brace not found");
		let depth = 0;
		for (let i = open; i < src.length; i++) {
			const c = src[i];
			if (c === "{") depth++;
			else if (c === "}") {
				depth--;
				if (depth === 0) return src.slice(open + 1, i);
			}
		}
		throw new Error("unbalanced braces in shouldReloadOnResume");
	}

	function stripComments(s: string): string {
		return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
	}

	const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	/**
	 * Map every local binding name → the `args.<field>` it originates from,
	 * covering both source destructuring (`const { a, x: y } = args;`) and the
	 * fixture's `var x = args.y;` prologue.
	 */
	function buildAliasMap(body: string): Record<string, string> {
		const map: Record<string, string> = {};
		const d = body.match(/(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*args\s*;/);
		if (d) {
			for (const part of d[1].split(",")) {
				const t = part.trim();
				if (!t) continue;
				if (t.includes(":")) {
					const [field, alias] = t.split(":").map((x) => x.trim());
					map[alias] = field;
				} else {
					map[t] = t;
				}
			}
		}
		const re = /(?:const|let|var)\s+(\w+)\s*=\s*args\.(\w+)\s*;/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(body)) !== null) map[m[1]] = m[2];
		return map;
	}

	function removePrologue(body: string): string {
		return body
			.replace(/(?:const|let|var)\s*\{[\s\S]*?\}\s*=\s*args\s*;/g, " ")
			.replace(/(?:const|let|var)\s+\w+\s*=\s*args\.\w+\s*;/g, " ");
	}

	function canonicalize(rawBody: string): string {
		let body = stripComments(rawBody);
		const aliasMap = buildAliasMap(body);
		body = removePrologue(body);
		const keys = Object.keys(aliasMap).sort((a, b) => b.length - a.length);
		if (keys.length) {
			const re = new RegExp("\\b(" + keys.map(escapeRe).join("|") + ")\\b", "g");
			body = body.replace(re, (_, k: string) => "args." + aliasMap[k]);
		}
		// Drop body-local declaration keywords and TS type annotations on locals,
		// then collapse all whitespace so the comparison is formatting-insensitive.
		body = body.replace(/\b(?:const|let|var)\s+/g, "");
		return body.replace(/\s+/g, "");
	}

	test("fixture shouldReloadOnResume core logic matches the source", () => {
		const sourceBody = extractFnBody(fs.readFileSync(SOURCE, "utf8"));
		const fixtureBody = extractFnBody(fs.readFileSync(FIXTURE_FILE, "utf8"));
		const canonSource = canonicalize(sourceBody);
		const canonFixture = canonicalize(fixtureBody);
		// Sanity: canonicalization must produce non-trivial output (guards against
		// a silently-empty extraction passing the equality check).
		expect(canonSource.length).toBeGreaterThan(40);
		expect(canonFixture).toBe(canonSource);
	});
});
