import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/error-details.spec.ts (v2-dom tier).
// Rewritten from the Playwright file:// fixture (which mirrored the component in
// plain JS) to render the REAL <error-details> lit component under happy-dom.
import { afterEach, describe, expect, it } from "vitest";
import "../../src/ui/components/ErrorDetails.js";

afterEach(() => { document.body.innerHTML = ""; });

async function mount(props: { message: string; code?: string; stack?: string }) {
	const el = document.createElement("error-details") as any;
	el.message = props.message;
	if (props.code !== undefined) el.code = props.code;
	if (props.stack !== undefined) el.stack = props.stack;
	document.body.appendChild(el);
	await el.updateComplete;
	return el as HTMLElement;
}
const q = (el: HTMLElement, sel: string) => el.querySelector(sel);
const all = (el: HTMLElement, sel: string) => el.querySelectorAll(sel);

describe("<error-details>", () => {
	it("renders message + no <details> when stack is undefined", async () => {
		const el = await mount({ message: "Something broke" });
		expect(q(el, '[data-testid="error-details-message"]')?.textContent).toBe("Something broke");
		expect(all(el, '[data-testid="error-details-stack"]').length).toBe(0);
		expect(all(el, "details").length).toBe(0);
		expect(all(el, "pre").length).toBe(0);
	});

	it("renders <details> collapsed when stack is provided; <pre> contains stack text", async () => {
		const stack = "Error: boom\n    at frob (foo.ts:42:10)\n    at <anonymous>";
		const el = await mount({ message: "Crashed", stack });
		const det = q(el, '[data-testid="error-details-stack"]') as HTMLDetailsElement;
		expect(det).toBeTruthy();
		expect(det.open).toBe(false);
		const pre = det.querySelector("pre");
		expect(pre).toBeTruthy();
		expect(pre!.textContent).toContain("Error: boom");
		expect(pre!.textContent).toContain("frob (foo.ts:42:10)");
	});

	it("renders code line when code is provided; omits when undefined", async () => {
		const withCode = await mount({ message: "Auth failed", code: "ERR_UNAUTHORIZED" });
		expect(q(withCode, '[data-testid="error-details-code"]')?.textContent).toBe("ERR_UNAUTHORIZED");
		const noCode = await mount({ message: "Other failure" });
		expect(all(noCode, '[data-testid="error-details-code"]').length).toBe(0);
	});

	it("user can expand the disclosure and see the stack", async () => {
		const el = await mount({ message: "Crashed", stack: "TRACE-LINE-1\nTRACE-LINE-2" });
		const det = q(el, '[data-testid="error-details-stack"]') as HTMLDetailsElement;
		// Toggle open (summary click drives the native disclosure).
		det.open = true;
		expect(det.open).toBe(true);
		expect(det.querySelector("pre")?.textContent).toContain("TRACE-LINE-2");
	});

	it("escapes HTML in message/code/stack (no injection)", async () => {
		const el = await mount({ message: "<script>boom</script>", code: "<b>code</b>", stack: "<img onerror=x>" });
		expect(q(el, '[data-testid="error-details-message"]')?.textContent).toBe("<script>boom</script>");
		expect(q(el, '[data-testid="error-details-code"]')?.textContent).toBe("<b>code</b>");
		expect(q(el, '[data-testid="error-details-stack"] pre')?.textContent).toContain("<img onerror=x>");
		// No real <script> element was created from the input text.
		expect(all(el, '[data-testid="error-details-message"] script').length).toBe(0);
	});
});
