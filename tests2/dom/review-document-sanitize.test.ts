import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/review-document-sanitize.spec.ts (v2-dom tier).
// The legacy esbuild file:// fixture exposed the real ReviewDocument sanitizer
// helpers on window; this port imports them directly and runs the SAME DOM
// assertions under happy-dom (template.innerHTML / querySelectorAll).
import { afterEach, describe, expect, it } from "vitest";
import {
	renderReviewMarkdownToHtml,
	sanitizeReviewMarkdownHtml,
} from "../../src/ui/components/review/ReviewDocument.js";

afterEach(() => { document.body.innerHTML = ""; });

describe("review document markdown sanitization", () => {
	it("escapes raw HTML gadgets before markdown reaches innerHTML", () => {
		const markdown = `# Safe heading

[Safe link](https://example.test/path)

<iframe srcdoc="<script>parent.__xss = true</script>"></iframe>
<script>window.__xss = true</script>
<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">
<svg><script>window.__xss = true</script></svg><math><mtext>x</mtext></math>
<template><img src=x onerror="window.__xss = true"></template><style>body{display:none}</style><link rel="stylesheet" href="javascript:alert(1)"><meta http-equiv="refresh" content="0;javascript:alert(1)"><base href="https://evil.test/">
<form action="javascript:alert(1)"><input autofocus onfocus="window.__xss = true"><button>Go</button><textarea>bad</textarea><select><option>bad</option></select></form>

\`<iframe srcdoc="still code"></iframe>\``;
		const html = renderReviewMarkdownToHtml(markdown);
		const container = document.createElement("div");
		container.innerHTML = html;
		const result = {
			html,
			text: container.textContent || "",
			dangerousCount: container.querySelectorAll("iframe,script,object,embed,svg,math,template,style,link,meta,base,form,input,button,textarea,select,option").length,
			eventAttrCount: container.querySelectorAll("[onclick],[onerror],[onfocus],[srcdoc]").length,
			anchorTarget: container.querySelector("a")?.getAttribute("target") || "",
			anchorRel: container.querySelector("a")?.getAttribute("rel") || "",
		};

		expect(result.dangerousCount).toBe(0);
		expect(result.eventAttrCount).toBe(0);
		expect(result.text).toContain("Safe heading");
		expect(result.text).toContain("<iframe srcdoc=");
		expect(result.anchorTarget).toBe("_blank");
		expect(result.anchorRel).toBe("noopener noreferrer");
		expect(result.html).not.toContain("<iframe");
		expect(result.html).not.toContain("<script");
	});

	it("strips dangerous generated markdown URL attributes while preserving safe links", () => {
		const markdown = `[safe](https://example.test) [bad](javascript:alert(1)) ![bad image](javascript:alert(1)) ![safe data](data:image/png;base64,AAAA)`;
		const html = renderReviewMarkdownToHtml(markdown);
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

		expect(links).toContainEqual({
			text: "safe",
			href: "https://example.test",
			target: "_blank",
			rel: "noopener noreferrer",
		});
		expect(links.find((link) => link.text === "bad")?.href).toBeNull();
		expect(images.find((image) => image.alt === "bad image")?.src).toBeNull();
		expect(images.find((image) => image.alt === "safe data")?.src).toMatch(/^data:image\/png;base64,AAAA/i);
	});

	it("defense-in-depth sanitizer removes forbidden tags and attributes from parsed HTML", () => {
		const html = sanitizeReviewMarkdownHtml(`<p onclick="alert(1)"><a href="javascript:alert(1)" style="color:red">bad</a><iframe srcdoc="<script>alert(1)</script>"></iframe><object data="https://example.test/x"></object><svg><a xlink:href="javascript:alert(1)">x</a></svg><img src="https://example.test/safe.png" srcset="https://example.test/a.png 1x, javascript:alert(1) 2x"></p>`);
		const container = document.createElement("div");
		container.innerHTML = html;
		const result = {
			html,
			dangerousCount: container.querySelectorAll("iframe,object,svg").length,
			paragraphOnclick: container.querySelector("p")?.getAttribute("onclick") ?? null,
			linkHref: container.querySelector("a")?.getAttribute("href") ?? null,
			linkStyle: container.querySelector("a")?.getAttribute("style") ?? null,
			imageSrc: container.querySelector("img")?.getAttribute("src") ?? null,
			imageSrcset: container.querySelector("img")?.getAttribute("srcset") ?? null,
		};

		expect(result.dangerousCount).toBe(0);
		expect(result.paragraphOnclick).toBeNull();
		expect(result.linkHref).toBeNull();
		expect(result.linkStyle).toBeNull();
		expect(result.imageSrc).toBe("https://example.test/safe.png");
		expect(result.imageSrcset).toBeNull();
	});
});
