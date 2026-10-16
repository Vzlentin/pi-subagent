import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Op } from "@earendil-works/chord/delta";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";

/** The version of the protocol between the CLI and the host. A client refuses a host with another version. */
export const PROTOCOL_VERSION = 2;

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
	/** The child's working directory. */
	readonly cwd: string;
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
			/** Whether the caller trusts the project in `cwd`; without it, the host takes the decision saved with `/trust`. */
			readonly trusted?: boolean;
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
	| { readonly type: "stop"; readonly caller: string; readonly handle: string }
	/**
	 * The viewer's stream of the child: the reply, then one `WatchLine` after each commit to the child's conversation
	 * and after each rename. `watch()` sends it on a connection of its own. Do not send requests on a watch connection;
	 * the host closes the connection.
	 */
	| { readonly type: "watch"; readonly handle: string }
	/** Stops the child's current turn. The viewer sends it. */
	| { readonly type: "abort"; readonly handle: string };

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
	readonly watch: { readonly view: ConversationView; readonly child: ChildInfo; readonly caller: string };
	readonly abort: ChildInfo;
};

/** A line of a watch after its reply: the changes of one commit or a rename, or the end when the child was stopped. */
export type WatchLine =
	| { readonly ops: readonly Op[]; readonly child: ChildInfo; readonly stopped?: undefined }
	| { readonly stopped: true };

/** The live state of a conversation view: the running turn, the streamed message and the tool slots. */
export function liveState(view: ConversationView): LiveState | undefined {
	return view.docs["pi.live"];
}

/** One reply line. */
export type Reply = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** The files of the host: `$XDG_STATE_HOME/pi-subagent/`, default `~/.local/state/pi-subagent/`. */
export function statePaths(): { dir: string; socket: string; log: string } {
	const dir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-subagent");
	return { dir, socket: join(dir, "host.sock"), log: join(dir, "host.log") };
}

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
	readonly #pending: { resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = [];
	#ended = false;
	/** Gets the lines that no request waits for. Only `watch` sets it; otherwise such a line is dropped. */
	#stream: { line: (line: string) => void; end: () => void } | undefined;
	/** The process ID of the host, from its `hello` reply. */
	pid = 0;

	constructor(socket: Socket) {
		this.#socket = socket;
		onLines(socket, (line) => {
			const waiter = this.#pending.shift();
			if (waiter === undefined) {
				this.#stream?.line(line);
				return;
			}
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

	/**
	 * Sends the `watch` request of `handle`. After it, the connection carries only the watch: do not send other
	 * requests, the host closes the connection. The lines that come before `listen` wait for it.
	 */
	async watch(handle: string): Promise<Watch> {
		const buffer: WatchLine[] = [];
		let onLine: (line: WatchLine) => void = (line) => buffer.push(line);
		let onEnd: (() => void) | undefined;
		this.#stream = { line: (line) => onLine(JSON.parse(line) as WatchLine), end: () => onEnd?.() };
		const reply = await this.request({ type: "watch", handle });
		return {
			...reply,
			listen: (lineListener, endListener) => {
				for (const line of buffer.splice(0)) lineListener(line);
				onLine = lineListener;
				if (this.#ended) endListener();
				else onEnd = endListener;
			},
			close: () => this.close(),
		};
	}

	close(): void {
		this.#socket.end();
	}

	/** Rejects the pending requests with `reason` and closes the connection. The host then stops them. */
	abort(reason: unknown): void {
		this.#end(reason);
		this.#socket.destroy();
	}

	#end(reason: unknown = new Error("The subagent host closed the connection")): void {
		if (!this.#ended) this.#stream?.end();
		this.#ended = true;
		for (const waiter of this.#pending.splice(0)) waiter.reject(reason);
	}
}

/** A watch of a child on a connection of its own: the reply of the `watch` request, and the lines after it. */
export type Watch = Replies["watch"] & {
	/**
	 * Calls `onLine` with each line after the reply, the lines that came before this call first, and `onEnd` once when
	 * the connection closes. Call it once.
	 */
	listen(onLine: (line: WatchLine) => void, onEnd: () => void): void;
	close(): void;
};

/**
 * A connection to the host after its `hello`. When no host listens and `start` is true, it starts one, detached, with its
 * output in `host.log`, and tries to connect for 10 s, or until `signal` aborts. When no host listens and `start` is
 * false, it is undefined.
 */
export async function connect(options: ConnectOptions): Promise<Client | undefined> {
	const paths = statePaths();
	let socket = await tryConnect(paths.socket);
	if (socket === undefined) {
		if (!options.start) return undefined;
		startHost(paths.dir, paths.log);
		const deadline = Date.now() + START_TIMEOUT_MS;
		while (socket === undefined) {
			options.signal?.throwIfAborted();
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

/** Watches the child `handle` on a new connection. It starts the host as `connect` does. */
export async function watch(handle: string): Promise<Watch> {
	const client = await connect({ start: true });
	if (client === undefined) throw new Error("Could not connect to the subagent host");
	try {
		return await client.watch(handle);
	} catch (error) {
		client.close();
		throw error;
	}
}

type ConnectOptions = { readonly start: boolean; readonly signal?: AbortSignal | undefined };

type OneShot<T extends Request["type"]> = Extract<Request, { type: T }>;

/**
 * Connects as `connect` does, sends `request`, and closes the connection. It is undefined when no host listens and
 * `start` is false. When `signal` aborts, it rejects with the abort reason, and the host stops the request.
 */
export function request<T extends Request["type"]>(
	request: OneShot<T>,
	options: ConnectOptions & { readonly start: true },
): Promise<Replies[T]>;
export function request<T extends Request["type"]>(
	request: OneShot<T>,
	options: ConnectOptions,
): Promise<Replies[T] | undefined>;
export async function request<T extends Request["type"]>(
	request: OneShot<T>,
	options: ConnectOptions,
): Promise<Replies[T] | undefined> {
	const { signal } = options;
	const client = await connect(options);
	if (client === undefined) return undefined;
	const abort = () => client.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	try {
		signal?.throwIfAborted();
		return await client.request(request);
	} finally {
		signal?.removeEventListener("abort", abort);
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
