export type GoalGithubLinkResponse =
	| { available: true; url: string; kind: "pr" | "branch" }
	| { available: false; reason: "no-branch" | "no-github-remote" | "goal-not-found" };

export function parseGithubRemoteUrl(remoteUrl: string): { host: string; owner: string; repo: string } | null {
	const raw = remoteUrl.trim();
	if (!raw) return null;

	const fromParts = (host: string, owner: string, repo: string): { host: string; owner: string; repo: string } | null => {
		const normalizedHost = host.trim().toLowerCase();
		if (!isGithubHost(normalizedHost)) return null;
		const normalizedOwner = owner.trim();
		const normalizedRepo = repo.trim().replace(/\.git$/i, "");
		if (!isSafeGithubPathSegment(normalizedOwner) || !isSafeGithubPathSegment(normalizedRepo)) return null;
		return { host: normalizedHost, owner: normalizedOwner, repo: normalizedRepo };
	};

	try {
		const parsed = new URL(raw);
		if (parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "ssh:") {
			const segments = parsed.pathname.split("/").filter(Boolean);
			if (segments.length >= 2) return fromParts(parsed.hostname, segments[0], segments[1]);
		}
	} catch {
		// SSH scp-style remotes are handled below.
	}

	const scpLike = raw.match(/^(?:[^@\s]+@)?([^:\s/]+):([^\s/]+)\/([^\s/]+)$/);
	if (scpLike) return fromParts(scpLike[1], scpLike[2], scpLike[3]);

	return null;
}

export function buildGithubBranchUrl(remoteUrl: string, branch: string): string | null {
	const parsed = parseGithubRemoteUrl(remoteUrl);
	if (!parsed || !branch.trim()) return null;
	return `https://${parsed.host}/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/tree/${encodeURIComponent(branch)}`;
}

function isGithubHost(host: string): boolean {
	return host === "github.com" || host.endsWith(".github.com");
}

function isSafeGithubPathSegment(segment: string): boolean {
	return /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== "." && segment !== "..";
}
