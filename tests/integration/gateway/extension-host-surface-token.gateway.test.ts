import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { test, expect } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import { apiFetch, base, createSession, deleteSession, readE2EToken } from "../../../tests/support/harnesses/integration/gateway/e2e-setup.js";
import { API_CORS_ALLOWED_HEADERS, API_CORS_ALLOWED_METHODS, API_CORS_PREFLIGHT_MAX_AGE_SECONDS } from "../../../src/server/cors.js";

const SERVER_FILE = fileURLToPath(new URL("../../../src/server/server.ts", import.meta.url));

type RouteHandler = { sourceFile: string; name: string };
type ImportedHandler = { modulePath: string; exportedName: string };

const NON_ROUTE_REQ_CALLEES = new Set([
	"cookieTryAuth",
	"headerValue",
	"isArray",
	"proxyRequest",
	"readBody",
	"readLimitedJson",
	"readLimitedReviewJson",
	"requireOwningSessionSecret",
	"revisionFromRequest",
	"verifyCallerSession",
]);

function sourceFile(sourcePath: string): ts.SourceFile {
	return ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true);
}

function namedFunction(source: ts.SourceFile, name: string): ts.FunctionLikeDeclarationBase {
	let found: ts.FunctionLikeDeclarationBase | undefined;
	const find = (node: ts.Node): boolean => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
			found = node;
			return true;
		}
		return ts.forEachChild(node, find) ?? false;
	};
	find(source);
	if (!found) throw new Error(`API route handler ${name} was not found in ${source.fileName}`);
	if (!found.body) throw new Error(`API route handler ${name} has no body in ${source.fileName}`);
	return found;
}

function apiBoundaryMethods(): string[] {
	const source = sourceFile(SERVER_FILE);
	let apiBranch: ts.Statement | undefined;
	const findApiBranch = (node: ts.Node): boolean => {
		if (ts.isIfStatement(node) && ts.isCallExpression(node.expression)
			&& ts.isPropertyAccessExpression(node.expression.expression)
			&& node.expression.expression.name.text === "startsWith"
			&& ts.isPropertyAccessExpression(node.expression.expression.expression)
			&& ts.isIdentifier(node.expression.expression.expression.expression)
			&& node.expression.expression.expression.expression.text === "url"
			&& node.expression.expression.expression.name.text === "pathname"
			&& node.expression.arguments.some(argument => ts.isStringLiteral(argument) && argument.text === "/api/")) {
			apiBranch = node.thenStatement;
			return true;
		}
		return ts.forEachChild(node, findApiBranch) ?? false;
	};
	findApiBranch(source);
	if (!apiBranch) throw new Error("The /api/ router boundary was not found in server.ts");

	return methodLiterals(apiBranch, {
		allowNonDispatchReqMethod: (node) => {
			const parent = node.parent;
			return (ts.isCallExpression(parent) && parent.arguments.includes(node)
				&& ts.isIdentifier(parent.expression) && parent.expression.text === "normalizeApiRouteLabel")
				|| (ts.isPropertyAssignment(parent) && parent.initializer === node)
				|| (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
				|| ts.isTemplateSpan(parent);
		},
	});
}

function calleeName(expression: ts.LeftHandSideExpression): string | undefined {
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	return undefined;
}

function callReceivesReq(call: ts.CallExpression): boolean {
	return call.arguments.some((argument) => {
		if (ts.isIdentifier(argument) && argument.text === "req") return true;
		if (!ts.isObjectLiteralExpression(argument)) return false;
		return argument.properties.some((property) => {
			if (ts.isShorthandPropertyAssignment(property)) return property.name.text === "req";
			return ts.isPropertyAssignment(property)
				&& (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
				&& property.name.text === "req"
				&& ts.isIdentifier(property.initializer) && property.initializer.text === "req";
		});
	});
}

function resolveImportedHandler(sourcePath: string, delegateName: string, modulePath: string): string {
	if (!modulePath.startsWith(".")) {
		throw new Error(`API route delegate ${delegateName} must use a relative named import, received ${modulePath}`);
	}
	const pathWithoutExtension = modulePath.replace(/\.(?:[cm]?js|ts)$/, "");
	const candidates = [
		resolve(dirname(sourcePath), `${pathWithoutExtension}.ts`),
		resolve(dirname(sourcePath), pathWithoutExtension, "index.ts"),
	];
	const resolved = candidates.find(existsSync);
	if (!resolved) {
		throw new Error(`API route delegate ${delegateName} import ${modulePath} did not resolve to a .ts file or index.ts`);
	}
	return resolved;
}

function importedRouteHandlers(source: ts.SourceFile, body: ts.Node, sourcePath: string): RouteHandler[] {
	const imports = new Map<string, ImportedHandler>();
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		for (const binding of bindings.elements) {
			imports.set(binding.name.text, {
				modulePath: statement.moduleSpecifier.text,
				exportedName: binding.propertyName?.text ?? binding.name.text,
			});
		}
	}

	const handlers: RouteHandler[] = [];
	const find = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && callReceivesReq(node)) {
			const delegateName = calleeName(node.expression);
			if (delegateName && NON_ROUTE_REQ_CALLEES.has(delegateName)) {
				// Verified request helpers are not API route delegates.
			} else {
				const imported = delegateName ? imports.get(delegateName) : undefined;
				if (!imported) {
					throw new Error(`API route delegate ${delegateName ?? "<computed>"} must be an imported handler or allowlisted as non-routing`);
				}
				handlers.push({
					name: imported.exportedName,
					sourceFile: resolveImportedHandler(sourcePath, delegateName!, imported.modulePath),
				});
			}
		}
		ts.forEachChild(node, find);
	};
	find(body);
	return handlers;
}

