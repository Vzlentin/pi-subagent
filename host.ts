import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, join, resolve as resolvePath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import * as ai from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	createEventBus,
	DefaultPackageManager,
	getAgentDir,
	ProjectTrustStore,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as durable from "@earendil-works/pi-durable";
import {
	AgentDoc,
	AssistantEntry,
	type Conversation,
	type ConversationId,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	type Extension,
	Harness,
	type HarnessSettings,
	LiveDoc,
	type LiveState,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
	type ChildInfo,
	type ChildState,
	onLines,
	PROTOCOL_VERSION,
	type Replies,
	type Reply,
	type Request,
	type WatchLine,
} from "./client.ts";
import { subagentTool } from "./durable.ts";

/** The root of this package, whose `piDurable` entry the host does not load. */
const PACKAGE_DIR = realpathSync(dirname(fileURLToPath(import.meta.url)));

/** The host exits after this long with no connection, no live task and no request. */
const IDLE_EXIT_MS = 5 * 60_000;
const IDLE_CHECK_MS = 60_000;
/** The deepest child: a child of a child of a caller that is not a child. */
const MAX_DEPTH = 2;

const context = BACKGROUND_CONTEXT;

type ChildRecord = {
	name?: string;
	/** `PI_SESSION_ID` of the spawner: a Pi session, the conversation ID of another child, or `cli`. */
	caller: string;
	createdAt: string;
	conversationId: ConversationId;
	/**
	 * The request ID of the newest submission to the child, which `wait` reads the settlement of. It is stored
	 * before the submit, so a host that stops between the two still finds the submission.
	 */
	lastRequest: string;
};

/** The children by handle, and the handle of each spawn request ID. */
const Children = defineDoc<{ children: Record<string, ChildRecord>; requests: Record<string, string> }>({
	kind: "subagent.children",
	version: 1,
	scope: "session",
	initial: () => ({ children: {}, requests: {} }),
});

/**
 * Owns a child's conversation. It is a background task of the root conversation that finishes at once, so the child
 * outlives any one request and only an abort with `background: true` reaches it.
 */
