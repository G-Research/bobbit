import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, it } from "vitest";

import {
	COOKIE_NAME,
	CookieStore,
	extractCookieValue,
	issueCookie,
	issueIfMissing,
	tryAuth,
} from "../../src/server/auth/cookie.ts";
import {
	classifyBrowserCookieEligibility,
	type BrowserCookieEligibilityContext,
	type BrowserCookieRequestMetadata,
} from "../../src/server/auth/browser-cookie.ts";

function fakeRequest(cookie?: string): any {
	return { headers: cookie ? { cookie } : {} };
}

function fakeResponse() {
	const headers: Record<string, string | string[]> = {};
	return {
		headers,
		getHeader(name: string) { return headers[name]; },
		setHeader(name: string, value: string | string[]) { headers[name] = value; },
	};
}

function serializedCookie(response: ReturnType<typeof fakeResponse>): string {
	const value = response.headers["Set-Cookie"];
	assert.ok(value, "expected Set-Cookie");
	return Array.isArray(value) ? value.at(-1)! : value;
}

describe("mount-scoped signed browser cookies", () => {
	it("uses root Path in root mode and a trailing-slash mount Path otherwise", () => {
		const store = new CookieStore(Buffer.alloc(32, 0x31));
		const rootResponse = fakeResponse();
		issueCookie(rootResponse as any, store, { localhost: true, basePath: "" });
		assert.match(serializedCookie(rootResponse), /(?:^|; )Path=\/(?:;|$)/);

		const mountedResponse = fakeResponse();
		issueCookie(mountedResponse as any, store, { localhost: true, basePath: "/team/bobbit" });
		assert.match(serializedCookie(mountedResponse), /(?:^|; )Path=\/team\/bobbit\/(?:;|$)/);
		assert.doesNotMatch(serializedCookie(mountedResponse), /; Path=\/(?:;|$)/);
	});

	it.each(["invalid-first", "valid-first"])("authenticates the valid duplicate cookie when it is %s", (order) => {
		const currentStore = new CookieStore(Buffer.alloc(32, 0x41));
		const otherStore = new CookieStore(Buffer.alloc(32, 0x42));
		const valid = currentStore.mint();
		const invalidForCurrentMount = otherStore.mint();
		const parts = order === "invalid-first"
			? [`${COOKIE_NAME}=${invalidForCurrentMount}`, `${COOKIE_NAME}=${valid}`]
			: [`${COOKIE_NAME}=${valid}`, `${COOKIE_NAME}=${invalidForCurrentMount}`];
		const request = fakeRequest(parts.join("; "));

		assert.equal(tryAuth(request, currentStore), true);
		assert.equal(extractCookieValue(request, currentStore), valid);
		const response = fakeResponse();
		assert.equal(
			issueIfMissing(request, response as any, currentStore, { localhost: true, basePath: "/bobbit" }),
			undefined,
			"a valid duplicate must not be shadowed into needless replacement",
		);
		assert.equal(response.headers["Set-Cookie"], undefined);
	});

	it("rejects and replaces a duplicate set when none verifies in the current store", () => {
		const currentStore = new CookieStore(Buffer.alloc(32, 0x51));
		const otherStore = new CookieStore(Buffer.alloc(32, 0x52));
		const request = fakeRequest(`${COOKIE_NAME}=malformed; ${COOKIE_NAME}=${otherStore.mint()}`);
		assert.equal(tryAuth(request, currentStore), false);
		assert.equal(extractCookieValue(request, currentStore), undefined);

		const response = fakeResponse();
		const replacement = issueIfMissing(request, response as any, currentStore, { localhost: true, basePath: "/bobbit" });
		assert.ok(replacement);
		assert.ok(currentStore.verify(replacement));
		assert.match(serializedCookie(response), /Path=\/bobbit\//);
	});
});

describe("same-host native transport cookie eligibility", () => {
	const request: BrowserCookieRequestMetadata = {
		method: "GET",
		pathname: "/api/health",
		isTls: true,
		headers: {
			host: "bobbit.example:3001",
			origin: "https://bobbit.example:5173",
			"sec-fetch-site": "same-site",
			"sec-fetch-mode": "cors",
		},
	};
	const context: BrowserCookieEligibilityContext = {
		deployment: "direct",
		configuredHost: "bobbit.example",
		authentication: { source: "admin-bearer" },
	};

	it("allows same-scheme, same-host browser bootstrap across ports", () => {
		assert.deepEqual(classifyBrowserCookieEligibility(request, context), {
			mayBootstrap: true,
			mayRenew: false,
			reason: "eligible-bootstrap",
		});
	});

	it("does not widen cookie bootstrap to another host or scheme", () => {
		const otherHost = classifyBrowserCookieEligibility({
			...request,
			headers: { ...request.headers, origin: "https://ui.example:5173" },
		}, context);
		assert.equal(otherHost.mayBootstrap, false);

		const otherScheme = classifyBrowserCookieEligibility({
			...request,
			headers: { ...request.headers, origin: "http://bobbit.example:5173" },
		}, context);
		assert.equal(otherScheme.mayBootstrap, false);
	});
});

interface WorkerHarness {
	listeners: Record<string, (event: any) => void>;
	openedCaches: string[];
	precacheAdds: string[][];
	cachePuts: string[];
	cacheMatches: unknown[];
	deletedCaches: string[];
	cacheKeys: string[];
	setNetworkFetch(fn: (request: any) => Promise<any>): void;
}

function loadWorker(mount: string): WorkerHarness {
	let source = fs.readFileSync(path.resolve("public/sw.js"), "utf8");
	source = source
		.split("__BOBBIT_BUILD_ID__").join("test-build")
		.split("/*__BOBBIT_PRECACHE_CHUNKS__*/").join('"/assets/lazy.js"');
	const listeners: Record<string, (event: any) => void> = {};
	const openedCaches: string[] = [];
	const precacheAdds: string[][] = [];
	const cachePuts: string[] = [];
	const cacheMatches: unknown[] = [];
	const deletedCaches: string[] = [];
	const cacheKeys: string[] = [];
	let networkFetch: (request: any) => Promise<any> = async () => ({
		ok: true,
		type: "basic",
		clone() { return this; },
	});
	const caches = {
		async open(name: string) {
			openedCaches.push(name);
			return {
				async addAll(values: string[]) { precacheAdds.push([...values]); },
				async put(request: any) { cachePuts.push(typeof request === "string" ? request : request.url); },
				async match(request: any) {
					cacheMatches.push(request);
					const value = typeof request === "string" ? request : request.url;
					if (value === `${mount}/` || (mount === "" && value === "/")) return { offline: true };
					return undefined;
				},
			};
		},
		async keys() { return [...cacheKeys]; },
		async delete(name: string) { deletedCaches.push(name); return true; },
	};
	const self = {
		location: { origin: "https://host.example", pathname: `${mount}/sw.js` || "/sw.js" },
		addEventListener(type: string, listener: (event: any) => void) { listeners[type] = listener; },
		skipWaiting() {},
		clients: { async claim() {} },
	};
	vm.runInNewContext(source, {
		self,
		caches,
		URL,
		Promise,
		Error,
		fetch: (request: any) => networkFetch(request),
	}, { filename: "public/sw.js" });
	return {
		listeners,
		openedCaches,
		precacheAdds,
		cachePuts,
		cacheMatches,
		deletedCaches,
		cacheKeys,
		setNetworkFetch(fn) { networkFetch = fn; },
	};
}

async function dispatchExtendable(listener: (event: any) => void): Promise<void> {
	let pending: Promise<unknown> | undefined;
	listener({ waitUntil(value: Promise<unknown>) { pending = value; } });
	await pending;
}

function dispatchFetch(worker: WorkerHarness, url: string, options: { method?: string; mode?: string } = {}): Promise<any> | undefined {
	let response: Promise<any> | undefined;
	worker.listeners.fetch({
		request: { url, method: options.method ?? "GET", mode: options.mode ?? "cors" },
		respondWith(value: Promise<any>) { response = value; },
	});
	return response;
}

describe("service worker mount isolation", () => {
	it("re-anchors precache entries and isolates cache cleanup by mount", async () => {
		const worker = loadWorker("/team/bobbit");
		await dispatchExtendable(worker.listeners.install);
		assert.deepEqual(worker.precacheAdds, [["/team/bobbit/assets/lazy.js"]]);
		const currentCache = worker.openedCaches[0];
		assert.ok(currentCache.includes("test-build"));
		assert.match(currentCache, /bobbit/i);

		const oldCurrentMountCache = currentCache.replace("test-build", "old-build");
		worker.cacheKeys.push(currentCache, oldCurrentMountCache, "bobbit:another-mount:old-build", "unrelated-app-cache");
		await dispatchExtendable(worker.listeners.activate);
		assert.deepEqual(worker.deletedCaches, [oldCurrentMountCache]);
	});

	it("bypasses mounted API/WS and every off-mount or sibling request", () => {
		const worker = loadWorker("/team/bobbit");
		for (const pathname of [
			"/team/bobbit/api",
			"/team/bobbit/api/health",
			"/team/bobbit/ws",
			"/team/bobbit/ws/viewer",
			"/api/health",
			"/team/bobbit-other/app.js",
			"/other/app.js",
		]) {
			assert.equal(dispatchFetch(worker, `https://host.example${pathname}`), undefined, pathname);
		}
		assert.equal(dispatchFetch(worker, "https://other.example/team/bobbit/assets/app.js"), undefined);
	});

	it("claims and caches only successful same-origin requests within its mount", async () => {
		const worker = loadWorker("/team/bobbit");
		const mounted = dispatchFetch(worker, "https://host.example/team/bobbit/assets/app.js");
		assert.ok(mounted);
		await mounted;
		await Promise.resolve();
		assert.deepEqual(worker.cachePuts, ["https://host.example/team/bobbit/assets/app.js"]);
	});

	it("uses the mounted root as the offline navigation fallback", async () => {
		const worker = loadWorker("/team/bobbit");
		worker.setNetworkFetch(async () => { throw new Error("offline"); });
		const response = dispatchFetch(worker, "https://host.example/team/bobbit/session/abc", { mode: "navigate" });
		assert.ok(response);
		assert.deepEqual(await response, { offline: true });
		assert.ok(worker.cacheMatches.includes("/team/bobbit/"));
	});

	it("retains root-mounted API bypass and offline fallback", async () => {
		const worker = loadWorker("");
		assert.equal(dispatchFetch(worker, "https://host.example/api/health"), undefined);
		worker.setNetworkFetch(async () => { throw new Error("offline"); });
		const response = dispatchFetch(worker, "https://host.example/session/abc", { mode: "navigate" });
		assert.ok(response);
		assert.deepEqual(await response, { offline: true });
		assert.ok(worker.cacheMatches.includes("/"));
	});
});

function sourceFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(absolute));
		else if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)) files.push(absolute);
	}
	return files;
}

