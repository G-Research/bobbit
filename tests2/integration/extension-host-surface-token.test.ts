import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, base, createSession, deleteSession, readE2EToken } from "./_e2e/e2e-setup.js";
import { API_CORS_ALLOWED_HEADERS, API_CORS_ALLOWED_METHODS, API_CORS_PREFLIGHT_MAX_AGE_SECONDS } from "../../src/server/cors.js";

const SERVER_FILE = fileURLToPath(new URL("../../src/server/server.ts", import.meta.url));

type RouteHandler = { sourceFile: string; name: string };

function sourceFile(sourcePath: string): ts.SourceFile {
	return ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true);
}

function namedFunction(source: ts.SourceFile, name: string): ts.FunctionLikeDeclarationBase {
	let found: ts.FunctionLikeDeclarationBase | undefined;
	const find = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
		ts.forEachChild(node, find);
	};
	find(source);
	if (!found?.body) throw new Error(`API route handler ${name} was not found in ${source.fileName}`);
	return found;
}

function apiBoundaryMethods(): string[] {
	const source = sourceFile(SERVER_FILE);
	let apiBranch: ts.Statement | undefined;
	const findApiBranch = (node: ts.Node): void => {
		if (ts.isIfStatement(node) && ts.isCallExpression(node.expression)
			&& ts.isPropertyAccessExpression(node.expression.expression)
			&& node.expression.expression.name.text === "startsWith"
			&& ts.isPropertyAccessExpression(node.expression.expression.expression)
			&& ts.isIdentifier(node.expression.expression.expression.expression)
			&& node.expression.expression.expression.expression.text === "url"
			&& node.expression.expression.expression.name.text === "pathname"
			&& node.expression.arguments.some(argument => ts.isStringLiteral(argument) && argument.text === "/api/")) {
			apiBranch = node.thenStatement;
			return;
		}
		ts.forEachChild(node, findApiBranch);
	};
	findApiBranch(source);
	if (!apiBranch) throw new Error("The /api/ router boundary was not found in server.ts");

	const methods = new Set<string>();
	const add = (node: ts.Expression): void => {
		if (!ts.isStringLiteral(node) || !/^[A-Z]+$/.test(node.text)) {
			throw new Error("The /api/ router boundary must use uppercase method literals");
		}
		methods.add(node.text);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isBinaryExpression(node) && [
			ts.SyntaxKind.EqualsEqualsToken,
			ts.SyntaxKind.EqualsEqualsEqualsToken,
			ts.SyntaxKind.ExclamationEqualsToken,
			ts.SyntaxKind.ExclamationEqualsEqualsToken,
		].includes(node.operatorToken.kind)) {
			if (isReqMethod(node.left, new Set())) add(node.right);
			if (isReqMethod(node.right, new Set())) add(node.left);
		}
		if (ts.isSwitchStatement(node) && isReqMethod(node.expression, new Set())) {
			for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause)) add(clause.expression);
		}
		ts.forEachChild(node, visit);
	};
	visit(apiBranch);
	return [...methods];
}

function importedRouteHandlers(source: ts.SourceFile, body: ts.Node, sourcePath: string): RouteHandler[] {
	const imports = new Map<string, string>();
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		for (const binding of bindings.elements) imports.set(binding.name.text, statement.moduleSpecifier.text);
	}

	const handlers: RouteHandler[] = [];
	const find = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
			&& /^(?:handle|tryHandle).*(?:Route|Request)$/.test(node.expression.text)
			&& node.arguments.some(argument => ts.isIdentifier(argument) && argument.text === "req")) {
			const modulePath = imports.get(node.expression.text);
			if (!modulePath) throw new Error(`API route delegate ${node.expression.text} must be an imported handler`);
			handlers.push({
				name: node.expression.text,
				sourceFile: resolve(dirname(sourcePath), modulePath.replace(/\.js$/, ".ts")),
			});
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

function methodLiterals(body: ts.Node): string[] {
	const aliases = new Set<string>();
	const objectLiterals = new Map<string, ts.ObjectLiteralExpression>();
	const methods = new Set<string>();
	const comparisonOperators = new Set([
		ts.SyntaxKind.EqualsEqualsToken,
		ts.SyntaxKind.EqualsEqualsEqualsToken,
		ts.SyntaxKind.ExclamationEqualsToken,
		ts.SyntaxKind.ExclamationEqualsEqualsToken,
	]);
	const addMethod = (node: ts.Expression): void => {
		if (!ts.isStringLiteral(node) || !/^[A-Z]+$/.test(node.text)) {
			throw new Error(`API method dispatch must use an uppercase string literal in ${body.getSourceFile().fileName}`);
		}
		methods.add(node.text);
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
			addMethod(ts.isIdentifier(property.name)
				? ts.factory.createStringLiteral(property.name.text)
				: property.name);
		}
	};
	const visit = (node: ts.Node): void => {
		if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "req" && node.name.text === "method") {
			const parent = node.parent;
			const supported = (ts.isVariableDeclaration(parent) && parent.initializer === node)
				|| (ts.isBinaryExpression(parent) && (parent.left === node || parent.right === node))
				|| (ts.isSwitchStatement(parent) && parent.expression === node)
				|| (ts.isElementAccessExpression(parent) && parent.argumentExpression === node);
			if (!supported) throw new Error(`Unsupported API method dispatch in ${body.getSourceFile().fileName}`);
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

function routedApiMethods(): string[] {
	const handlers = [{ sourceFile: SERVER_FILE, name: "handleApiRoute" }];
	const methods = new Set<string>(apiBoundaryMethods());
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
