/**
 * Mission DAG SVG namespace regression test.
 *
 * Bug: nested templates inside MissionDagSvg.ts used lit's html`` tag, which
 * creates HTML-namespace elements. Even when nested inside <svg>, those
 * `<g>`/`<rect>`/`<text>`/`<path>` elements were HTMLElements, not
 * SVGElements — so they had no rendering box (0×0) and no `getBBox`.
 *
 * Fix: switch nested templates to lit's svg`` tag so the elements live in
 * the SVG namespace.
 *
 * Probe: SVGElement.getBBox() exists; HTMLElement.getBBox does not.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/mission-dag-svg.html");
const BUNDLE = path.resolve("tests/fixtures/mission-dag-svg-bundle.js");
const ENTRY = path.resolve("tests/fixtures/mission-dag-svg-entry.ts");
const COMPONENT_SRC = path.resolve("src/ui/components/MissionDagSvg.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(COMPONENT_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				"--alias:pdfjs-dist=./tests/fixtures/empty-shim",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;

const SAMPLE_PLAN = {
	rationale: "test plan",
	estimatedConcurrency: 2,
	version: 1,
	goals: [
		{ planId: "p1", title: "First node", spec: "", workflowId: "feature" },
		{ planId: "p2", title: "Second node", spec: "", workflowId: "feature" },
		{ planId: "p3", title: "Third node", spec: "", workflowId: "feature" },
	],
	dependencies: [
		{ from: "p1", to: "p2" },
		{ from: "p2", to: "p3" },
	],
};

test.describe("MissionDagSvg namespace", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(PAGE);
		await page.waitForFunction(() => (window as any).__ready === true, null, {
			timeout: 10_000,
		});
	});

	test("rect element is in SVG namespace and has correct bbox", async ({ page }) => {
		const result = await page.evaluate((plan) => {
			const container = document.getElementById("container")!;
			(window as any).__renderDag(plan, container);
			const rect = container.querySelector(".mission-dag-node rect") as SVGRectElement | null;
			if (!rect) return { found: false };
			const hasBBox = typeof rect.getBBox === "function";
			let bbox: { width: number; height: number } | null = null;
			if (hasBBox) {
				const b = rect.getBBox();
				bbox = { width: b.width, height: b.height };
			}
			return {
				found: true,
				hasBBox,
				namespace: rect.namespaceURI,
				isSVGElement: rect instanceof SVGElement,
				bbox,
				width: rect.getAttribute("width"),
				height: rect.getAttribute("height"),
			};
		}, SAMPLE_PLAN);

		expect(result.found).toBe(true);
		expect(result.namespace).toBe("http://www.w3.org/2000/svg");
		expect(result.isSVGElement).toBe(true);
		expect(result.hasBBox).toBe(true);
		expect(result.bbox?.width).toBe(160);
		expect(result.bbox?.height).toBe(56);
		expect(result.width).toBe("160");
		expect(result.height).toBe("56");
	});

	test("group, text, and path elements are all in SVG namespace", async ({ page }) => {
		const result = await page.evaluate((plan) => {
			const container = document.getElementById("container")!;
			(window as any).__renderDag(plan, container);
			const svgNS = "http://www.w3.org/2000/svg";
			const g = container.querySelector(".mission-dag-node");
			const text = container.querySelector(".mission-dag-node text");
			const path = container.querySelector("svg path");
			return {
				gNS: g?.namespaceURI,
				textNS: text?.namespaceURI,
				pathNS: path?.namespaceURI,
				gIsSVG: g instanceof SVGElement,
				textIsSVG: text instanceof SVGElement,
				pathIsSVG: path instanceof SVGElement,
				expectedNS: svgNS,
			};
		}, SAMPLE_PLAN);

		expect(result.gNS).toBe(result.expectedNS);
		expect(result.textNS).toBe(result.expectedNS);
		expect(result.pathNS).toBe(result.expectedNS);
		expect(result.gIsSVG).toBe(true);
		expect(result.textIsSVG).toBe(true);
		expect(result.pathIsSVG).toBe(true);
	});

	test("all node rects have nonzero rendering boxes", async ({ page }) => {
		const sizes = await page.evaluate((plan) => {
			const container = document.getElementById("container")!;
			(window as any).__renderDag(plan, container);
			const rects = Array.from(
				container.querySelectorAll(".mission-dag-node rect"),
			) as SVGRectElement[];
			return rects.map((r) => {
				const b = r.getBBox();
				return { w: b.width, h: b.height };
			});
		}, SAMPLE_PLAN);

		expect(sizes.length).toBe(3);
		for (const size of sizes) {
			expect(size.w).toBeGreaterThan(0);
			expect(size.h).toBeGreaterThan(0);
		}
	});

	test("empty plan renders the empty placeholder, not an SVG", async ({ page }) => {
		const result = await page.evaluate(() => {
			const container = document.getElementById("container")!;
			(window as any).__renderDag(null, container);
			const empty = container.querySelector('[data-testid="mission-dag-empty"]');
			const svg = container.querySelector('[data-testid="mission-dag-svg"]');
			return {
				hasEmpty: !!empty,
				hasSvg: !!svg,
			};
		});
		expect(result.hasEmpty).toBe(true);
		expect(result.hasSvg).toBe(false);
	});
});