function sourcePatternViolations(
	files: string[],
	pattern: RegExp,
	allow: (relative: string, match: RegExpMatchArray) => boolean = () => false,
): string[] {
	assert.equal(pattern.global, true, "source guard patterns must be global");
	const root = path.resolve("src");
	const violations: string[] = [];
	for (const file of files) {
		const relative = path.relative(root, file).split(path.sep).join("/");
		const source = fs.readFileSync(file, "utf8");
		for (const match of source.matchAll(pattern)) {
			if (allow(relative, match)) continue;
			const offset = match.index ?? 0;
			const line = source.slice(0, offset).split(/\r?\n/).length;
			const excerpt = match[0].replace(/\s+/g, " ").trim().slice(0, 180);
			violations.push(`${relative}:${line}: ${excerpt}`);
		}
	}
	return violations;
}

const ROOT_GATEWAY_ROUTE = /^\/(?:api|preview|ws)(?:\/|\?|$)/;
const URL_SINK_PROPERTY = /^(?:src|href|action|poster|icon(?:Url|Src)?|iframe(?:Url|Src)|popoutUrl|sidePanelPopoutUrl)$/i;

type FunctionRegion =
	| ts.FunctionDeclaration
	| ts.FunctionExpression
	| ts.ArrowFunction
	| ts.MethodDeclaration
	| ts.ConstructorDeclaration
	| ts.GetAccessorDeclaration
	| ts.SetAccessorDeclaration;

