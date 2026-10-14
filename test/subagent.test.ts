import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import * as ai from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as durable from "@earendil-works/pi-durable";
import { AssistantEntry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, request, statePaths } from "../client.ts";
import subagentEntry, { subagentTool } from "../durable.ts";
import { type Host, runHost } from "../host.ts";
import subagentExtension from "../index.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "subagent.ts");

/** One model request: what the faux provider saw. */
type Call = {
	readonly provider: string;
	readonly model: string;
	readonly thinking: string | undefined;
	readonly prompt: string;
};

const calls: Call[] = [];
/** Requests that wait for a test to release them, by prompt. */
const gates = new Map<string, PromiseWithResolvers<void>>();

let root: string;
let host: Host | undefined;
const models = createModels();
const environment = { ...process.env };

function textOf(message: Message): string {
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
]);
/** Resolved when the model asks the `subagent` tool to wait, by the prompt of the turn. */
const toolWaits = new Map<string, PromiseWithResolvers<string>>();

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
	if (last?.role === "toolResult") return fauxAssistantMessage(`Tool said: ${textOf(last)}`);
	calls.push({ provider: model.provider, model: model.id, thinking: options?.reasoning, prompt });
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

type Result = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** Runs `subagent <args>` as a real process, in `cwd`, with `env` over the test environment. */
function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}, cwd = root): Promise<Result> {
	return new Promise((resolve) => {
		execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
			resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr });
		});
	});
}

/** The handle in `Spawned <handle>` or `Spawned <name> (<handle>)`. */
function handleOf(result: Result): string {
	const handle = /^Spawned (?:.* \()?([a-z0-9]+)\)?$/m.exec(result.stdout)?.[1];
	if (handle === undefined) throw new Error(`no handle in ${JSON.stringify(result)}`);
	return handle;
}

function startHost(): Promise<Host | undefined> {
	return runHost({ stateDir: statePaths().dir, models });
}

/** Polls `check` for up to 10 s. */
async function until(check: () => boolean): Promise<void> {
	for (let tries = 0; tries < 200 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
	if (!check()) throw new Error("timed out");
}

function called(prompt: string): number {
	return calls.filter((call) => call.prompt === prompt).length;
}

/** The `subagent` tool that the Pi extension registers, with `thinking` as Pi's thinking level. */
function piTool(thinking: string): ToolDefinition {
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

/** The context of a Pi tool call in the session `pi-session`, with the model `faux/<model>`. */
function piContext(model: string): ExtensionToolContext {
	return {
		model: { provider: "faux", id: model },
		sessionManager: { getSessionId: () => "pi-session" },
		cwd: root,
	} as unknown as ExtensionToolContext;
}

/** What the pi-durable test hosts report, such as a structured output that does not match the tool's schema. */
const reports: unknown[] = [];

let piCalls = 0;

/** Calls the Pi tool and gives its text and structured content. */
async function callPi(
	tool: ToolDefinition,
	ctx: ExtensionToolContext,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ text: string; data: unknown }> {
	const result = await tool.execute(`call-${++piCalls}`, args, signal, undefined, ctx);
	const [content] = result.content;
	return { text: content?.type === "text" ? content.text : "", data: result.structuredContent };
}

/** A pi-durable host over `store` with the `piDurable` entry of this package. */
async function openDurable(store: string): Promise<Harness> {
	const entry = subagentEntry({ durable, ai });
	const registry = durable.createRegistry();
	for (const extension of entry.extensions) registry.install(extension);
	return Harness.open(
		await openNodeSqliteStorage(store),
		{ models, registry, onReport: (error) => reports.push(error) },
		BACKGROUND_CONTEXT,
	);
}

/**
 * A pi-durable host over `store` with the `subagent` tool, where the caller is `durable-test:<conversation ID>`. With
 * `hangSpawn`, a spawn reaches the subagent host, but the tool call never finishes.
 */
async function openDurableTool(store: string, hangSpawn: boolean): Promise<Harness> {
	const registry = durable.createRegistry();
	registry.install(
		subagentTool(durable, ai, {
			caller: async (api) => `durable-test:${api.conversationId}`,
			send: async (message, signal) => {
				const reply = await request(message, { start: true, signal });
				if (!hangSpawn || message.type !== "spawn") return reply;
				return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
			},
		}),
	);
	return Harness.open(
		await openNodeSqliteStorage(store),
		{ models, registry, onReport: (error) => reports.push(error) },
		BACKGROUND_CONTEXT,
	);
}

beforeAll(async () => {
	// macOS limits a Unix socket path to 104 bytes, so the state stays short, under /tmp.
	root = await mkdtemp("/tmp/pi-subagent-");
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
	for (const name of ["PI_SESSION_ID", "PI_REASONING_LEVEL", "PI_SESSION_FILE"]) delete process.env[name];
	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "faux-1", reasoning: true },
			{ id: "faux-2", reasoning: true },
		],
	});
	faux.setResponses(Array.from({ length: 500 }, () => respond));
	models.setProvider(faux.provider);
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	process.env = environment;
	await rm(root, { recursive: true, force: true });
});

