import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(".");
const MARKER = "ASYNC_BACKGROUND_CLEANUP_SYNC_IO";

const SYNC_FS_APIS = new Set([
	"accessSync",
	"appendFileSync",
	"chmodSync",
	"chownSync",
	"closeSync",
	"copyFileSync",
	"cpSync",
	"existsSync",
	"fdatasyncSync",
	"fchmodSync",
	"fchownSync",
	"fsyncSync",
	"ftruncateSync",
	"futimesSync",
	"globSync",
	"lchmodSync",
	"lchownSync",
	"linkSync",
	"lstatSync",
	"lutimesSync",
	"mkdirSync",
	"mkdtempSync",
	"openSync",
	"opendirSync",
	"readFileSync",
	"readdirSync",
	"readlinkSync",
	"readSync",
	"readvSync",
	"realpathSync",
	"renameSync",
	"rmSync",
	"rmdirSync",
	"statSync",
	"statfsSync",
	"symlinkSync",
	"truncateSync",
	"unlinkSync",
	"utimesSync",
	"writeFileSync",
	"writeSync",
	"writevSync",
]);
const SYNC_CHILD_PROCESS_APIS = new Set(["execFileSync", "execSync", "spawnSync"]);

type CallableNode =
	| ts.FunctionDeclaration
	| ts.FunctionExpression
	| ts.ArrowFunction
	| ts.MethodDeclaration
	| ts.ConstructorDeclaration
	| ts.GetAccessorDeclaration
	| ts.SetAccessorDeclaration;

interface RootSpec {
	file: string;
	name: string;
	className?: string;
	required?: boolean;
}

interface RegionSpec {
	label: string;
	file: string;
	start: string;
	end: string;
	follow: (relativeFile: string, declarationName: string) => boolean;
}

interface WorkItem {
	callable: CallableNode;
	trace: string[];
}

interface Violation {
	root: string;
	file: string;
	line: number;
	column: number;
	api: string;
	trace: string[];
}

const ROOT_SPECS: RootSpec[] = [
	// Immutable preview artifacts and their complete metadata/list/hash/copy graph.
	...[
		"persistPreviewArtifact",
		"readPreviewArtifact",
		"restorePreviewArtifact",
		"removeArtifacts",
		"sweepOrphanArtifacts",
		"findPreviewArtifactByHash",
	].map((name) => ({ file: "src/server/preview/artifacts.ts", name, required: true })),

	// Cleanup/hash seams reached by preview routes and archive purge. The POST,
	// GET, restore, and SSE route regions below select only the preview callees
	// actually used by those routes, rather than rooting handleApiRoute wholesale.
	{ file: "src/server/preview/mount.ts", name: "contentHashForMount", required: true },
	{ file: "src/server/preview/mount.ts", name: "removeMount", required: true },

	// Boot sweeper, pool initialization/reclaim/fill/drain, inventory and shared cleanup.
	{ file: "src/server/agent/worktree-sweeper.ts", name: "sweepOrphanedWorktrees", required: true },
	{ file: "src/server/agent/worktree-pool.ts", className: "WorktreePool", name: "constructor", required: true },
	...[
		"initialize",
		"startFilling",
		"reclaimOrphaned",
		"replenish",
		"_fill",
		"stop",
		"drain",
	].map((name) => ({ file: "src/server/agent/worktree-pool.ts", className: "WorktreePool", name })),
	{ file: "src/server/agent/session-manager.ts", className: "SessionManager", name: "initWorktreePoolForProject", required: true },
	...[
		"scan",
		"cleanup",
		"legacyOrphanedWorktrees",
		"legacyArchivedSessionWorktrees",
		"cleanupLegacyArchivedSessionWorktrees",
	].map((name) => ({
		file: "src/server/agent/worktree-inventory.ts",
		className: "WorktreeInventoryService",
		name,
		required: name === "scan" || name === "cleanup",
	})),
	{ file: "src/server/skills/git.ts", name: "cleanupWorktree", required: true },

	// The whole PlanMutationStore persistence/timer surface is scoped because
	// prune shares its read/write helpers with route-driven CRUD operations.
	...[
		"constructor",
		"stopSweep",
		"ensureDir",
		"readFile",
		"writeFile",
		"put",
		"get",
		"remove",
		"listForGoal",
		"pruneExpired",
	].map((name) => ({
		file: "src/server/agent/plan-mutation-store.ts",
		className: "PlanMutationStore",
		name,
		required: name === "constructor" || name === "stopSweep" || name === "pruneExpired",
	})),

	// Scheduled/manual archive purge, stats, and the cleanup/listener call graph.
	...[
		"purgeArchivedSession",
		"purgeExpiredArchives",
		"purgeOneSession",
		"getExpiredArchiveStats",
		"startPurgeSchedule",
	].map((name) => ({
		file: "src/server/agent/session-manager.ts",
		className: "SessionManager",
		name,
		required: true,
	})),
	// Child reaping is reached by purge, but rooting its two narrow cleanup
	// bodies directly avoids treating unrelated session-replacement callbacks as
	// purge work merely because they share a generic coordinator signature.
	{ file: "src/server/agent/session-manager.ts", className: "SessionManager", name: "cascadeReapOwner" },
	{ file: "src/server/agent/session-manager.ts", className: "SessionManager", name: "_terminateSessionOwned" },

	// The bounded async scanner and the worktree-plus-recent-transcript gate.
	{ file: "src/server/agent/orphan-cleanup.ts", name: "scanOrphanedTranscriptsAsync", required: true },
	{ file: "src/server/agent/orphan-cleanup.ts", name: "shouldKeepDespiteOrphan", required: true },
];

