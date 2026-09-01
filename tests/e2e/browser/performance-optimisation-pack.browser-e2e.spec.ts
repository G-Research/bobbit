import { test, expect } from "../../../tests2/browser/gateway-harness.js";
import { apiFetch, deleteSession } from "../../../tests2/browser/e2e-setup.js";
import { createSessionViaUI, openApp } from "../../../tests2/browser/e2e/ui-helpers.js";

test.describe.configure({ mode: "serial" });

const PACK = "performance-optimisation";
const PANEL = '[data-testid="performance-optimisation-panel"]';

async function setEnabled(enabled: boolean): Promise<void> {
	await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({
			scope: "server",
			packName: PACK,
			disabled: enabled
				? { enabled: true, roles: [], tools: [], skills: [], entrypoints: [] }
				: { roles: [], tools: [], skills: [], entrypoints: [] },
		}),
	});
}

test.describe("performance optimisation pack", () => {
	let sessionId: string | undefined;

	test.beforeEach(async () => {
		await setEnabled(true);
	});

	test.afterEach(async () => {
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		sessionId = undefined;
		await setEnabled(false).catch(() => {});
	});

	test("launcher, deep-link fixture, responsive flow, tabs, reload, and cleanup @smoke", async ({ page }) => {
		test.setTimeout(60_000);
		await page.setViewportSize({ width: 1400, height: 900 });
		await openApp(page);
		sessionId = await createSessionViaUI(page);
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.());
		const projectReadResponse = page.waitForResponse((response) => response.url().includes("/api/ext/project/read"));
		await page.evaluate(() => (window as any).__bobbitRunPackLauncher?.("performance-optimisation.open"));

		const panel = page.locator(PANEL);
		await expect(panel).toBeVisible({ timeout: 20_000 });
		expect((await projectReadResponse).ok()).toBe(true);
		await expect(panel.getByRole("tab", { name: "Flow map" })).toBeVisible();
		expect(await panel.locator(".po-shell > :first-child").getAttribute("class")).toContain("po-tabs");
		await expect(panel.getByText(/live project state$/)).toHaveCount(0);

		await page.reload();
		await expect(page.locator(PANEL), "the launcher-opened singleton panel survives reload").toBeVisible({ timeout: 20_000 });
		expect(await page.locator(PANEL).locator(".po-shell > :first-child").getAttribute("class")).toContain("po-tabs");

		// The route is registered by the real pack contribution. `demo=true` is an
		// explicitly labelled visual-development fixture, never the launcher default.
		// A wide viewport still uses the panel container width for responsive layout.
		await page.setViewportSize({ width: 1_800, height: 1_000 });
		await page.goto(`${page.url().split("#")[0]}#/ext/performance-optimisation?tab=flow&demo=true`);
		await expect(panel).toContainText("Development fixture · not live project data", { timeout: 20_000 });
		for (const name of ["Optimisation Scanner", "Coverage", "Ideators", "Hypotheses", "Optimisation Director", "Goal teams", "Benchmarks"]) {
			await expect(panel.getByText(name, { exact: true }).first()).toBeVisible();
		}
		const layout = panel.locator(".po-map-layout");
		await expect(layout).toHaveAttribute("data-layout-engine", "semantic-grid");
		await expect(layout).toHaveAttribute("data-layout-mode", "STORE_COLUMN");
		await expect(panel.locator('.po-edge[data-routing="SEMANTIC_SPLINE"]')).toHaveCount(8);
		await expect(panel.locator('.po-edge[data-terminals="port-aware-curved"]')).toHaveCount(8);
		const edgePaths = panel.locator(".po-edge .po-edge-line");
		await expect(edgePaths).toHaveCount(8);
		const routeNodeCollisions = () => panel.evaluate((root) => {
			const nodes = Array.from(root.querySelectorAll<HTMLElement>(".po-map-node")).map((node) => node.getBoundingClientRect());
			let collisions = 0;
			for (const path of root.querySelectorAll<SVGPathElement>(".po-edge-line")) {
				const matrix = path.getScreenCTM();
				const length = path.getTotalLength();
				if (!matrix || length <= 40) continue;
				for (let offset = 20; offset <= length - 20; offset += 4) {
					const point = path.getPointAtLength(offset).matrixTransform(matrix);
					if (nodes.some((rect) => point.x > rect.left + 2 && point.x < rect.right - 2 && point.y > rect.top + 2 && point.y < rect.bottom - 2)) collisions += 1;
				}
			}
			return collisions;
		});
		const routeSelfOverlaps = () => panel.evaluate((root) => {
			let overlaps = 0;
			for (const path of root.querySelectorAll<SVGPathElement>(".po-edge-line")) {
				const length = path.getTotalLength();
				const points: DOMPoint[] = [];
				for (let offset = 0; offset <= length; offset += 2) points.push(path.getPointAtLength(offset));
				if (points.some((point, index) => points.slice(index + 5).some((other) => Math.hypot(point.x - other.x, point.y - other.y) < 1))) overlaps += 1;
			}
			return overlaps;
		});
		const routePairIntersections = () => panel.evaluate((root) => {
			const paths = Array.from(root.querySelectorAll<SVGPathElement>(".po-edge-line"));
			const samples = paths.map((path) => {
				const points: DOMPoint[] = [];
				for (let offset = 5; offset < path.getTotalLength() - 5; offset += 2) points.push(path.getPointAtLength(offset));
				return points;
			});
			let intersections = 0;
			for (let first = 0; first < samples.length; first += 1) {
				for (let second = first + 1; second < samples.length; second += 1) {
					if (samples[first].some((point) => samples[second].some((other) => Math.hypot(point.x - other.x, point.y - other.y) < 2.9))) intersections += 1;
				}
			}
			return intersections;
		});
		const wideRouteShapes = await edgePaths.evaluateAll((paths) => paths.map((path) => path.getAttribute("d") ?? ""));
		expect(wideRouteShapes.every((route) => /\bL\b/.test(route)), "every route preserves straight architectural segments").toBe(true);
		expect(wideRouteShapes.filter((route) => /\bC\b/.test(route)).length, "only routes that turn receive cubic corner fillets").toBeGreaterThanOrEqual(3);
		await expect(panel.locator('.po-edge[data-obstacle-safe="visibility-channel"]')).toHaveCount(8);
		expect(await routeNodeCollisions(), "visibility-channel routes avoid every non-terminal node").toBe(0);
		expect(await routeSelfOverlaps(), "short terminal gaps never make an arrow double back over itself").toBe(0);
		await expect(panel.locator('.po-edge[data-edge="refresh-coverage"]')).toHaveAttribute("aria-label", /scanner and coverage \(bidirectional\)/);
		await expect(panel.locator('.po-edge[data-edge="refresh-coverage"] .po-edge-line')).toHaveAttribute("marker-start", "url(#po-flow-arrow)");
		await expect(panel.locator('.po-edge[data-edge="seal-coverage"]')).toHaveAttribute("aria-label", /ideators to coverage/);
		await expect(panel.locator('.po-edge[data-edge="select-benchmark"]')).toHaveAttribute("aria-label", /benchmarks and goals \(bidirectional\)/);
		await expect(panel.locator('.po-edge[data-edge="select-benchmark"] .po-edge-line')).toHaveAttribute("marker-start", "url(#po-flow-arrow)");
		await expect(panel.locator("bobbit-host-sprite")).toHaveCount(2);
		await expect(panel.locator('bobbit-host-sprite[aria-label="Optimisation Scanner Bobbit avatar"]')).toBeVisible();
		await expect(panel.locator('bobbit-host-sprite[aria-label="Optimisation Director Bobbit avatar"]')).toBeVisible();
		const statusDotStyles = await panel.locator(".po-map-status").evaluateAll((dots) => dots.map((dot) => {
			const style = getComputedStyle(dot);
			return { width: style.width, height: style.height, padding: style.padding, radius: style.borderRadius };
		}));
		expect(statusDotStyles.every((dot) => dot.width === "9px" && dot.height === "9px" && dot.padding === "0px" && dot.radius === "50%"), "process state is a compact status dot, never an empty pill").toBe(true);
		expect(await panel.locator('.po-edge[data-bend-alignment="port-axis"]').count(), "the router keeps nearly every bend aligned to a terminal axis").toBeGreaterThanOrEqual(6);
		await expect(panel.locator('.po-edge[data-edge="rank-hypothesis"]')).toHaveAttribute("data-from-port-fraction", "0.333");
		await expect(panel.locator('.po-edge[data-edge="record-outcome"]')).toHaveAttribute("data-to-port-fraction", "0.667");
		await panel.locator('.po-edge[data-edge="refresh-coverage"] .po-edge-line').hover();
		const routeTooltip = panel.locator('[data-edge-tip="refresh-coverage"]');
		await expect(routeTooltip).toHaveClass(/is-visible/);
		const tooltipAboveNodes = await routeTooltip.evaluate((tooltip) => {
			const node = tooltip.closest(".po-map-layout")?.querySelector<HTMLElement>(".po-map-node");
			return Number(getComputedStyle(tooltip).zIndex) > Number(getComputedStyle(node!).zIndex);
		});
		expect(tooltipAboveNodes, "route tooltips occupy the highest map layer").toBe(true);
		const widePortSides = await panel.locator(".po-map-node").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-port-sides")));
		expect(widePortSides).toHaveLength(7);
		expect(widePortSides.every((sides) => sides !== null && /^(NORTH|EAST|SOUTH|WEST)( (NORTH|EAST|SOUTH|WEST))*$/.test(sides))).toBe(true);
		expect(new Set(widePortSides).size, "ports reflect each route rather than one global direction").toBeGreaterThan(1);
		const panelGridColumns = await layout.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean));
		expect(panelGridColumns, "the constrained production panel uses paired operational/store columns").toHaveLength(2);
		const stores = panel.locator(".po-map-node.is-store");
		await expect(stores.locator(".po-cylinder-cap")).toHaveCount(3);
		const storePresentation = await stores.evaluateAll((nodes) => nodes.map((node) => {
			const cap = node.querySelector<SVGEllipseElement>(".po-cylinder-cap")!.getBoundingClientRect();
			const head = node.querySelector<HTMLElement>(".po-map-node-head")!.getBoundingClientRect();
			return { shadow: getComputedStyle(node).boxShadow, capGap: head.top - cap.bottom };
		}));
		expect(storePresentation.every(({ shadow, capGap }) => shadow === "none" && capGap >= 6), "stores have no square shadow and content clears the top ellipse").toBe(true);
		const storeCenters = await stores.evaluateAll((nodes) => nodes.map((node) => {
			const rect = node.getBoundingClientRect();
			return rect.left + rect.width / 2;
		}));
		expect(Math.max(...storeCenters) - Math.min(...storeCenters), "all stores share the right-column centre").toBeLessThan(1);

		await panel.evaluate((root) => { root.style.width = "1800px"; });
		await expect(layout).toHaveAttribute("data-layout-mode", "STORE_ROW");
		expect(await routePairIntersections(), "wide architectural routes never cross or overlap one another").toBe(0);
		await panel.evaluate((root) => { root.style.removeProperty("width"); });
		await expect(layout).toHaveAttribute("data-layout-mode", "STORE_COLUMN");

		const tabMetrics = await panel.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => {
			const style = getComputedStyle(tab);
			const iconStyle = getComputedStyle(tab.querySelector("svg")!);
			return { width: tab.getBoundingClientRect().width, fontSize: style.fontSize, padding: style.padding, radius: style.borderRadius, gap: style.gap, iconSize: iconStyle.width };
		}));
		expect(new Set(tabMetrics.map((metric) => Math.round(metric.width))).size).toBe(1);
		for (const metric of tabMetrics) {
			expect(metric.padding).toBe("4px 6px");
			expect(metric.radius).toBe("4px");
			expect(parseFloat(metric.fontSize)).toBeCloseTo(14, 2);
			expect(parseFloat(metric.gap)).toBeCloseTo(3.5, 2);
			expect(parseFloat(metric.iconSize)).toBeCloseTo(14, 2);
		}

		await panel.getByRole("tab", { name: "Scan coverage" }).click();
		await expect(panel.getByRole("searchbox", { name: "Filter scan coverage" })).toBeVisible();
		await panel.getByRole("tab", { name: "Hypothesis registry" }).click();
		await expect(panel.getByRole("searchbox", { name: "Search hypothesis registry" })).toBeVisible();
		await panel.getByRole("tab", { name: "Benchmark store" }).click();
		await expect(panel.getByRole("searchbox", { name: "Search benchmark store" })).toBeVisible();

		await page.setViewportSize({ width: 500, height: 900 });
		await panel.getByRole("tab", { name: "Flow map" }).click();
		await expect(layout).toHaveAttribute("data-layout-engine", "semantic-grid");
		await expect(layout).toHaveAttribute("data-layout-mode", "SINGLE_COLUMN");
		await expect(panel.locator('.po-edge[data-routing="SEMANTIC_SPLINE"][data-terminals="port-aware-curved"]')).toHaveCount(8);
		const narrowRouteShapes = await edgePaths.evaluateAll((paths) => paths.map((path) => path.getAttribute("d") ?? ""));
		expect(narrowRouteShapes.every((route) => /\bL\b/.test(route))).toBe(true);
		expect(narrowRouteShapes.filter((route) => /\bC\b/.test(route)).length).toBeGreaterThanOrEqual(2);
		expect(await routeNodeCollisions(), "narrow feedback gutters remain obstacle-safe").toBe(0);
		expect(await routeSelfOverlaps(), "narrow bidirectional arrows never overlap themselves").toBe(0);
		const narrowGridColumns = await layout.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean));
		expect(narrowGridColumns, "flow becomes a single-column sequence below 520px").toHaveLength(1);
		const narrowNodeOrder = await panel.locator(".po-map-node").evaluateAll((nodes) => nodes
			.map((node) => ({ id: node.getAttribute("data-flow-node"), top: node.getBoundingClientRect().top }))
			.sort((a, b) => a.top - b.top)
			.map(({ id }) => id));
		expect(narrowNodeOrder).toEqual(["scanner", "coverage", "ideators", "hypotheses", "director", "goals", "benchmarks"]);
		const overlaps = await panel.locator(".po-map-node").evaluateAll((nodes) => {
			const rects = nodes.map((node) => node.getBoundingClientRect());
			return rects.flatMap((a, i) => rects.slice(i + 1).filter((b) =>
				Math.max(a.left, b.left) < Math.min(a.right, b.right)
				&& Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom),
			).map(() => i));
		});
		expect(overlaps, "semantic responsive flow cards must not overlap").toEqual([]);
		await expect(page.locator(PANEL).getByText("Live activity", { exact: true })).toBeVisible();
	});
});