const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "subagent.anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, taskContext) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext),
	},
	abort: (_anchor, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

const SubagentTasks = defineExtension({ name: "subagent", tasks: [Anchor] });

export type Host = {
	/** Resolves once the host has closed, by `close()`, the idle exit, or a store failure. */
	readonly closed: Promise<void>;
	close(): Promise<void>;
};

/**
 * Runs the host in this process: the store in `stateDir`, the children's models from `models`, and the socket. It is
 * undefined when another host holds the lock.
 */
export async function runHost(options: {
	readonly stateDir: string;
	readonly models: Models;
}): Promise<Host | undefined> {
	const { stateDir, models } = options;
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const lock = takeLock(stateDir);
	if (lock === undefined) return undefined;
	const socketPath = join(stateDir, "host.sock");
	rmSync(socketPath, { force: true });

	const registry = createRegistry();
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(stateDir, agentDir, {
		projectTrusted: new ProjectTrustStore(agentDir).get(stateDir) === true,
	});
	const warn = (error: unknown) =>
		process.stderr.write(`warning: ${error instanceof Error ? error.message : String(error)}\n`);
	const entries = await loadEntries(stateDir, agentDir, settings, warn).catch((error: unknown) => {
		lock.close();
		throw error;
	});
	const envs = new Map<ConversationId, NodeExecutionEnv>();
	let harness: Harness;
	const watches: Watches = new Map();
	// A child calls the host in this process, not through the socket, so a long `wait` cannot hold up the requests
	// of a connection. Its caller is its conversation ID, which the depth limit and the owner checks key on.
	const tool = subagentTool(durable, ai, {
		caller: async (api) => String(api.conversationId),
		send: (request, signal) => handleRequest(request, { harness, models, registry, watches, signal }),
	});
	const selected = [CodingTools, tool, ...entries.extensions];
	try {
		for (const extension of selected) registry.install(extension);
		registry.install(SubagentTasks);
		harness = await Harness.open(
			await openNodeSqliteStorage(join(stateDir, "durable.sqlite")),
			{
				models,
				registry,
				settings: piSettings(settings, selected),
				env: async ({ conversationId, cwd, read }, envContext) => {
					if (cwd === undefined) return undefined;
					const cached = envs.get(conversationId);
					if (cached !== undefined) return cached;
					const agent = await read.snapshot(AgentDoc, conversationId, envContext);
					const shellEnv: NodeJS.ProcessEnv = { PI_SESSION_ID: String(conversationId) };
					if (agent?.model !== undefined) {
						shellEnv.PI_PROVIDER = agent.model.provider;
						shellEnv.PI_MODEL = agent.model.modelId;
					}
					if (agent?.thinkingLevel !== undefined) shellEnv.PI_REASONING_LEVEL = agent.thinkingLevel;
					const env = new NodeExecutionEnv({ cwd, shellEnv });
					envs.set(conversationId, env);
					return env;
				},
				onReport: warn,
			},
			context,
		);
	} catch (error) {
		await entries.close();
		lock.close();
		throw error;
	}
	harness.resume();

	const connections = new Set<Socket>();
	const aborts = new Set<AbortController>();
	let lastActivity = Date.now();
	const handle = (request: Request, signal: AbortSignal) =>
		handleRequest(request, { harness, models, registry, watches, signal });

	const server = createServer((socket) => {
		connections.add(socket);
		const abort = new AbortController();
		aborts.add(abort);
		let queue = Promise.resolve();
		// After a watch, the connection carries only the watch.
		let watching = false;
		onLines(socket, (line) => {
			queue = queue.then(async () => {
				if (watching) {
					socket.destroy();
					return;
				}
				let reply: Reply;
				let start: (() => void) | undefined;
				try {
					const request = JSON.parse(line) as Request;
					if (request.type !== "hello" && request.type !== "list" && request.type !== "status") {
						lastActivity = Date.now();
					}
					if (request.type === "watch") {
						const watch = await watchChild(harness, request.handle, socket, watches);
						watching = true;
						start = watch.start;
						reply = { ok: true, value: watch.value };
					} else {
						reply = { ok: true, value: await handle(request, abort.signal) };
					}
				} catch (error) {
					reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
				}
				if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
				start?.();
			});
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			connections.delete(socket);
			aborts.delete(abort);
			abort.abort();
		});
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(socketPath, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	}).catch(async (error: unknown) => {
		await entries.close();
		await harness.close(context);
		lock.close();
		throw error;
	});

	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			clearInterval(timer);
			server.close();
			for (const socket of connections) socket.destroy();
			for (const abort of aborts) abort.abort();
			try {
				// Entries close first: an entry may still need the open harness.
				await entries.close();
				await harness.close(context);
				for (const env of envs.values()) await env.cleanup(context);
			} finally {
				rmSync(socketPath, { force: true });
				lock.close();
			}
		})();
		return closing;
	};
	const timer = setInterval(() => {
		if (connections.size > 0 || Date.now() - lastActivity < IDLE_EXIT_MS) return;
		harness
			.inspect(context)
			.then(({ tasks }) => (tasks.length === 0 && connections.size === 0 ? close() : undefined))
			.catch(warn);
	}, IDLE_CHECK_MS);
	timer.unref();
	// A store failure closes the harness; the host then closes too.
	const closed = harness.closed.then(() => close());
	return { closed, close };
}

type Handler = {
	readonly harness: Harness;
	readonly models: Models;
	readonly registry: ReturnType<typeof createRegistry>;
	readonly watches: Watches;
	/** Aborted when the connection of the request closes. */
	readonly signal: AbortSignal;
};