const REGION_SPECS: RegionSpec[] = [
	{
		label: "server.preview-routes",
		file: "src/server/server.ts",
		start: "// POST /api/preview/mount?sessionId=<sid>",
		end: "// ── Background process endpoints",
		follow: (file) => file.startsWith("src/server/preview/"),
	},
	{
		label: "server.preview-purge-listener",
		file: "src/server/server.ts",
		start: "// Push a session_removed broadcast to ALL clients on terminate/archive/purge",
		end: "sessionManager.setOnPrCreationDetected",
		follow: (file) => file === "src/server/preview/artifacts.ts",
	},
	{
		label: "server.worktree-boot-seams",
		file: "src/server/server.ts",
		start: "const sweeperTask = (async () =>",
		end: "await Promise.all([transcriptBackfillTask, sweeperTask, poolInitTask]);",
		follow: (file, name) => file === "src/server/agent/worktree-sweeper.ts"
			|| (file === "src/server/agent/session-manager.ts" && name === "initWorktreePoolForProject"),
	},
];

function normalizeFile(file: string): string {
	return path.relative(REPO_ROOT, path.resolve(file)).split(path.sep).join("/");
}

function nodeName(node: ts.Node): string | undefined {
	const named = node as ts.NamedDeclaration;
	if (!named.name) return undefined;
	if (ts.isIdentifier(named.name) || ts.isPrivateIdentifier(named.name) || ts.isStringLiteralLike(named.name)) {
		return named.name.text;
	}
	return named.name.getText();
}

function isCallableWithBody(node: ts.Node): node is CallableNode {
	return (ts.isFunctionDeclaration(node)
		|| ts.isFunctionExpression(node)
		|| ts.isArrowFunction(node)
		|| ts.isMethodDeclaration(node)
		|| ts.isConstructorDeclaration(node)
		|| ts.isGetAccessorDeclaration(node)
		|| ts.isSetAccessorDeclaration(node))
		&& !!node.body;
}

function callableLabel(node: CallableNode): string {
	const source = node.getSourceFile();
	const relative = normalizeFile(source.fileName);
	const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
	let name = nodeName(node);
	if (ts.isConstructorDeclaration(node)) {
		name = ts.isClassDeclaration(node.parent) && node.parent.name
			? `${node.parent.name.text}.constructor`
			: "constructor";
	} else if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
		const owner = ts.isClassDeclaration(node.parent) && node.parent.name?.text;
		name = owner ? `${owner}.${name ?? "<method>"}` : name;
	} else if (!name && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
		const parent = node.parent;
		if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) name = parent.name.text;
		else if (ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) name = nodeName(parent);
	}
	return `${name ?? "<callback>"} (${relative}:${line + 1})`;
}

function lineAndColumn(source: ts.SourceFile, node: ts.Node): { line: number; column: number } {
	const position = source.getLineAndCharacterOfPosition(node.getStart(source));
	return { line: position.line + 1, column: position.character + 1 };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	for (;;) {
		if (ts.isParenthesizedExpression(current)
			|| ts.isAsExpression(current)
			|| ts.isTypeAssertionExpression(current)
			|| ts.isNonNullExpression(current)
			|| ts.isSatisfiesExpression(current)) {
			current = current.expression;
			continue;
		}
		return current;
	}
}

