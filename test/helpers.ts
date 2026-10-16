import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessage,
	getSystemMessageText,
	type Message,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { statePaths } from "../client.ts";
import { type Host, runHost } from "../host.ts";
import subagentExtension from "../index.ts";

export const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "subagent.ts");

export let root: string;

/** One model request: what the faux provider saw. */
type Call = {
	readonly provider: string;
	readonly model: string;
	readonly thinking: string | undefined;
	readonly prompt: string;
};

export const calls: Call[] = [];
/** The system prompt and the tools of the last request for each prompt. */
export const requests = new Map<string, { readonly system: string; readonly tools: readonly string[] }>();
/** Requests that wait for a test to release them, by prompt. */
export const gates = new Map<string, PromiseWithResolvers<void>>();

export const models = createModels();
const environment = { ...process.env };

export function textOf(message: Message): string {
	if (message.role === "system") return "";
	const { content } = message;
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The bash command a child runs for `Task:\nNest`: spawn a child with the same task, then wait for it. */
function nestCommand(): string {
	const cli = `"${process.execPath}" "${CLI}"`;
	return [
		`out=$(${cli} spawn --name nested --prompt Nest) || exit 1`,
		`echo "$out"`,
		`${cli} wait "$(echo "$out" | sed -n 's/.*(\\([a-z0-9]*\\))$/\\1/p')"`,
	].join("\n");
}

/** Prompts that call the `subagent` tool to spawn a child with the given prompt, then to wait for it. */
const toolSpawns = new Map([
	["Durable", "Durable child"],
	["Durable spawn", "Durable spawned"],
	["Task:\nNest tool", "Nest tool"],
	["No cwd", "No cwd child"],
	["Task:\nSend and wait", "Send and wait child"],
]);
/** Resolved when the model asks the `subagent` tool to wait, by the prompt of the turn. */
export const toolWaits = new Map<string, PromiseWithResolvers<string>>();

async function respond(
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	_state: unknown,
	model: { readonly id: string; readonly provider: string },
): Promise<AssistantMessage> {
	const messages = context.messages.filter((message) => message.role !== "system");
	const last = messages.at(-1);
	const lastUser = messages.findLast((message) => message.role === "user");
	const prompt = lastUser === undefined ? "" : textOf(lastUser);
	const child = toolSpawns.get(prompt);
	if (
		child !== undefined &&
		last?.role === "toolResult" &&
		messages.filter((m) => m.role === "toolResult").length === 1
	) {
		const handle = /\(([a-z0-9]+)\)$/m.exec(textOf(last))?.[1];
		if (handle !== undefined) {
			toolWaits.get(prompt)?.resolve(handle);
			return fauxAssistantMessage(fauxToolCall("subagent", { action: "wait", handle }), { stopReason: "toolUse" });
		}
	}
	// After its spawn and wait, `Task:\nSend and wait` sends to the child and waits for it in one message.
	const results = messages.filter((m) => m.role === "toolResult");
	if (prompt === "Task:\nSend and wait" && last?.role === "toolResult" && results.length === 2) {
		const handle = /\(([a-z0-9]+)\)$/m.exec(results[0] === undefined ? "" : textOf(results[0]))?.[1];
		if (handle === undefined) throw new Error("no handle in the spawn result");
		const toolCalls = [
			fauxToolCall("subagent", { action: "send", handle, message: "Sent message" }),
			fauxToolCall("subagent", { action: "wait", handle }),
		];
		return fauxAssistantMessage(toolCalls, { stopReason: "toolUse" });
	}
	if (last?.role === "toolResult") return fauxAssistantMessage(`Tool said: ${textOf(last)}`);
	calls.push({ provider: model.provider, model: model.id, thinking: options?.reasoning, prompt });
	const [system] = context.messages;
	if (system?.role === "system") {
		requests.set(prompt, {
			system: getSystemMessageText(system),
			tools: (system.toolsAdded ?? []).map(({ name }) => name),
		});
	}
	const gate = gates.get(prompt);
	if (gate !== undefined) {
		await Promise.race([
			gate.promise,
			new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
		]);
	}
	if (child !== undefined) {
		const args = { action: "spawn", name: "nested", prompts: [child] };
		return fauxAssistantMessage(fauxToolCall("subagent", args), { stopReason: "toolUse" });
	}
	if (prompt === "Task:\nUse a tool") {
		return fauxAssistantMessage(fauxToolCall("bash", { command: `while [ ! -f go ]; do sleep 0.05; done` }), {
			stopReason: "toolUse",
		});
	}
	if (prompt === "Task:\nNest") {
		return fauxAssistantMessage(fauxToolCall("bash", { command: nestCommand() }), { stopReason: "toolUse" });
	}
	if (prompt === "Task:\nEnvironment") {
		const command = 'echo "$PI_SESSION_ID $PI_PROVIDER $PI_MODEL $PI_REASONING_LEVEL"';
		return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
	}
	if (prompt === "Task:\nFail") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });
	return fauxAssistantMessage(`Answer to ${prompt}`);
}

