---
name: subagent
description: Spawn and communicate with observable Pi subagents for second opinions, independent investigations, and delegated implementation work.
---

# Subagent

Use the `subagent` CLI to delegate work to a separate agent with its own context. Each subagent is a conversation in one background host process, which the CLI starts when needed. A subagent can spawn its own subagents, but those cannot spawn more.

## Spawn

Give each child a short, descriptive name. The name appears in the parent UI, while the generated handle remains its stable identifier:

```sh
subagent spawn --name implementation --prompt "Complete task"
```

By default, the child inherits the current Pi provider, model, and reasoning level from the bash environment. Use `--provider`, `--model`, or `--thinking` only when deliberately choosing a different configuration, for example a faster model for simple investigation or a stronger model for difficult review. Never pass `$PI_PROVIDER`, `$PI_MODEL`, or `$PI_REASONING_LEVEL` back to the CLI explicitly.

`--cwd` defaults to the current directory. Repeat `--prompt` and `--file` as needed; the child receives the text of the files and all prompts in its first message. Run `subagent spawn` directly without piping or redirecting its concise output.

## Tools

Without `--tools`, a child gets these tools:

- `read` - Read text files and images.
- `bash` - Execute shell commands. This can also modify files, so it is not a read-only capability.
- `edit` - Apply exact text replacements to existing files.
- `write` - Create or overwrite files.

It also gets the tools of installed packages that declare `piDurable` entries. It does not get MCP tools, other Pi extensions, `AGENTS.md`, or skills, so put the instructions it needs in the prompt.

`--tools` is a comma-separated allowlist. An unknown name is an error. Common choices:

```sh
# Enforced read-only repository investigation
--tools read

# Investigation that may run tests or other commands; bash can modify files
--tools read,bash

# Implementation work: omit --tools to use the defaults
```

Spawn prints the child's name and random handle. Keep the handle for later commands. Subagents persist after their current turn completes: `wait`, completion, and becoming idle do not terminate them. They survive `/reload` and the end of the spawning Pi session. They are only removed by `subagent stop`.

## Inspect and wait

```sh
subagent status <handle>
subagent list
subagent wait <handle>
```

Run `subagent list` at any time to rediscover the subagents of this session and their handles, names, and current states if you no longer remember them.

`wait` waits until the subagent is idle and prints its latest final assistant response. It fails when the last turn failed. Run it directly so the bash tool returns that response; do not redirect it to a file or pipe it unless the user explicitly asks for an artifact. Set the bash timeout above `wait`'s default 1800-second deadline.

## Communicate

```sh
# Change the name shown in the parent UI.
subagent rename <handle> "new name"

# Idle: starts a new prompt. Busy: steers the current work after its current tool round.
subagent send <handle> "message"

# Busy: waits until current work finishes, then starts another turn.
subagent send <handle> --follow-up "message"
```

Names are 1–64 characters and need not be unique.

## Stop

```sh
subagent stop <handle>
```

Explicitly stop every subagent when it is no longer needed; do not leave completed subagents idle. This stops its work and removes it. Keep an idle subagent only when concrete follow-up work is expected, then stop it afterward.

The interactive `/subagent` command lists the subagents spawned by the current Pi session.
