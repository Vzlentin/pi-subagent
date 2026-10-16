import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AssistantMessage, Message, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionToolContext,
	ProjectTrustStore,
	type RegisteredCommand,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { connect } from "harness/client";
import { type Host, runHost } from "harness/host";
import { statePaths } from "harness/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import subagentExtension, { SESSION_TRUST_HINT } from "../src/pi-extension.ts";

/** The harness CLI that a Herdr tab runs: the one next to the modules this package imports. */
const CLI = join(dirname(createRequire(import.meta.url).resolve("harness/herdr")), "cli.js");

const environment = { ...process.env };
const models = createModels();
/** The model requests: the prompt, the model and the thinking level. */
const calls: { readonly model: string; readonly thinking: string | undefined; readonly prompt: string }[] = [];
/** Requests that wait for a test to release them, by prompt. */
const gates = new Map<string, PromiseWithResolvers<void>>();

let root: string;
let host: Host | undefined;

function textOf(message: Message): string {
	if (message.role === "system") return "";
	const { content } = message;
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

async function respond(
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	_state: unknown,
	model: { readonly id: string },
): Promise<AssistantMessage> {
	const lastUser = context.messages.findLast((message) => message.role === "user");
	const prompt = lastUser === undefined ? "" : textOf(lastUser);
	calls.push({ model: model.id, thinking: options?.reasoning, prompt });
	const gate = gates.get(prompt);
	if (gate !== undefined) {
		await Promise.race([
			gate.promise,
			new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
		]);
	}
	return fauxAssistantMessage(`Answer to ${prompt}`);
}

/** The tool and the command that the extension registers, with `thinking` as Pi's thinking level. */
function extension(thinking = "medium"): {
	tool: ToolDefinition;
	command: Omit<RegisteredCommand, "name" | "sourceInfo">;
} {
	const tools: ToolDefinition[] = [];
	const commands: Omit<RegisteredCommand, "name" | "sourceInfo">[] = [];
	const pi = {
		on: () => {},
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerCommand: (_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => commands.push(command),
		getThinkingLevel: () => thinking,
	};
	subagentExtension(pi as unknown as ExtensionAPI);
	const [tool] = tools;
	const [command] = commands;
	if (tool === undefined || command === undefined) throw new Error("no tool or command");
	return { tool, command };
}

/** A tool call in the session `pi-session` with the model `faux/<model>`, in `cwd`, trusted for the session when `trusted`. */
function piContext(model: string, scope: { readonly cwd?: string; readonly trusted?: boolean } = {}) {
	return {
		model: { provider: "faux", id: model },
		sessionManager: { getSessionId: () => "pi-session" },
		cwd: scope.cwd ?? root,
		isProjectTrusted: () => scope.trusted === true,
	} as unknown as ExtensionToolContext;
}

/** A `/subagent` call in the session `pi-session` that selects the first option that `pick` accepts and keeps the notes. */
function commandContext(pick: (option: string) => boolean, notes: string[]): ExtensionCommandContext {
	return {
		sessionManager: { getSessionId: () => "pi-session" },
		ui: {
			select: async (_title: string, options: string[]) => options.find(pick),
			notify: (message: string) => notes.push(message),
		},
	} as unknown as ExtensionCommandContext;
}

let piCalls = 0;

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

function handleOf(result: { data: unknown }): string {
	return (result.data as { value: { handle: string } }).value.handle;
}

async function until(check: () => boolean): Promise<void> {
	for (let tries = 0; tries < 200 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
	if (!check()) throw new Error("timed out");
}

/**
 * A `herdr` on `PATH` that logs its arguments to `log`, one line for each call, and gives the pane `p1` to a new tab, or
 * fails `tab create` with `failTabCreate` on stderr.
 */
async function fakeHerdr(failTabCreate?: string): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
	const bin = await mkdtemp(join(root, "bin-"));
	const log = join(bin, "herdr.log");
	const tabCreate =
		failTabCreate === undefined
			? `echo '{"result":{"root_pane":{"pane_id":"p1"}}}'`
			: `echo '${failTabCreate}' >&2; exit 1`;
	const script = `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1 $2" = "tab create" ]; then ${tabCreate}; fi
`;
	await writeFile(join(bin, "herdr"), script);
	await chmod(join(bin, "herdr"), 0o755);
	return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, log };
}

function logLines(log: string): string[] {
	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
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
	};
	for (const name of ["PI_SESSION_ID", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "HERDR_ENV", "HERDR_PANE_ID"]) {
		delete process.env[name];
	}
	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "faux-1", reasoning: true },
			{ id: "faux-2", reasoning: true },
		],
	});
	faux.setResponses(Array.from({ length: 100 }, () => respond));
	models.setProvider(faux.provider);
	host = await runHost({ stateDir: statePaths().dir, models });
});

afterAll(async () => {
	await host?.close();
	process.env = environment;
	await rm(root, { recursive: true, force: true });
});

