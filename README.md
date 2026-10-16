# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

This package is the Pi extension. The subagents run in the host of [harness](https://github.com/Vzlentin/harness), which this package imports as a library. The harness README describes the CLI, the viewer, the host and where the state lives.

## Requirements

- Pi
- Node.js 22.19 or newer
- Access to `github.com/Vzlentin/harness`: Pi's `npm install` clones it as a git dependency

## Install

Install it as a Pi package:

```sh
pi install https://github.com/Vzlentin/pi-subagent
```

Run `/reload` in an existing Pi session. The extension contributes the `subagent` tool, the `/subagent` command, the status widget and the bundled skill.

The CLI is the one of harness: install harness and link `harness` and `subagent` as its README shows. The skill tells agents to use `subagent` in bash when they do not have the tool. The tool, the Herdr viewer tab and the Herdr resume command do not need a CLI on `PATH`.

`npm install` builds the `dist/` of harness (its `prepare` script). The extension imports `harness/client`, `harness/protocol`, `harness/tool`, `harness/herdr` and `harness/trust`. When no host runs, the extension starts `node_modules/harness/dist/cli.js host`.

## Tool

The extension gives Pi the `subagent` tool of harness. It does what the harness CLI does, with one `action` and its arguments:

| `action` | Arguments |
| --- | --- |
| `spawn` | `name`, `provider`, `model`, `thinking`, `cwd`, `tools`, `prompts`, `files`, `key` |
| `send` | `handle`, `message`, `followUp`, `key` |
| `wait` | `handle`, `timeout` (seconds, default 1800) |
| `status`, `stop` | `handle` |
| `rename` | `handle`, `name` |
| `list` | none |

The harness README describes the arguments and the results. The caller is the Pi session ID, the same as `PI_SESSION_ID` for the CLI, so `/subagent`, the widget, and `harness list` in that session show the tool's children. A spawn without `provider`, `model`, or `thinking` uses the session's model and thinking level. When the call is aborted, for example with Esc, a `wait` stops; the child continues.

A child's system prompt follows only the project trust saved for future sessions. When the session trusts its project for itself only, a spawn adds `The child gets no project skills (.pi/skills, .agents/skills): this project is trusted for this Pi session only, and children see only the trust saved for future sessions. To give children project skills, run /trust and choose Trust.` to its output.

## `/subagent`

Use `/subagent` in Pi to open the viewer of a child of the current session. It shows a select list of the children. In Herdr (`HERDR_ENV` is set), it opens a new tab with the label `<name>` (or the handle), in the child's working directory, that runs the viewer of the child. The tab runs `env <node> <harness>/dist/cli.js attach <handle>`: the viewer with this Node and the harness that this package imports, so it does not need `harness` on `PATH`. When `XDG_STATE_HOME` is set, the tab gets it too. Outside Herdr, it shows `Run in another terminal: harness attach <handle>`. When a `herdr` call fails, it shows `Could not open a Herdr tab: <error>. Run in another terminal: harness attach <handle>`, where `<error>` is what went wrong: the stderr of `herdr`, or the reason that the call failed.

The status widget shows active names (or handles for unnamed runs) and their current state. The widget does not start the host, and shows nothing when no host runs.
