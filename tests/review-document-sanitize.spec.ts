import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/fixtures/review-document-sanitize-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "review-document-sanitize-bundle.js");
const REVIEW_DOCUMENT_SRC = path.resolve("src/ui/components/review/ReviewDocument.ts");
const ANNOTATION_STORE_SRC = path.resolve("src/ui/components/review/AnnotationStore.ts");

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__reviewDocumentSanitizeReady === true, null, { timeout: 10_000 });
}

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, REVIEW_DOCUMENT_SRC, ANNOTATION_STORE_SRC],
	});
});

test.describe("review document markdown sanitization", () => {
	test("escapes raw HTML gadgets before markdown reaches innerHTML", async ({ page }) => {
		await loadFixture(page);
		const result = await page.evaluate(() => {
			const markdown = `# Safe heading

[Safe link](https://example.test/path)

<iframe srcdoc="<script>parent.__xss = true</script>"></iframe>
<script>window.__xss = true</script>
<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">
<svg><script>window.__xss = true</script></svg><math><mtext>x</mtext></math>
<template><img src=x onerror="window.__xss = true"></template><style>body{display:none}</style><link rel="stylesheet" href="javascript:alert(1)"><meta http-equiv="refresh" content="0;javascript:alert(1)"><base href="https://evil.test/">
<form action="javascript:alert(1)"><input autofocus onfocus="window.__xss = true"><button>Go</button><textarea>bad</textarea><select><option>bad</option></select></form>

\`<iframe srcdoc="still code"></iframe>\``;
			const html = (window as any).__renderReviewMarkdownToHtml(markdown) as string;
			const container = document.createElement("div");
			container.innerHTML = html;
			return {
				html,
				text: container.textContent || "",
				dangerousCount: container.querySelectorAll("iframe,script,object,embed,svg,math,template,style,link,meta,base,form,input,button,textarea,select,option").length,
				eventAttrCount: container.querySelectorAll("[onclick],[onerror],[onfocus],[srcdoc]").length,
				anchorTarget: container.querySelector("a")?.getAttribute("target") || "",
				anchorRel: container.querySelector("a")?.getAttribute("rel") || "",
			};
		});

		expect(result.dangerousCount).toBe(0);
		expect(result.eventAttrCount).toBe(0);
		expect(result.text).toContain("Safe heading");
		expect(result.text).toContain("<iframe srcdoc=");
		expect(result.anchorTarget).toBe("_blank");
		expect(result.anchorRel).toBe("noopener noreferrer");
		expect(result.html).not.toContain("<iframe");
		expect(result.html).not.toContain("<script");
	});

	test("strips dangerous generated markdown URL attributes while preserving safe links", async ({ page }) => {
		await loadFixture(page);
		const result = await page.evaluate(() => {
			const markdown = `[safe](https://example.test) [bad](javascript:alert(1)) ![bad image](javascript:alert(1)) ![safe data](data:image/png;base64,AAAA)`;
			const html = (window as any).__renderReviewMarkdownToHtml(markdown) as string;
			const container = document.createElement("div");
			container.innerHTML = html;
			const links = Array.from(container.querySelectorAll("a")).map((a) => ({
				text: a.textContent,
				href: a.getAttribute("href"),
				target: a.getAttribute("target"),
				rel: a.getAttribute("rel"),
			}));
			const images = Array.from(container.querySelectorAll("img")).map((img) => ({
				alt: img.getAttribute("alt"),
				src: img.getAttribute("src"),
			}));
			return { links, images };
		});

		expect(result.links).toContainEqual({
			text: "safe",
			href: "https://example.test",
			target: "_blank",
			rel: "noopener noreferrer",
		});
		expect(result.links.find((link) => link.text === "bad")?.href).toBeNull();
		expect(result.images.find((image) => image.alt === "bad image")?.src).toBeNull();
		expect(result.images.find((image) => image.alt === "safe data")?.src).toMatch(/^data:image\/png;base64,AAAA/i);
	});

	test("defense-in-depth sanitizer removes forbidden tags and attributes from parsed HTML", async ({ page }) => {
		await loadFixture(page);
		const result = await page.evaluate(() => {
			const html = (window as any).__sanitizeReviewMarkdownHtml(`<p onclick="alert(1)"><a href="javascript:alert(1)" style="color:red">bad</a><iframe srcdoc="<script>alert(1)</script>"></iframe><object data="https://example.test/x"></object><svg><a xlink:href="javascript:alert(1)">x</a></svg><img src="https://example.test/safe.png" srcset="https://example.test/a.png 1x, javascript:alert(1) 2x"></p>`) as string;
			const container = document.createElement("div");
			container.innerHTML = html;
			return {
				html,
				dangerousCount: container.querySelectorAll("iframe,object,svg").length,
				paragraphOnclick: container.querySelector("p")?.getAttribute("onclick") ?? null,
				linkHref: container.querySelector("a")?.getAttribute("href") ?? null,
				linkStyle: container.querySelector("a")?.getAttribute("style") ?? null,
				imageSrc: container.querySelector("img")?.getAttribute("src") ?? null,
				imageSrcset: container.querySelector("img")?.getAttribute("srcset") ?? null,
			};
		});

		expect(result.dangerousCount).toBe(0);
		expect(result.paragraphOnclick).toBeNull();
		expect(result.linkHref).toBeNull();
		expect(result.linkStyle).toBeNull();
		expect(result.imageSrc).toBe("https://example.test/safe.png");
		expect(result.imageSrcset).toBeNull();
	});
});
