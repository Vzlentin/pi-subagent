import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Message, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, statePaths } from "../client.ts";
import { type Host, runHost } from "../host.ts";

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
	if (last?.role === "toolResult") return fauxAssistantMessage(`Tool said: ${textOf(last)}`);
	calls.push({ provider: model.provider, model: model.id, thinking: options?.reasoning, prompt });
	const gate = gates.get(prompt);
	if (gate !== undefined) {
		await Promise.race([
			gate.promise,
			new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
		]);
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
});
