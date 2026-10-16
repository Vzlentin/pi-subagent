import { once } from "node:events";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { apply } from "@earendil-works/chord/delta";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Terminal } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, connect } from "../src/client.ts";
import type { Host } from "../src/host.ts";
import { type Request, statePaths, type WatchLine } from "../src/protocol.ts";
import { attach } from "../src/viewer.ts";
import {
	CLI,
	called,
	callPi,
	cli,
	gates,
	handleOf,
	piContext,
	piExtension,
	root,
	setUp,
	startHost,
	tearDown,
	textOf,
	until,
} from "./helpers.ts";

// The in-process client finds the host under the test's HOME, not the user's home, when XDG_STATE_HOME is not set.
vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	homedir: () => process.env.HOME ?? "",
}));

/** The text of each user and assistant message in `view`. */
function textsOf(view: ConversationView | undefined): string[] {
	return (view?.entries ?? []).flatMap((entry) => {
		const message = entry.model?.[0];
		return message !== undefined && (message.role === "user" || message.role === "assistant") ? [textOf(message)] : [];
	});
}

/** Pushes each event of `lines` to `into`, until the connection closes. */
async function collect(lines: AsyncIterable<WatchLine>, into: WatchLine[]): Promise<void> {
	for await (const line of lines) into.push(line);
}

/** A client of the running host. */
async function hostClient(): Promise<Client> {
	const client = await connect({ start: false });
	if (client === undefined) throw new Error("no host");
	return client;
}

/** The `--seq` of a logged `herdr` call. */
function seqOf(line: string | undefined): number {
	return Number(/--seq (\d+)/.exec(line ?? "")?.[1]);
}

