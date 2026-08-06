const NUMERIC = String.raw`(?:0|[1-9]\d*)`;
const PRERELEASE_ID = String.raw`(?:${NUMERIC}|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const BUILD_ID = String.raw`[0-9A-Za-z-]+`;
const VERSION_PATTERN = new RegExp(
	String.raw`^(${NUMERIC})\.(${NUMERIC})\.(${NUMERIC})` +
		String.raw`(?:-(${PRERELEASE_ID}(?:\.${PRERELEASE_ID})*))?` +
		String.raw`(?:\+${BUILD_ID}(?:\.${BUILD_ID})*)?$`,
);

export function isExactVersion(value) {
	return typeof value === "string" && VERSION_PATTERN.test(value);
}

function parseVersion(value) {
	const match = VERSION_PATTERN.exec(value);
	if (!match) throw new Error(`invalid version: ${value}`);
	return {
		core: match.slice(1, 4).map(BigInt),
		prerelease: match[4]?.split(".") ?? [],
	};
}

// SemVer gives numeric identifiers lower precedence than non-numeric ones;
// build metadata is parsed but intentionally does not affect ordering.
function comparePrerelease(left, right) {
	if (left.length === 0 || right.length === 0) {
		return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
	}
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		if (index >= left.length) return -1;
		if (index >= right.length) return 1;
		const [a, b] = [left[index], right[index]];
		const [aNumeric, bNumeric] = [/^\d+$/.test(a), /^\d+$/.test(b)];
		if (aNumeric && bNumeric && BigInt(a) !== BigInt(b)) return BigInt(a) < BigInt(b) ? -1 : 1;
		if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
		if (!aNumeric && a !== b) return a < b ? -1 : 1;
	}
	return 0;
}

export function compareReleaseVersions(leftValue, rightValue) {
	const [left, right] = [parseVersion(leftValue), parseVersion(rightValue)];
	for (let index = 0; index < 3; index += 1) {
		if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
	}
	return comparePrerelease(left.prerelease, right.prerelease);
}

export async function assertDistTagAdvances({ packageName, distTag, version, fetchImpl = fetch }) {
	const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(distTag)}`;
	const response = await fetchImpl(url, { headers: { accept: "application/json" } });
	if (response.status === 404) {
		console.log(`dist-tag ${distTag} does not exist yet`);
		return null;
	}
	if (!response.ok) throw new Error(`dist-tag lookup returned ${response.status}`);

	const current = (await response.json()).version;
	if (compareReleaseVersions(version, current) <= 0) {
		throw new Error(`refusing to move ${distTag} backwards: ${current} -> ${version}`);
	}
	console.log(`${distTag} will advance ${current} -> ${version}`);
	return current;
}
