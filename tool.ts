import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type * as Ai from "@earendil-works/pi-ai";
import {
	checkHandle,
	normalizeRunName,
	outputText,
	type Replies,
	type Request,
	spawnPrompt,
	THINKING_LEVELS,
} from "./client.ts";

export const TOOL_DESCRIPTION = `Spawn and manage subagents: separate agents with their own context, for second opinions, independent investigations and delegated work.
- spawn: start a child with \`prompts\` and \`files\`. It uses your provider, model and thinking level unless you give others. Give it a short \`name\`. It prints the child's handle.
- status, wait, send, rename, stop: act on the child \`handle\`. \`wait\` waits until the child is idle (up to \`timeout\` seconds, default 1800) and gives its last answer. \`send\` steers a busy child, or queues \`message\` with \`followUp\`.
- list: your children.
Children persist after a turn. Stop each child when you no longer need it.`;

export type ToolArgs = {
	readonly action: "spawn" | "send" | "wait" | "status" | "rename" | "list" | "stop";
	readonly name?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly cwd?: string;
	readonly tools?: readonly string[];
	readonly prompts?: readonly string[];
	readonly files?: readonly string[];
	readonly handle?: string;
	readonly message?: string;
	readonly followUp?: boolean;
	readonly timeout?: number;
	readonly key?: string;
};

/** Sends one request to the host and gives its reply. */
export type Send = <T extends Request["type"]>(
	request: Extract<Request, { type: T }>,
	signal: AbortSignal | undefined,
) => Promise<Replies[T]>;

/** What a tool call gets from its adapter. */
export type ToolScope = {
	/** The caller that owns the children. */
	readonly caller: string;
	/** The request ID of a spawn or send, from the `key` argument or else from the call. */
	requestId(key: string | undefined): string;
	readonly provider: string | undefined;
	readonly model: string | undefined;
	readonly thinking: string;
	/** Relative `cwd` and `files` paths resolve against it. */
	readonly cwd: string;
	readonly send: Send;
	readonly signal: AbortSignal | undefined;
};

/** The result of a call: the text for the model, and the data for programs. */
export type ToolResult = { readonly text: string; readonly data: { readonly action: string; readonly value: unknown } };

/** The parameters and the output schema of the tool, built with the `Type` of the caller's pi-ai. */
export function toolSchemas(Type: typeof Ai.Type) {
	const text = (description: string) => Type.Optional(Type.String({ description }));
	const texts = (description: string) => Type.Optional(Type.Array(Type.String(), { description }));
	const parameters = Type.Object({
		action: Type.Union(
			[
				Type.Literal("spawn"),
				Type.Literal("send"),
				Type.Literal("wait"),
				Type.Literal("status"),
				Type.Literal("rename"),
				Type.Literal("list"),
				Type.Literal("stop"),
			],
			{ description: "What to do" },
		),
		name: text("spawn, rename: the child's name, 1 to 64 characters"),
		provider: text("spawn: the provider; default yours"),
		model: text("spawn: the model; default yours"),
		thinking: text("spawn: off, minimal, low, medium, high, xhigh or max; default yours"),
		cwd: text("spawn: the child's working directory; default yours"),
		tools: texts("spawn: the only tools the child gets; default read, write, edit, bash and the package tools"),
		prompts: texts("spawn: the task, in parts"),
		files: texts("spawn: files whose text goes before the task"),
		handle: text("send, wait, status, rename, stop: the child's handle"),
		message: text("send: the message"),
		followUp: Type.Optional(Type.Boolean({ description: "send: queue after the current answer, not a steer" })),
		timeout: Type.Optional(Type.Integer({ minimum: 1, description: "wait: seconds; default 1800" })),
		key: text("spawn, send: a key that makes a repeated call do nothing; default the call"),
	});
	const output = Type.Object({ action: Type.String(), value: Type.Unknown() });
	return { parameters, output };
}

function required(value: string | undefined, argument: string, action: string): string {
	if (value === undefined || value === "") throw new Error(`${action} requires ${argument}`);
	return value;
}

/** Runs one call of the tool. */
export async function runTool(args: ToolArgs, scope: ToolScope): Promise<ToolResult> {
	const { action } = args;
	const { send, signal, caller } = scope;
	const handle = () => checkHandle(required(args.handle, "handle", action));
	switch (action) {
		case "spawn": {
			const provider = args.provider ?? scope.provider;
			const model = args.model ?? scope.model;
			const thinking = args.thinking ?? scope.thinking;
			if (!provider) throw new Error("No provider specified and the caller has no model");
			if (!model) throw new Error("No model specified and the caller has no model");
			if (!THINKING_LEVELS.has(thinking)) throw new Error(`Invalid thinking level: ${thinking}`);
			const name = args.name === undefined ? undefined : normalizeRunName(args.name);
			const cwd = resolve(scope.cwd, args.cwd ?? ".");
			if (!existsSync(cwd)) throw new Error(`Working directory not found: ${cwd}`);
			const tools = args.tools?.map((tool) => tool.trim()).filter((tool) => tool);
			if (tools !== undefined && tools.length === 0) throw new Error("tools requires at least one tool name");
			const files = (args.files ?? []).map((file) => resolve(scope.cwd, file));
			for (const file of files) if (!existsSync(file)) throw new Error(`File not found: ${file}`);
			const prompts = args.prompts ?? [];
			if (prompts.length === 0 && files.length === 0) throw new Error("spawn requires at least one prompt or file");
			const child = await send(
				{
					type: "spawn",
					requestId: scope.requestId(args.key),
					caller,
					...(name === undefined ? {} : { name }),
					provider,
					model,
					thinking,
					cwd,
					...(tools === undefined ? {} : { tools }),
					prompt: spawnPrompt(files, prompts),
				},
				signal,
			);
			return { text: outputText.spawn(child), data: { action, value: child } };
		}
		case "send": {
			const message = required(args.message?.trim(), "message", action);
			const sent = await send(
				{
					type: "send",
					requestId: scope.requestId(args.key),
					caller,
					handle: handle(),
					message,
					followUp: args.followUp === true,
				},
				signal,
			);
			return { text: outputText.send(sent), data: { action, value: sent } };
		}
		case "wait": {
			const target = handle();
			const waited = await send({ type: "wait", handle: target, timeout: args.timeout ?? 1800 }, signal);
			return { text: outputText.wait(target, waited), data: { action, value: waited } };
		}
		case "status": {
			const child = await send({ type: "status", handle: handle() }, signal);
			return { text: outputText.status(child), data: { action, value: child } };
		}
		case "rename": {
			const name = normalizeRunName(required(args.name, "name", action));
			const child = await send({ type: "rename", caller, handle: handle(), name }, signal);
			return { text: outputText.rename(child), data: { action, value: child } };
		}
		case "list": {
			const children = await send({ type: "list", caller }, signal);
			return { text: outputText.list(children), data: { action, value: children } };
		}
		case "stop": {
			const stopped = await send({ type: "stop", caller, handle: handle() }, signal);
			return { text: outputText.stop(stopped), data: { action, value: stopped } };
		}
		default:
			throw new Error(`Unknown action: ${String(action)}`);
	}
}