function handleRequest<T extends Request["type"]>(
	request: Extract<Request, { type: T }>,
	handler: Handler,
): Promise<Replies[T]>;
async function handleRequest(request: Request, handler: Handler): Promise<Replies[Request["type"]]> {
	switch (request.type) {
		case "hello":
			return { version: PROTOCOL_VERSION, pid: process.pid };
		case "spawn":
			return spawnChild(request, handler);
		case "send":
			return sendChild(request, handler);
		case "wait":
			return waitChild(request, handler);
		case "status":
			return childInfo(handler.harness, request.handle);
		case "abort": {
			const conversation = await childConversation(handler.harness, await childRecord(handler.harness, request.handle));
			await conversation.abort(context);
			return childInfo(handler.harness, request.handle);
		}
		case "list": {
			const state = await handler.harness.snapshot(Children, context);
			const own = Object.entries(state?.children ?? {})
				.filter(([, record]) => record.caller === request.caller)
				.sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
			return Promise.all(own.map(([handle, record]) => childInfo(handler.harness, handle, record)));
		}
		case "rename": {
			await ownRecord(handler.harness, request.handle, request.caller);
			await handler.harness.commit(async (tx) => {
				const record = (await tx.doc(Children)).children[request.handle];
				if (record !== undefined) record.name = request.name;
			}, context);
			return childInfo(handler.harness, request.handle);
		}
		case "stop": {
			const record = await ownRecord(handler.harness, request.handle, request.caller);
			const conversation = await childConversation(handler.harness, record);
			await conversation.abort(context, { background: true });
			await handler.harness.commit(async (tx) => {
				const state = await tx.doc(Children);
				delete state.children[request.handle];
				for (const [requestId, handle] of Object.entries(state.requests)) {
					if (handle === request.handle) delete state.requests[requestId];
				}
			}, context);
			for (const stopped of handler.watches.get(request.handle) ?? []) stopped();
			return { handle: request.handle, ...(record.name === undefined ? {} : { name: record.name }) };
		}
		default:
			throw new Error(`Unknown request: ${(request as { type?: unknown }).type}`);
	}
}

async function spawnChild(request: Extract<Request, { type: "spawn" }>, handler: Handler): Promise<ChildInfo> {
	const { harness, models, registry } = handler;
	const state = await harness.snapshot(Children, context);
	let handle = state?.requests[request.requestId];
	if (handle === undefined) {
		if (models.getModel(request.provider, request.model) === undefined) {
			throw new Error(`Unknown model: ${request.provider}/${request.model}`);
		}
		let tools: ToolRegistration[] | undefined;
		if (request.tools !== undefined) {
			const installed = registry.snapshot().tools();
			tools = request.tools.map((name) => {
				const found = installed.findLast(({ tool }) => tool.name === name);
				if (found === undefined) throw new Error(`Unknown tool: ${name}`);
				return found.tool;
			});
		}
		if (depthOf(request.caller, state?.children ?? {}) > MAX_DEPTH) throw new Error("Nested subagents are disabled");
		const root = await harness.root(context);
		handle = await root.commit(async (tx) => {
			const current = await tx.doc(Children);
			const existing = current.requests[request.requestId];
			if (existing !== undefined) return existing;
			let fresh = randomBytes(3).toString("hex");
			while (Object.hasOwn(current.children, fresh)) fresh = randomBytes(3).toString("hex");
			const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			await configure(tx, child.id, {
				model: { provider: request.provider, modelId: request.model },
				thinkingLevel: request.thinking as ModelThinkingLevel,
				cwd: request.cwd,
				...(tools === undefined ? {} : { tools }),
			});
			current.children[fresh] = {
				...(request.name === undefined ? {} : { name: request.name }),
				caller: request.caller,
				createdAt: new Date().toISOString(),
				conversationId: child.id,
				lastRequest: `spawn:${request.requestId}`,
			};
			current.requests[request.requestId] = fresh;
			return fresh;
		}, context);
	}
	const record = await childRecord(harness, handle);
	const conversation = await childConversation(harness, record);
	// The request ID makes a repeated spawn find the first submission, also after a crash before it.
	await submitAs(harness, handle, record, conversation, {
		type: "input",
		content: request.prompt,
		requestId: `spawn:${request.requestId}`,
	});
	return childInfo(harness, handle, record);
}

