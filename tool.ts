import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type * as Ai from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import { childLine, isValidRunName, type Replies, type Request, request, runDisplayName } from "./client.ts";

const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** The signal of a call that its adapter cannot abort. */
const NO_ABORT = new AbortController().signal;

export const TOOL_DESCRIPTION = `Spawn and manage subagents: separate agents with their own context, for second opinions, independent investigations and delegated work.
- spawn: start a child with \`prompts\` and \`files\`. It uses your provider, model and thinking level unless you give others. Give it a short \`name\`. It prints \`Spawned <name> (<handle>)\`. The handle is the short hex ID in parentheses, not the name.
- status, wait, send, rename, stop: act on the child \`handle\`. \`wait\` waits until the child is idle (up to \`timeout\` seconds, default 1800) and gives its last answer. \`send\` steers a busy child, or queues \`message\` with \`followUp\`.
- list: your children.
Calls in one message run one after another, in message order, so a \`wait\` after a \`send\` gives the answer to that message.
Children persist after a turn. Stop each child when you no longer need it.`;

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
		handle: text("send, wait, status, rename, stop: the hex ID that spawn prints in parentheses, not the name"),
		message: text("send: the message"),
		followUp: Type.Optional(Type.Boolean({ description: "send: queue after the current answer, not a steer" })),
		timeout: Type.Optional(Type.Integer({ minimum: 1, description: "wait: seconds; default 1800" })),
		key: text("spawn, send: a key that makes a repeated call do nothing; default the call"),
	});
	const child = Type.Object({
		handle: Type.String(),
		name: Type.Optional(Type.String()),
		state: Type.Union([Type.Literal("busy"), Type.Literal("idle"), Type.Literal("error")]),
		provider: Type.String(),
		model: Type.String(),
		thinking: Type.String(),
	});
	const result = <A extends string, V extends TSchema>(action: A, value: V) =>
		Type.Object({ action: Type.Literal(action), value });
	const output = Type.Union([
		result("spawn", child),
		result("send", Type.Object({ verb: Type.String(), child })),
		result("wait", Type.Object({ answer: Type.String() })),
		result("status", child),
		result("rename", child),
		result("list", Type.Array(child)),
		result("stop", Type.Object({ handle: Type.String(), name: Type.Optional(Type.String()) })),
	]);
	return { parameters, output };
}

type Schemas = ReturnType<typeof toolSchemas>;
export type ToolArgs = Static<Schemas["parameters"]>;

/** The result of a call: the text for the model, the same as the CLI output, and the host's reply for programs. */
export type ToolResult = { readonly text: string; readonly data: Static<Schemas["output"]> };

/** Sends one request to the host and gives its reply. */
export type Send = <T extends Request["type"]>(
	request: Extract<Request, { type: T }>,
	signal: AbortSignal,
) => Promise<Replies[T]>;

/** Sends through the host's socket, and starts the host when none runs. */
export const sendToHost: Send = (message, signal) => request(message, { start: true, signal });

/** What a tool call gets from its adapter. */
export type ToolScope = {
	/** The caller that owns the children. */
	readonly caller: string;
	/** The identity of the call. Without `key`, it is the key of a spawn or send. */
	readonly callKey: string;
	readonly provider: string | undefined;
	readonly model: string | undefined;
	readonly thinking: string;
	/** Relative `cwd` and `files` paths resolve against it. A caller without one cannot spawn. */
	readonly cwd: string | undefined;
	readonly send: Send;
	readonly signal: AbortSignal | undefined;
};

