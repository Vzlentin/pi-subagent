import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The version of the protocol between the CLI and the host. A client refuses a host with another version. */
export const PROTOCOL_VERSION = 1;

const START_TIMEOUT_MS = 10_000;

export type ChildState = "busy" | "idle" | "error";

/** One child as the host reports it. Provider, model and thinking level come from the child's agent. */
export type ChildInfo = {
	readonly handle: string;
	readonly name?: string;
	readonly state: ChildState;
	readonly provider: string;
	readonly model: string;
	readonly thinking: string;
};

/** One request line. The caller is `PI_SESSION_ID`, or `cli` without one. */
export type Request =
	| { readonly type: "hello"; readonly version: number }
	| {
			readonly type: "spawn";
			readonly requestId: string;
			readonly caller: string;
			readonly name?: string;
			readonly provider: string;
			readonly model: string;
			readonly thinking: string;
			readonly cwd: string;
			readonly tools?: readonly string[];
			readonly prompt: string;
	  }
	| {
			readonly type: "send";
			readonly requestId: string;
			readonly caller: string;
			readonly handle: string;
			readonly message: string;
			readonly followUp: boolean;
	  }
	| { readonly type: "wait"; readonly handle: string; readonly timeout: number }
	| { readonly type: "status"; readonly handle: string }
	| { readonly type: "list"; readonly caller: string }
	| { readonly type: "rename"; readonly caller: string; readonly handle: string; readonly name: string }
	| { readonly type: "stop"; readonly caller: string; readonly handle: string };

/** The value of the reply to each request type. */
export type Replies = {
	readonly hello: { readonly version: number; readonly pid: number };
	readonly spawn: ChildInfo;
	readonly send: { readonly verb: string; readonly child: ChildInfo };
	readonly wait: { readonly answer: string };
	readonly status: ChildInfo;
	readonly list: readonly ChildInfo[];
	readonly rename: ChildInfo;
	readonly stop: { readonly handle: string; readonly name?: string };
};

/** One reply line. */
export type Reply = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** The files of the host: `$XDG_STATE_HOME/pi-subagent/`, default `~/.local/state/pi-subagent/`. */
export function statePaths(): { dir: string; socket: string; log: string } {
	const dir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-subagent");
	return { dir, socket: join(dir, "host.sock"), log: join(dir, "host.log") };
}

/** The thinking levels a child can have. */
export const THINKING_LEVELS: ReadonlySet<string> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		// biome-ignore lint/suspicious/noControlCharactersInRegex: a name must not contain control characters.
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: { readonly handle: string; readonly name?: string | undefined }): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

/** The line of one child in a list. */
export function childLine(child: ChildInfo): string {
	return `${runDisplayName(child)}  ${child.state.padEnd(8)}  ${child.provider}/${child.model}  ${child.thinking}`;
}

/** `value` without surrounding spaces. It must be a valid run name. */
export function normalizeRunName(value: string): string {
	const name = value.trim();
	if (!isValidRunName(name)) throw new Error("Subagent name must be a single line of 1 to 64 characters");
	return name;
}

export function checkHandle(handle: string): string {
	if (!/^[a-z0-9]+$/.test(handle)) throw new Error(`Invalid subagent handle: ${handle}`);
	return handle;
}

/** The text of `file` as Pi gives a file argument to the model. An empty file gives nothing. */
export function fileText(file: string): string {
	if (statSync(file).size === 0) return "";
	return `<file name="${file}">\n${readFileSync(file, "utf8").replace(/^\uFEFF/, "")}\n</file>\n`;
}

/** The first message of a child: the text of each file, then `Task:` and the prompts. */
export function spawnPrompt(files: readonly string[], prompts: readonly string[]): string {
	let prompt = files.map(fileText).join("");
	if (prompts.length > 0) prompt += `Task:\n${prompts.join("\n\n")}`;
	return prompt;
}

/** The output of each command, the same for the CLI and the tool. */
export const outputText = {
	spawn: (child: ChildInfo) => `Spawned ${runDisplayName(child)}\nState: busy\n`,
	status: (child: ChildInfo) =>
		`${runDisplayName(child)}: ${child.state} (${child.provider}/${child.model}, ${child.thinking})\n`,
	rename: (child: ChildInfo) => `Renamed ${runDisplayName(child)}\n`,
	send: ({ verb, child }: Replies["send"]) => `${verb} ${runDisplayName(child)}\n`,
	wait: (handle: string, { answer }: Replies["wait"]) => `${handle} finished\n\n${answer}\n`,
	stop: (child: Replies["stop"]) => `Stopped ${runDisplayName(child)}\n`,
	list: (children: Replies["list"]) =>
		children.length === 0 ? "No subagents\n" : children.map((child) => `${childLine(child)}\n`).join(""),
};