async function sendChild(
	request: Extract<Request, { type: "send" }>,
	handler: Handler,
): Promise<{ verb: string; child: ChildInfo }> {
	const { harness } = handler;
	const record = request.viewer
		? await childRecord(harness, request.handle)
		: await ownRecord(harness, request.handle, request.caller);
	const conversation = await childConversation(harness, record);
	const busy = await isBusy(harness, record);
	await submitAs(harness, request.handle, record, conversation, {
		type: "input",
		content: request.message,
		whenBusy: request.followUp ? "followUp" : "steer",
		requestId: request.requestId,
	});
	const verb = !busy ? "Prompted" : request.followUp ? "Queued follow-up for" : "Steered";
	return { verb, child: await childInfo(harness, request.handle) };
}

async function waitChild(request: Extract<Request, { type: "wait" }>, handler: Handler): Promise<{ answer: string }> {
	const { harness } = handler;
	const conversation = await childConversation(harness, await childRecord(harness, request.handle));
	const timeout = AbortSignal.timeout(request.timeout * 1000);
	try {
		await conversation.waitForIdle(withAbortSignal(AbortSignal.any([timeout, handler.signal]), context));
	} catch (error) {
		if (timeout.aborted) throw new Error(`Timed out after ${request.timeout}s waiting for ${request.handle}`);
		throw error;
	}
	const settled = await lastSettlement(harness, await childRecord(harness, request.handle));
	if (settled?.status === "unanswered") throw new Error(failureText(request.handle, settled.reason, settled.detail));
	if (settled?.status !== "done" || settled.answer === undefined) {
		throw new Error(`${request.handle} stopped with queued messages after a failed turn`);
	}
	const answer = settled.answer;
	const entry = await harness.commit((tx) => tx.entry(AssistantEntry, answer), context);
	const message = entry?.model?.[0];
	const text =
		message?.role === "assistant" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [];
	return { answer: text.join("\n").trim() };
}

/** The depth of a child of `caller`: 1 for a caller that is not a child, and one more for each child above it. */
function depthOf(caller: string, children: Readonly<Record<string, ChildRecord>>): number {
	let depth = 1;
	let current: string | undefined = caller;
	while (depth <= MAX_DEPTH) {
		const parent = Object.values(children).find((record) => String(record.conversationId) === current);
		if (parent === undefined) return depth;
		depth++;
		current = parent.caller;
	}
	return depth;
}

async function childRecord(harness: Harness, handle: string): Promise<ChildRecord> {
	const state = await harness.snapshot(Children, context);
	const record = state !== undefined && Object.hasOwn(state.children, handle) ? state.children[handle] : undefined;
	if (record === undefined) throw new Error(`Unknown subagent: ${handle}`);
	return record;
}

/** The record of `handle`, which must belong to `caller`. */
async function ownRecord(harness: Harness, handle: string, caller: string): Promise<ChildRecord> {
	const record = await childRecord(harness, handle);
	if (record.caller !== caller) throw new Error(`Subagent ${handle} belongs to another session`);
	return record;
}

async function childConversation(harness: Harness, record: ChildRecord): Promise<Conversation> {
	const conversation = await harness.conversation(record.conversationId, context);
	if (conversation === undefined) throw new Error(`Missing conversation ${record.conversationId}`);
	return conversation;
}

/**
 * Submits `input` to the child `handle`. A request ID with no submission yet becomes `lastRequest` before the submit,
 * so a host that stops between the two still finds the submission. A repeated request keeps `lastRequest`, so it
 * does not move back to an older request.
 */