export type Result = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** Runs `subagent <args>` as a real process, in `cwd`, with `env` over the test environment. */
export function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}, cwd = root): Promise<Result> {
	return new Promise((resolve) => {
		execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
			resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr });
		});
	});
}

/** The handle in `Spawned <handle>` or `Spawned <name> (<handle>)`. */
export function handleOf(result: Result): string {
	const handle = /^Spawned (?:.* \()?([a-z0-9]+)\)?$/m.exec(result.stdout)?.[1];
	if (handle === undefined) throw new Error(`no handle in ${JSON.stringify(result)}`);
	return handle;
}

export function startHost(): Promise<Host | undefined> {
	return runHost({ stateDir: statePaths().dir, models });
}

/** Polls `check` for up to 10 s. */
export async function until(check: () => boolean): Promise<void> {
	for (let tries = 0; tries < 200 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
	if (!check()) throw new Error("timed out");
}

export function called(prompt: string): number {
	return calls.filter((call) => call.prompt === prompt).length;
}

/** The `subagent` tool that the Pi extension registers, with `thinking` as Pi's thinking level. */
export function piTool(thinking: string): ToolDefinition {
	const tools: ToolDefinition[] = [];
	const pi = {
		on: () => {},
		registerCommand: () => {},
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		getThinkingLevel: () => thinking,
	};
	subagentExtension(pi as unknown as ExtensionAPI);
	const [tool] = tools;
	if (tool === undefined) throw new Error("no tool");
	return tool;
}

/**
 * The context of a Pi tool call in the session `pi-session`, with the model `faux/<model>`, in `cwd` (default the
 * root), whose project the session trusts when `trusted` is true.
 */
export function piContext(
	model: string,
	scope: { readonly cwd?: string; readonly trusted?: boolean } = {},
): ExtensionToolContext {
	return {
		model: { provider: "faux", id: model },
		sessionManager: { getSessionId: () => "pi-session" },
		cwd: scope.cwd ?? root,
		isProjectTrusted: () => scope.trusted === true,
	} as unknown as ExtensionToolContext;
}

let piCalls = 0;

/** Calls the Pi tool and gives its text and structured content. */
export async function callPi(
	tool: ToolDefinition,
	ctx: ExtensionToolContext,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ text: string; data: unknown }> {
	const result = await tool.execute(`call-${++piCalls}`, args, signal, undefined, ctx);
	const [content] = result.content;
	return { text: content?.type === "text" ? content.text : "", data: result.structuredContent };
}

/** Makes a temporary root with the agent dir, home and state, points `process.env` at it and sets up the faux provider. */
export async function setUp(): Promise<void> {
	// macOS limits a Unix socket path to 104 bytes, so the state stays short, under /tmp.
	root = await mkdtemp("/tmp/pi-subagent-");
	requests.clear();
	await mkdir(join(root, "agent"));
	await mkdir(join(root, "home"));
	await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	process.env = {
		...environment,
		XDG_STATE_HOME: join(root, "state"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		HOME: join(root, "home"),
		PI_PROVIDER: "faux",
		PI_MODEL: "faux-1",
	};
	for (const name of ["PI_SESSION_ID", "PI_REASONING_LEVEL", "PI_SESSION_FILE", "HERDR_ENV", "HERDR_PANE_ID"]) {
		delete process.env[name];
	}
	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "faux-1", reasoning: true },
			{ id: "faux-2", reasoning: true },
		],
	});
	faux.setResponses(Array.from({ length: 500 }, () => respond));
	models.setProvider(faux.provider);
}

/** Restores `process.env` and removes the temporary root. */
export async function tearDown(): Promise<void> {
	process.env = environment;
	await rm(root, { recursive: true, force: true });
}
