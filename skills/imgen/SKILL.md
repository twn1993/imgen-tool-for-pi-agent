---
name: imgen
description: Generates and edits images (text-to-image, image-to-image) with the gpt-image-2 model via a relay API. Use whenever the user asks to create/draw/generate an image from a description, edit or transform an existing image (replace/remove/change objects, people, or animals; restyle or change the background), or save an image to a specific file path or folder. Triggers on English and Chinese requests alike (e.g. 生成一张图片、画一个…、把图里的猫换成狗、做一张海报、把照片改成夜晚风格). Do NOT use for analyzing or describing images without modifying them, or for generating non-image files.
compatibility:
  - Custom tools imgen_generate / imgen_edit (registered by the imgen-tool extension)
  - Network access to the relay endpoint configured in the extension's config.json
---

# imgen — image generation & editing via relay tools

Generate and edit images with `gpt-image-2` through an OpenAI-compatible relay
using two custom tools registered by the **imgen-tool** extension:

- `imgen_generate` — text-to-image: `prompt`, `output`, optional `size` / `quality` / `format`
- `imgen_edit` — image-to-image / editing: `image`, `prompt`, `output`, optional `mask` / `size` / `quality` / `format`

No Python or shell involved — the tools call the relay directly, save the image
file themselves, and return the saved path. If the tools are listed in your
session's available tools, call them directly; this skill only provides the
workflow knowledge (prompting, sizing, error handling).

## When to invoke

- User asks to create/generate/draw an image from a description (text-to-image), in any language.
- User asks to edit or transform an existing image file — replace/remove/change a subject, restyle, or swap the background.
- User names a target file path or folder for the image, or hands over a file to work from.
- Proactively when an image artifact would satisfy the request, even if the user never says "image" (e.g. "make a poster of...", "画一张…"); don't fall back to describing what the image would look like.

## Workflow: text-to-image

1. **Decide the output location.** If the user named a file or folder, use it verbatim. Otherwise choose a sensible default (current working directory, an `outputs/` folder, or next to the input file) and tell the user the final path. The tool creates parent folders automatically.
2. **Translate the user's request into English first**, whatever language they used — gpt-image-2 follows English prompts most reliably. Capture subject, style, lighting, composition, mood. E.g. "a red fox in a snowy forest, photorealistic, golden hour light".
3. **Call `imgen_generate`** with the English prompt and the resolved output path; pass `size`/`quality`/`format` when the user cares about them.
4. **Verify and report**: confirm the saved file exists and is non-trivial (> 50 KB), then report the absolute saved path and file size.

## Workflow: image editing

Editing uses `imgen_edit` with the input image. Edits need a firmer hand than generation:

- **Translate the user's edit request into English first** — never pass a non-English prompt to the model.
- Write the prompt in **English, imperative form**: say what to remove/replace and what to keep. "Remove the orange cat completely and replace it with a white husky in the same spot. Keep the windowsill, plants and lighting exactly the same. Only the animal must change."
- Soft prompts like "change the cat to a dog, keep other things similar" often make the model redraw only the background and leave the subject untouched — that is why the imperative structure matters.
- If only one region should change, provide a `mask` (white = regenerated area).
- If the user gave no edit instructions, use a gentle enhancement prompt ("Enhance this image and keep the content unchanged").

## Sizes, quality, formats

- `size`: any `WxH` with both edges multiples of 16, max edge 3840, ratio ≤ 3:1, total pixels 655,360–8,294,400. Popular: `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048` (2K square), `2048x1152`, `2560x1440`, `auto`. Use `auto` when the user doesn't care. The tool rejects invalid sizes with a clear message.
- `quality`: `low` (fast drafts), `medium`, `high`, `auto`.
- `format`: `png` (default), `jpeg`, `webp`.

## When the tools are unavailable

Some sessions (e.g. subagents with a strict tool allowlist) do not have
`imgen_generate` / `imgen_edit`. In that case **do not improvise** with shell,
curl, or Python scripts — image generation requires the relay credentials held
by the extension. Report back that the image task needs the main session or the
`imgen-worker` agent (which has the tools).

## Config (relay URL, keys, model)

The tools read `config.json` next to the extension on every call
(`~/.pi/agent/extensions/imgen-tool/config.json`), so config changes apply
immediately — no restart, no code changes:

- `base_url` — relay endpoint (e.g. `https://ai.orbitlink.me/v1`)
- `api_key` — primary key; `api_keys` — extra keys tried in order, rotated automatically on HTTP 401/403/429
- `model` — model id (default `gpt-image-2`)
- `default_size` / `default_quality` / `default_format` — used when the tool call omits the corresponding parameter
- `user_agent` — browser-like UA; some relays reject default user agents with a Cloudflare 403 (Error 1010)
- `timeout_seconds` — request timeout (default 300)

## Troubleshooting

- `HTTP 524` (origin timeout): transient — retry the call once; the retry usually succeeds.
- `HTTP 401/403`: bad or expired key — other configured keys are tried automatically; check config.json.
- `HTTP 429`: rate limit / quota — wait, or add another key to `api_keys`.
- `HTTP 400` with a size error: resolution violates constraints (see sizes above).
- Saved image is smaller than requested: the relay downscales outputs; inform the user.

## Examples

**Example 1 — text-to-image, explicit path:**
Input: "生成一张图：一只橘猫坐在窗台上，夕阳，保存到 cat.png"
Call: `imgen_generate` with `prompt: "an orange cat sitting on a windowsill at sunset"`, `output: "cat.png"`

**Example 2 — edit with strong prompt:**
Input: "把 photo.png 里的车换成自行车，其他不变"
Call: `imgen_edit` with `image: "photo.png"`, `prompt: "Remove the car completely and replace it with a bicycle in the same spot. Keep the rest of the scene exactly the same."`, `output: "photo_bike.png"`

**Example 3 — size and quality flags:**
Input: "帮我做一张 2K 的高清风景海报"
Call: `imgen_generate` with `prompt: "majestic mountain sunrise, misty valley, cinematic"`, `size: "2560x1440"`, `quality: "high"`, `output: "poster.png"`
