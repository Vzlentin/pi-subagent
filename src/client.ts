import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	onLines,
	PROTOCOL_VERSION,
	type Replies,
	type Reply,
	type Request,
	statePaths,
	type WatchLine,
} from "./protocol.ts";

const START_TIMEOUT_MS = 10_000;

/**
 * A connection to the host. Requests are answered in order, one reply line for each request line. After `watch`, the
 * event lines of the watch come between the replies.
 */
export class Client {
	readonly #socket: Socket;
	readonly #pending: { resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = [];
	#ended = false;
	/** The events of the watch. Only `watch` sets it; otherwise an event is dropped. */
	#lines: Readable | undefined;
	/** The process ID of the host, from its `hello` reply. */
	pid = 0;

	constructor(socket: Socket) {
		this.#socket = socket;
		onLines(socket, (line) => {
			const parsed = JSON.parse(line) as Reply | { event: WatchLine };
			if ("event" in parsed) {
				this.#lines?.push(parsed.event);
				return;
			}
			const waiter = this.#pending.shift();
			if (waiter === undefined) return;
			if (parsed.ok) waiter.resolve(parsed.value);
			else waiter.reject(new Error(parsed.error));
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
	 * Sends the `watch` request of `handle`. Its `lines` are the events of the watch, and end when the connection closes.
	 * Other requests can follow on this client. Call it once.
	 */
	async watch(handle: string): Promise<Replies["watch"] & { lines: AsyncIterable<WatchLine> }> {
		const lines = new Readable({ objectMode: true, read() {} });
		this.#lines = lines;
		const reply = await this.request({ type: "watch", handle });
		return { ...reply, lines };
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
		if (!this.#ended) this.#lines?.push(null);
		this.#ended = true;
		for (const waiter of this.#pending.splice(0)) waiter.reject(reason);
	}
}

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
		const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
		spawn(process.execPath, [cli, "host"], { cwd: dir, detached: true, stdio: ["ignore", output, output] }).unref();
	} finally {
		closeSync(output);
	}
}
