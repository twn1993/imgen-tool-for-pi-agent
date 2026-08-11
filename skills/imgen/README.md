# imgen — skill

Generates and edits images with `gpt-image-2` through an OpenAI-compatible
relay, using the custom tools `imgen_generate` (text-to-image) and
`imgen_edit` (image-to-image / editing).

## How it works

- The tools are registered by the **imgen-tool** extension
  (`~/.pi/agent/extensions/imgen-tool/`) — pure Node, no Python.
- Relay URL, API keys, model, and defaults live in
  `~/.pi/agent/extensions/imgen-tool/config.json`; config is read on every
  call, so edits apply immediately.
- This skill supplies the workflow knowledge (English prompt translation,
  strong imperative edit prompts, size/quality guidance). Read `SKILL.md`
  for the full instructions.

## For subagents

The `imgen-worker` agent (`~/.pi/agent/agents/imgen-worker.md`) has both tools
in its allowlist — use it for delegated image tasks. Sessions without the
tools should escalate instead of improvising with shell scripts.
