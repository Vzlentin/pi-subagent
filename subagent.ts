#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	checkHandle,
	normalizeRunName,
	outputText,
	request,
	spawnPrompt,
	statePaths,
	THINKING_LEVELS,
} from "./client.ts";

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
  subagent list`);
}

function valueAfter(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) fail(`${option} requires a value`);
	return value;
}

/** `PI_SESSION_ID`, or `cli` outside Pi. */
function caller(): string {
	return process.env.PI_SESSION_ID || "cli";
}

async function spawnSubagent(args: string[]): Promise<void> {
	let name: string | undefined;
	let provider = process.env.PI_PROVIDER;
	let model = process.env.PI_MODEL;
	let thinking = process.env.PI_REASONING_LEVEL || "medium";
	let cwd = process.cwd();
	let tools: string | undefined;
	const prompts: string[] = [];
	const files: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--name":
				name = normalizeRunName(valueAfter(args, i, arg));
				i++;
				break;
			case "--provider":
				provider = valueAfter(args, i, arg);
				i++;
				break;
			case "--model":
				model = valueAfter(args, i, arg);
				i++;
				break;
			case "--thinking":
				thinking = valueAfter(args, i, arg);
				i++;
				break;
			case "--cwd":
				cwd = resolve(valueAfter(args, i, arg));
				i++;
				break;
			case "--tools":
				tools = valueAfter(args, i, arg);
				i++;
				break;
			case "--prompt":
				prompts.push(valueAfter(args, i, arg));
				i++;
				break;
			case "--file": {
				const file = resolve(valueAfter(args, i, arg));
				if (!existsSync(file)) fail(`File not found: ${file}`);
				files.push(file);
				i++;
				break;
			}
			default:
				fail(`Unknown spawn argument: ${arg}`);
		}
	}

	if (!provider) fail("No provider specified and PI_PROVIDER is not set");
	if (!model) fail("No model specified and PI_MODEL is not set");
	if (!THINKING_LEVELS.has(thinking)) fail(`Invalid thinking level: ${thinking}`);
	const toolNames = tools
		?.split(",")
		.map((tool) => tool.trim())
		.filter((tool) => tool);
	if (toolNames !== undefined && toolNames.length === 0) fail("--tools requires at least one tool name");
	if (prompts.length === 0 && files.length === 0) fail("spawn requires at least one --prompt or --file");
	if (!existsSync(cwd)) fail(`Working directory not found: ${cwd}`);

	const prompt = spawnPrompt(files, prompts);
	const child = await request(
		{
			type: "spawn",
			requestId: randomUUID(),
			caller: caller(),
			...(name === undefined ? {} : { name }),
			provider,
			model,
			thinking,
			cwd,
			...(toolNames === undefined ? {} : { tools: toolNames }),
			prompt,
		},
		{ start: true },
	);
	process.stdout.write(outputText.spawn(child));
}

async function statusSubagent(args: string[]): Promise<void> {
	const [handle] = args;
	if (args.length !== 1 || handle === undefined) usage();
	const child = await request({ type: "status", handle: checkHandle(handle) }, { start: true });
	process.stdout.write(outputText.status(child));
}

async function renameSubagent(args: string[]): Promise<void> {
	const [handle, value] = args;
	if (args.length !== 2 || handle === undefined || value === undefined) usage();
	const name = normalizeRunName(value);
	const child = await request({ type: "rename", caller: caller(), handle: checkHandle(handle), name }, { start: true });
	process.stdout.write(outputText.rename(child));
}

async function sendSubagent(args: string[]): Promise<void> {
	const handle = args.shift();
	if (!handle) usage();
	let followUp = false;
	const messageParts: string[] = [];
	for (const arg of args) {
		if (arg === "--follow-up") followUp = true;
		else if (arg.startsWith("--")) fail(`Unknown send argument: ${arg}`);
		else messageParts.push(arg);
	}
	const message = messageParts.join(" ").trim();
	if (!message) fail("send requires a message");
	const sent = await request(
		{
			type: "send",
			requestId: randomUUID(),
			caller: caller(),
			handle: checkHandle(handle),
			message,
			followUp,
		},
		{ start: true },
	);
	process.stdout.write(outputText.send(sent));
}

function parseTimeout(args: string[]): number {
	if (args.length === 0) return 1800;
	if (args.length !== 2 || args[0] !== "--timeout") usage();
	const timeout = Number(args[1]);
	if (!Number.isInteger(timeout) || timeout <= 0) fail("--timeout must be a positive integer");
	return timeout;
}

async function waitSubagent(args: string[]): Promise<void> {
	const handle = args.shift();
	if (!handle) usage();
	const timeout = parseTimeout(args);
	const waited = await request({ type: "wait", handle: checkHandle(handle), timeout }, { start: true });
	process.stdout.write(outputText.wait(handle, waited));
}

async function stopSubagent(args: string[]): Promise<void> {
	const [handle] = args;
	if (args.length !== 1 || handle === undefined) usage();
	const child = await request({ type: "stop", caller: caller(), handle: checkHandle(handle) }, { start: true });
	process.stdout.write(outputText.stop(child));
}

async function listSubagents(args: string[]): Promise<void> {
	if (args.length !== 0) usage();
	const children = await request({ type: "list", caller: caller() }, { start: true });
	process.stdout.write(outputText.list(children));
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

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args.shift();
	switch (command) {
		case "spawn":
			await spawnSubagent(args);
			break;
		case "status":
			await statusSubagent(args);
			break;
		case "rename":
			await renameSubagent(args);
			break;
		case "send":
			await sendSubagent(args);
			break;
		case "wait":
			await waitSubagent(args);
			break;
		case "stop":
			await stopSubagent(args);
			break;
		case "list":
			await listSubagents(args);
			break;
		case "host":
			await hostCommand(args);
			break;
		default:
			usage();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
