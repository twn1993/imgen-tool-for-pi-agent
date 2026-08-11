/**
 * imgen-tool — image generation & editing extension for pi.
 *
 * Registers two custom tools backed by the gpt-image-2 model through an
 * OpenAI-compatible relay (no Python required, pure Node):
 *   - imgen_generate: text-to-image  -> POST /images/generations
 *   - imgen_edit:     image-to-image -> POST /images/edits (multipart, optional mask)
 *
 * The endpoint URL and API keys live in config.json next to this file, so the
 * tools stay portable: edit config.json to point at another relay or rotate
 * keys — no code changes needed. Keys are rotated automatically on HTTP
 * 401/403/429.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(EXT_DIR, "config.json");

// Some relays reject Python/Node default user agents with Cloudflare 403
// (Error 1010). Override via user_agent in config.json.
const DEFAULT_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface RelayConfig {
	base_url: string;
	api_key?: string;
	api_keys?: string[];
	model?: string;
	default_size?: string;
	default_quality?: string;
	default_format?: string;
	user_agent?: string;
	timeout_seconds?: number;
}

// ---------------------------------------------------------------------------
// Config + relay plumbing
// ---------------------------------------------------------------------------

async function loadConfig(): Promise<RelayConfig> {
	let text: string;
	try {
		text = await readFile(CONFIG_PATH, "utf8");
	} catch {
		throw new Error(
			`imgen: config not found at ${CONFIG_PATH}. Create config.json next to this extension (see README.md).`
		);
	}
	try {
		return JSON.parse(text) as RelayConfig;
	} catch (e) {
		throw new Error(`imgen: invalid JSON in ${CONFIG_PATH}: ${(e as Error).message}`);
	}
}

function collectKeys(cfg: RelayConfig): string[] {
	const keys: string[] = [];
	if (cfg.api_key) keys.push(cfg.api_key.trim());
	for (const k of cfg.api_keys ?? []) {
		const t = k.trim();
		if (t && !keys.includes(t)) keys.push(t);
	}
	if (keys.length === 0) {
		throw new Error("imgen: no API key configured. Set api_key or api_keys in config.json.");
	}
	return keys;
}

function errorMessage(raw: string): string {
	try {
		const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
		if (typeof parsed?.error?.message === "string") return parsed.error.message;
		return raw.slice(0, 500);
	} catch {
		return raw.slice(0, 500);
	}
}

/**
 * POST to the relay, rotating keys on 401/403/429, honoring the tool's
 * abort signal plus the configured timeout. content_type is only set when
 * non-empty (FormData must set its own multipart boundary).
 */