function isFunctionRegion(node: ts.Node): node is FunctionRegion {
	return ts.isFunctionDeclaration(node)
		|| ts.isFunctionExpression(node)
		|| ts.isArrowFunction(node)
		|| ts.isMethodDeclaration(node)
		|| ts.isConstructorDeclaration(node)
		|| ts.isGetAccessorDeclaration(node)
		|| ts.isSetAccessorDeclaration(node);
}

function propertyName(node: ts.PropertyName | ts.MemberName | undefined): string | undefined {
	if (!node) return undefined;
	if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
	if (ts.isNumericLiteral(node)) return node.text;
	return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current)
		|| ts.isAsExpression(current)
		|| ts.isTypeAssertionExpression(current)
		|| ts.isNonNullExpression(current)
		|| ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function directRootGatewayRoute(expression: ts.Expression): boolean {
	const current = unwrapExpression(expression);
	if (ts.isStringLiteralLike(current)) return ROOT_GATEWAY_ROUTE.test(current.text);
	return ts.isTemplateExpression(current) && ROOT_GATEWAY_ROUTE.test(current.head.text);
}

function sameOriginExpression(expression: ts.Expression, sourceFile: ts.SourceFile): boolean {
	const current = unwrapExpression(expression).getText(sourceFile).replace(/\s+/g, "");
	return /^(?:(?:window|globalThis|self)\.)?location\.origin$/.test(current);
}

