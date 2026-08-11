# imgen-tool — pi extension

Registers two custom tools that generate and edit images with `gpt-image-2`
through an OpenAI-compatible relay. Pure Node/TypeScript — no Python needed.

## Tools

| Tool | Purpose |
| --- | --- |
| `imgen_generate` | Text-to-image. Params: `prompt`, `output`, optional `size`/`quality`/`format` |
| `imgen_edit` | Image-to-image / editing. Params: `image`, `prompt`, `output`, optional `mask`/`size`/`quality`/`format` |

Both tools are auto-invoked by the LLM whenever the user asks to generate or
edit an image. Prompts are always written in English (the model translates the
user's request first).

## Config

All settings live in `config.json` **in this directory** — the tools read it on
every call, so you can switch relays or rotate keys without restarting pi:

- `base_url` — relay endpoint
- `api_key` — primary key; `api_keys` — extra keys tried in order, rotated
  automatically on HTTP 401/403/429
- `model` — model id (default `gpt-image-2`)
- `default_size` / `default_quality` / `default_format` — used when the tool
  call omits the corresponding parameter
- `user_agent` — browser-like UA; required because some relays reject Node's
  default UA with a Cloudflare 403 (Error 1010)
- `timeout_seconds` — request timeout (default 300)

## Installation

The extension is auto-discovered from `~/.pi/agent/extensions/imgen-tool/`.
Restart pi (or use `/reload`) to pick it up. Verify with `pi.getAllTools()` or
by simply asking for an image.

## Notes

- Output images are saved from `b64_json` when available, otherwise downloaded
  from the returned `url`.
- One image per call (`n=1`) — many relays only support this.
- `gpt-image-2` does not support transparent backgrounds.
- Editing works best with strong imperative English prompts:
  "Remove X completely and replace it with Y. Keep everything else exactly the same."
