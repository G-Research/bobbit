import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SERVER_ROOT = path.resolve("src/server");

function sourceFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(absolute));
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
	}
	return files;
}

function enclosingFunctionName(node: ts.Node): string | undefined {
	let current: ts.Node | undefined = node;
	while (current) {
		if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
		if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
		current = current.parent;
	}
	return undefined;
}

function routeCommentBefore(source: string, offset: number): string {
	const prefix = source.slice(0, offset);
	const matches = [...prefix.matchAll(/^\s*\/\/\s*(GET|POST|PUT|DELETE|PATCH)\s+([^\r\n]+)/gm)];
	return matches.at(-1)?.[0].trim() ?? "<no route comment>";
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
	return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

interface Violation {
	file: string;
	line: number;
	detail: string;
}

function findLifecyclePushViolations(): Violation[] {
	const violations: Violation[] = [];
	for (const file of sourceFiles(SERVER_ROOT)) {
		const source = fs.readFileSync(file, "utf8");
		const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const relative = path.relative(process.cwd(), file).split(path.sep).join("/");

		const visit = (node: ts.Node): void => {
			if (ts.isArrayLiteralExpression(node)) {
				const first = node.elements[0];
				if (first && ts.isStringLiteralLike(first) && first.text === "push") {
					const args = node.elements
						.filter(ts.isStringLiteralLike)
						.map(element => element.text);
					const isDelete = args.includes("--delete") || args.includes("-d");
					const isExplicitPushArguments = relative === "src/server/server.ts"
						&& enclosingFunctionName(node) === "branchPublishGitArgs";
					if (!isDelete && !isExplicitPushArguments) {
						violations.push({
							file: relative,
							line: lineOf(sourceFile, node),
							detail: `non-delete git argument array ${node.getText(sourceFile)}`,
						});
					}
				}
			}

			if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "publishCurrentBranchToOrigin") {
				const route = routeCommentBefore(source, node.getStart(sourceFile));
				if (!/POST .*\/git-push\b/.test(route) || /git-squash-push/.test(route)) {
					violations.push({
						file: relative,
						line: lineOf(sourceFile, node),
						detail: `publisher called outside explicit git-push route (${route})`,
					});
				}
			}

			if (ts.isCallExpression(node)) {
				const callee = node.expression.getText(sourceFile);
				const commandText = node.arguments
					.filter(argument => ts.isStringLiteralLike(argument) || ts.isTemplateExpression(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
					.map(argument => argument.getText(sourceFile))
					.find(text => /\bgit\s+push\b/.test(text));
				if (commandText && /exec|run|spawn|command/i.test(callee)) {
					const isDelete = /git\s+push\s+[^\r\n]*--delete/.test(commandText);
					const route = routeCommentBefore(source, node.getStart(sourceFile));
					const isExplicitSquashPush = relative === "src/server/server.ts"
						&& /POST .*\/git-squash-push\b/.test(route);
					if (!isDelete && !isExplicitSquashPush) {
						violations.push({
							file: relative,
							line: lineOf(sourceFile, node),
							detail: `shell push execution outside explicit squash-push route: ${commandText}`,
						});
					}
				}
			}

			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return violations;
}

describe("gateway non-delete push source boundary", () => {
	it("permits only explicit publication and squash-push while allowing remote deletion", () => {
		const violations = findLifecyclePushViolations();
		expect(
			violations,
			`GATEWAY_NONDELETE_PUSH_BOUNDARY: lifecycle code contains non-delete pushes:\n${violations
				.map(violation => `${violation.file}:${violation.line} ${violation.detail}`)
				.join("\n")}`,
		).toEqual([]);
	});
});