async function submitAs(
	harness: Harness,
	handle: string,
	record: ChildRecord,
	conversation: Conversation,
	input: Parameters<Conversation["submit"]>[0] & { requestId: string },
): Promise<void> {
	await harness.commit(async (tx) => {
		if ((await tx.submissionByRequest(record.conversationId, input.requestId)) !== undefined) return;
		const current = (await tx.doc(Children)).children[handle];
		if (current !== undefined) current.lastRequest = input.requestId;
	}, context);
	await conversation.submit(input, context);
}

async function isBusy(harness: Harness, record: ChildRecord): Promise<boolean> {
	const live = await harness.snapshot(LiveDoc, record.conversationId, context);
	return live?.run !== undefined;
}

async function lastSettlement(harness: Harness, record: ChildRecord) {
	return harness.commit((tx) => tx.submissionByRequest(record.conversationId, record.lastRequest), context);
}

function failureText(handle: string, reason: string, detail: unknown): string {
	if (reason === "aborted") return `${handle} was aborted`;
	const text =
		typeof detail === "string"
			? detail
			: typeof (detail as { message?: unknown } | undefined)?.message === "string"
				? (detail as { message: string }).message
				: undefined;
	return text === undefined ? `${handle} failed: ${reason}` : `${handle} failed: ${text}`;
}

/** The info of `handle`. A caller that already has the record gives it as `record`. */
async function childInfo(harness: Harness, handle: string, record?: ChildRecord): Promise<ChildInfo> {
	record ??= await childRecord(harness, handle);
	const conversation = await childConversation(harness, record);
	const agent = await conversation.agent(context);
	let state: ChildState = "idle";
	if (await isBusy(harness, record)) state = "busy";
	else {
		const settled = await lastSettlement(harness, record);
		// An aborted turn leaves the child idle.
		if (settled?.status === "unanswered" && settled.reason !== "aborted") state = "error";
	}
	return {
		handle,
		...(record.name === undefined ? {} : { name: record.name }),
		state,
		provider: agent.model?.provider ?? "",
		model: agent.model?.modelId ?? "",
		thinking: agent.thinkingLevel,
		cwd: agent.cwd ?? "",
	};
}

/** The open watches of each child, by handle. Each callback tells its viewer that the child was stopped. */
type Watches = Map<string, Set<() => void>>;

/**
 * Opens a watch of `handle` for the connection `socket`. The reply value is the view and the child. After the reply,
 * `start()` writes one `WatchLine` after each commit, and waits for a slow socket to drain, so pi-durable replaces
 * the frames it holds back with one frame of the whole view. The watch stops when the socket closes; a wait for
 * `drain` then stays on the closed socket and goes with it. When the child stops, the viewer gets a `stopped` line;
 * when the watch ends for another reason, the connection ends.
 */
