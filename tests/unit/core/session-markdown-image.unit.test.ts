import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	MAX_SESSION_MARKDOWN_IMAGE_BYTES,
	SessionMarkdownImageError,
	localMarkdownImagePath,
	readSessionMarkdownImage,
} from "../../../src/server/agent/session-markdown-image.js";

const roots: string[] = [];
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-markdown-image-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("session Markdown images", () => {
	it("reads relative, absolute, and file-URL images beneath the session cwd", async () => {
		const cwd = tempRoot();
		const imagePath = path.join(cwd, ".bobbit-qa", "screenshots", "shot.png");
		fs.mkdirSync(path.dirname(imagePath), { recursive: true });
		fs.writeFileSync(imagePath, PNG);

		for (const requested of [
			path.join(".bobbit-qa", "screenshots", "shot.png"),
			imagePath,
			pathToFileURL(imagePath).href,
		]) {
			const image = await readSessionMarkdownImage({ cwd }, requested, null);
			expect(image.mimeType).toBe("image/png");
			expect(image.data).toEqual(PNG);
		}
	});

	it("rejects traversal and symlink escapes from the session cwd", async () => {
		const cwd = tempRoot();
		const outside = tempRoot();
		const outsideImage = path.join(outside, "secret.png");
		fs.writeFileSync(outsideImage, PNG);

		await expect(readSessionMarkdownImage({ cwd }, outsideImage, null))
			.rejects.toMatchObject({ code: "forbidden" });

		const link = path.join(cwd, "linked.png");
		try {
			fs.symlinkSync(outsideImage, link, "file");
			await expect(readSessionMarkdownImage({ cwd }, "linked.png", null))
				.rejects.toMatchObject({ code: "forbidden" });
		} catch (error) {
			// Symlink creation can be unavailable on locked-down Windows runners.
			if (!(error instanceof Error) || !("code" in error) || !["EPERM", "EACCES", "ENOTSUP"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
		}

		const reboundRoot = path.join(path.dirname(cwd), `rebound-${path.basename(cwd)}`);
		try {
			fs.symlinkSync(outside, reboundRoot, "junction");
			roots.push(reboundRoot);
			await expect(readSessionMarkdownImage({ cwd: reboundRoot }, outsideImage, null))
				.rejects.toMatchObject({ code: "forbidden" });
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || !["EPERM", "EACCES", "ENOTSUP"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
		}
	});

	it("rejects unsupported formats, oversized files, malformed URLs, and remote schemes", async () => {
		const cwd = tempRoot();
		fs.writeFileSync(path.join(cwd, "image.svg"), "<svg/>");
		fs.writeFileSync(path.join(cwd, "large.png"), Buffer.alloc(MAX_SESSION_MARKDOWN_IMAGE_BYTES + 1));

		await expect(readSessionMarkdownImage({ cwd }, "image.svg", null))
			.rejects.toMatchObject({ code: "invalid" });
		await expect(readSessionMarkdownImage({ cwd }, "large.png", null))
			.rejects.toMatchObject({ code: "too_large" });
		expect(() => localMarkdownImagePath("https://example.com/image.png"))
			.toThrowError(SessionMarkdownImageError);
		expect(() => localMarkdownImagePath("file://remote-host/image.png"))
			.toThrowError(SessionMarkdownImageError);
	});

	it("uses the sandbox realm and validates the returned byte count", async () => {
		const calls: string[][] = [];
		const sandbox = {
			exec: async (args: string[]) => {
				calls.push(args);
				return JSON.stringify({ data: PNG.toString("base64"), extension: ".png", size: PNG.length });
			},
		};
		const manager = { get: (projectId: string) => projectId === "project-1" ? sandbox : undefined } as any;
		const image = await readSessionMarkdownImage(
			{ cwd: "/workspace-wt/session/example", sandboxed: true, projectId: "project-1" },
			"screenshots/shot.png",
			manager,
		);
		expect(image.data).toEqual(PNG);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("/workspace-wt/session/example/screenshots/shot.png");

		await expect(readSessionMarkdownImage(
			{ cwd: "/workspace-wt/session/example", sandboxed: true, projectId: "project-1" },
			"../outside.png",
			manager,
		)).rejects.toMatchObject({ code: "forbidden" });
		expect(calls).toHaveLength(1);
	});
});
