---
name: subagent
description: Spawn and communicate with observable Pi subagents for second opinions, independent investigations, and delegated implementation work.
---

# Subagent

Use the `subagent` tool to delegate work to a separate agent with its own context. Each subagent is a conversation in one background host process, which starts when needed. A subagent can spawn its own subagents, but those cannot spawn more.

When the tool is not available, use the `subagent` CLI in bash. It has the same commands (see [CLI](#cli)).

## Spawn

Give each child a short, descriptive name. The name appears in the parent UI, while the generated handle remains its stable identifier:

```json
{ "action": "spawn", "name": "implementation", "prompts": ["Complete task"] }
```

By default, the child uses your provider, model, and thinking level. Set `provider`, `model`, or `thinking` only when deliberately choosing a different configuration, for example a faster model for simple investigation or a stronger model for difficult review.

`cwd` defaults to your working directory. Give the task in `prompts` and the files to read in `files`; the child receives the text of the files and all prompts in its first message.

## Tools

Without `tools`, a child gets these tools:

- `read` - Read text files and images.
- `bash` - Execute shell commands. This can also modify files, so it is not a read-only capability.
- `edit` - Apply exact text replacements to existing files.
- `write` - Create or overwrite files.
- `subagent` - Spawn and manage its own subagents.

It also gets the tools of installed packages that declare `piDurable` entries. It does not get MCP tools, other Pi extensions, `AGENTS.md`, or skills, so put the instructions it needs in the prompt.

`tools` is an allowlist. An unknown name is an error. Common choices:

- `["read"]`: enforced read-only repository investigation.
- `["read", "bash"]`: investigation that may run tests or other commands; bash can modify files.
- Omit `tools` for implementation work.

Spawn gives the child's name and random handle. Keep the handle for later actions. Subagents persist after their current turn completes: `wait`, completion, and becoming idle do not terminate them. They survive `/reload` and the end of the spawning Pi session. They are only removed by `stop`.

## Inspect and wait

```json
{ "action": "status", "handle": "<handle>" }
{ "action": "list" }
{ "action": "wait", "handle": "<handle>" }
```

Use `list` at any time to rediscover the subagents of this session and their handles, names, and current states if you no longer remember them.

`wait` waits until the subagent is idle, up to `timeout` seconds (default 1800), and gives its latest final assistant response. It fails when the last turn failed.

## Communicate

```json
{ "action": "rename", "handle": "<handle>", "name": "new name" }
{ "action": "send", "handle": "<handle>", "message": "message" }
{ "action": "send", "handle": "<handle>", "message": "message", "followUp": true }
```

`rename` changes the name shown in the parent UI. Names are 1–64 characters and need not be unique. `send` to an idle child starts a new prompt; to a busy child it steers the current work after its current tool round. With `followUp`, it waits until the current work finishes, then starts another turn.

## Stop

```json
{ "action": "stop", "handle": "<handle>" }
```

Explicitly stop every subagent when it is no longer needed; do not leave completed subagents idle. This stops its work and removes it. Keep an idle subagent only when concrete follow-up work is expected, then stop it afterward.

The interactive `/subagent` command lists the subagents spawned by the current Pi session.

## CLI

```sh
subagent spawn --name implementation --prompt "Complete task"
subagent spawn --tools read,bash --file /tmp/spec.md --prompt "Investigate the failure"
subagent status <handle>
subagent list
subagent wait <handle>
subagent rename <handle> "new name"
subagent send <handle> "message"
subagent send <handle> --follow-up "message"
subagent stop <handle>
```

The CLI takes the provider, model, and reasoning level from the bash environment. Never pass `$PI_PROVIDER`, `$PI_MODEL`, or `$PI_REASONING_LEVEL` back to it explicitly. Repeat `--prompt` and `--file` as needed; `--tools` is a comma-separated list. Run `subagent spawn` and `subagent wait` directly, without piping or redirecting their output, so the bash tool returns it. Set the bash timeout above `wait`'s default 1800-second deadline.
