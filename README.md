# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent is a conversation in one durable host process. The parent can inspect status, wait for durable results, steer active work, and queue follow-ups.

## Requirements

- Pi
- Node.js 22.19 or newer

## Install

Install it as a Pi package, then expose the CLI on `PATH`:

```sh
pi install https://github.com/Vzlentin/pi-subagent
ln -s ~/.pi/agent/git/github.com/Vzlentin/pi-subagent/subagent.ts ~/.local/bin/subagent
```

Run `/reload` in an existing Pi session. The extension contributes the `subagent` tool and its bundled skill. The tool does not need the CLI on `PATH`; the CLI is for shells and scripts.

## Tool

The extension gives Pi the `subagent` tool. It does what the CLI does, with one `action` and its arguments:

| `action` | Arguments |
| --- | --- |
| `spawn` | `name`, `provider`, `model`, `thinking`, `cwd`, `tools`, `prompts`, `files`, `key` |
| `send` | `handle`, `message`, `followUp`, `key` |
| `wait` | `handle`, `timeout` (seconds, default 1800) |
| `status`, `stop` | `handle` |
| `rename` | `handle`, `name` |
| `list` | none |

`tools`, `prompts`, and `files` are arrays. A relative `cwd` or file path is relative to the caller's working directory. A caller without a working directory cannot spawn. The text result is the output of the same CLI command. The structured result is `{ action, value }`, and the tool declares its schema, where `value` is the host's reply: the child for `spawn`, `status`, and `rename`, `{ verb, child }` for `send`, `{ answer }` for `wait`, the children for `list`, and `{ handle, name }` for `stop`. A child is `{ handle, name, state, provider, model, thinking, cwd }`, where `cwd` is its working directory.

A spawn without `provider`, `model`, or `thinking` uses the caller's. A `spawn` or `send` that comes again with the same `key` finds the first one and does not repeat it. Without `key`, the call is the key. Each caller has its own keys. When the call is aborted, for example with Esc, a `wait` stops; the child continues.

`subagent` calls in one message run one after another, in message order, so a `wait` after a `send` waits for the answer to that message. A round with a `subagent` call runs all of its tool calls in order, `bash` and `read` included.

The CLI runs each command as a call of the same tool. There are two other adapters:

- In Pi, the caller is the session ID, the same as `PI_SESSION_ID` for the CLI, so `/subagent`, the widget, and `subagent list` in that session show the tool's children.
- In a pi-durable host, the `piDurable` entry `durable.ts` gives the tool. The caller is `<store>:<conversation ID>`, where `<store>` is a random ID that the store keeps. A call that runs again after the host restarts uses the same key, so its spawn or send does not repeat.

The children get the tool too. Their caller is their conversation ID, as for their bash commands.

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