function importModuleFor(node: ts.Node): string | undefined {
	let current: ts.Node | undefined = node;
	while (current && !ts.isImportDeclaration(current)) current = current.parent;
	return current && ts.isStringLiteralLike(current.moduleSpecifier) ? current.moduleSpecifier.text : undefined;
}

function collectExpressionOrigins(
	expression: ts.Expression,
	checker: ts.TypeChecker,
	names: Set<string>,
	modules: Set<string>,
	seenSymbols = new Set<ts.Symbol>(),
): void {
	const current = unwrapExpression(expression);
	if (ts.isIdentifier(current)) {
		names.add(current.text);
		let symbol = checker.getSymbolAtLocation(current);
		if (!symbol || seenSymbols.has(symbol)) return;
		seenSymbols.add(symbol);
		if (symbol.flags & ts.SymbolFlags.Alias) {
			const aliasDeclarations = symbol.declarations ?? [];
			for (const declaration of aliasDeclarations) {
				const moduleName = importModuleFor(declaration);
				if (moduleName) modules.add(moduleName);
				if (ts.isImportSpecifier(declaration)) names.add((declaration.propertyName ?? declaration.name).text);
			}
			try { symbol = checker.getAliasedSymbol(symbol); } catch { return; }
		}
		for (const declaration of symbol.declarations ?? []) {
			const declared = nodeName(declaration);
			if (declared) names.add(declared);
			if (ts.isBindingElement(declaration)) {
				if (declaration.propertyName && ts.isIdentifier(declaration.propertyName)) names.add(declaration.propertyName.text);
				const variable = declaration.parent.parent;
				if (ts.isVariableDeclaration(variable) && variable.initializer) {
					collectExpressionOrigins(variable.initializer, checker, names, modules, seenSymbols);
				}
			} else if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
				collectExpressionOrigins(declaration.initializer, checker, names, modules, seenSymbols);
			}
		}
		return;
	}
	if (ts.isPropertyAccessExpression(current)) {
		names.add(current.name.text);
		collectExpressionOrigins(current.expression, checker, names, modules, seenSymbols);
		return;
	}
	if (ts.isElementAccessExpression(current)) {
		const argument = current.argumentExpression;
		if (argument && ts.isStringLiteralLike(argument)) names.add(argument.text);
		collectExpressionOrigins(current.expression, checker, names, modules, seenSymbols);
	}
}

function syncApiFor(call: ts.CallExpression, checker: ts.TypeChecker): string | undefined {
	const names = new Set<string>();
	const modules = new Set<string>();
	collectExpressionOrigins(call.expression, checker, names, modules);
	const signature = checker.getResolvedSignature(call);
	const declaration = signature?.declaration;
	if (declaration) {
		const declaredName = nodeName(declaration);
		if (declaredName) names.add(declaredName);
		const declarationFile = normalizeFile(declaration.getSourceFile().fileName);
		if (/node_modules\/@types\/node\/(fs|child_process)\.d\.ts$/.test(declarationFile)) {
			modules.add(declarationFile.includes("child_process") ? "node:child_process" : "node:fs");
		}
	}

	for (const name of names) {
		if (SYNC_FS_APIS.has(name)) return `filesystem ${name}`;
		if (SYNC_CHILD_PROCESS_APIS.has(name)) return `child-process ${name}`;
	}

	const expressionText = call.expression.getText(call.getSourceFile());
	const atomicsDeclaration = declaration
		? /lib\.es\d+\.sharedmemory\.d\.ts$/.test(normalizeFile(declaration.getSourceFile().fileName))
		: false;
	if (names.has("wait") && (names.has("Atomics") || /(^|\W)Atomics\s*\.\s*wait\b/.test(expressionText) || atomicsDeclaration)) {
		return "Atomics.wait";
	}

	// Keep module provenance in the analysis so aliased/destructured node imports
	// cannot silently become opaque if TypeScript changes resolved-signature shape.
	for (const moduleName of modules) {
		if ((moduleName === "node:fs" || moduleName === "fs") && [...names].some((name) => SYNC_FS_APIS.has(name))) {
			return `filesystem ${[...names].find((name) => SYNC_FS_APIS.has(name))}`;
		}
		if ((moduleName === "node:child_process" || moduleName === "child_process")
			&& [...names].some((name) => SYNC_CHILD_PROCESS_APIS.has(name))) {
			return `child-process ${[...names].find((name) => SYNC_CHILD_PROCESS_APIS.has(name))}`;
		}
	}
	return undefined;
}

