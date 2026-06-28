const GENERATED_DIRECTORY_NAMES = new Set([
	".next",
	".nuxt",
	"build",
	"coverage",
	"dist",
	"gen",
	"generated",
	"out",
	"target",
	"__generated__",
	"__snapshots__",
]);

const LOCKFILE_NAMES = new Set([
	"bun.lock",
	"bun.lockb",
	"cargo.lock",
	"composer.lock",
	"gemfile.lock",
	"go.sum",
	"npm-shrinkwrap.json",
	"package-lock.json",
	"pipfile.lock",
	"pnpm-lock.yaml",
	"poetry.lock",
	"uv.lock",
	"yarn.lock",
]);

const GENERATED_BASENAME_MARKER = /(?:^|[._-])(?:designer|gen|generated|grpc|pb|pb2)(?:[._-]|$)|[._-]g[._-]/;

export function isLikelyGeneratedPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/").toLowerCase().replace(/^\.\/+/, "");
	const segments = normalized.split("/").filter(Boolean);
	const basename = segments.at(-1) ?? normalized;
	const directories = segments.slice(0, -1);

	return isBuiltMarketPackOutput(segments)
		|| directories.some(segment => GENERATED_DIRECTORY_NAMES.has(segment))
		|| LOCKFILE_NAMES.has(basename)
		|| basename.endsWith(".snap")
		|| basename.includes(".min.")
		|| basename.endsWith(".map")
		|| GENERATED_BASENAME_MARKER.test(basename);
}

function isBuiltMarketPackOutput(segments: string[]): boolean {
	for (let index = 0; index < segments.length - 3; index += 1) {
		if (segments[index] === "market-packs" && segments[index + 2] === "lib") return true;
	}
	return false;
}