/** Calls `onLine` with each line that arrives on `socket`, without its newline. */
export function onLines(socket: Socket, onLine: (line: string) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			onLine(line);
		}
	});
}

/** A connection to the host. Requests are answered in order, one reply line for each request line. */
export class Client {
	readonly #socket: Socket;
	readonly #pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
	#ended = false;
	/** The process ID of the host, from its `hello` reply. */
	pid = 0;

	constructor(socket: Socket) {
		this.#socket = socket;
		onLines(socket, (line) => {
			const waiter = this.#pending.shift();
			if (waiter === undefined) return;
			const reply = JSON.parse(line) as Reply;
			if (reply.ok) waiter.resolve(reply.value);
			else waiter.reject(new Error(reply.error));
		});
		socket.on("error", () => this.#end());
		socket.on("close", () => this.#end());
	}

	request<T extends Request["type"]>(request: Extract<Request, { type: T }>): Promise<Replies[T]> {
		if (this.#ended) return Promise.reject(new Error("The subagent host closed the connection"));
		return new Promise((resolve, reject) => {
			this.#pending.push({ resolve: resolve as (value: unknown) => void, reject });
			this.#socket.write(`${JSON.stringify(request)}\n`);
		});
	}

	close(): void {
		this.#socket.end();
	}

	#end(): void {
		this.#ended = true;
		for (const waiter of this.#pending.splice(0)) {
			waiter.reject(new Error("The subagent host closed the connection"));
		}
	}
}

/**
 * A connection to the host after its `hello`. When no host listens and `start` is true, it starts one, detached, with its
 * output in `host.log`, and tries to connect for 10 s. When no host listens and `start` is false, it is undefined.
 */
export async function connect(options: { readonly start: boolean }): Promise<Client | undefined> {
	const paths = statePaths();
	let socket = await tryConnect(paths.socket);
	if (socket === undefined) {
		if (!options.start) return undefined;
		startHost(paths.dir, paths.log);
		const deadline = Date.now() + START_TIMEOUT_MS;
		while (socket === undefined) {
			if (Date.now() > deadline) throw new Error(`Could not start the subagent host; see ${paths.log}`);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
			socket = await tryConnect(paths.socket);
		}
	}
	const client = new Client(socket);
	try {
		const hello = await client.request({ type: "hello", version: PROTOCOL_VERSION });
		if (hello.version !== PROTOCOL_VERSION) {
			throw new Error(
				`The subagent host (pid ${hello.pid}) uses protocol ${hello.version}, not ${PROTOCOL_VERSION}; stop it and try again`,
			);
		}
		client.pid = hello.pid;
		return client;
	} catch (error) {
		client.close();
		throw error;
	}
}

type OneShot<T extends Request["type"]> = Extract<Request, { type: T }>;

/**
 * Connects as `connect` does, sends `request`, and closes the connection. It is undefined when no host listens and
 * `start` is false.
 */
export function request<T extends Request["type"]>(
	request: OneShot<T>,
	options: { readonly start: true; readonly signal?: AbortSignal | undefined },
): Promise<Replies[T]>;
export function request<T extends Request["type"]>(
	request: OneShot<T>,
	options: { readonly start: boolean; readonly signal?: AbortSignal | undefined },
): Promise<Replies[T] | undefined>;
export async function request<T extends Request["type"]>(
	request: OneShot<T>,
	options: { readonly start: boolean; readonly signal?: AbortSignal | undefined },
): Promise<Replies[T] | undefined> {
	const { signal } = options;
	const client = await connect(options);
	if (client === undefined) return undefined;
	// An abort closes the connection, and the host then stops the request.
	const onAbort = () => client.close();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		signal?.throwIfAborted();
		const reply = client.request(request);
		if (signal === undefined) return await reply;
		const aborted = new Promise<never>((_, reject) =>
			signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
		);
		reply.catch(() => {});
		return await Promise.race([reply, aborted]);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		client.close();
	}
}

/** The connected socket, or undefined when nothing listens at `path`. */
function tryConnect(path: string): Promise<Socket | undefined> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		socket.once("connect", () => {
			socket.removeAllListeners("error");
			resolve(socket);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(undefined);
			else reject(error);
		});
	});
}

function startHost(dir: string, log: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const output = openSync(log, "a", 0o600);
	try {
		const cli = join(dirname(fileURLToPath(import.meta.url)), "subagent.ts");
		spawn(process.execPath, [cli, "host"], { cwd: dir, detached: true, stdio: ["ignore", output, output] }).unref();
	} finally {
		closeSync(output);
	}
}