function isReqMethod(node: ts.Expression, aliases: ReadonlySet<string>): boolean {
	return (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "req" && node.name.text === "method")
		|| (ts.isIdentifier(node) && aliases.has(node.text));
}

type MethodLiteralOptions = {
	allowNonDispatchReqMethod?: (node: ts.PropertyAccessExpression) => boolean;
};

function methodLiterals(body: ts.Node, options: MethodLiteralOptions = {}): string[] {
	const aliases = new Set<string>();
	const objectLiterals = new Map<string, ts.ObjectLiteralExpression>();
	const methods = new Set<string>();
	const comparisonOperators = new Set([
		ts.SyntaxKind.EqualsEqualsToken,
		ts.SyntaxKind.EqualsEqualsEqualsToken,
		ts.SyntaxKind.ExclamationEqualsToken,
		ts.SyntaxKind.ExclamationEqualsEqualsToken,
	]);
	const addMethodName = (name: string): void => {
		if (!/^[A-Z]+$/.test(name)) {
			throw new Error(`API method dispatch must use an uppercase string literal in ${body.getSourceFile().fileName}`);
		}
		methods.add(name);
	};
	const addMethod = (node: ts.Expression): void => {
		if (!ts.isStringLiteral(node)) {
			throw new Error(`API method dispatch must use an uppercase string literal in ${body.getSourceFile().fileName}`);
		}
		addMethodName(node.text);
	};
	const lookupMethods = (target: ts.Expression): void => {
		const map = ts.isObjectLiteralExpression(target)
			? target
			: ts.isIdentifier(target) ? objectLiterals.get(target.text) : undefined;
		if (!map) throw new Error(`API method lookup must use a local object literal in ${body.getSourceFile().fileName}`);
		for (const property of map.properties) {
			if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) {
				throw new Error(`API method lookup has an unsupported property in ${body.getSourceFile().fileName}`);
			}
			if (!property.name || !ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) {
				throw new Error(`API method lookup must use named method keys in ${body.getSourceFile().fileName}`);
			}
			addMethodName(property.name.text);
		}
	};
	const visit = (node: ts.Node): void => {
		if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "req" && node.name.text === "method") {
			const parent = node.parent;
			const supported = (ts.isVariableDeclaration(parent) && parent.initializer === node)
				|| (ts.isBinaryExpression(parent) && comparisonOperators.has(parent.operatorToken.kind)
					&& (parent.left === node || parent.right === node))
				|| (ts.isSwitchStatement(parent) && parent.expression === node)
				|| (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)
				|| (ts.isPropertyAssignment(parent) && parent.initializer === node)
				|| ts.isTemplateSpan(parent)
				|| options.allowNonDispatchReqMethod?.(node) === true;
			if (!supported) {
				throw new Error(`req.method appears in an unrecognized position in ${body.getSourceFile().fileName}; extract it to a local alias or extend the inventory`);
			}
		}
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			if (isReqMethod(node.initializer, aliases)) aliases.add(node.name.text);
			if (ts.isObjectLiteralExpression(node.initializer)) objectLiterals.set(node.name.text, node.initializer);
		}
		if (ts.isBinaryExpression(node) && comparisonOperators.has(node.operatorToken.kind)) {
			if (isReqMethod(node.left, aliases)) addMethod(node.right);
			if (isReqMethod(node.right, aliases)) addMethod(node.left);
		}
		if (ts.isSwitchStatement(node) && isReqMethod(node.expression, aliases)) {
			for (const clause of node.caseBlock.clauses) {
				if (ts.isCaseClause(clause)) addMethod(clause.expression);
			}
		}
		if (ts.isElementAccessExpression(node) && node.argumentExpression && isReqMethod(node.argumentExpression, aliases)) {
			lookupMethods(node.expression);
		}
		ts.forEachChild(node, visit);
	};
	visit(body);
	return [...methods].sort();
}