function callableFromDeclaration(declaration: ts.Declaration): CallableNode | undefined {
	if (isCallableWithBody(declaration)) return declaration;
	if ((ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration))
		&& declaration.initializer) {
		const initializer = unwrapExpression(declaration.initializer);
		if (isCallableWithBody(initializer)) return initializer;
	}
	return undefined;
}

function callTargets(call: ts.CallExpression | ts.NewExpression, checker: ts.TypeChecker): CallableNode[] {
	const out = new Map<string, CallableNode>();
	const addDeclaration = (declaration: ts.Declaration | undefined): void => {
		if (!declaration) return;
		const callable = callableFromDeclaration(declaration);
		if (!callable) return;
		const file = normalizeFile(callable.getSourceFile().fileName);
		if (!file.startsWith("src/")) return;
		out.set(`${file}:${callable.pos}`, callable);
	};

	addDeclaration(checker.getResolvedSignature(call)?.declaration);
	let symbol = checker.getSymbolAtLocation(call.expression);
	if (!symbol && ts.isPropertyAccessExpression(call.expression)) {
		symbol = checker.getSymbolAtLocation(call.expression.name);
	}
	if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) {
		try { symbol = checker.getAliasedSymbol(symbol); } catch { symbol = undefined; }
	}
	for (const declaration of symbol?.declarations ?? []) addDeclaration(declaration);

	const expression = unwrapExpression(call.expression);
	if (isCallableWithBody(expression)) out.set(`${normalizeFile(expression.getSourceFile().fileName)}:${expression.pos}`, expression);
	return [...out.values()];
}

function callbackTargets(argument: ts.Expression, checker: ts.TypeChecker): CallableNode[] {
	const expression = unwrapExpression(argument);
	if (isCallableWithBody(expression)) return [expression];
	let symbol = checker.getSymbolAtLocation(expression);
	if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) {
		try { symbol = checker.getAliasedSymbol(symbol); } catch { symbol = undefined; }
	}
	return (symbol?.declarations ?? [])
		.map(callableFromDeclaration)
		.filter((node): node is CallableNode => !!node)
		.filter((node) => normalizeFile(node.getSourceFile().fileName).startsWith("src/"));
}

const CALLBACK_INVOKERS = new Set([
	"allSettledWithConcurrency",
	"catch",
	"every",
	"filter",
	"finally",
	"find",
	"findIndex",
	"flatMap",
	"forEach",
	"map",
	"mapWithConcurrency",
	"queueMicrotask",
	"reduce",
	"reduceRight",
	"setImmediate",
	"setInterval",
	"setTimeout",
	"some",
	"sort",
	"then",
]);

function callName(call: ts.CallExpression | ts.NewExpression): string | undefined {
	const expression = unwrapExpression(call.expression);
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	if (ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)) {
		return expression.argumentExpression.text;
	}
	return undefined;
}

const PURGE_GRAPH_ROOTS = new Set([
	"root SessionManager.purgeArchivedSession",
	"root SessionManager.purgeExpiredArchives",
	"root SessionManager.purgeOneSession",
	"root SessionManager.startPurgeSchedule",
	"root SessionManager.cascadeReapOwner",
	"root SessionManager._terminateSessionOwned",
]);
const PURGE_CLEANUP_FILES = new Set([
	"src/server/agent/color-store.ts",
	"src/server/agent/deletion-tombstones.ts",
	"src/server/agent/session-fs.ts",
	"src/server/agent/session-store.ts",
	"src/server/agent/system-prompt.ts",
	"src/server/agent/team-store.ts",
	"src/server/preview/artifacts.ts",
	"src/server/preview/mount.ts",
	"src/server/skills/git.ts",
]);
const PURGE_ENTRY_METHODS = new Set(["purgeOneSession", "purgeExpiredArchives"]);

function targetIsInScope(item: WorkItem, target: CallableNode): boolean {
	const root = item.trace[0];
	const file = normalizeFile(target.getSourceFile().fileName);
	if (PURGE_GRAPH_ROOTS.has(root)) {
		if (PURGE_CLEANUP_FILES.has(file) || file === "src/server/agent/bounded-async-work.ts") return true;
		return file === "src/server/agent/session-manager.ts" && PURGE_ENTRY_METHODS.has(nodeName(target) ?? "");
	}
	if (root.startsWith("root WorktreeInventoryService.")) {
		return file === "src/server/agent/worktree-inventory.ts"
			|| file === "src/server/agent/bounded-async-work.ts"
			|| file === "src/server/skills/git.ts";
	}
	return true;
}

