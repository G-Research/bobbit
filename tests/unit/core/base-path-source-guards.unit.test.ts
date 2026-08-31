import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, it } from "vitest";

const SOURCE_ROOT = path.resolve("src");
const CLIENT_ROOTS = [path.resolve("src/app"), path.resolve("src/ui")];

/**
 * The browser boundary is the only client file allowed to own same-origin
 * gateway fallback and HTTP Authorization construction. Internal `/api` and
 * `/preview` route literals remain valid everywhere, but they must reach a
 * browser URL sink through one of the centralized boundary calls below.
 */
const CENTRAL_BROWSER_BOUNDARY = "app/gateway-fetch.ts";
const RESOLVED_URL_BOUNDARIES = new Set(["appUrl", "gatewayFetch", "gatewayUrl", "gatewayWsUrl"]);
const INTERNAL_ROUTE_BOUNDARIES = new Set(["gatewayRoute", "previewGatewayRoute", "String", "encodeURI"]);
const INTERNAL_GATEWAY_ROUTE = /^\/(?:api|preview)(?:\/|\?|$)/;
const URL_SINK_PROPERTY = /^(?:src|href|action|poster|icon(?:Url|Src)?|iframe(?:Url|Src)|popoutUrl|sidePanelPopoutUrl)$/i;

function sourceFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(absolute));
		else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) files.push(absolute);
	}
	return files;
}

const CLIENT_FILES = CLIENT_ROOTS.flatMap(sourceFiles);

function relativeSourcePath(file: string): string {
	return path.relative(SOURCE_ROOT, file).split(path.sep).join("/");
}