/** A terminal that keeps what the TUI writes and gives it typed input. */
class FakeTerminal implements Terminal {
	output = "";
	started = false;
	#onInput: ((data: string) => void) | undefined;
	start(onInput: (data: string) => void): void {
		this.started = true;
		this.#onInput = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.output += data;
	}
	get columns(): number {
		return 100;
	}
	get rows(): number {
		return 40;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
	input(data: string): void {
		this.#onInput?.(data);
	}
	/** The output without escape sequences. */
	text(): string {
		return stripVTControlCharacters(this.output);
	}
}

/**
 * A `herdr` on `PATH` that logs its arguments to `log`, one line for each call, and gives the pane `p1` to a new tab.
 * With `failTabCreate`, `tab create` writes that text to stderr and exits with 1.
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

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("subagent", { timeout: 30_000 }, () => {
	it("watches a child: a snapshot, then an update after each commit", async () => {
		gates.set("Task:\nWatched", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--name", "watched", "--prompt", "Watched"]));
		await until(() => called("Task:\nWatched") === 1);
		const client = await hostClient();
		const first = await client.watch(handle);
		const lines: WatchLine[] = [];
		void collect(first.lines, lines);
		try {
			expect(first.child).toMatchObject({ handle, name: "watched", state: "busy", cwd: realpathSync(root) });
			expect(textsOf(first.view)).toEqual(["Task:\nWatched"]);
			gates.get("Task:\nWatched")?.resolve();
			let view = first.view;
			await until(() => lines.some((line) => !line.stopped && line.child.state === "idle"));
			for (const line of lines) if (!line.stopped) view = apply(view, line.ops);
			expect(textsOf(view)).toEqual(["Task:\nWatched", "Answer to Task:\nWatched"]);

			const second = await connect({ start: false });
			try {
				const fresh = await second?.request({ type: "watch", handle });
				expect(fresh?.child.state).toBe("idle");
				expect(textsOf(fresh?.view)).toEqual(["Task:\nWatched", "Answer to Task:\nWatched"]);
			} finally {
				second?.close();
			}
		} finally {
			client.close();
		}
	});

	it("sends a watch line when the child is renamed", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Rename me"]));
		await cli(["wait", handle]);
		const client = await hostClient();
		const watched = await client.watch(handle);
		const lines: WatchLine[] = [];
		void collect(watched.lines, lines);
		try {
			expect(watched.child.state).toBe("idle");
			expect((await cli(["rename", handle, "renamed"])).code).toBe(0);
			await until(() => lines.some((line) => !line.stopped && line.child.name === "renamed"));
		} finally {
			client.close();
		}
	});

	it("keeps the name and the state of a renamed child on its watch lines", async () => {
		gates.set("Task:\nFail", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Fail"]));
		await until(() => called("Task:\nFail") === 1);
		const client = await hostClient();
		const watched = await client.watch(handle);
		const lines: WatchLine[] = [];
		void collect(watched.lines, lines);
		try {
			expect(watched.child.state).toBe("busy");
			expect((await cli(["rename", handle, "busy name"])).code).toBe(0);
			await until(() => lines.some((line) => !line.stopped && line.child.name === "busy name"));
			expect(lines.find((line) => !line.stopped && line.child.name === "busy name")).toMatchObject({
				child: { state: "busy" },
			});
			gates.get("Task:\nFail")?.resolve();
			await until(() =>
				lines.some((line) => !line.stopped && line.child.state === "error" && line.child.name === "busy name"),
			);
			expect((await client.request({ type: "status", handle })).state).toBe("error");
		} finally {
			client.close();
		}
	});

	it("keeps watching after a watch connection closes during setup", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Closed watch"]));
		await cli(["wait", handle]);
		const stderr = vi.spyOn(process.stderr, "write");
		try {
			const socket = createConnection(statePaths().socket);
			socket.write(`${JSON.stringify({ type: "watch", handle })}\n`, () => socket.destroy());
			await once(socket, "close");
			const client = await hostClient();
			const watched = await client.watch(handle);
			const lines: WatchLine[] = [];
			void collect(watched.lines, lines);
			try {
				expect((await cli(["rename", handle, "renamed after close"])).code).toBe(0);
				await until(() => lines.some((line) => !line.stopped && line.child.name === "renamed after close"));
			} finally {
				client.close();
			}
			expect(stderr.mock.calls.filter(([text]) => String(text).includes("warning:"))).toEqual([]);
		} finally {
			stderr.mockRestore();
		}
	});

	it("answers requests on a watch connection, between the watch events", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Idle"]));
		await cli(["wait", handle]);
		const client = await hostClient();
		try {
			const watched = await client.watch(handle);
			expect(watched.child.state).toBe("idle");
			const lines: WatchLine[] = [];
			void collect(watched.lines, lines);
			const sent = await client.request({
				type: "input",
				requestId: "watch-connection-send",
				handle,
				message: "On the watch connection",
				followUp: false,
			});
			expect(sent.verb).toBe("Prompted");
			const busy = () => lines.findIndex((line) => !line.stopped && line.child.state === "busy");
			await until(() => busy() !== -1);
			await until(() => lines.slice(busy() + 1).some((line) => !line.stopped && line.child.state === "idle"));
			expect((await client.request({ type: "status", handle })).state).toBe("idle");
		} finally {
			client.close();
		}
	});

	it("aborts a busy child, which keeps its history and answers later", async () => {
		gates.set("Task:\nAbort me", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Abort me"]));
		await until(() => called("Task:\nAbort me") === 1);
		const client = await connect({ start: false });
		if (client === undefined) throw new Error("no host");
		try {
			expect((await client.request({ type: "abort", handle })).state).toBe("idle");
			expect(await client.request({ type: "abort", handle })).toMatchObject({ handle, state: "idle" });
			expect((await cli(["status", handle])).stdout).toBe(`${handle}: idle (faux/faux-1, medium)\n`);
			expect((await cli(["wait", handle])).stderr).toBe(`${handle} was aborted\n`);
			expect((await cli(["send", handle, "After abort"])).stdout).toBe(`Prompted ${handle}\n`);
			expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to After abort\n`);
			const watched = await client.request({ type: "watch", handle });
			expect(textsOf(watched.view)).toContain("Task:\nAbort me");
			expect(textsOf(watched.view)).toContain("Answer to After abort");
		} finally {
			client.close();
		}
	});

	it("refuses to attach to an unknown child before the terminal starts", async () => {
		const terminal = new FakeTerminal();
		await expect(attach("abcdef", { terminal, env: {} })).rejects.toThrow("Unknown subagent: abcdef");
		expect(terminal.started).toBe(false);
	});

	it("shows a child in the viewer and sends what the user types", async () => {
		const herdr = await fakeHerdr();
		const handle = handleOf(await cli(["spawn", "--name", "viewed", "--prompt", "View me"]));
		await cli(["wait", handle]);
		const requests = vi.spyOn(Client.prototype, "request");
		const sent = () =>
			requests.mock.calls.flatMap(([sentRequest]) =>
				sentRequest.type === "input" || sentRequest.type === "abort" ? [sentRequest as Request] : [],
			);
		const terminal = new FakeTerminal();
		const env = { ...herdr.env, HERDR_ENV: "1", HERDR_PANE_ID: "pane-7" };
		try {
			const exited = attach(handle, { terminal, env });
			await until(() => terminal.text().includes("Answer to Task:"));
			expect(terminal.text()).toContain("View me");
			expect(terminal.text()).toContain(`viewed (${handle})  faux/faux-1  medium  idle`);

			// Enter on an idle child starts a turn.
			terminal.input("Hello there");
			terminal.input("\r");
			await until(() => terminal.text().includes("Answer to Hello there"));

			// Enter on a busy child steers it, and Alt+Enter queues a follow-up.
			gates.set("Busy turn", Promise.withResolvers());
			terminal.input("Busy turn");
			terminal.input("\r");
			await until(() => called("Busy turn") === 1);
			await until(() => terminal.text().includes("medium  busy"));
			terminal.input("Steer it");
			terminal.input("\r");
			terminal.input("Then this");
			terminal.input("\u001b\r");
			await until(() => sent().length === 4);
			gates.get("Busy turn")?.resolve();
			await until(() => terminal.text().includes("Answer to Then this"));
			expect(sent().map((r) => (r.type === "input" ? [r.message, r.followUp] : r.type))).toEqual([
				["Hello there", false],
				["Busy turn", false],
				["Steer it", false],
				["Then this", true],
			]);
			expect(called("Steer it")).toBe(1);

			// Esc on an idle child sends nothing.
			await until(() => terminal.text().lastIndexOf("medium  idle") > terminal.text().lastIndexOf("medium  busy"));
			terminal.input("\u001b");
			expect(sent()).toHaveLength(4);

			// Esc aborts the turn and leaves the child idle.
			gates.set("Long turn", Promise.withResolvers());
			terminal.input("Long turn");
			terminal.input("\r");
			await until(() => called("Long turn") === 1);
			terminal.input("\u001b");
			await until(() => sent().at(-1)?.type === "abort");
			expect(sent().filter((r) => r.type === "abort")).toHaveLength(1);
			await until(() => terminal.text().lastIndexOf("medium  idle") > terminal.text().lastIndexOf("medium  busy"));
			expect((await cli(["status", handle])).stdout).toBe(`viewed (${handle}): idle (faux/faux-1, medium)\n`);

			// Ctrl+C exits and leaves the child running.
			terminal.input("\u0003");
			expect(await exited).toBe(0);
			expect((await cli(["status", handle])).code).toBe(0);
		} finally {
			requests.mockRestore();
		}

		const reports = logLines(herdr.log);
		const resume = `-- env ${process.execPath} ${CLI} attach ${handle}`;
		expect(reports[0]).toBe(
			`pane report-agent --source custom:pi-subagent --agent viewed --state idle --seq ${seqOf(reports[0])} pane-7 ${resume}`,
		);
		expect(reports).toContain(
			`pane report-agent --source custom:pi-subagent --agent viewed --state working --seq ${seqOf(reports[1])} pane-7 ${resume}`,
		);
		expect(reports.at(-1)).toBe(
			`pane release-agent --source custom:pi-subagent --agent viewed --seq ${seqOf(reports.at(-1))} pane-7`,
		);
		const seqs = reports.map(seqOf);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);

		// Without HERDR_ENV, the viewer does not call herdr. A stopped child ends the viewer.
		const again = new FakeTerminal();
		const exited = attach(handle, { terminal: again, env: herdr.env });
		await until(() => again.text().includes("Answer to Hello there"));
		expect((await cli(["stop", handle])).code).toBe(0);
		expect(await exited).toBe(0);
		expect(again.text()).toContain(`viewed (${handle}) was stopped\n`);
		expect(logLines(herdr.log)).toEqual(reports);
	});

	it("opens a child from /subagent in a Herdr tab, or shows the command", async () => {
		const herdr = await fakeHerdr();
		const { tool, command } = piExtension();
		const spawned = await callPi(tool, piContext("faux-1"), { action: "spawn", name: "tabbed", prompts: ["Tab me"] });
		const handle = (spawned.data as { value: { handle: string } }).value.handle;
		const notes: string[] = [];
		const ctx = {
			sessionManager: { getSessionId: () => "pi-session" },
			ui: {
				select: async (_title: string, options: string[]) => options.find((option) => option.includes(handle)),
				notify: (message: string) => notes.push(message),
			},
		} as unknown as ExtensionCommandContext;
		const saved = process.env;
		try {
			process.env = { ...herdr.env, HERDR_ENV: "1" };
			const state = process.env.XDG_STATE_HOME;
			expect(state).toBeTruthy();
			const run = `pane run p1 'env' '${process.execPath}' '${CLI}' 'attach' '${handle}'`;
			await command.handler("", ctx);
			expect(logLines(herdr.log)).toEqual([
				`tab create --cwd ${root} --label tabbed --focus --env XDG_STATE_HOME=${state}`,
				run,
			]);
			expect(notes).toEqual([]);
			// Without XDG_STATE_HOME, the host directory is under HOME: link it to the same host.
			await mkdir(join(root, "home", ".local"), { recursive: true });
			await symlink(state as string, join(root, "home", ".local", "state"));
			delete process.env.XDG_STATE_HOME;
			await command.handler("", ctx);
			expect(logLines(herdr.log).slice(2)).toEqual([`tab create --cwd ${root} --label tabbed --focus`, run]);
			process.env = { ...herdr.env };
			delete process.env.HERDR_ENV;
			await command.handler("", ctx);
			expect(logLines(herdr.log)).toHaveLength(4);
			expect(notes).toEqual([`Run in another terminal: subagent attach ${handle}`]);
		} finally {
			process.env = saved;
		}
	});

	it("shows the herdr error and the command when /subagent cannot open a Herdr tab", async () => {
		const herdr = await fakeHerdr("no such session");
		const { tool, command } = piExtension();
		const spawned = await callPi(tool, piContext("faux-1"), { action: "spawn", name: "untabbed", prompts: ["No tab"] });
		const handle = (spawned.data as { value: { handle: string } }).value.handle;
		const notes: string[] = [];
		const ctx = {
			sessionManager: { getSessionId: () => "pi-session" },
			ui: {
				select: async (_title: string, options: string[]) => options.find((option) => option.includes(handle)),
				notify: (message: string) => notes.push(message),
			},
		} as unknown as ExtensionCommandContext;
		const saved = process.env;
		try {
			process.env = { ...herdr.env, HERDR_ENV: "1" };
			await command.handler("", ctx);
		} finally {
			process.env = saved;
		}
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("no such session");
		expect(notes[0]).toContain(`Run in another terminal: subagent attach ${handle}`);
		expect(logLines(herdr.log)).toHaveLength(1);
		expect(logLines(herdr.log)[0]).toMatch(/^tab create /);
	});

	it("opens the selected child from /subagent when its name starts with the handle of another child", async () => {
		const herdr = await fakeHerdr();
		const { tool, command } = piExtension();
		const first = await callPi(tool, piContext("faux-1"), { action: "spawn", prompts: ["Unnamed"] });
		const handleA = (first.data as { value: { handle: string } }).value.handle;
		const name = `${handleA}  copy`;
		const second = await callPi(tool, piContext("faux-1"), { action: "spawn", name, prompts: ["Named"] });
		const handleB = (second.data as { value: { handle: string } }).value.handle;
		const notes: string[] = [];
		const ctx = {
			sessionManager: { getSessionId: () => "pi-session" },
			ui: {
				select: async (_title: string, options: string[]) => options.find((option) => option.includes(`(${handleB})`)),
				notify: (message: string) => notes.push(message),
			},
		} as unknown as ExtensionCommandContext;
		const saved = process.env;
		try {
			process.env = { ...herdr.env, HERDR_ENV: "1" };
			await command.handler("", ctx);
		} finally {
			process.env = saved;
		}
		expect(notes).toEqual([]);
		const lines = logLines(herdr.log);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(`--label ${name} --focus`);
		expect(lines[1]).toMatch(new RegExp(`'attach' '${handleB}'$`));
	});
});