Restrict tools with `--tools`, a comma-separated list. Without it, a child gets `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`, `subagent`, and the tools of installed packages (see Limits). An unknown tool name is an error:

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
subagent attach a1b2c3
```

- `status` prints `<name> (<handle>): <state> (<provider>/<model>, <thinking>)`. The state is `busy`, `idle`, or `error` when the last turn failed. After an abort from the viewer, the state is `idle`.
- `send` prints `Prompted`, `Steered`, or `Queued follow-up for`, then the child. A steer goes in after the current tool round. A follow-up starts after the current answer.
- `wait` waits until the child is idle, up to `--timeout` seconds (default 1800), and prints `<handle> finished`, a blank line, and the last answer. A failed or aborted last turn is an error: after an abort, it prints `<handle> was aborted`.
- `stop` stops the child's work and removes it.
- `list` prints one line per child of the current caller: `<name> (<handle>)  <state>  <provider>/<model>  <thinking>`.
- `attach` opens the viewer of the child in this terminal (see [Viewer](#viewer)).

The caller is `PI_SESSION_ID`, or `cli` when it is not set. `list` shows only the caller's children. The CLI and the tool refuse to `send` to, `rename`, or `stop` a child of another caller. The viewer does not check the caller, because the host socket is for one user: it can show, send to, and abort the child of any caller.

Use `/subagent` in Pi to open the viewer of a child of the current session. It shows a select list of the children. In Herdr (`HERDR_ENV` is set), it opens a new tab with the label `<name>` (or the handle), in the child's working directory, that runs the viewer of the child. The tab runs the viewer with Node and this package's `subagent.ts`, so it does not need `subagent` on `PATH`. When `XDG_STATE_HOME` is set, the tab gets it too. Outside Herdr, it shows `Run in another terminal: subagent attach <handle>`. When a `herdr` call fails, it shows the command too. The status widget shows active names (or handles for unnamed runs) and their current state.

## Viewer

`subagent attach <handle>` shows the conversation of one child in the current terminal, live, and sends what you type to it. It starts the host when none runs. An unknown handle is an error before the viewer starts.

The viewer shows the user messages, the assistant text and thinking, and one line for each tool call with its state: `pending`, `running`, `done`, or `error`. The status line shows `<name> (<handle>)  <provider>/<model>  <thinking>  <state>`. When the child is renamed, the status line shows the new name. The viewer uses Pi's default theme and keys, not your Pi settings.

| Key | Action |
| --- | --- |
| Enter | Send the message: a steer when the child is busy, a new turn when it is idle |
| Alt+Enter | Send the message as a follow-up |
| Esc | Abort the current turn and withdraw the queued messages. The child stays, with its history, and is `idle`. Does nothing when the child is idle. |
| Ctrl+C | Exit. The child continues |

Closing the viewer never changes the child. When the child is stopped, the viewer prints `<name> (<handle>) was stopped` and exits with code 0. When the host closes the connection, the viewer exits with code 1.

In Herdr (`HERDR_ENV` is set), the viewer reports the agent state of its pane, `HERDR_PANE_ID`, at each change: `herdr pane report-agent --source custom:pi-subagent --agent <name or handle> --state working|idle --seq <n> <pane> -- subagent attach <handle>`. A busy child is `working`; an idle child and a child with an error are `idle`. `--seq` increases with each call. The label is the name at the start of the viewer; a rename does not change it. On exit, the viewer calls `herdr pane release-agent`. A failed `herdr` call does not stop the viewer. Herdr runs the resume command in a shell, so the `subagent` CLI must be on that shell's `PATH` (see [Install](#install)).

## Host

The children run in one host process, `subagent host`. The first command that needs it starts it in the background. It exits after 5 minutes with no connection, no running work, and no command other than `list` and `status`. An open viewer is a connection, so it keeps the host running. The widget does not start the host, and shows nothing when no host runs.

The host keeps its state in `$XDG_STATE_HOME/pi-subagent/` (default `~/.local/state/pi-subagent/`):

- `durable.sqlite`: the children's conversations and records. Work that a host stop interrupts continues when the host starts again.
- `lock.sqlite`: one host at a time.
- `host.sock`: the socket the CLI, the viewer, and the extension connect to. The protocol has version 2. A client refuses a host with another version: stop the old host (`subagent host` process) and run the command again.
- `host.log`: the host's output.

A child's bash commands get `PI_SESSION_ID` (the child's conversation ID), `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`, so a child can spawn its own children with the same configuration. A child of a child is the deepest level: a deeper spawn fails with `Nested subagents are disabled`. Children survive `/reload` and the end of the parent Pi session. `subagent stop` removes a child permanently.

A child's system prompt has what a Pi session in the child's working directory gets: the `AGENTS.md` or `CLAUDE.md` of the agent directory and of the working directory and its parents, the skills, and the working directory. User skills always load. Project skills (`.pi/skills`, and `.agents/skills` in the working directory and its parents) load only for a trusted project: a directory without project resources, then the decision saved with `/trust`, then the `defaultProjectTrust` setting, where `ask` counts as not trusted. A trust decision that a Pi session made for itself without saving it does not reach its children; when the tool spawns in such a session, it adds `The child gets no project skills (.pi/skills, .agents/skills): this project is trusted for this Pi session only, and children see only the trust saved for future sessions. To give children project skills, run /trust and choose Trust.` to its output. The host checks the trust on every model request, so a decision saved later applies from the next request. The host reads the instructions and skills of a directory once per trust decision and keeps them until it exits. It skips packages that are not installed. When the instructions or skills of a directory fail to load, the child gets none for that request, the host writes a warning, and the next request tries again.

## Limits

- Children get only `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`, `subagent`, and the `piDurable` tools of installed packages. The host does not load the `piDurable` entry of its own package directory, because it gives its children the tool with their own caller. They get no MCP tools and no other Pi extensions. Entries of packages installed with npm do not load, because Node does not strip types under `node_modules`.
- A change to `AGENTS.md` or to a skill reaches children only after the host restarts.
- `--file` gives text only; images are not attached.
- `stop` removes only the named child. The children that it spawned stay in the store, and no caller can reach them.
- The CLI sends each `spawn` once and has no `key`. If the host stops during a `spawn` and you run the command again, there can be two children.
