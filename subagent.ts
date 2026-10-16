#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { statePaths } from "./client.ts";
import { runTool, sendToHost, type ToolArgs } from "./tool.ts";

function fail(message: string): never {
	throw new Error(message);
}

function usage(): never {
	fail(`Usage:
  subagent spawn [--name <name>] [--provider <provider>] [--model <model>] [--thinking <level>]
    [--cwd <dir>] [--tools <names>] (--prompt <text> | --file <path>)...
  subagent status <handle>
  subagent rename <handle> <name>
  subagent send <handle> [--follow-up] <message>
  subagent wait <handle> [--timeout <seconds>]
  subagent stop <handle>
  subagent list
  subagent attach <handle>`);
}

function valueAfter(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) fail(`${option} requires a value`);
	return value;
}

function spawnArgs(args: string[]): ToolArgs {
	const spawn: ToolArgs = { action: "spawn" };
	const prompts: string[] = [];
	const files: string[] = [];
	for (let i = 0; i < args.length; i += 2) {
		const option = args[i];
		switch (option) {
			case "--name":
				spawn.name = valueAfter(args, i, option);
				break;
			case "--provider":
				spawn.provider = valueAfter(args, i, option);
				break;
			case "--model":
				spawn.model = valueAfter(args, i, option);
				break;
			case "--thinking":
				spawn.thinking = valueAfter(args, i, option);
				break;
			case "--cwd":
				spawn.cwd = valueAfter(args, i, option);
				break;
			case "--tools":
				spawn.tools = valueAfter(args, i, option).split(",");
				break;
			case "--prompt":
				prompts.push(valueAfter(args, i, option));
				break;
			case "--file":
				files.push(valueAfter(args, i, option));
				break;
			default:
				fail(`Unknown spawn argument: ${option}`);
		}
	}
	return { ...spawn, prompts, files };
}

function sendArgs(args: string[]): ToolArgs {
	const [handle, ...rest] = args;
	if (!handle) usage();
	let followUp = false;
	const messageParts: string[] = [];
	for (const arg of rest) {
		if (arg === "--follow-up") followUp = true;
		else if (arg.startsWith("--")) fail(`Unknown send argument: ${arg}`);
		else messageParts.push(arg);
	}
	return { action: "send", handle, message: messageParts.join(" "), followUp };
}

function waitArgs(args: string[]): ToolArgs {
	const [handle, ...rest] = args;
	if (!handle) usage();
	if (rest.length === 0) return { action: "wait", handle };
	if (rest.length !== 2 || rest[0] !== "--timeout") usage();
	const timeout = Number(rest[1]);
	if (!Number.isInteger(timeout) || timeout <= 0) fail("--timeout must be a positive integer");
	return { action: "wait", handle, timeout };
}

/** The tool arguments of a CLI command. */
function toolArgs(command: string | undefined, args: string[]): ToolArgs {
	const [first, second] = args;
	switch (command) {
		case "spawn":
			return spawnArgs(args);
		case "send":
			return sendArgs(args);
		case "wait":
			return waitArgs(args);
		case "status":
		case "stop":
			if (args.length !== 1 || first === undefined) usage();
			return { action: command, handle: first };
		case "rename":
			if (args.length !== 2 || first === undefined || second === undefined) usage();
			return { action: command, handle: first, name: second };
		case "list":
			if (args.length !== 0) usage();
			return { action: command };
		default:
			usage();
	}
}

/** Runs the host in this process with Pi's models. It exits at once when another host runs. */
async function hostCommand(args: string[]): Promise<void> {
	if (args.length !== 0) usage();
	const { createAgentSessionServices } = await import("@earendil-works/pi-coding-agent");
	const { runHost } = await import("./host.ts");
	const { modelRuntime } = await createAgentSessionServices({ cwd: process.cwd() });
	const host = await runHost({ stateDir: statePaths().dir, models: modelRuntime });
	if (host === undefined) {
		process.stderr.write(`Another subagent host runs (pid ${process.pid} exits)\n`);
		process.exit(0);
	}
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void host.close());
	await host.closed;
	process.exit(0);
}

/** Opens the viewer of a child in this terminal. */
async function attachCommand(args: string[]): Promise<void> {
	const [handle] = args;
	if (args.length !== 1 || handle === undefined) usage();
	const { ProcessTerminal } = await import("@earendil-works/pi-tui");
	const { attach } = await import("./viewer.ts");
	process.exitCode = await attach(handle, { terminal: new ProcessTerminal(), env: process.env });
}

/**
 * Runs a command as a call of the `subagent` tool. The caller is `PI_SESSION_ID`, or `cli` outside Pi, and the defaults
 * of a spawn come from `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL`.
 */
async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (command === "host") return hostCommand(args);
	if (command === "attach") return attachCommand(args);
	const { text } = await runTool(toolArgs(command, args), {
		caller: process.env.PI_SESSION_ID || "cli",
		callKey: randomUUID(),
		provider: process.env.PI_PROVIDER,
		model: process.env.PI_MODEL,
		thinking: process.env.PI_REASONING_LEVEL || "medium",
		cwd: process.cwd(),
		trusted: undefined,
		send: sendToHost,
		signal: undefined,
	});
	process.stdout.write(text);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