describe("subagent", { timeout: 30_000 }, () => {
	it("spawns, reports and waits for a child", async () => {
		const spawned = await cli(["spawn", "--name", "greeter", "--prompt", "Say hello"]);
		expect(spawned.stderr).toBe("");
		const handle = handleOf(spawned);
		expect(spawned.stdout).toBe(`Spawned greeter (${handle})\nState: busy\n`);

		const waited = await cli(["wait", handle]);
		expect(waited).toEqual({ code: 0, stdout: `${handle} finished\n\nAnswer to Task:\nSay hello\n`, stderr: "" });
		expect((await cli(["status", handle])).stdout).toBe(`greeter (${handle}): idle (faux/faux-1, medium)\n`);
		expect((await cli(["list"])).stdout).toContain(`greeter (${handle})  idle      faux/faux-1  medium\n`);
		expect(calls.find((call) => call.prompt === "Task:\nSay hello")).toEqual({
			provider: "faux",
			model: "faux-1",
			thinking: "medium",
			prompt: "Task:\nSay hello",
		});
	});

	it("passes the model, thinking level and files to the child", async () => {
		const file = join(root, "spec.md");
		await writeFile(file, "The spec.");
		const spawned = await cli([
			"spawn",
			"--provider",
			"faux",
			"--model",
			"faux-2",
			"--thinking",
			"high",
			"--file",
			file,
			"--prompt",
			"Read it",
		]);
		const handle = handleOf(spawned);
		const prompt = `<file name="${file}">\nThe spec.\n</file>\nTask:\nRead it`;
		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to ${prompt}\n`);
		expect(calls.find((call) => call.prompt === prompt)).toEqual({
			provider: "faux",
			model: "faux-2",
			thinking: "high",
			prompt,
		});
		expect((await cli(["status", handle])).stdout).toBe(`${handle}: idle (faux/faux-2, high)\n`);
	});

	it("refuses unknown arguments, models and tools", async () => {
		expect((await cli(["spawn", "--no-skills", "--prompt", "x"])).stderr).toBe("Unknown spawn argument: --no-skills\n");
		expect((await cli(["spawn", "--model", "nope", "--prompt", "x"])).stderr).toBe("Unknown model: faux/nope\n");
		expect((await cli(["spawn", "--tools", "read,grep", "--prompt", "x"])).stderr).toBe("Unknown tool: grep\n");
		expect((await cli(["status", "abcdef"])).stderr).toBe("Unknown subagent: abcdef\n");
		expect((await cli(["spawn", "--thinking", "huge", "--prompt", "x"])).stderr).toBe("Invalid thinking level: huge\n");
		expect((await cli(["spawn", "--name", "x"])).stderr).toBe("spawn requires at least one prompt or file\n");
		expect((await cli(["status", "ABC"])).stderr).toBe("Invalid subagent handle: ABC\n");
	});

	it("gives the child's bash its session ID, provider, model and thinking level", async () => {
		const handle = handleOf(await cli(["spawn", "--thinking", "low", "--prompt", "Environment"]));
		const { stdout } = await cli(["wait", handle]);
		expect(stdout).toMatch(new RegExp(`^${handle} finished\n\nTool said: \\d+ faux faux-1 low\n`));
	});

	it("steers a busy child after its tool round", async () => {
		const cwd = await mkdtemp(join(root, "steer-"));
		const handle = handleOf(await cli(["spawn", "--cwd", cwd, "--prompt", "Use a tool"]));
		await until(() => called("Task:\nUse a tool") === 1);
		expect((await cli(["send", handle, "Focus on errors"])).stdout).toBe(`Steered ${handle}\n`);
		await writeFile(join(cwd, "go"), "");
		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to Focus on errors\n`);
		expect((await cli(["send", handle, "Again"])).stdout).toBe(`Prompted ${handle}\n`);
		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to Again\n`);
	});

	it("queues a follow-up, renames and stops a child", async () => {
		gates.set("Task:\nHold on", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Hold on"]));
		await until(() => called("Task:\nHold on") === 1);
		expect((await cli(["send", handle, "--follow-up", "Then summarize"])).stdout).toBe(
			`Queued follow-up for ${handle}\n`,
		);
		expect((await cli(["status", handle])).stdout).toBe(`${handle}: busy (faux/faux-1, medium)\n`);
		gates.get("Task:\nHold on")?.resolve();
		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to Then summarize\n`);

		expect((await cli(["rename", handle, "summary"])).stdout).toBe(`Renamed summary (${handle})\n`);
		expect((await cli(["stop", handle])).stdout).toBe(`Stopped summary (${handle})\n`);
		expect((await cli(["status", handle])).stderr).toBe(`Unknown subagent: ${handle}\n`);
	});

	it("stops a busy child", async () => {
		gates.set("Task:\nNever", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Never"]));
		await until(() => called("Task:\nNever") === 1);
		expect((await cli(["stop", handle])).stdout).toBe(`Stopped ${handle}\n`);
		expect((await cli(["list"])).stdout).not.toContain(handle);
	});

	it("reports a failed turn as an error", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Fail"]));
		const waited = await cli(["wait", handle]);
		expect(waited.code).toBe(1);
		expect(waited.stderr).toBe(`${handle} failed: overloaded\n`);
		expect((await cli(["status", handle])).stdout).toBe(`${handle}: error (faux/faux-1, medium)\n`);
	});

	it("times out a wait", async () => {
		gates.set("Task:\nSlow", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Slow"]));
		expect((await cli(["wait", handle, "--timeout", "1"])).stderr).toBe(`Timed out after 1s waiting for ${handle}\n`);
		gates.get("Task:\nSlow")?.resolve();
		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to Task:\nSlow\n`);
	});

	it("keeps each caller's children apart", async () => {
		const other = { PI_SESSION_ID: "other-session" };
		gates.set("Task:\nMine", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--name", "mine", "--prompt", "Mine"], other));
		expect((await cli(["list"], other)).stdout).toBe(`mine (${handle})  busy      faux/faux-1  medium\n`);
		expect((await cli(["list"], { PI_SESSION_ID: "third" })).stdout).toBe("No subagents\n");
		expect((await cli(["send", handle, "Hi"])).stderr).toBe(`Subagent ${handle} belongs to another session\n`);
		expect((await cli(["stop", handle])).stderr).toBe(`Subagent ${handle} belongs to another session\n`);
		gates.get("Task:\nMine")?.resolve();
		expect((await cli(["wait", handle], other)).stdout).toBe(`${handle} finished\n\nAnswer to Task:\nMine\n`);
	});

	it("lets a child spawn a child, but not a third level", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Nest"]));
		const { stdout } = await cli(["wait", handle]);
		expect(stdout).toMatch(/^[a-z0-9]+ finished\n\nTool said: Spawned nested \(([a-z0-9]+)\)\nState: busy\n/);
		expect(stdout).toContain("finished\n\nTool said: Nested subagents are disabled");
		expect(called("Task:\nNest")).toBe(2);
		// The nested child belongs to its parent, not to this caller.
		expect((await cli(["list"])).stdout).not.toContain("nested");
	});

	it("lets a child spawn a child with the tool, but not a third level", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Nest tool"]));
		const { stdout } = await cli(["wait", handle]);
		expect(stdout).toMatch(
			new RegExp(
				`^${handle} finished\n\nTool said: [a-z0-9]+ finished\n\nTool said: <harness>\n\\[error\\] Nested subagents are disabled\n`,
			),
		);
		expect(called("Task:\nNest tool")).toBe(2);
	});

	it("gives children the host's own tool when pi-subagent is also an installed package", async () => {
		const linked = join(root, "linked-package");
		await symlink(dirname(CLI), linked);
		const settings = join(root, "agent", "settings.json");
		await writeFile(settings, JSON.stringify({ retry: { enabled: false }, packages: [linked] }));
		try {
			await host?.close();
			host = await startHost();
			// With the entry of the package, the caller of a child would be `<store>:<conversation ID>`, and the depth
			// limit would not see the third level.
			const handle = handleOf(await cli(["spawn", "--prompt", "Nest tool"]));
			expect((await cli(["wait", handle])).stdout).toContain("Nested subagents are disabled");
		} finally {
			await writeFile(settings, JSON.stringify({ retry: { enabled: false } }));
			await host?.close();
			host = await startHost();
		}
	});

	it("runs the Pi tool with the caller's session, model and thinking level", async () => {
		const tool = piTool("low");
		const ctx = piContext("faux-2");
		const spawned = await callPi(tool, ctx, { action: "spawn", name: "pi", prompts: ["From Pi"] });
		const handle = (spawned.data as { value: { handle: string } }).value.handle;
		expect(spawned.text).toBe(`Spawned pi (${handle})\nState: busy\n`);
		expect(spawned.data).toMatchObject({
			action: "spawn",
			value: { handle, name: "pi", provider: "faux", model: "faux-2", thinking: "low" },
		});
		expect(await callPi(tool, ctx, { action: "wait", handle })).toEqual({
			text: `${handle} finished\n\nAnswer to Task:\nFrom Pi\n`,
			data: { action: "wait", value: { answer: "Answer to Task:\nFrom Pi" } },
		});
		expect(calls.find((call) => call.prompt === "Task:\nFrom Pi")).toEqual({
			provider: "faux",
			model: "faux-2",
			thinking: "low",
			prompt: "Task:\nFrom Pi",
		});
		expect((await cli(["list"], { PI_SESSION_ID: "pi-session" })).stdout).toContain(
			`pi (${handle})  idle      faux/faux-2  low\n`,
		);

		const args = { action: "spawn", provider: "faux", model: "faux-1", thinking: "high", prompts: ["Pi override"] };
		const other = (await callPi(tool, ctx, args)).data as { value: { handle: string } };
		await callPi(tool, ctx, { action: "wait", handle: other.value.handle });
		expect(calls.find((call) => call.prompt === "Task:\nPi override")).toMatchObject({
			model: "faux-1",
			thinking: "high",
		});
	});

	it("stops a Pi tool wait on abort and leaves the child busy", async () => {
		const tool = piTool("medium");
		const ctx = piContext("faux-1");
		gates.set("Task:\nPi gated", Promise.withResolvers());
		const spawned = await callPi(tool, ctx, { action: "spawn", prompts: ["Pi gated"] });
		const handle = (spawned.data as { value: { handle: string } }).value.handle;
		await until(() => called("Task:\nPi gated") === 1);
		await expect(callPi(tool, ctx, { action: "wait", handle }, AbortSignal.timeout(100))).rejects.toMatchObject({
			name: "TimeoutError",
		});
		expect((await callPi(tool, ctx, { action: "status", handle })).text).toBe(
			`${handle}: busy (faux/faux-1, medium)\n`,
		);
		gates.get("Task:\nPi gated")?.resolve();
		expect((await callPi(tool, ctx, { action: "wait", handle })).text).toBe(
			`${handle} finished\n\nAnswer to Task:\nPi gated\n`,
		);
	});

	it("runs the tool in a pi-durable host and reruns a wait after a restart", async () => {
		reports.length = 0;
		const context = BACKGROUND_CONTEXT;
		const store = join(root, "durable-host.sqlite");
		gates.set("Task:\nDurable child", Promise.withResolvers());
		const waiting = Promise.withResolvers<string>();
		toolWaits.set("Durable", waiting);
		let harness = await openDurable(store);
		try {
			const conversation = await harness.root(context, {
				agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root },
			});
			await conversation.submit({ type: "input", content: "Durable", requestId: "durable" }, context);
			const handle = await waiting.promise;
			await until(() => called("Task:\nDurable child") === 1);
			// Let the wait reach the host before the restart.
			await new Promise((resolve) => setTimeout(resolve, 200));
			await harness.close(context);
			harness = await openDurable(store);
			harness.resume();
			gates.get("Task:\nDurable child")?.resolve();
			const reopened = await harness.root(context);
			const submission = await reopened.submit({ type: "input", content: "Durable", requestId: "durable" }, context);
			const settled = await submission.wait(context);
			if (settled.status !== "done" || settled.answer === undefined) throw new Error(JSON.stringify(settled));
			const answer = settled.answer;
			const entry = await harness.commit((tx) => tx.entry(AssistantEntry, answer), context);
			const message = entry?.model?.[0];
			expect(message?.role === "assistant" ? message.content : []).toEqual([
				{ type: "text", text: `Tool said: ${handle} finished\n\nAnswer to Task:\nDurable child\n` },
			]);
			expect(called("Task:\nDurable child")).toBe(1);
			expect(reports).toEqual([]);
		} finally {
			await harness.close(context);
		}
	});

	it("reruns a pi-durable spawn after a restart and reaches the same child", async () => {
		reports.length = 0;
		const context = BACKGROUND_CONTEXT;
		const store = join(root, "durable-spawn.sqlite");
		let harness = await openDurableTool(store, true);
		try {
			const conversation = await harness.root(context, {
				agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root },
			});
			const caller = `durable-test:${conversation.id}`;
			await conversation.submit({ type: "input", content: "Durable spawn", requestId: "durable-spawn" }, context);
			await until(() => called("Task:\nDurable spawned") === 1);
			await harness.close(context);
			harness = await openDurableTool(store, false);
			harness.resume();
			const reopened = await harness.root(context);
			const submission = await reopened.submit(
				{ type: "input", content: "Durable spawn", requestId: "durable-spawn" },
				context,
			);
			const settled = await submission.wait(context);
			if (settled.status !== "done" || settled.answer === undefined) throw new Error(JSON.stringify(settled));
			const children = await request({ type: "list", caller }, { start: false });
			expect(children).toHaveLength(1);
			const answer = settled.answer;
			const entry = await harness.commit((tx) => tx.entry(AssistantEntry, answer), context);
			const message = entry?.model?.[0];
			expect(message?.role === "assistant" ? message.content : []).toEqual([
				{
					type: "text",
					text: `Tool said: ${children?.[0]?.handle} finished\n\nAnswer to Task:\nDurable spawned\n`,
				},
			]);
			expect(called("Task:\nDurable spawned")).toBe(1);
			expect(reports).toEqual([]);
		} finally {
			await harness.close(context);
		}
	});

	it("refuses a pi-durable spawn from a conversation without a working directory", async () => {
		reports.length = 0;
		const context = BACKGROUND_CONTEXT;
		const harness = await openDurable(join(root, "durable-no-cwd.sqlite"));
		try {
			const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			const submission = await conversation.submit({ type: "input", content: "No cwd", requestId: "no-cwd" }, context);
			const settled = await submission.wait(context);
			if (settled.status !== "done" || settled.answer === undefined) throw new Error(JSON.stringify(settled));
			const answer = settled.answer;
			const entry = await harness.commit((tx) => tx.entry(AssistantEntry, answer), context);
			const message = entry?.model?.[0];
			const text = message?.role === "assistant" && message.content[0]?.type === "text" ? message.content[0].text : "";
			expect(text).toContain("spawn requires a caller with a working directory");
			expect(called("Task:\nNo cwd child")).toBe(0);
			expect(reports).toEqual([]);
		} finally {
			await harness.close(context);
		}
	});

	it("dedupes spawn and send by request ID", async () => {
		const client = await connect({ start: false });
		if (client === undefined) throw new Error("no host");
		try {
			const spawn = {
				type: "spawn",
				requestId: "spawn-once",
				caller: "cli",
				provider: "faux",
				model: "faux-1",
				thinking: "medium",
				cwd: root,
				prompt: "Once",
			} as const;
			const [first, second] = await Promise.all([client.request(spawn), client.request(spawn)]);
			expect(second.handle).toBe(first.handle);
			await client.request({ type: "wait", handle: first.handle, timeout: 10 });
			const send = {
				type: "send",
				requestId: "send-once",
				caller: "cli",
				handle: first.handle,
				message: "Twice?",
				followUp: false,
			} as const;
			await client.request(send);
			await client.request(send);
			expect(await client.request({ type: "wait", handle: first.handle, timeout: 10 })).toEqual({
				answer: "Answer to Twice?",
			});
			// A repeat after success finds its first submission and does not move `wait` back to it.
			await client.request(spawn);
			expect(await client.request({ type: "wait", handle: first.handle, timeout: 10 })).toEqual({
				answer: "Answer to Twice?",
			});
			await client.request({ ...send, requestId: "send-newer", message: "Newer" });
			expect(await client.request({ type: "wait", handle: first.handle, timeout: 10 })).toEqual({
				answer: "Answer to Newer",
			});
			await client.request(send);
			expect(await client.request({ type: "wait", handle: first.handle, timeout: 10 })).toEqual({
				answer: "Answer to Newer",
			});
		} finally {
			client.close();
		}
		expect(called("Once")).toBe(1);
		expect(called("Twice?")).toBe(1);
		expect(called("Newer")).toBe(1);
	});

	it("keeps the prompt of a spawn that stopped before its submit, also after a send", async () => {
		await host?.close();
		const open = Harness.open.bind(Harness);
		const opened = vi.spyOn(Harness, "open").mockImplementationOnce(async (...args) => {
			const harness = await open(...args);
			// The first conversation lookup after the spawn commits its record is the one before the submit.
			vi.spyOn(harness, "conversation").mockRejectedValueOnce(new Error("Stopped before submit"));
			return harness;
		});
		const caller = "interrupted";
		const spawn = {
			type: "spawn",
			requestId: "spawn-interrupted",
			caller,
			provider: "faux",
			model: "faux-1",
			thinking: "medium",
			cwd: root,
			prompt: "First prompt",
		} as const;
		try {
			host = await startHost();
			const client = await connect({ start: false });
			if (client === undefined) throw new Error("no host");
			try {
				await expect(client.request(spawn)).rejects.toThrow("Stopped before submit");
			} finally {
				client.close();
			}
			await host?.close();
		} finally {
			opened.mockRestore();
		}
		host = await startHost();
		const client = await connect({ start: false });
		if (client === undefined) throw new Error("no host");
		try {
			const [child] = await client.request({ type: "list", caller });
			if (child === undefined) throw new Error("no child");
			const handle = child.handle;
			await client.request({
				type: "send",
				requestId: "send-between",
				caller,
				handle,
				message: "Between",
				followUp: false,
			});
			expect(await client.request({ type: "wait", handle, timeout: 10 })).toEqual({ answer: "Answer to Between" });
			expect((await client.request(spawn)).handle).toBe(handle);
			expect(await client.request({ type: "wait", handle, timeout: 10 })).toEqual({
				answer: "Answer to First prompt",
			});
		} finally {
			client.close();
		}
		expect(called("First prompt")).toBe(1);
		expect(called("Between")).toBe(1);
	});

	it("finishes a turn after the host restarts", async () => {
		gates.set("Task:\nSurvive", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Survive"]));
		await until(() => called("Task:\nSurvive") === 1);
		await host?.close();
		gates.delete("Task:\nSurvive");
		host = await startHost();
		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to Task:\nSurvive\n`);
		expect(called("Task:\nSurvive")).toBe(2);
	});

	it("starts one host for two clients", async () => {
		const state = join(root, "state2");
		process.env.XDG_STATE_HOME = state;
		let pid: number | undefined;
		try {
			const clients = await Promise.all([connect({ start: true }), connect({ start: true })]);
			for (const client of clients) client?.close();
			pid = clients[0]?.pid;
			expect(pid).toBeGreaterThan(0);
			expect(clients[1]?.pid).toBe(pid);
			expect(pid).not.toBe(process.pid);
			// The other started host finds the lock held and exits.
			const log = join(state, "pi-subagent", "host.log");
			await until(() => readFileSync(log, "utf8").includes("Another subagent host runs"));
		} finally {
			process.env.XDG_STATE_HOME = join(root, "state");
			if (pid !== undefined) process.kill(pid, "SIGTERM");
		}
		await until(() => !existsSync(join(state, "pi-subagent", "host.sock")));
	});

	it("stops waiting for the host to start when the request aborts", async () => {
		const state = join(root, "state3");
		await mkdir(join(state, "pi-subagent"), { recursive: true });
		// With the lock held, the started host exits at once, and nothing ever listens.
		const lock = new DatabaseSync(join(state, "pi-subagent", "lock.sqlite"));
		lock.exec("BEGIN EXCLUSIVE");
		process.env.XDG_STATE_HOME = state;
		try {
			const signal = AbortSignal.timeout(200);
			await expect(request({ type: "list", caller: "cli" }, { start: true, signal })).rejects.toMatchObject({
				name: "TimeoutError",
			});
			// The lock stays held until the started host has found it held and exited.
			const log = join(state, "pi-subagent", "host.log");
			await until(() => existsSync(log) && readFileSync(log, "utf8").includes("Another subagent host runs"));
		} finally {
			process.env.XDG_STATE_HOME = join(root, "state");
			lock.close();
		}
	});
});