describe("pi-subagent", { timeout: 30_000 }, () => {
	it("runs the tool with the caller's session, model and thinking level", async () => {
		const { tool } = extension("low");
		const ctx = piContext("faux-2");
		const spawned = await callPi(tool, ctx, { action: "spawn", name: "pi", prompts: ["From Pi"] });
		const handle = handleOf(spawned);
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
			model: "faux-2",
			thinking: "low",
			prompt: "Task:\nFrom Pi",
		});
		expect((await callPi(tool, ctx, { action: "list" })).text).toContain(
			`pi (${handle})  idle      faux/faux-2  low\n`,
		);

		const args = { action: "spawn", provider: "faux", model: "faux-1", thinking: "high", prompts: ["Pi override"] };
		await callPi(tool, ctx, { action: "wait", handle: handleOf(await callPi(tool, ctx, args)) });
		expect(calls.find((call) => call.prompt === "Task:\nPi override")).toMatchObject({
			model: "faux-1",
			thinking: "high",
		});
	});

	it("stops a wait on abort and leaves the child busy", async () => {
		const { tool } = extension();
		const ctx = piContext("faux-1");
		gates.set("Task:\nPi gated", Promise.withResolvers());
		const handle = handleOf(await callPi(tool, ctx, { action: "spawn", prompts: ["Pi gated"] }));
		await until(() => calls.some((call) => call.prompt === "Task:\nPi gated"));
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

	it("tells a session that trusts its project only for itself that the child gets no project skills", async () => {
		const project = join(root, "project");
		await mkdir(join(project, ".pi", "skills", "local"), { recursive: true });
		await writeFile(
			join(project, ".pi", "skills", "local", "SKILL.md"),
			"---\nname: local\ndescription: The local skill.\n---\nDo it.\n",
		);
		const { tool } = extension();
		const sessionOnly = piContext("faux-1", { cwd: project, trusted: true });
		const spawn = { action: "spawn", prompts: ["Session trust"] };
		expect((await callPi(tool, sessionOnly, spawn)).text).toContain(`\n${SESSION_TRUST_HINT}\n`);
		// Once `/trust` saves the decision, the session is told nothing.
		new ProjectTrustStore(join(root, "agent")).set(project, true);
		expect((await callPi(tool, sessionOnly, spawn)).text).not.toContain(SESSION_TRUST_HINT);
	});

	it("opens a child from /subagent in a Herdr tab, or shows the command", async () => {
		const herdr = await fakeHerdr();
		const { tool, command } = extension();
		const spawned = await callPi(tool, piContext("faux-1"), { action: "spawn", name: "tabbed", prompts: ["Tab me"] });
		const handle = handleOf(spawned);
		const notes: string[] = [];
		const ctx = commandContext((option) => option.includes(handle), notes);
		const saved = process.env;
		try {
			process.env = { ...herdr.env, HERDR_ENV: "1" };
			await command.handler("", ctx);
			expect(logLines(herdr.log)).toEqual([
				`tab create --cwd ${root} --label tabbed --focus --env XDG_STATE_HOME=${process.env.XDG_STATE_HOME}`,
				`pane run p1 'env' '${process.execPath}' '${CLI}' 'attach' '${handle}'`,
			]);
			expect(notes).toEqual([]);
			process.env = { ...herdr.env };
			await command.handler("", ctx);
			expect(logLines(herdr.log)).toHaveLength(2);
			expect(notes).toEqual([`Run in another terminal: harness attach ${handle}`]);
		} finally {
			process.env = saved;
		}
	});

	it("shows the herdr error and the command when /subagent cannot open a Herdr tab", async () => {
		const herdr = await fakeHerdr("no such session");
		const { tool, command } = extension();
		const handle = handleOf(
			await callPi(tool, piContext("faux-1"), { action: "spawn", name: "untabbed", prompts: ["No tab"] }),
		);
		const notes: string[] = [];
		const saved = process.env;
		try {
			process.env = { ...herdr.env, HERDR_ENV: "1" };
			await command.handler(
				"",
				commandContext((option) => option.includes(handle), notes),
			);
		} finally {
			process.env = saved;
		}
		expect(notes).toEqual([
			`Could not open a Herdr tab: no such session. Run in another terminal: harness attach ${handle}`,
		]);
		expect(logLines(herdr.log)).toHaveLength(1);
		expect(logLines(herdr.log)[0]).toMatch(/^tab create /);
	});

	it("opens the selected child from /subagent when its name starts with the handle of another child", async () => {
		const herdr = await fakeHerdr();
		const { tool, command } = extension();
		const handleA = handleOf(await callPi(tool, piContext("faux-1"), { action: "spawn", prompts: ["Unnamed"] }));
		const name = `${handleA}  copy`;
		const handleB = handleOf(await callPi(tool, piContext("faux-1"), { action: "spawn", name, prompts: ["Named"] }));
		const notes: string[] = [];
		const saved = process.env;
		try {
			process.env = { ...herdr.env, HERDR_ENV: "1" };
			await command.handler(
				"",
				commandContext((option) => option.includes(`(${handleB})`), notes),
			);
		} finally {
			process.env = saved;
		}
		expect(notes).toEqual([]);
		const lines = logLines(herdr.log);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(`--label ${name} --focus`);
		expect(lines[1]).toMatch(new RegExp(`'attach' '${handleB}'$`));
	});

	it("starts a host from the harness under node_modules when none runs", async () => {
		const saved = process.env;
		process.env = { ...saved, XDG_STATE_HOME: join(root, "other-state") };
		try {
			const client = await connect({ start: true });
			const pid = client?.pid;
			client?.close();
			expect(pid).toBeGreaterThan(0);
			if (pid !== undefined) process.kill(pid);
		} finally {
			process.env = saved;
		}
	});
});
