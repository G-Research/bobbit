import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { getGatewayUrl, getGatewayToken } from "../_shared/gateway.ts";

function outputPathFor(basePath: string, index: number, count: number, mimeType: string): string {
	const extFromMime = mimeType.includes("jpeg") ? ".jpg" : mimeType.includes("webp") ? ".webp" : ".png";
	const parsed = path.parse(basePath);
	const ext = parsed.ext || extFromMime;
	const rawTarget = count <= 1
		? (parsed.ext ? basePath : `${basePath}${ext}`)
		: path.join(parsed.dir, `${parsed.name}-${index + 1}${ext}`);
	const resolved = path.resolve(process.cwd(), rawTarget);
	// Containment: outputPath is model-controlled. Reject any path that escapes the
	// session worktree (parent traversal or absolute path outside cwd).
	const rel = path.relative(process.cwd(), resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error("outputPath escapes worktree");
	}
	return resolved;
}

const extension: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "generate_image",
		label: "Generate Image",
		description: "Generate images using GPT Image 2, DALL-E, Nano Banana/Gemini, or another configured image generation model.",
		promptSnippet: "generate_image: Generate raster images. Supports GPT Image 2 via model=\"openai/gpt-image-2\" and uses the configured session image model by default.",
		promptGuidelines: [
			"Use generate_image when the user asks for AI image generation or bitmap visual assets.",
			"Do not call MCP image tools such as mcp__nano-banana__generate_image; this tool owns image generation routing.",
			"If the user asks for GPT Image 2, ChatGPT Images 2.0, or gpt-image-2, call generate_image with model=\"openai/gpt-image-2\".",
			"Use exact Google image model ids: Gemini 3.1 Flash Image is google/gemini-3.1-flash-image-preview, Gemini 3 Pro Image is google/gemini-3-pro-image-preview, Gemini 2.5 Flash Image is google/gemini-2.5-flash-image, Imagen 4 Ultra is google/imagen-4.0-ultra-generate-001, Imagen 4 Standard is google/imagen-4.0-generate-001, Imagen 4 Fast is google/imagen-4.0-fast-generate-001. Google also refers to Gemini 2.5 Flash Image as Nano Banana and Gemini 3 Pro Image as Nano Banana Pro. If the user asks for Nano Banana 2, use Gemini 3 Pro Image unless they explicitly provide another Google model id.",
			"Use outputPath when the generated image should become a project asset.",
			"Prefer the configured session image model. Omit model unless the user explicitly names a non-default provider/model in the prompt.",
			"If the selected or requested model fails because of auth or provider availability, report the failure and ask before switching to another provider.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Detailed image prompt" }),
			outputPath: Type.Optional(Type.String({ description: "Optional path to save the generated image" })),
			model: Type.Optional(Type.String({ description: "Optional override as provider/modelId" })),
			size: Type.Optional(Type.String({ description: "OpenAI size, e.g. 1024x1024, 1536x1024, 1024x1536, or auto" })),
			quality: Type.Optional(Type.String({ description: "OpenAI quality, e.g. auto, low, medium, high, standard, or hd" })),
			background: Type.Optional(Type.Union([
				Type.Literal("auto"),
				Type.Literal("transparent"),
				Type.Literal("opaque"),
			])),
			format: Type.Optional(Type.Union([
				Type.Literal("png"),
				Type.Literal("jpeg"),
				Type.Literal("webp"),
			])),
			aspectRatio: Type.Optional(Type.String({ description: "Gemini aspect ratio, e.g. 1:1, 16:9, 9:16" })),
			imageSize: Type.Optional(Type.String({ description: "Provider-specific image size" })),
			n: Type.Optional(Type.Number({ description: "Number of images to generate", minimum: 1, maximum: 4 })),
		}),
		async execute(_toolCallId, params) {
			let baseUrl: string;
			let token: string;
			try {
				baseUrl = getGatewayUrl();
				token = getGatewayToken();
			} catch {
				return {
					content: [{ type: "text" as const, text: "Image generation failed: missing Bobbit gateway credentials." }],
					isError: true,
				} as any;
			}

			let response: Response;
			try {
				response = await fetch(`${baseUrl}/api/image-generation/generate`, {
					method: "POST",
					headers: {
						"Authorization": `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						sessionId: process.env.BOBBIT_SESSION_ID,
						prompt: params.prompt,
						model: params.model,
						size: params.size,
						quality: params.quality,
						background: params.background,
						format: params.format,
						aspectRatio: params.aspectRatio,
						imageSize: params.imageSize,
						n: params.n,
					}),
				});
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `Image generation failed: ${err?.message || err}` }],
					isError: true,
				} as any;
			}

			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				return {
					content: [{ type: "text" as const, text: `Image generation failed: ${data?.error || response.statusText}` }],
					isError: true,
				} as any;
			}

			const images = Array.isArray(data.images) ? data.images : [];
			const savedPaths: string[] = [];
			if (params.outputPath) {
				if (images.length === 1) {
					// Single-image fast path — resolve once and mkdir once.
					const image = images[0];
					const filePath = outputPathFor(params.outputPath, 0, 1, image.mimeType || "image/png");
					fs.mkdirSync(path.dirname(filePath), { recursive: true });
					fs.writeFileSync(filePath, Buffer.from(image.data, "base64"));
					savedPaths.push(filePath);
				} else {
					for (let i = 0; i < images.length; i++) {
						const image = images[i];
						const filePath = outputPathFor(params.outputPath, i, images.length, image.mimeType || "image/png");
						fs.mkdirSync(path.dirname(filePath), { recursive: true });
						fs.writeFileSync(filePath, Buffer.from(image.data, "base64"));
						savedPaths.push(filePath);
					}
				}
			}

			const modelLabel = data.model ? `${data.model.provider}/${data.model.id}` : "configured image model";
			const text = [
				`Generated ${images.length} image${images.length === 1 ? "" : "s"} with ${modelLabel}.`,
				...savedPaths.map((p) => `Saved: ${p}`),
			].join("\n");

			return {
				content: [
					{ type: "text" as const, text },
					...images.map((image: any) => ({
						type: "image" as const,
						data: image.data,
						mimeType: image.mimeType || "image/png",
					})),
				],
				details: { model: data.model, savedPaths },
			};
		},
	});
};

export default extension;
