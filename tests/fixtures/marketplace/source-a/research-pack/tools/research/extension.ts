// Research Pack fixture tool — executable code payload (drives the §9 warning).
export async function web_dig(args: { url: string }): Promise<{ result: string }> {
	return { result: `dug into ${args.url}` };
}
