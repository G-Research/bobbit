import { beforeAll, describe, expect, it } from "vitest";
import { render } from "lit";
import { syncCustomElements } from "../../tests/support/helpers/dom/setup/custom-elements.js";
import { WriteRenderer } from "../../src/ui/tools/renderers/WriteRenderer.js";

beforeAll(() => syncCustomElements());

const TRUNCATED_WRITE = {
	_truncated: true as const,
	_originalLength: 2 * 1024 * 1024,
	preview: "<svg><text>bounded preview</text></svg>",
};

describe("large streamed write rendering", () => {
	it.each(["large-output.html", "large-output.svg"])(
		"renders the truncated descriptor for %s without treating it as a source string",
		(path) => {
			const container = document.createElement("div");
			document.body.appendChild(container);
			expect(() => {
				const output = new WriteRenderer().render(
					{ path, content: TRUNCATED_WRITE },
					undefined,
					true,
				);
				render(output.content, container);
			}).not.toThrow();
			expect(container.textContent).toContain("Truncated");
			expect(container.textContent).toContain("2.0 MB");
		},
	);
});