function memberKey(expression: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
	const current = unwrapExpression(expression);
	if (ts.isPropertyAccessExpression(current)) return current.getText(sourceFile).replace(/\s+/g, "");
	if (ts.isElementAccessExpression(current) && current.argumentExpression) {
		const argument = unwrapExpression(current.argumentExpression);
		if (ts.isStringLiteralLike(argument)) {
			return `${current.expression.getText(sourceFile).replace(/\s+/g, "")}.${argument.text}`;
		}
	}
	return undefined;
}

function rawBrowserGatewayUrlViolations(relative: string, source: string): string[] {
	const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const regions: Array<{ root: ts.Node; owner?: FunctionRegion }> = [{ root: sourceFile }];
	const recorded = new Map<string, string>();

	const record = (node: ts.Node, reason: string) => {
		const start = node.getStart(sourceFile);
		const key = `${start}:${reason}`;
		if (recorded.has(key)) return;
		const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
		const excerpt = node.getText(sourceFile).replace(/\s+/g, " ").trim().slice(0, 180);
		recorded.set(key, `${relative}:${line}: ${reason}: ${excerpt}`);
	};

	const collectRegions = (node: ts.Node) => {
		if (isFunctionRegion(node) && node.body) regions.push({ root: node.body, owner: node });
		ts.forEachChild(node, collectRegions);
	};
	collectRegions(sourceFile);

	const walkRegion = (root: ts.Node, visit: (node: ts.Node) => void) => {
		const walk = (node: ts.Node) => {
			if (node !== root && isFunctionRegion(node)) return;
			visit(node);
			ts.forEachChild(node, walk);
		};
		walk(root);
	};

	for (const region of regions) {
		const taintedNames = new Set<string>();
		const taintedMembers = new Set<string>();
		const assignments: Array<{ name?: string; member?: string; value: ts.Expression }> = [];

		const addAssignment = (target: ts.Expression | ts.BindingName, value: ts.Expression) => {
			if (ts.isIdentifier(target)) assignments.push({ name: target.text, value });
			else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
				const member = memberKey(target, sourceFile);
				if (member) assignments.push({ member, value });
			}
		};

		walkRegion(region.root, (node) => {
			if (ts.isVariableDeclaration(node) && node.initializer) {
				addAssignment(node.name, node.initializer);
				const initializer = unwrapExpression(node.initializer);
				if (ts.isIdentifier(node.name) && ts.isObjectLiteralExpression(initializer)) {
					for (const property of initializer.properties) {
						if (!ts.isPropertyAssignment(property)) continue;
						const name = propertyName(property.name);
						if (name) assignments.push({ member: `${node.name.text}.${name}`, value: property.initializer });
					}
				}
			} else if (ts.isPropertyDeclaration(node) && node.initializer) {
				const name = propertyName(node.name);
				if (name) assignments.push({ member: `this.${name}`, value: node.initializer });
			} else if (
				ts.isBinaryExpression(node)
				&& node.operatorToken.kind === ts.SyntaxKind.EqualsToken
			) {
				addAssignment(node.left, node.right);
			}
		});

		const isTainted = (expression: ts.Expression): boolean => {
			const current = unwrapExpression(expression);
			if (directRootGatewayRoute(current)) return true;
			if (ts.isIdentifier(current)) return taintedNames.has(current.text);
			const key = memberKey(current, sourceFile);
			if (key && taintedMembers.has(key)) return true;
			if (ts.isConditionalExpression(current)) {
				return isTainted(current.whenTrue) || isTainted(current.whenFalse);
			}
			if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
				const left = unwrapExpression(current.left);
				return isTainted(current.left)
					|| (sameOriginExpression(current.left, sourceFile) && directRootGatewayRoute(current.right))
					|| (ts.isStringLiteralLike(left) && left.text === "" && isTainted(current.right));
			}
			if (ts.isTemplateExpression(current)) {
				if (current.head.text !== "" || current.templateSpans.length === 0) return false;
				const firstSpan = current.templateSpans[0]!;
				return isTainted(firstSpan.expression)
					|| (sameOriginExpression(firstSpan.expression, sourceFile) && ROOT_GATEWAY_ROUTE.test(firstSpan.literal.text));
			}
			if (ts.isNewExpression(current)) {
				const callee = unwrapExpression(current.expression);
				return ts.isIdentifier(callee)
					&& callee.text === "URL"
					&& current.arguments?.length === 2
					&& directRootGatewayRoute(current.arguments[0]!)
					&& sameOriginExpression(current.arguments[1]!, sourceFile);
			}
			if (ts.isCallExpression(current)) {
				const callee = unwrapExpression(current.expression);
				const name = ts.isIdentifier(callee)
					? callee.text
					: ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
				if (name === "gatewayUrl" || name === "gatewayWsUrl" || name === "appUrl" || name === "gatewayFetch") return false;
				if (name === "gatewayRoute" || name === "String" || name === "encodeURI") {
					return current.arguments[0] ? isTainted(current.arguments[0]) : false;
				}
			}
			return false;
		};

		let changed = true;
		while (changed) {
			changed = false;
			for (const assignment of assignments) {
				if (!isTainted(assignment.value)) continue;
				if (assignment.name && !taintedNames.has(assignment.name)) {
					taintedNames.add(assignment.name);
					changed = true;
				}
				if (assignment.member && !taintedMembers.has(assignment.member)) {
					taintedMembers.add(assignment.member);
					changed = true;
				}
			}
		}

		walkRegion(region.root, (node) => {
			if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
				const callee = unwrapExpression(node.expression);
				const calleeName = ts.isIdentifier(callee)
					? callee.text
					: ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
				const owner = ts.isPropertyAccessExpression(callee) ? callee.expression.getText(sourceFile) : "";
				const nativeSink = (calleeName === "fetch" && (!owner || /^(?:window|globalThis|self)$/.test(owner)))
					|| ((calleeName === "EventSource" || calleeName === "WebSocket") && !owner)
					|| (calleeName === "open" && /^(?:window|globalThis)$/.test(owner))
					|| (calleeName === "sendBeacon" && owner === "navigator");
				const firstArgument = node.arguments?.[0];
				if (nativeSink && firstArgument && isTainted(firstArgument)) {
					record(node, `raw gateway route reaches ${calleeName}`);
				}
				if (calleeName === "setAttribute" && node.arguments?.length) {
					const attribute = unwrapExpression(node.arguments[0]!);
					const value = node.arguments[1];
					if (ts.isStringLiteralLike(attribute) && URL_SINK_PROPERTY.test(attribute.text) && value && isTainted(value)) {
						record(node, `raw gateway route reaches ${attribute.text} attribute`);
					}
				}
			}

			if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
				const target = unwrapExpression(node.left);
				if (ts.isPropertyAccessExpression(target) && URL_SINK_PROPERTY.test(target.name.text) && isTainted(node.right)) {
					record(node, `raw gateway route reaches ${target.name.text} property`);
				}
			}

			if (ts.isPropertyAssignment(node)) {
				const name = propertyName(node.name);
				if (name && URL_SINK_PROPERTY.test(name) && isTainted(node.initializer)) {
					record(node, `raw gateway route reaches ${name} property`);
				}
			}

			if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === "html") {
				const template = node.template;
				const staticChunks = ts.isTemplateExpression(template)
					? [template.head.text, ...template.templateSpans.map(span => span.literal.text)]
					: [template.text];
				if (staticChunks.some(chunk => /\b(?:src|href|icon)\s*=\s*["']\/(?:api|preview|ws)(?:\/|\?|["'])/i.test(chunk))) {
					record(node, "raw gateway route appears in an HTML URL attribute");
				}
				if (ts.isTemplateExpression(template)) {
					for (let index = 0; index < template.templateSpans.length; index += 1) {
						const before = index === 0 ? template.head.text : template.templateSpans[index - 1]!.literal.text;
						const span = template.templateSpans[index]!;
						if (/\b(?:src|href|icon)\s*=\s*$/i.test(before) && isTainted(span.expression)) {
							record(span.expression, "raw gateway route reaches an HTML URL attribute");
						}
					}
				}
			}
		});

		if (region.owner) {
			const ownerName = propertyName(region.owner.name)
				?? (ts.isVariableDeclaration(region.owner.parent) && ts.isIdentifier(region.owner.parent.name)
					? region.owner.parent.name.text
					: undefined);
			const publicUrlFactory = ownerName === "previewUrlForTab"
				|| (ownerName !== undefined && /(?:iframe|icon|popout).*?(?:url|src)/i.test(ownerName));
			if (publicUrlFactory) {
				if (ts.isArrowFunction(region.owner) && !ts.isBlock(region.owner.body) && isTainted(region.owner.body)) {
					record(region.owner.body, `raw gateway route returned by ${ownerName}`);
				} else {
					walkRegion(region.root, (node) => {
						if (ts.isReturnStatement(node) && node.expression && isTainted(node.expression)) {
							record(node, `raw gateway route returned by ${ownerName}`);
						}
					});
				}
			}
		}
	}

	return [...recorded.values()];
}