function sourcePatternViolations(
	files: string[],
	pattern: RegExp,
	allow: (relative: string, match: RegExpMatchArray) => boolean = () => false,
): string[] {
	assert.equal(pattern.global, true, "source guard patterns must be global");
	const violations: string[] = [];
	for (const file of files) {
		const relative = relativeSourcePath(file);
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

function directInternalGatewayRoute(expression: ts.Expression): boolean {
	const current = unwrapExpression(expression);
	if (ts.isStringLiteralLike(current)) return INTERNAL_GATEWAY_ROUTE.test(current.text);
	return ts.isTemplateExpression(current) && INTERNAL_GATEWAY_ROUTE.test(current.head.text);
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

/**
 * Focused intra-function taint scan adapted from the proven base-path guard.
 * A generic `url` data property is deliberately not a sink: preview records
 * store internal routes. Browser-facing src/href/icon/iframe/popout properties
 * are sinks, and gatewayFetch/gatewayUrl are the explicit resolution allowlist.
 */
function rawBrowserGatewayUrlViolations(relative: string, source: string): string[] {
	const scriptKind = relative.endsWith(".tsx")
		? ts.ScriptKind.TSX
		: relative.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, scriptKind);
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
			} else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
				addAssignment(node.left, node.right);
			}
		});

		const isTainted = (expression: ts.Expression): boolean => {
			const current = unwrapExpression(expression);
			if (directInternalGatewayRoute(current)) return true;
			if (ts.isIdentifier(current)) return taintedNames.has(current.text);
			const key = memberKey(current, sourceFile);
			if (key && taintedMembers.has(key)) return true;
			if (ts.isConditionalExpression(current)) {
				return isTainted(current.whenTrue) || isTainted(current.whenFalse);
			}
			if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
				const left = unwrapExpression(current.left);
				return isTainted(current.left)
					|| (sameOriginExpression(current.left, sourceFile) && directInternalGatewayRoute(current.right))
					|| (ts.isStringLiteralLike(left) && left.text === "" && isTainted(current.right));
			}
			if (ts.isTemplateExpression(current)) {
				if (current.head.text !== "" || current.templateSpans.length === 0) return false;
				const firstSpan = current.templateSpans[0]!;
				return isTainted(firstSpan.expression)
					|| (sameOriginExpression(firstSpan.expression, sourceFile) && INTERNAL_GATEWAY_ROUTE.test(firstSpan.literal.text));
			}
			if (ts.isNewExpression(current)) {
				const callee = unwrapExpression(current.expression);
				return ts.isIdentifier(callee)
					&& callee.text === "URL"
					&& current.arguments?.length === 2
					&& directInternalGatewayRoute(current.arguments[0]!)
					&& sameOriginExpression(current.arguments[1]!, sourceFile);
			}
			if (ts.isCallExpression(current)) {
				const callee = unwrapExpression(current.expression);
				const name = ts.isIdentifier(callee)
					? callee.text
					: ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
				if (RESOLVED_URL_BOUNDARIES.has(name)) return false;
				if (INTERNAL_ROUTE_BOUNDARIES.has(name)) {
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
					|| (calleeName === "EventSource" && !owner)
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
				if (staticChunks.some(chunk => /\b(?:src|href|icon)\s*=\s*["']\/(?:api|preview)(?:\/|\?|["'])/i.test(chunk))) {
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

describe("client gateway source guards", () => {
	it("keeps the guard sensitive while allowing internal route literals and the central URL boundary", () => {
		const unsafe = `
			const apiPath = \`/api/goals/\${goalId}\`;
			fetch(apiPath);
			const previewRecord = { url: \`/preview/\${sessionId}/index.html\` };
			iframe.src = previewRecord.url;
			const action = { iconUrl: "/api/icons/goal.svg" };
			function sidePanelPopoutUrl() { return \`/preview/\${sessionId}/inline.html\`; }
			html\`<iframe src="/preview/static/index.html"></iframe>\`;
			const absoluteApi = window.location.origin + "/api/projects";
			fetch(absoluteApi);
			const absolutePreview = \`\${globalThis.location.origin}/preview/\${sessionId}/index.html\`;
			previewIframe.src = absolutePreview;
			fetch(new URL("/api/health", self.location.origin));
		`;
		const unsafeViolations = rawBrowserGatewayUrlViolations("fixture-unsafe.ts", unsafe);
		assert.equal(unsafeViolations.length, 8, unsafeViolations.join("\n"));
		for (const expected of [
			"fetch(apiPath)",
			"iframe.src",
			"iconUrl",
			"sidePanelPopoutUrl",
			"<iframe src=",
			"fetch(absoluteApi)",
			"absolutePreview",
			"new URL",
		]) {
			assert.ok(unsafeViolations.some(violation => violation.includes(expected)), `${expected}:\n${unsafeViolations.join("\n")}`);
		}

		const safe = `
			gatewayFetch(\`/api/goals/\${goalId}\`);
			const internalPreviewRoute = gatewayRoute(\`/preview/\${sessionId}/index.html\`);
			const structuredResult = { url: internalPreviewRoute };
			iframe.src = gatewayUrl(structuredResult.url);
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

	it("has no bare-origin stored gateway fallback outside gateway-fetch", () => {
		const bareFallback = /(?:getItem\(\s*(?:GW_URL_KEY|["']gateway\.url["'])\s*\)|gateway\.url)\s*(?:\|\||\?\?)\s*(?:window\.)?location\.origin|setItem\(\s*GW_URL_KEY\s*,\s*window\.location\.origin\s*\)/g;
		for (const unsafe of [
			`localStorage.getItem(GW_URL_KEY) || window.location.origin`,
			`gateway.url ?? location.origin`,
			`localStorage.setItem(GW_URL_KEY, window.location.origin)`,
		]) {
			assert.ok([...unsafe.matchAll(new RegExp(bareFallback.source, bareFallback.flags))].length > 0, unsafe);
		}
		const violations = sourcePatternViolations(
			CLIENT_FILES,
			bareFallback,
			(relative) => relative === CENTRAL_BROWSER_BOUNDARY,
		);
		assert.deepEqual(violations, [], `Bare-origin gateway fallback/persistence drops the runtime mount:\n${violations.join("\n")}`);
	});

	it("has no raw same-origin API or preview route flowing to a browser URL sink", () => {
		const violations = CLIENT_FILES.flatMap((file) => rawBrowserGatewayUrlViolations(
			relativeSourcePath(file),
			fs.readFileSync(file, "utf8"),
		));
		assert.deepEqual(violations, [], `Raw API/preview routes must cross gatewayFetch or gatewayUrl:\n${violations.join("\n")}`);
	});

	it("centralizes direct browser Authorization Bearer construction in gateway-fetch", () => {
		const directBearer = /(?:(?:["']?Authorization["']?|headers\s*\[\s*["']Authorization["']\s*\])\s*(?::|=)|\.set\(\s*["']Authorization["']\s*,)[\s\S]{0,120}?(?:`Bearer\s+\$\{|["']Bearer\s+["']\s*\+)/gi;
		for (const unsafe of [
			`const headers = { Authorization: \`Bearer \${token}\` };`,
			`headers["Authorization"] = "Bearer " + token;`,
			`headers.set("authorization", \`Bearer \${token}\`);`,
		]) {
			assert.ok([...unsafe.matchAll(new RegExp(directBearer.source, directBearer.flags))].length > 0, unsafe);
		}
		const violations = sourcePatternViolations(
			CLIENT_FILES,
			directBearer,
			(relative) => relative === CENTRAL_BROWSER_BOUNDARY,
		);
		assert.deepEqual(violations, [], `Direct client Bearer construction must use gatewayAuthorizationHeaders:\n${violations.join("\n")}`);
	});
});