function findRoot(source: ts.SourceFile, spec: RootSpec): CallableNode | undefined {
	let found: CallableNode | undefined;
	const visit = (node: ts.Node): void => {
		if (found) return;
		if (spec.className && ts.isClassDeclaration(node) && node.name?.text === spec.className) {
			for (const member of node.members) {
				const memberName = ts.isConstructorDeclaration(member) ? "constructor" : nodeName(member);
				if (memberName === spec.name && isCallableWithBody(member)) {
					found = member;
					return;
				}
			}
			return;
		}
		if (!spec.className && isCallableWithBody(node) && nodeName(node) === spec.name) {
			found = node;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function productionTypeScriptFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...productionTypeScriptFiles(absolute));
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
	}
	return files;
}

function createScopedProgram(): ts.Program {
	// Root production source explicitly and disable dependency expansion. This
	// retains one cross-file TypeChecker for aliases, destructuring, methods and
	// wrappers while avoiding the cost of loading/checking every third-party
	// declaration pulled in by server.ts. The static guard must fit the 15 s solo
	// unit-file budget on Windows as well as Linux.
	const rootNames = productionTypeScriptFiles(path.resolve("src/server"));
	const sharedRoot = path.resolve("src/shared");
	if (fs.existsSync(sharedRoot)) rootNames.push(...productionTypeScriptFiles(sharedRoot));
	return ts.createProgram({
		rootNames,
		options: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.Node16,
			moduleResolution: ts.ModuleResolutionKind.Node16,
			noLib: true,
			noResolve: true,
			skipLibCheck: true,
			noEmit: true,
		},
	});
}

