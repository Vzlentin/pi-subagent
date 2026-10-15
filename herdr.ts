import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ChildInfo } from "./client.ts";

const HERDR_SOURCE = "custom:pi-subagent";

/**
 * Runs `herdr` with `args` and gives its output. It is undefined when `herdr` fails: a failing call never stops the
 * caller.
 */
export function herdr(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("herdr", args, { env }, (error, stdout) => resolve(error === null ? stdout : undefined));
	});
}

/** Opens a Herdr tab that runs the viewer of `child`. It resolves with false when a `herdr` call fails. */
export async function openViewerTab(child: ChildInfo, env: NodeJS.ProcessEnv): Promise<boolean> {
	// The tab must find the same host as `statePaths()` in client.ts.
	const state = env.XDG_STATE_HOME;
	const created = await herdr(
		[
			"tab",
			"create",
			"--cwd",
			child.cwd,
			"--label",
			child.name ?? child.handle,
			"--focus",
			...(state ? ["--env", `XDG_STATE_HOME=${state}`] : []),
		],
		env,
	);
	let pane: unknown;
	try {
		pane = (JSON.parse(created ?? "") as { result?: { root_pane?: { pane_id?: unknown } } }).result?.root_pane?.pane_id;
	} catch {
		return false;
	}
	if (typeof pane !== "string") return false;
	// The tab's shell may not have the CLI on PATH, so run this package's subagent.ts with this Node.
	const viewer = `${[process.execPath, fileURLToPath(new URL("./subagent.ts", import.meta.url))]
		.map((path) => `'${path.replaceAll("'", "'\\''")}'`)
		.join(" ")} attach ${child.handle}`;
	return (await herdr(["pane", "run", pane, viewer], env)) !== undefined;
}

/**
 * Reports the state of the agent `label` to the Herdr pane of this process. Both methods do nothing outside Herdr.
 * The calls run one after another, so `--seq` reaches Herdr in order.
 */
export function agentReporter(
	env: NodeJS.ProcessEnv,
	label: string,
	handle: string,
): { report(busy: boolean): void; release(): Promise<void> } {
	const pane = env.HERDR_ENV ? env.HERDR_PANE_ID : undefined;
	let calls: Promise<unknown> = Promise.resolve();
	let seq = 0;
	let reported: string | undefined;
	const call = (command: string, options: readonly string[], resume: readonly string[]) => {
		if (pane === undefined) return;
		seq = Math.max(Date.now(), seq + 1);
		const args = ["pane", command, "--source", HERDR_SOURCE, "--agent", label, ...options, "--seq", String(seq), pane];
		calls = calls.then(() => herdr([...args, ...resume], env));
	};
	return {
		report(busy) {
			const state = busy ? "working" : "idle";
			if (state === reported) return;
			reported = state;
			call("report-agent", ["--state", state], ["--", "subagent", "attach", handle]);
		},
		async release() {
			call("release-agent", [], []);
			await calls;
		},
	};
}