/** Runs one call of the tool. */
export async function runTool(args: ToolArgs, scope: ToolScope): Promise<ToolResult> {
	const { action } = args;
	const { send, caller } = scope;
	const signal = scope.signal ?? NO_ABORT;
	const requestId = `${caller}:${args.key ?? scope.callKey}`;
	const handle = () => checkHandle(required(args.handle, "handle", action));
	switch (action) {
		case "spawn": {
			const child = await send(spawnRequest(args, scope, requestId), signal);
			return { text: `Spawned ${runDisplayName(child)}\nState: busy\n`, data: { action, value: child } };
		}
		case "send": {
			const message = required(args.message?.trim(), "message", action);
			const followUp = args.followUp === true;
			const sent = await send({ type: "send", requestId, caller, handle: handle(), message, followUp }, signal);
			return { text: `${sent.verb} ${runDisplayName(sent.child)}\n`, data: { action, value: sent } };
		}
		case "wait": {
			const target = handle();
			const waited = await send({ type: "wait", handle: target, timeout: args.timeout ?? 1800 }, signal);
			return { text: `${target} finished\n\n${waited.answer}\n`, data: { action, value: waited } };
		}
		case "status": {
			const child = await send({ type: "status", handle: handle() }, signal);
			const text = `${runDisplayName(child)}: ${child.state} (${child.provider}/${child.model}, ${child.thinking})\n`;
			return { text, data: { action, value: child } };
		}
		case "rename": {
			const name = normalizeRunName(required(args.name, "name", action));
			const child = await send({ type: "rename", caller, handle: handle(), name }, signal);
			return { text: `Renamed ${runDisplayName(child)}\n`, data: { action, value: child } };
		}
		case "list": {
			const children = await send({ type: "list", caller }, signal);
			const text = children.length === 0 ? "No subagents\n" : children.map((child) => `${childLine(child)}\n`).join("");
			return { text, data: { action, value: [...children] } };
		}
		case "stop": {
			const stopped = await send({ type: "stop", caller, handle: handle() }, signal);
			return { text: `Stopped ${runDisplayName(stopped)}\n`, data: { action, value: stopped } };
		}
		default:
			throw new Error(`Unknown action: ${String(action)}`);
	}
}

/** The spawn request of `args`, with the defaults of `scope`. */
function spawnRequest(args: ToolArgs, scope: ToolScope, requestId: string): Extract<Request, { type: "spawn" }> {
	const provider = args.provider ?? scope.provider;
	const model = args.model ?? scope.model;
	const thinking = args.thinking ?? scope.thinking;
	if (!provider) throw new Error("No provider specified and the caller has no model");
	if (!model) throw new Error("No model specified and the caller has no model");
	if (!THINKING_LEVELS.has(thinking)) throw new Error(`Invalid thinking level: ${thinking}`);
	const base = scope.cwd;
	if (base === undefined) throw new Error("spawn requires a caller with a working directory");
	const name = args.name === undefined ? undefined : normalizeRunName(args.name);
	const cwd = resolve(base, args.cwd ?? ".");
	if (!existsSync(cwd)) throw new Error(`Working directory not found: ${cwd}`);
	const tools = args.tools?.map((tool) => tool.trim()).filter((tool) => tool);
	if (tools !== undefined && tools.length === 0) throw new Error("tools requires at least one tool name");
	const files = (args.files ?? []).map((file) => resolve(base, file));
	for (const file of files) if (!existsSync(file)) throw new Error(`File not found: ${file}`);
	const prompts = args.prompts ?? [];
	if (prompts.length === 0 && files.length === 0) throw new Error("spawn requires at least one prompt or file");
	// The first message: the text of each file, as Pi gives a file argument to the model, then `Task:` and the prompts.
	let prompt = files.map(fileText).join("");
	if (prompts.length > 0) prompt += `Task:\n${prompts.join("\n\n")}`;
	return {
		type: "spawn",
		requestId,
		caller: scope.caller,
		...(name === undefined ? {} : { name }),
		provider,
		model,
		thinking,
		cwd,
		...(tools === undefined ? {} : { tools }),
		prompt,
	};
}

/** The text of `file` in a `<file>` block. An empty file gives nothing. */
function fileText(file: string): string {
	if (statSync(file).size === 0) return "";
	return `<file name="${file}">\n${readFileSync(file, "utf8").replace(/^\uFEFF/, "")}\n</file>\n`;
}

function required(value: string | undefined, argument: string, action: string): string {
	if (value === undefined || value === "") throw new Error(`${action} requires ${argument}`);
	return value;
}

/** `value` without surrounding spaces. It must be a valid run name. */
function normalizeRunName(value: string): string {
	const name = value.trim();
	if (!isValidRunName(name)) throw new Error("Subagent name must be a single line of 1 to 64 characters");
	return name;
}

function checkHandle(handle: string): string {
	if (!/^[a-z0-9]+$/.test(handle)) throw new Error(`Invalid subagent handle: ${handle}`);
	return handle;
}
