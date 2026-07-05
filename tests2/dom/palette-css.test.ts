import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/palette-css.spec.ts (v2-dom tier).
// The legacy Playwright fixture asserted CSS-custom-property cascade + var()
// resolution via getComputedStyle over a <style> block of palette overrides.
// happy-dom's computed-style engine resolves stylesheet custom properties
// (including [data-palette] / .dark attribute+class cascade) AND var() in
// backgroundColor, so the SAME facts port directly (verified empirically).
// The <style> is the byte-for-byte palette CSS from the legacy fixture.
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const PALETTE_CSS = `
:root {
  --background: oklch(0.935 0.012 148);
  --foreground: oklch(0.18 0.014 142);
  --primary: oklch(0.38 0.08 148);
  --primary-foreground: oklch(0.96 0.008 146);
  --sidebar: oklch(0.915 0.014 148);
  --notif-system-bg: rgba(100, 120, 160, 0.12);
  --notif-system-border: rgba(100, 120, 160, 0.30);
  --notif-system-text: rgba(130, 150, 190, 0.90);
  --notif-task-bg: rgba(185, 145, 45, 0.12);
  --user-msg-accent: rgba(80, 140, 80, 1);
  --user-msg-bg: rgba(80, 140, 80, 0.10);
}
.dark {
  --background: oklch(0.21 0.008 145);
  --foreground: oklch(0.96 0.008 140);
  --primary: oklch(0.72 0.12 140);
  --primary-foreground: oklch(0.18 0.01 145);
  --sidebar: oklch(0.23 0.01 145);
}
[data-palette="ocean"] {
  --background: oklch(0.935 0.012 230);
  --primary: oklch(0.38 0.08 230);
  --sidebar: oklch(0.915 0.014 230);
  --notif-system-bg: rgba(60, 120, 190, 0.12);
  --notif-system-border: rgba(60, 120, 190, 0.30);
  --notif-system-text: rgba(90, 150, 210, 0.90);
  --notif-task-bg: rgba(224, 120, 80, 0.12);
  --user-msg-accent: rgba(50, 120, 190, 1);
  --user-msg-bg: rgba(50, 120, 190, 0.10);
}
.dark[data-palette="ocean"], [data-palette="ocean"].dark {
  --background: oklch(0.21 0.008 230);
  --primary: oklch(0.72 0.12 230);
  --sidebar: oklch(0.23 0.01 230);
}
[data-palette="dusk"] {
  --background: oklch(0.935 0.012 300);
  --primary: oklch(0.38 0.08 300);
  --sidebar: oklch(0.915 0.014 300);
  --notif-system-bg: rgba(90, 90, 175, 0.12);
  --notif-system-border: rgba(90, 90, 175, 0.30);
  --notif-system-text: rgba(120, 120, 200, 0.90);
  --notif-task-bg: rgba(212, 160, 23, 0.12);
  --user-msg-accent: rgba(160, 90, 180, 1);
  --user-msg-bg: rgba(160, 90, 180, 0.10);
}
.dark[data-palette="dusk"], [data-palette="dusk"].dark {
  --background: oklch(0.21 0.008 300);
  --primary: oklch(0.72 0.12 300);
  --sidebar: oklch(0.23 0.01 300);
}
[data-palette="ember"] {
  --background: oklch(0.935 0.012 65);
  --primary: oklch(0.38 0.08 65);
  --sidebar: oklch(0.915 0.014 65);
  --notif-system-bg: rgba(100, 120, 160, 0.12);
  --notif-task-bg: rgba(200, 150, 40, 0.12);
  --user-msg-accent: rgba(190, 140, 40, 1);
  --user-msg-bg: rgba(190, 140, 40, 0.10);
}
.dark[data-palette="ember"], [data-palette="ember"].dark {
  --background: oklch(0.21 0.008 65);
  --primary: oklch(0.72 0.12 65);
}
[data-palette="rose"] {
  --background: oklch(0.935 0.012 10);
  --primary: oklch(0.38 0.08 10);
  --sidebar: oklch(0.915 0.014 10);
  --user-msg-accent: rgba(190, 80, 90, 1);
  --user-msg-bg: rgba(190, 80, 90, 0.10);
}
.dark[data-palette="rose"], [data-palette="rose"].dark {
  --background: oklch(0.21 0.008 10);
  --primary: oklch(0.72 0.12 10);
}
[data-palette="slate"] {
  --background: oklch(0.935 0.008 260);
  --primary: oklch(0.38 0.04 260);
  --sidebar: oklch(0.915 0.010 260);
  --user-msg-accent: rgba(110, 110, 160, 1);
  --user-msg-bg: rgba(110, 110, 160, 0.10);
}
.dark[data-palette="slate"], [data-palette="slate"].dark {
  --background: oklch(0.21 0.006 260);
  --primary: oklch(0.72 0.06 260);
}
[data-palette="sand"] {
  --background: oklch(0.935 0.012 85);
  --primary: oklch(0.38 0.08 85);
  --sidebar: oklch(0.915 0.014 85);
  --user-msg-accent: rgba(140, 130, 50, 1);
  --user-msg-bg: rgba(140, 130, 50, 0.10);
}
.dark[data-palette="sand"], [data-palette="sand"].dark {
  --background: oklch(0.21 0.008 85);
  --primary: oklch(0.72 0.12 85);
}
[data-palette="teal"] {
  --background: oklch(0.935 0.012 195);
  --primary: oklch(0.38 0.08 195);
  --sidebar: oklch(0.915 0.014 195);
  --user-msg-accent: rgba(40, 145, 160, 1);
  --user-msg-bg: rgba(40, 145, 160, 0.10);
}
.dark[data-palette="teal"], [data-palette="teal"].dark {
  --background: oklch(0.21 0.008 195);
  --primary: oklch(0.72 0.12 195);
}
[data-palette="copper"] {
  --background: oklch(0.935 0.012 50);
  --primary: oklch(0.38 0.08 50);
  --sidebar: oklch(0.915 0.014 50);
  --user-msg-accent: rgba(180, 120, 50, 1);
  --user-msg-bg: rgba(180, 120, 50, 0.10);
}
.dark[data-palette="copper"], [data-palette="copper"].dark {
  --background: oklch(0.21 0.008 50);
  --primary: oklch(0.72 0.12 50);
}
[data-palette="mono"] {
  --background: oklch(0.935 0 0);
  --primary: oklch(0.38 0 0);
  --sidebar: oklch(0.915 0 0);
  --notif-system-bg: rgba(107, 114, 128, 0.12);
  --notif-system-border: rgba(107, 114, 128, 0.30);
  --notif-system-text: rgba(140, 147, 161, 0.90);
  --notif-task-bg: rgba(209, 213, 219, 0.12);
  --user-msg-accent: rgba(156, 163, 175, 1);
  --user-msg-bg: rgba(156, 163, 175, 0.10);
}
.dark[data-palette="mono"], [data-palette="mono"].dark {
  --background: oklch(0.21 0 0);
  --primary: oklch(0.72 0 0);
  --sidebar: oklch(0.23 0 0);
}
.test-box {
  width: 100px;
  height: 20px;
  background: var(--notif-system-bg);
  border: 1px solid var(--notif-system-border);
  color: var(--notif-system-text);
}
.user-box {
  width: 100px;
  height: 20px;
  background: var(--user-msg-bg);
  color: var(--user-msg-accent);
}
.primary-box {
  width: 100px;
  height: 20px;
  background: var(--primary);
}
.bg-box {
  width: 100px;
  height: 20px;
  background: var(--background);
}
`;