async function watchChild(
	harness: Harness,
	handle: string,
	socket: Socket,
	watches: Watches,
): Promise<{ value: Replies["watch"]; start: () => void }> {
	const record = await childRecord(harness, handle);
	let last = await childInfo(harness, handle, record);
	const watch = await (await childConversation(harness, record)).watch(context);
	const value = { view: watch.value, child: last };
	const write = (line: WatchLine) => socket.write(`${JSON.stringify(line)}\n`);
	const stopped = () => {
		if (socket.writableEnded || socket.destroyed) return;
		write({ stopped: true });
		socket.end();
	};
	const start = () => {
		// A socket that closed before the reply never emits `close` again.
		if (socket.destroyed) {
			void watch.stop();
			return;
		}
		const open = watches.get(handle) ?? new Set();
		watches.set(handle, open.add(stopped));
		socket.once("close", () => {
			void watch.stop();
			open.delete(stopped);
			if (open.size === 0 && watches.get(handle) === open) watches.delete(handle);
		});
		// The child can stop before `stopped` is in `watches`.
		void childRecord(harness, handle).catch(stopped);
		void watch.closed.then(() => childRecord(harness, handle).then(() => socket.end(), stopped)).catch(() => {});
		watch.start(async (view, ops) => {
			// Each commit costs one `Children` read for each watcher. A rename push from the `rename` handler would
			// remove it. A stopped child has no record; its `stopped` line follows.
			const current = await childRecord(harness, handle).catch(() => undefined);
			if (current === undefined || socket.destroyed) return;
			const busy = (view.docs["pi.live"] as LiveState | undefined)?.run !== undefined;
			// Streaming commits change only `docs/pi.live`, and need no new info while the turn runs.
			const changed =
				current.name !== last.name ||
				busy !== (last.state === "busy") ||
				ops.some((op) => op[0] === "r" || op[1][0] !== "docs" || op[1][1] !== "pi.live");
			if (changed) {
				const info = await childInfo(harness, handle, current).catch(() => undefined);
				if (info === undefined || socket.destroyed) return;
				last = info;
			}
			if (!write({ ops, child: last })) await once(socket, "drain").catch(() => {});
		});
	};
	return { value, start };
}

/**
 * The lock of the host, an exclusive transaction on `lock.sqlite`, held until `close()`. The system drops it when the
 * process ends. It is undefined when another process holds it.
 */
function takeLock(directory: string): DatabaseSync | undefined {
	const database = new DatabaseSync(join(directory, "lock.sqlite"), { timeout: 0 });
	try {
		database.exec("BEGIN EXCLUSIVE");
		return database;
	} catch {
		database.close();
		return undefined;
	}
}

/** Pi's run settings from `settings`, read at every use, with `extensions` as the default selection. */
function piSettings(settings: SettingsManager, extensions: readonly Extension[]): HarnessSettings {
	return {
		extensions,
		get stream() {
			const provider = settings.getProviderRetrySettings();
			const idle = settings.getHttpIdleTimeoutMs();
			return {
				timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
				maxRetryDelayMs: provider.maxRetryDelayMs,
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
			};
		},
		get retry() {
			return settings.getRetrySettings();
		},
		get compaction() {
			return settings.getCompactionSettings();
		},
	};
}

/** What the default export of a `piDurable` entry returns. */
type Entry = { readonly extensions: readonly Extension[]; close(): Promise<void> };

/**
 * The `piDurable` entries of the installed packages in Pi's `settingsManager` for `cwd`, in one shared event bus, as one
 * entry whose `close()` closes each of them and passes its errors to `warn`. When an entry fails to load, the entries
 * loaded before it close. Missing packages are skipped, not installed. Node does not strip types under
 * `node_modules`, so entries of npm packages fail to load.
 */
async function loadEntries(
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	warn: (error: unknown) => void,
): Promise<Entry> {
	const roots = new Set(
		new DefaultPackageManager({ cwd, agentDir, settingsManager })
			.listConfiguredPackages()
			.flatMap((found) => found.installedPath ?? []),
	);
	const events = createEventBus();
	const entries: Entry[] = [];
	const close = async () => {
		for (const result of await Promise.allSettled(entries.map((entry) => entry.close()))) {
			if (result.status === "rejected") warn(result.reason);
		}
	};
	try {
		for (const root of roots) {
			const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8").catch(() => "{}")) as {
				readonly piDurable?: { readonly extensions?: readonly string[] };
			};
			// The host installs its own tool, with its own caller.
			if ((await realpath(root).catch(() => root)) === PACKAGE_DIR) continue;
			for (const path of manifest.piDurable?.extensions ?? []) {
				const entry = await import(pathToFileURL(resolvePath(root, path)).href);
				entries.push(await entry.default({ durable, ai, events }));
			}
		}
	} catch (error) {
		await close();
		throw error;
	}
	return { extensions: entries.flatMap((entry) => entry.extensions), close };
}