async function relayPost(
	cfg: RelayConfig,
	path: string,
	body: BodyInit,
	contentType: string,
	signal: AbortSignal | undefined
): Promise<any> {
	const keys = collectKeys(cfg);
	const timeoutMs = (cfg.timeout_seconds ?? 300) * 1000;
	const ac = new AbortController();
	const onAbort = () => ac.abort();
	signal?.addEventListener("abort", onAbort);
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		let last: { code: number; body: string } | null = null;
		for (const key of keys) {
			try {
				const headers: Record<string, string> = {
					Authorization: `Bearer ${key}`,
					Accept: "application/json",
					"User-Agent": cfg.user_agent ?? DEFAULT_UA,
				};
				if (contentType) headers["Content-Type"] = contentType;
				const res = await fetch(cfg.base_url.replace(/\/+$/, "") + path, {
					method: "POST",
					headers,
					body,
					signal: ac.signal,
				});
				const text = await res.text();
				if (!res.ok) {
					last = { code: res.status, body: text };
					if (res.status === 401 || res.status === 403 || res.status === 429) continue; // try next key
					break;
				}
				return JSON.parse(text);
			} catch (e) {
				if (e instanceof Error && e.name === "AbortError") {
					throw new Error("imgen: request aborted (timeout or user cancellation).");
				}
				throw new Error(
					`imgen: network error contacting ${cfg.base_url}: ${(e as Error).message}`
				);
			}
		}
		throw new Error(
			`imgen: relay returned HTTP ${last?.code ?? "?"}: ${errorMessage(last?.body ?? "")}`
		);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function generate(
	cfg: RelayConfig,
	prompt: string,
	size: string,
	quality: string,
	format: string,
	signal: AbortSignal | undefined
): Promise<any> {
	const payload = {
		model: cfg.model ?? "gpt-image-2",
		prompt,
		n: 1,
		size,
		quality,
		output_format: format,
		response_format: "b64_json",
	};
	return relayPost(cfg, "/images/generations", JSON.stringify(payload), "application/json", signal);
}

async function edit(
	cfg: RelayConfig,
	imageAbs: string,
	prompt: string,
	size: string,
	quality: string,
	format: string,
	maskAbs: string | undefined,
	signal: AbortSignal | undefined
): Promise<any> {
	const form = new FormData();
	form.append("model", cfg.model ?? "gpt-image-2");
	form.append("prompt", prompt);
	form.append("n", "1");
	form.append("size", size);
	form.append("quality", quality);
	form.append("output_format", format);
	form.append("response_format", "b64_json");
	form.append("image", new Blob([await readFile(imageAbs)]), basename(imageAbs));
	if (maskAbs) {
		form.append("mask", new Blob([await readFile(maskAbs)]), basename(maskAbs));
	}
	return relayPost(cfg, "/images/edits", form, "", signal);
}

async function saveItem(item: any, outputAbs: string, signal: AbortSignal | undefined): Promise<number> {
	let raw: Buffer;
	if (typeof item?.b64_json === "string") {
		raw = Buffer.from(item.b64_json, "base64");
	} else if (typeof item?.url === "string") {
		const res = await fetch(item.url, { signal });
		if (!res.ok) {
			throw new Error(`imgen: failed to download image from ${item.url}: HTTP ${res.status}`);
		}
		raw = Buffer.from(await res.arrayBuffer());
	} else {
		throw new Error(`imgen: unexpected image item in response: ${JSON.stringify(Object.keys(item ?? {}))}`);
	}
	await mkdir(dirname(outputAbs), { recursive: true });
	await writeFile(outputAbs, raw);
	return raw.length;
}

/** Models sometimes prefix tool path arguments with @ — normalize it. */
function resolveOutput(raw: string, cwd: string): string {
	let p = raw.trim();
	if (p.startsWith("@")) p = p.slice(1);
	return isAbsolute(p) ? p : resolve(cwd, p);
}

function checkSize(size: string): void {
	if (!size || size === "auto") return;
	const m = /^(\d+)x(\d+)$/i.exec(size.trim());
	if (!m) {
		throw new Error(`imgen: invalid size "${size}" — use WxH (e.g. 1024x1024, 2560x1440) or auto.`);
	}
	const w = Number(m[1]);
	const h = Number(m[2]);
	const problems: string[] = [];
	if (w % 16 !== 0 || h % 16 !== 0) problems.push("both edges must be multiples of 16");
	if (Math.max(w, h) > 3840) problems.push("maximum edge is 3840px");
	if (Math.max(w, h) / Math.min(w, h) > 3) problems.push("aspect ratio must be ≤ 3:1");
	const px = w * h;
	if (px < 655360 || px > 8294400) problems.push("total pixels must be 655,360 – 8,294,400");
	if (problems.length) {
		throw new Error(`imgen: size ${size} is invalid — ${problems.join("; ")}.`);
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function imgenExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "imgen_generate",
		label: "Generate Image",
		description:
			"Generate a new image from a text description (text-to-image) using gpt-image-2 via the relay configured in the extension's config.json. Saves the image to a file and returns its path. The prompt passed to the model must be English — translate the user's request first if it is in another language.",
		promptSnippet: "Generate an image from a text prompt and save it to a file",
		promptGuidelines: [
			"Use imgen_generate whenever the user asks to create/generate/draw/render an image from a description (in any language); translate the request into an English prompt, save the image to the path the user asked for (or a sensible default), and report the saved path.",
		],
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Image description. Must be in English — translate the user's request first if it is in another language. Include subject, style, lighting, composition, mood.",
			}),
			output: Type.String({
				description:
					"Output file path (absolute, or relative to the working directory). Parent folders are created automatically. Use .png, .jpg/.jpeg or .webp extension.",
			}),
			size: Type.Optional(
				Type.String({
					description:
						"Image size WxH or auto (default from config). Examples: 1024x1024, 1536x1024, 2048x1152, 2560x1440.",
				})
			),
			quality: Type.Optional(StringEnum(["auto", "low", "medium", "high"] as const)),
			format: Type.Optional(StringEnum(["png", "jpeg", "webp"] as const)),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cfg = await loadConfig();
			const size = params.size ?? cfg.default_size ?? "auto";
			const quality = params.quality ?? cfg.default_quality ?? "auto";
			const format = params.format ?? cfg.default_format ?? "png";
			checkSize(size);
			const outputAbs = resolveOutput(params.output, ctx.cwd);
			return withFileMutationQueue(outputAbs, async () => {
				const data = await generate(cfg, params.prompt, size, quality, format, signal);
				const items = data?.data ?? [];
				if (!items.length) throw new Error("imgen: relay returned no images.");
				const bytes = await saveItem(items[0], outputAbs, signal);
				return {
					content: [
						{
							type: "text",
							text: `Saved: ${outputAbs} (${(bytes / 1024).toFixed(0)} KB)`,
						},
					],
					details: {
						output: outputAbs,
						bytes,
						size,
						quality,
						format,
						model: cfg.model ?? "gpt-image-2",
					},
				};
			});
		},
	});

	pi.registerTool({
		name: "imgen_edit",
		label: "Edit Image",
		description:
			"Edit or transform an existing image file (image-to-image) using gpt-image-2: replace/remove/change objects, people or animals, restyle, or change the background. Use a strong English imperative prompt stating what to remove/replace and what must stay unchanged (soft prompts tend to only redraw the background). Optionally pass a mask image (white = area to regenerate). Saves the result and returns its path.",
		promptSnippet: "Edit an existing image (replace/remove subjects, change style or background) and save the result",
		promptGuidelines: [
			"Use imgen_edit whenever the user asks to edit/modify/transform an existing image file or replace something in a photo; translate the user's request into a strong imperative English prompt (what to remove/replace, what to keep identical) and save the result to the requested path.",
		],
		parameters: Type.Object({
			image: Type.String({
				description: "Path to the input image file (absolute, or relative to the working directory).",
			}),
			prompt: Type.String({
				description:
					"Edit instructions in English, imperative form: what to remove/replace and what must stay unchanged, e.g. \"Remove X completely and replace it with Y in the same spot. Keep everything else exactly the same.\"",
			}),
			output: Type.String({
				description:
					"Output file path (absolute, or relative to the working directory). Parent folders are created automatically.",
			}),
			mask: Type.Optional(
				Type.String({
					description: "Optional mask image path; white areas are regenerated, black areas are preserved.",
				})
			),
			size: Type.Optional(
				Type.String({ description: "Image size WxH or auto (default from config)." })
			),
			quality: Type.Optional(StringEnum(["auto", "low", "medium", "high"] as const)),
			format: Type.Optional(StringEnum(["png", "jpeg", "webp"] as const)),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cfg = await loadConfig();
			const size = params.size ?? cfg.default_size ?? "auto";
			const quality = params.quality ?? cfg.default_quality ?? "auto";
			const format = params.format ?? cfg.default_format ?? "png";
			checkSize(size);
			const imageAbs = resolveOutput(params.image, ctx.cwd);
			const maskAbs = params.mask ? resolveOutput(params.mask, ctx.cwd) : undefined;
			const outputAbs = resolveOutput(params.output, ctx.cwd);
			try {
				await readFile(imageAbs);
			} catch {
				throw new Error(`imgen: input image not found: ${imageAbs}`);
			}
			if (maskAbs) {
				try {
					await readFile(maskAbs);
				} catch {
					throw new Error(`imgen: mask not found: ${maskAbs}`);
				}
			}
			return withFileMutationQueue(outputAbs, async () => {
				const data = await edit(cfg, imageAbs, params.prompt, size, quality, format, maskAbs, signal);
				const items = data?.data ?? [];
				if (!items.length) throw new Error("imgen: relay returned no images.");
				const bytes = await saveItem(items[0], outputAbs, signal);
				return {
					content: [
						{
							type: "text",
							text: `Saved: ${outputAbs} (${(bytes / 1024).toFixed(0)} KB)`,
						},
					],
					details: {
						output: outputAbs,
						bytes,
						size,
						quality,
						format,
						input: imageAbs,
						model: cfg.model ?? "gpt-image-2",
					},
				};
			});
		},
	});
}
