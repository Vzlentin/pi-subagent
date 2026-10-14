# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent is a conversation in one durable host process. The parent can inspect status, wait for durable results, steer active work, and queue follow-ups.

## Requirements

- Pi
- Node.js 22.19 or newer

## Install

Clone into Pi's global extension directory and expose the CLI on `PATH`:

```sh
git clone git@github.com:earendil-works/pi-subagent.git ~/.pi/agent/extensions/subagent
ln -s ../extensions/subagent/subagent.ts ~/.pi/agent/bin/subagent
```

Run `/reload` in an existing Pi session. The extension contributes its bundled skill automatically.

## Usage

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Spawn prints `Spawned <name> (<handle>)` and `State: busy`. Names appear in the parent UI. Generated handles remain the stable identifiers used by management commands.

Override the model configuration when needed:

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

Provide multiple prompt fragments and files. The first message holds the text of each file, then `Task:` and the prompts:

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

Restrict tools with `--tools`, a comma-separated list. Without it, a child gets `read`, `write`, `edit`, `bash`, and the tools of installed packages (see Limits). An unknown tool name is an error:

```sh
subagent spawn --tools read,bash --prompt "Investigate the failure"
```

Manage a run by its generated handle:

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent wait a1b2c3
subagent stop a1b2c3
subagent list
```

- `status` prints `<name> (<handle>): <state> (<provider>/<model>, <thinking>)`. The state is `busy`, `idle`, or `error` when the last turn failed.
- `send` prints `Prompted`, `Steered`, or `Queued follow-up for`, then the child. A steer goes in after the current tool round. A follow-up starts after the current answer.
- `wait` waits until the child is idle, up to `--timeout` seconds (default 1800), and prints `<handle> finished`, a blank line, and the last answer. A failed or aborted last turn is an error.
- `stop` stops the child's work and removes it.
- `list` prints one line per child of the current caller: `<name> (<handle>)  <state>  <provider>/<model>  <thinking>`.

The caller is `PI_SESSION_ID`, or `cli` when it is not set. `list` shows only the caller's children, and `send`, `rename`, and `stop` refuse a child of another caller.

Use `/subagent` to list the children of the current Pi session. The status widget shows active names (or handles for unnamed runs) and their current state.

## Host

The children run in one host process, `subagent host`. The first command that needs it starts it in the background. It exits after 5 minutes with no connection, no running work, and no command other than `list` and `status`. The widget does not start the host, and shows nothing when no host runs.

The host keeps its state in `$XDG_STATE_HOME/pi-subagent/` (default `~/.local/state/pi-subagent/`):

- `durable.sqlite`: the children's conversations and records. Work that a host stop interrupts continues when the host starts again.
- `lock.sqlite`: one host at a time.
- `host.sock`: the socket the CLI and the extension connect to.
- `host.log`: the host's output.

A child's bash commands get `PI_SESSION_ID` (the child's conversation ID), `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`, so a child can spawn its own children with the same configuration. A child of a child is the deepest level: a deeper spawn fails with `Nested subagents are disabled`. Children survive `/reload` and the end of the parent Pi session. `subagent stop` removes a child permanently.

## Limits

- Children get only `read`, `write`, `edit`, `bash`, and the `piDurable` tools of installed packages. They get no MCP tools and no other Pi extensions. Entries of packages installed with npm do not load, because Node does not strip types under `node_modules`.
- Children get no `AGENTS.md` and no skills.
- `--file` gives text only; images are not attached.
- `stop` removes only the named child. The children that it spawned stay in the store, and no caller can reach them.
- The CLI sends each `spawn` once. If the host stops during a `spawn` and you run the command again, there can be two children.
