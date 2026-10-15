import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { apply } from "@earendil-works/chord/delta";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Terminal } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, connect, type Request, type WatchLine, watch } from "../client.ts";
import type { Host } from "../host.ts";
import subagentExtension from "../index.ts";
import { attach } from "../viewer.ts";
import {
	CLI,
	called,
	callPi,
	cli,
	gates,
	handleOf,
	piContext,
	piTool,
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

/** The `--seq` of a logged `herdr` call. */
function seqOf(line: string | undefined): number {
	return Number(/--seq (\d+)/.exec(line ?? "")?.[1]);
}

/** The `/subagent` command that the Pi extension registers. */
function piCommand(): Omit<RegisteredCommand, "name" | "sourceInfo"> {
	const commands: Omit<RegisteredCommand, "name" | "sourceInfo">[] = [];
	const pi = {
		on: () => {},
		registerCommand: (_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => commands.push(command),
		registerTool: () => {},
		getThinkingLevel: () => "medium",
	};
	subagentExtension(pi as unknown as ExtensionAPI);
	const [command] = commands;
	if (command === undefined) throw new Error("no command");
	return command;
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

/** A `herdr` on `PATH` that logs its arguments to `log`, one line for each call, and gives the pane `p1` to a new tab. */
async function fakeHerdr(): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
	const bin = await mkdtemp(join(root, "bin-"));
	const log = join(bin, "herdr.log");
	const script = `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1 $2" = "tab create" ]; then echo '{"result":{"root_pane":{"pane_id":"p1"}}}'; fi
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
		const first = await watch(handle);
		const lines: WatchLine[] = [];
		first.listen(
			(line) => lines.push(line),
			() => {},
		);
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
			first.close();
		}
	});

	it("sends a watch line when the child is renamed", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Rename me"]));
		await cli(["wait", handle]);
		const watched = await watch(handle);
		const lines: WatchLine[] = [];
		watched.listen(
			(line) => lines.push(line),
			() => {},
		);
		try {
			expect(watched.child.state).toBe("idle");
			expect((await cli(["rename", handle, "renamed"])).code).toBe(0);
			await until(() => lines.some((line) => !line.stopped && line.child.name === "renamed"));
		} finally {
			watched.close();
		}
	});

	it("closes a watch connection that gets another request", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Idle"]));
		await cli(["wait", handle]);
		const watcher = await connect({ start: false });
		if (watcher === undefined) throw new Error("no host");
		try {
			// The child is idle, so no watch line comes before the close.
			expect((await watcher.request({ type: "watch", handle })).child.state).toBe("idle");
			await expect(watcher.request({ type: "status", handle })).rejects.toThrow(
				"The subagent host closed the connection",
			);
		} finally {
			watcher.close();
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
				sentRequest.type === "send" || sentRequest.type === "abort" ? [sentRequest as Request] : [],
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
			expect(sent().map((r) => (r.type === "send" ? [r.message, r.followUp, r.caller] : r.type))).toEqual([
				["Hello there", false, "cli"],
				["Busy turn", false, "cli"],
				["Steer it", false, "cli"],
				["Then this", true, "cli"],
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
		const resume = `-- subagent attach ${handle}`;
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
		const tool = piTool("medium");
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
		const command = piCommand();
		const saved = process.env;
		try {
			process.env = { ...herdr.env, HERDR_ENV: "1" };
			const state = process.env.XDG_STATE_HOME;
			expect(state).toBeTruthy();
			const run = `pane run p1 '${process.execPath}' '${CLI}' attach ${handle}`;
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
});