function findScopedSyncIo(): { violations: Violation[]; missingRoots: string[] } {
	const program = createScopedProgram();
	const checker = program.getTypeChecker();
	const queue: WorkItem[] = [];
	const visited = new Set<string>();
	const violations: Violation[] = [];
	const violationKeys = new Set<string>();
	const missingRoots: string[] = [];
	const callablesByName = new Map<string, CallableNode[]>();
	for (const source of program.getSourceFiles()) {
		if (!normalizeFile(source.fileName).startsWith("src/")) continue;
		const indexCallable = (node: ts.Node): void => {
			if (isCallableWithBody(node)) {
				const name = nodeName(node);
				if (name) callablesByName.set(name, [...(callablesByName.get(name) ?? []), node]);
			}
			ts.forEachChild(node, indexCallable);
		};
		indexCallable(source);
	}

	const sourceFor = (relativeFile: string): ts.SourceFile | undefined => {
		const absolute = path.resolve(relativeFile);
		return program.getSourceFiles().find((source) => path.resolve(source.fileName) === absolute);
	};
	const enqueue = (callable: CallableNode, trace: string[]): void => {
		queue.push({ callable, trace });
	};
	const recordViolation = (call: ts.CallExpression, api: string, trace: string[]): void => {
		const source = call.getSourceFile();
		const file = normalizeFile(source.fileName);
		const position = lineAndColumn(source, call);
		const key = `${file}:${call.getStart(source)}:${api}`;
		if (violationKeys.has(key)) return;
		violationKeys.add(key);
		violations.push({ root: trace[0], file, ...position, api, trace });
	};

	for (const spec of ROOT_SPECS) {
		const source = sourceFor(spec.file);
		const root = source && findRoot(source, spec);
		if (!root) {
			if (spec.required) missingRoots.push(`${spec.file}::${spec.className ? `${spec.className}.` : ""}${spec.name}`);
			continue;
		}
		enqueue(root, [`root ${spec.className ? `${spec.className}.` : ""}${spec.name}`]);
	}

	// This unused sync twin is explicitly required to be deleted, not converted
	// or maintained beside the bounded async scanner.
	const orphanSource = sourceFor("src/server/agent/orphan-cleanup.ts");
	const legacyScanner = orphanSource && findRoot(orphanSource, {
		file: "src/server/agent/orphan-cleanup.ts",
		name: "scanOrphanedTranscripts",
	});
	if (legacyScanner) {
		const source = legacyScanner.getSourceFile();
		const position = lineAndColumn(source, legacyScanner);
		violations.push({
			root: "root orphan-cleanup legacy scanner",
			file: normalizeFile(source.fileName),
			...position,
			api: "legacy synchronous scanner must be removed",
			trace: ["root orphan-cleanup legacy scanner"],
		});
		enqueue(legacyScanner, ["root orphan-cleanup legacy scanner"]);
	}

	for (const region of REGION_SPECS) {
		const source = sourceFor(region.file);
		if (!source) {
			missingRoots.push(`${region.file}::${region.label}`);
			continue;
		}
		const text = source.getFullText();
		const start = text.indexOf(region.start);
		const endStart = start >= 0 ? text.indexOf(region.end, start + region.start.length) : -1;
		if (start < 0 || endStart < 0) {
			missingRoots.push(`${region.file}::${region.label} markers`);
			continue;
		}
		const end = endStart + region.end.length;
		const trace = [`root ${region.label}`];
		const visitRegion = (node: ts.Node): void => {
			if (node.end < start || node.pos > end) return;
			if (ts.isCallExpression(node) && node.getStart(source) >= start && node.getStart(source) < end) {
				const api = syncApiFor(node, checker);
				if (api) recordViolation(node, api, trace);
				const resolvedTargets = callTargets(node, checker);
				const targetKeys = new Set(resolvedTargets.map((target) => `${normalizeFile(target.getSourceFile().fileName)}:${target.pos}`));
				const syntacticName = callName(node);
				if (syntacticName) {
					for (const target of callablesByName.get(syntacticName) ?? []) {
						const key = `${normalizeFile(target.getSourceFile().fileName)}:${target.pos}`;
						if (!targetKeys.has(key)) resolvedTargets.push(target);
					}
				}
				for (const target of resolvedTargets) {
					const targetFile = normalizeFile(target.getSourceFile().fileName);
					const targetName = nodeName(target) ?? callableLabel(target).split(" ")[0];
					if (region.follow(targetFile, targetName)) enqueue(target, [...trace, callableLabel(target)]);
				}
			}
			ts.forEachChild(node, visitRegion);
		};
		visitRegion(source);
	}

	while (queue.length > 0) {
		const item = queue.shift()!;
		const callableFile = normalizeFile(item.callable.getSourceFile().fileName);
		const callableKey = `${callableFile}:${item.callable.pos}`;
		if (visited.has(callableKey)) continue;
		visited.add(callableKey);
		const body = item.callable.body;
		if (!body) continue;

		const visit = (node: ts.Node): void => {
			if (node !== body && isCallableWithBody(node)) return;
			if (ts.isCallExpression(node)) {
				const api = syncApiFor(node, checker);
				if (api) recordViolation(node, api, item.trace);
				for (const target of callTargets(node, checker)) {
					if (targetIsInScope(item, target)) enqueue(target, [...item.trace, callableLabel(target)]);
				}
				if (CALLBACK_INVOKERS.has(callName(node) ?? "")) {
					for (const argument of node.arguments) {
						for (const target of callbackTargets(argument, checker)) {
							if (targetIsInScope(item, target)) enqueue(target, [...item.trace, callableLabel(target)]);
						}
					}
				}
			} else if (ts.isNewExpression(node)) {
				for (const target of callTargets(node, checker)) {
					if (targetIsInScope(item, target)) enqueue(target, [...item.trace, callableLabel(target)]);
				}
				if (callName(node) === "Promise") {
					for (const argument of node.arguments ?? []) {
						for (const target of callbackTargets(argument, checker)) {
							if (targetIsInScope(item, target)) enqueue(target, [...item.trace, callableLabel(target)]);
						}
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(body);
	}

	violations.sort((a, b) => a.file.localeCompare(b.file)
		|| a.line - b.line
		|| a.column - b.column
		|| a.api.localeCompare(b.api));
	missingRoots.sort();
	return { violations, missingRoots };
}

function formatFailure(violations: Violation[], missingRoots: string[]): string {
	const lines = [`${MARKER}: scoped background-cleanup call graph contains blocking operations`];
	for (const missing of missingRoots) lines.push(`MISSING_ROOT ${missing}`);
	for (const violation of violations) {
		lines.push(`${violation.file}:${violation.line}:${violation.column} ${violation.api}`);
		lines.push(`  trace: ${violation.trace.join(" -> ")} -> ${violation.file}:${violation.line}`);
	}
	return lines.join("\n");
}

describe("async background cleanup static boundary", () => {
	it("has zero synchronous I/O in the scoped production call graph", { retry: 0 }, () => {
		const { violations, missingRoots } = findScopedSyncIo();
		expect(
			missingRoots.length + violations.length,
			formatFailure(violations, missingRoots),
		).toBe(0);
	});
});