function routedApiMethods(
	rootHandler: RouteHandler = { sourceFile: SERVER_FILE, name: "handleApiRoute" },
	boundaryMethods: readonly string[] = apiBoundaryMethods(),
): string[] {
	const handlers = [rootHandler];
	const methods = new Set<string>(boundaryMethods);
	const visited = new Set<string>();
	for (let index = 0; index < handlers.length; index++) {
		const handler = handlers[index]!;
		const key = `${handler.sourceFile}:${handler.name}`;
		if (visited.has(key)) continue;
		visited.add(key);
		const source = sourceFile(handler.sourceFile);
		const route = namedFunction(source, handler.name);
		for (const method of methodLiterals(route.body!)) methods.add(method);
		handlers.push(...importedRouteHandlers(source, route.body!, handler.sourceFile));
	}
	return [...methods].sort();
}

function headerList(value: string | null): string[] {
	return (value ?? "").split(",").map(item => item.trim()).filter(Boolean);
}

function fixtureSource(fileName: string, text: string): ts.SourceFile {
	return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
}

test("CORS inventory rejects untracked req-receiving calls", () => {
	for (const [label, call] of [
		["direct", "untracked(req)"],
		["object property", "untracked({ req: req })"],
		["object shorthand", "untracked({ req })"],
	] as const) {
		const source = fixtureSource(`${label}.ts`, `function handleApiRoute(req: unknown) { ${call}; }`);
		expect(() => importedRouteHandlers(source, namedFunction(source, "handleApiRoute").body!, source.fileName))
			.toThrow("API route delegate untracked must be an imported handler or allowlisted as non-routing");
	}

	const source = fixtureSource("bare-import.ts", `
		import { delegated } from "non-relative-package";
		function handleApiRoute(req: unknown) { delegated(req); }
	`);
	expect(() => importedRouteHandlers(source, namedFunction(source, "handleApiRoute").body!, source.fileName))
		.toThrow("API route delegate delegated must use a relative named import, received non-relative-package");
});

test("CORS inventory includes methods from imported req-receiving delegates", () => {
	const fixtureDirectory = mkdtempSync(join(tmpdir(), "bobbit-cors-route-inventory-"));
	const rootPath = join(fixtureDirectory, "root.ts");
	try {
		writeFileSync(rootPath, `
			import { handleFutureRoutes } from "./delegate.js";
			import { handleIndexedRoutes } from "./nested";
			function handleApiRoute(req: unknown) {
				handleFutureRoutes({ req });
				return handleIndexedRoutes(req);
			}
		`);
		writeFileSync(join(fixtureDirectory, "delegate.ts"), `
			export function handleFutureRoutes({ req }: { req: { method: string } }) {
				return req.method === "HEAD";
			}
		`);
		mkdirSync(join(fixtureDirectory, "nested"));
		writeFileSync(join(fixtureDirectory, "nested", "index.ts"), `
			export function handleIndexedRoutes(req: { method: string }) {
				return req.method === "CONNECT";
			}
		`);

		expect(API_CORS_ALLOWED_METHODS).not.toContain("HEAD");
		expect(routedApiMethods({ sourceFile: rootPath, name: "handleApiRoute" }, [])).toEqual(["CONNECT", "HEAD"]);
	} finally {
		rmSync(fixtureDirectory, { recursive: true, force: true });
	}
});

test("CORS preflight advertises every routed API method and required request metadata", async () => {
	const origin = "http://127.0.0.1:5173";
	const res = await fetch(`${base()}/api/ext/route/run`, {
		method: "OPTIONS",
		headers: {
			Origin: origin,
			"Access-Control-Request-Method": "POST",
			"Access-Control-Request-Headers": "authorization,content-type,if-match,x-bobbit-session-id,x-bobbit-session-secret",
		},
	});
	expect(res.status).toBe(204);
	expect(headerList(res.headers.get("access-control-allow-methods")).map(method => method.toUpperCase()))
		.toEqual([...API_CORS_ALLOWED_METHODS]);
	expect(routedApiMethods()).toEqual([...API_CORS_ALLOWED_METHODS].sort());
	expect(headerList(res.headers.get("access-control-allow-headers")).map(header => header.toLowerCase()).sort())
		.toEqual([...API_CORS_ALLOWED_HEADERS].map(header => header.toLowerCase()).sort());
	expect(Number(res.headers.get("access-control-max-age"))).toBe(API_CORS_PREFLIGHT_MAX_AGE_SECONDS);
	expect(API_CORS_PREFLIGHT_MAX_AGE_SECONDS).toBeGreaterThan(0);
	expect(API_CORS_PREFLIGHT_MAX_AGE_SECONDS).toBeLessThanOrEqual(86_400);
	expect(res.headers.get("access-control-allow-credentials")).toBeNull();

	// Preserve the existing wildcard/reflection decision and pair Vary only with reflection.
	const allowedOrigin = res.headers.get("access-control-allow-origin");
	if (allowedOrigin === "*") {
		expect(res.headers.get("vary")?.toLowerCase() ?? "").not.toContain("origin");
	} else {
		expect(allowedOrigin).toBe(origin);
		expect(res.headers.get("vary")?.toLowerCase()).toContain("origin");
	}
});