describe("client gateway sink regression guard", () => {
	const files = [...sourceFiles(path.resolve("src/app")), ...sourceFiles(path.resolve("src/ui"))];

	it("constructs credentialed root and mounted manifest URLs only from the current launch query", () => {
		const shell = fs.readFileSync(path.resolve("index.html"), "utf8");
		const manifestMarker = shell.indexOf("// Inject the PWA manifest link");
		const scriptStart = shell.lastIndexOf("<script>", manifestMarker);
		const scriptEnd = shell.indexOf("</script>", manifestMarker);
		assert.ok(manifestMarker >= 0 && scriptStart >= 0 && scriptEnd > manifestMarker, "manifest bootstrap must be discoverable");
		const bootstrap = shell.slice(scriptStart + "<script>".length, scriptEnd);
		const credentialStart = bootstrap.indexOf("var params = new URLSearchParams(window.location.search)");
		const credentialEnd = bootstrap.indexOf("document.head.appendChild(link)", credentialStart);
		assert.ok(credentialStart >= 0 && credentialEnd > credentialStart, "manifest credential source must be discoverable");
		const credentialSource = bootstrap.slice(credentialStart, credentialEnd);
		assert.match(credentialSource, /params\.get\(['"]token['"]\)/);
		assert.doesNotMatch(credentialSource, /localStorage|gateway\.token/, "remote or malformed stored credentials must not escape before validation");

		function manifestLink(basePath: string, search: string): Record<string, string> {
			const appended: Array<Record<string, string>> = [];
			vm.runInNewContext(bootstrap, {
				window: {
					__BOBBIT_BASE_PATH__: basePath,
					location: { search },
					localStorage: { getItem: () => "stored-remote-secret" },
				},
				document: {
					createElement: () => ({}),
					head: { appendChild: (link: Record<string, string>) => appended.push(link) },
				},
				URLSearchParams,
				encodeURIComponent,
			});
			assert.equal(appended.length, 1, "manifest bootstrap must append exactly one link");
			return appended[0]!;
		}

		for (const [basePath, search, expectedHref] of [
			["", "?token=launch%20secret", "/manifest.json?token=launch%20secret"],
			["/team/bobbit", "?token=launch%20secret", "/team/bobbit/manifest.json?token=launch%20secret"],
			["", "", "/manifest.json"],
			["/team/bobbit", "?token=localhost", "/team/bobbit/manifest.json"],
		] as const) {
			const link = manifestLink(basePath, search);
			assert.equal(link.rel, "manifest");
			assert.equal(link.id, "pwa-manifest");
			assert.equal(link.crossOrigin, "use-credentials");
			assert.equal(link.href, expectedHref);
		}
	});

	it("centralizes direct browser bearer construction", () => {
		const directBearer = /(?:["']?Authorization["']?|headers\s*\[\s*["']Authorization["']\s*\])\s*(?::|=)[\s\S]{0,120}?(?:`Bearer\s+\$\{|["']Bearer\s+["']\s*\+)/g;
		const violations = sourcePatternViolations(
			files,
			directBearer,
			(relative) => relative === "app/gateway-fetch.ts", // Sole documented owner: gatewayAuthorizationHeaders.
		);
		assert.deepEqual(violations, [], `Direct client Bearer construction must use gatewayAuthorizationHeaders:\n${violations.join("\n")}`);
	});

	it("has no bare-origin stored gateway fallback outside the boundary", () => {
		const bareFallback = /(?:getItem\(\s*(?:GW_URL_KEY|["']gateway\.url["'])\s*\)|gateway\.url)\s*(?:\|\||\?\?)\s*(?:window\.)?location\.origin|setItem\(\s*GW_URL_KEY\s*,\s*window\.location\.origin\s*\)/g;
		const violations = sourcePatternViolations(
			files,
			bareFallback,
			(relative) => relative === "app/gateway-fetch.ts", // Sole documented fallback owner validates and retains runtimeBasePath.
		);
		assert.deepEqual(violations, [], `Bare-origin gateway fallback/persistence drops the runtime mount:\n${violations.join("\n")}`);
	});

	it("pins variable, template, property, iframe, icon, and popout flows without flagging internal routes", () => {
		const unsafe = `
			const apiPath = \`/api/goals/\${goalId}\`;
			fetch(apiPath);
			const previewRecord = { route: \`/preview/\${sessionId}/index.html\` };
			iframe.src = previewRecord.route;
			const socketPath = "/ws/viewer";
			new WebSocket(socketPath);
			const action = { iconUrl: "/api/icons/goal.svg" };
			function sidePanelPopoutUrl() { return \`/preview/\${sessionId}/inline.html\`; }
			html\`<iframe src="/preview/static/index.html"></iframe>\`;
			const absoluteApi = window.location.origin + "/api/projects";
			fetch(absoluteApi);
			const absolutePreview = \`\${globalThis.location.origin}/preview/\${sessionId}/index.html\`;
			previewIframe.src = absolutePreview;
			fetch(new URL("/api/health", self.location.origin));
			const absoluteSocket = location.origin + "/ws/viewer";
			new WebSocket(absoluteSocket);
		`;
		const unsafeViolations = rawBrowserGatewayUrlViolations("fixture-unsafe.ts", unsafe);
		assert.equal(unsafeViolations.length, 10, unsafeViolations.join("\n"));
		for (const expected of ["fetch(apiPath)", "iframe.src", "WebSocket(socketPath)", "iconUrl", "sidePanelPopoutUrl", "<iframe src=", "fetch(absoluteApi)", "absolutePreview", "new URL", "WebSocket(absoluteSocket)"]) {
			assert.ok(unsafeViolations.some(violation => violation.includes(expected)), `${expected}:\n${unsafeViolations.join("\n")}`);
		}

		const safe = `
			gatewayFetch(\`/api/goals/\${goalId}\`);
			gatewayFetch(gatewayRoute(\`/api/sessions/\${sessionId}\`));
			const internalPreviewRoute = gatewayRoute(\`/preview/\${sessionId}/index.html\`);
			const structuredResult = { url: internalPreviewRoute };
			iframe.src = gatewayUrl(structuredResult.url);
			const internalSocketRoute = "/ws/viewer";
			new WebSocket(gatewayWsUrl(gatewayRoute(internalSocketRoute)));
			const deliberateInternalRoute = \`/api/goals/\${goalId}/gates\`;
			gatewayFetch(gatewayRoute(deliberateInternalRoute));
			function sidePanelPopoutUrl() { return gatewayUrl(internalPreviewRoute); }
			html\`<iframe src=\${gatewayUrl(internalPreviewRoute)}></iframe>\`;
			const resolvedApi = gatewayUrl(gatewayRoute("/api/projects"));
			fetch(resolvedApi);
			fetch("https://gateway.example/team/bobbit/api/projects");
		`;
		assert.deepEqual(rawBrowserGatewayUrlViolations("fixture-safe.ts", safe), []);
	});

	it("has no raw root-relative gateway route flowing to a native browser sink", () => {
		const root = path.resolve("src");
		const violations = files.flatMap((file) => rawBrowserGatewayUrlViolations(
			path.relative(root, file).split(path.sep).join("/"),
			fs.readFileSync(file, "utf8"),
		));
		assert.deepEqual(violations, [], `Raw gateway routes must cross gatewayFetch/gatewayUrl/gatewayWsUrl:\n${violations.join("\n")}`);
	});

	it("does not bind a preview result URL directly to a DOM/network sink", () => {
		const previewOwners = files.filter(file => /(?:render\.ts|side-panel-workspace\.ts|PreviewRenderer\.ts)$/.test(file));
		const rawPreviewSink = /(?:\bsrc|\bhref)\s*=\s*(?:\$\{\s*)?(?:(?!gatewayUrl)[\s\S]){0,120}?\b(?:result|source|preview)\.url\b/g;
		const violations = sourcePatternViolations(previewOwners, rawPreviewSink);
		assert.deepEqual(violations, [], `PreviewResult.url is a GatewayRoute and must cross gatewayUrl at its final sink:\n${violations.join("\n")}`);
	});

	it("has no post-boot root service-worker or app-icon sink", () => {
		const rawAppAsset = /(?:serviceWorker\.register|\.src\s*=|\.href\s*=|window\.open)\s*\(?\s*[`"']\/(?:sw\.js|manifest\.json|favicon[^/]*|icon[^/]*)/g;
		const violations = sourcePatternViolations(files, rawAppAsset);
		assert.deepEqual(violations, [], `Runtime app assets must cross appUrl:\n${violations.join("\n")}`);
	});
});
