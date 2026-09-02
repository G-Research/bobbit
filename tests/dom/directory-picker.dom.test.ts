import { beforeAll as syncBeforeAll } from "vitest";
import { syncCustomElements } from "../../tests/support/helpers/dom/setup/custom-elements.js";
syncBeforeAll(() => syncCustomElements());

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryPicker, BrowseDirectoryFn, DirectoryBrowseResult } from "../../src/ui/components/DirectoryPicker.js";
import "../../src/ui/components/DirectoryPicker.js";

let picker: DirectoryPicker;
let input: HTMLInputElement;

async function settle(): Promise<void> {
	await picker.updateComplete;
	await Promise.resolve();
	await picker.updateComplete;
}

async function type(value: string): Promise<void> {
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	await settle();
}

beforeEach(async () => {
	document.body.innerHTML = "<directory-picker></directory-picker>";
	picker = document.querySelector("directory-picker") as DirectoryPicker;
	picker.debounceMs = 0;
	picker.showBrowseButton = false;
	await settle();
	input = picker.querySelector("input")!;
	input.focus();
	await settle();
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("directory picker", () => {
	it("browses a typed prefix and commits the keyboard-selected suggestion", async () => {
		const browse = vi.fn<BrowseDirectoryFn>().mockResolvedValue({
			current: "/repo",
			parent: "/",
			entries: [
				{ name: "alpha-one", path: "/repo/alpha-one" },
				{ name: "alpha-two", path: "/repo/alpha-two" },
			],
		});
		picker.browseDirectory = browse;
		let selected = "";
		picker.addEventListener("directory-select", (event) => {
			selected = (event as CustomEvent<{ path: string }>).detail.path;
		});

		await type("/repo/alpha");
		await vi.waitFor(() => expect(picker.querySelectorAll("[role='option']")).toHaveLength(2));
		expect(browse).toHaveBeenCalledWith("/repo", { prefix: "alpha", limit: 12 });

		input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();

		expect(selected).toBe("/repo/alpha-two");
		expect(input.value).toBe("/repo/alpha-two");
		expect(document.activeElement).toBe(input);
		expect(picker.querySelector("[role='listbox']")).toBeNull();
	});

	it("treats a trailing separator as an explicit child lookup and preserves Windows drive roots", async () => {
		const browse = vi.fn<BrowseDirectoryFn>().mockResolvedValue({
			current: "C:\\\\",
			parent: null,
			entries: [{ name: "Users", path: "C:\\\\Users" }],
		});
		picker.browseDirectory = browse;

		await type("C:\\Us");
		await vi.waitFor(() => expect(browse).toHaveBeenCalled());
		expect(browse.mock.calls[0]).toEqual(["C:\\", { prefix: "Us", limit: 12 }]);

		browse.mockClear();
		await type("C:\\Users\\");
		await vi.waitFor(() => expect(browse).toHaveBeenCalled());
		expect(browse.mock.calls[0]).toEqual(["C:\\Users", { prefix: undefined, limit: 12 }]);
	});

	it("drops an in-flight lookup after blur", async () => {
		let resolveBrowse!: (value: Awaited<ReturnType<BrowseDirectoryFn>>) => void;
		picker.browseDirectory = vi.fn(() => new Promise<DirectoryBrowseResult>(resolve => { resolveBrowse = resolve; }));

		await type("/repo/alpha");
		input.blur();
		resolveBrowse({
			current: "/repo",
			parent: "/",
			entries: [{ name: "alpha", path: "/repo/alpha" }],
		});
		await settle();

		expect(picker.querySelector("[role='listbox']")).toBeNull();
		expect(picker.querySelector("[data-testid='directory-picker-loading']")).toBeNull();
	});

	it("uses the first Escape for suggestions and the second for dialog cancellation", async () => {
		picker.browseDirectory = vi.fn().mockResolvedValue({
			current: "/repo",
			parent: "/",
			entries: [{ name: "alpha", path: "/repo/alpha" }],
		});
		let cancellations = 0;
		picker.addEventListener("directory-cancel", () => cancellations++);
		await type("/repo/a");
		await vi.waitFor(() => expect(picker.querySelector("[role='listbox']")).not.toBeNull());

		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await settle();
		expect(picker.querySelector("[role='listbox']")).toBeNull();
		expect(cancellations).toBe(0);

		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(cancellations).toBe(1);
	});
});