test("authenticated cross-origin side-panel workspace PATCH persists after its preflight", async () => {
	const sessionId = await createSession();
	try {
		const tabId = "proposal:goal";
		const tabPath = `/api/sessions/${sessionId}/side-panel-workspace/tabs/${encodeURIComponent(tabId)}`;
		const opened = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/open`, {
			method: "POST",
			body: JSON.stringify({
				tab: {
					id: tabId,
					kind: "proposal",
					title: "Goal Proposal",
					label: "Goal",
					source: { type: "proposal", sessionId, proposalType: "goal" },
					updatedAt: 1,
				},
			}),
		});
		expect(opened.status).toBe(200);
		const workspace = await opened.json();

		const origin = "https://remote-ui.example.test";
		const preflight = await fetch(`${base()}${tabPath}`, {
			method: "OPTIONS",
			headers: {
				Origin: origin,
				"Access-Control-Request-Method": "PATCH",
				"Access-Control-Request-Headers": "authorization,content-type,if-match,x-bobbit-session-id,x-bobbit-session-secret",
			},
		});
		expect(preflight.status).toBe(204);
		expect(headerList(preflight.headers.get("access-control-allow-methods")).map(method => method.toUpperCase())).toContain("PATCH");

		const patch = await fetch(`${base()}${tabPath}`, {
			method: "PATCH",
			headers: {
				Origin: origin,
				Authorization: `Bearer ${readE2EToken()}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				baseRevision: workspace.revision,
				patch: {
					title: "Persisted cross-origin update",
					state: { selectedSection: "details" },
				},
			}),
		});
		expect(patch.status).toBe(200);
		expect(patch.headers.get("access-control-max-age")).toBeNull();

		const refetched = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace`);
		expect(refetched.status).toBe(200);
		const persisted = await refetched.json();
		expect(persisted.tabs.find((tab: any) => tab.id === tabId)).toMatchObject({
			title: "Persisted cross-origin update",
			state: { selectedSection: "details" },
		});

		const closePreflight = await fetch(`${base()}${tabPath}`, {
			method: "OPTIONS",
			headers: {
				Origin: origin,
				"Access-Control-Request-Method": "DELETE",
				"Access-Control-Request-Headers": "authorization,if-match",
			},
		});
		expect(closePreflight.status).toBe(204);
		expect(headerList(closePreflight.headers.get("access-control-allow-methods")).map(method => method.toUpperCase())).toContain("DELETE");
		expect(headerList(closePreflight.headers.get("access-control-allow-headers")).map(header => header.toLowerCase())).toContain("if-match");

		const close = await fetch(`${base()}${tabPath}`, {
			method: "DELETE",
			headers: {
				Origin: origin,
				Authorization: `Bearer ${readE2EToken()}`,
				"If-Match": `"${persisted.revision}"`,
			},
		});
		expect(close.status).toBe(200);

		const closedWorkspace = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace`);
		expect(closedWorkspace.status).toBe(200);
		expect((await closedWorkspace.json()).tabs.find((tab: any) => tab.id === tabId)).toBeUndefined();
	} finally {
		await deleteSession(sessionId);
	}
});

test("POST /api/ext/surface-token denies caller-selected pack-bound identities", async () => {
	const sessionId = await createSession();
	try {
		const res = await apiFetch("/api/ext/surface-token", {
			method: "POST",
			headers: { "x-bobbit-session-id": sessionId },
			body: JSON.stringify({
				sessionId,
				packId: "terminal",
				contributionKind: "panel",
				contributionId: "terminal",
			}),
		});
		const body = await res.json().catch(() => ({}));
		expect(res.status).toBe(403);
		expect(body.error).toContain("trusted session WebSocket");
	} finally {
		await deleteSession(sessionId);
	}
});