function getCssVar(varName: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function setPalette(id: string | null, dark = false): void {
	if (id) document.documentElement.dataset.palette = id;
	else delete document.documentElement.dataset.palette;
	if (dark) document.documentElement.classList.add("dark");
	else document.documentElement.classList.remove("dark");
}

beforeAll(() => {
	const style = document.createElement("style");
	style.textContent = PALETTE_CSS;
	document.head.appendChild(style);
	document.body.innerHTML = `
		<div class="test-box" id="system-box">System</div>
		<div class="user-box" id="user-box">User</div>
		<div class="primary-box" id="primary-box"></div>
		<div class="bg-box" id="bg-box"></div>
	`;
});

afterEach(() => { setPalette(null, false); });

describe("palette CSS custom properties", () => {
	it("default (forest) palette values are applied", () => {
		const val = getCssVar("--notif-system-bg");
		expect(val).toContain("100");
		expect(val).toContain("120");
		expect(val).toContain("160");
	});

	it("default (forest) theme vars are applied", () => {
		const primary = getCssVar("--primary");
		expect(primary).toContain("oklch");
		expect(primary).toContain("148");
	});

	it("ocean palette overrides theme and notification vars", () => {
		setPalette("ocean");
		const notif = getCssVar("--notif-system-bg");
		expect(notif).toContain("60");
		expect(notif).toContain("120");
		expect(notif).toContain("190");
		const primary = getCssVar("--primary");
		expect(primary).toContain("230");
	});

	it("dusk palette overrides theme and notification vars", () => {
		setPalette("dusk");
		expect(getCssVar("--primary")).toContain("300");
		const accent = getCssVar("--user-msg-accent");
		expect(accent).toContain("160");
		expect(accent).toContain("90");
		expect(accent).toContain("180");
	});

	it("ember palette overrides theme vars", () => {
		setPalette("ember");
		expect(getCssVar("--primary")).toContain("65");
		const accent = getCssVar("--user-msg-accent");
		expect(accent).toContain("190");
		expect(accent).toContain("140");
	});

	it("rose palette overrides theme vars", () => {
		setPalette("rose");
		const primary = getCssVar("--primary");
		expect(primary).toContain("0.38");
		expect(primary).toContain("10");
		const accent = getCssVar("--user-msg-accent");
		expect(accent).toContain("190");
		expect(accent).toContain("80");
		expect(accent).toContain("90");
	});

	it("slate palette uses low chroma", () => {
		setPalette("slate");
		const primary = getCssVar("--primary");
		expect(primary).toContain("0.04");
		expect(primary).toContain("260");
	});

	it("sand palette overrides theme vars", () => {
		setPalette("sand");
		expect(getCssVar("--primary")).toContain("85");
	});

	it("teal palette overrides theme vars", () => {
		setPalette("teal");
		expect(getCssVar("--primary")).toContain("195");
	});

	it("copper palette overrides theme vars", () => {
		setPalette("copper");
		expect(getCssVar("--primary")).toContain("50");
		const accent = getCssVar("--user-msg-accent");
		expect(accent).toContain("180");
		expect(accent).toContain("120");
	});

	it("mono palette overrides custom properties", () => {
		setPalette("mono");
		const accent = getCssVar("--user-msg-accent");
		expect(accent).toContain("156");
		expect(accent).toContain("163");
		expect(accent).toContain("175");
		const primary = getCssVar("--primary");
		expect(primary).toContain("oklch");
		expect(primary).toContain("0.38");
	});

	it("removing palette resets to forest defaults", () => {
		setPalette("ocean");
		let val = getCssVar("--user-msg-accent");
		expect(val).toContain("50");
		expect(val).toContain("120");
		expect(val).toContain("190");
		setPalette(null);
		val = getCssVar("--user-msg-accent");
		expect(val).toContain("80");
		expect(val).toContain("140");
		expect(val).toContain("80");
	});

	it("computed styles on elements change with palette", () => {
		let bg = getComputedStyle(document.getElementById("system-box")!).backgroundColor;
		expect(bg).toContain("100");

		setPalette("ocean");
		bg = getComputedStyle(document.getElementById("system-box")!).backgroundColor;
		expect(bg).toContain("60");
	});

	it("dark mode overrides work for ocean palette", () => {
		setPalette("ocean", true);
		const primary = getCssVar("--primary");
		expect(primary).toContain("0.72");
		expect(primary).toContain("230");
		const bg = getCssVar("--background");
		expect(bg).toContain("0.21");
	});

	it("dark mode overrides work for mono palette", () => {
		setPalette("mono", true);
		expect(getCssVar("--primary")).toContain("0.72");
		expect(getCssVar("--background")).toContain("0.21");
	});
});
