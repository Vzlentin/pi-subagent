/**
 * The children library: creates and drives child conversations on whatever pi-durable store its caller hands it. Its
 * caller passes its pi-durable module, so a process never holds two copies.
 */
import { type Context, withCancel } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type * as Durable from "@earendil-works/pi-durable";
import type {
	Conversation,
	ConversationId,
	DocumentReader,
	EntryId,
	Extension,
	RegistrySnapshot,
	Submission,
	SubmissionId,
	TaskId,
	ToolRegistration,
	Tx,
	UsageState,
} from "@earendil-works/pi-durable";

/** The deepest child by default: a child of a child of a root. */
export const DEFAULT_DEPTH_LIMIT = 2;

/**
 * The store children live in: a Harness, or a running task's runtime with the Harness's `submission`. `commit`
 * callbacks return nothing, as a task's do, and read back through `tx` or `snapshot`.
 */
export type Store = {
	commit(change: (tx: Tx) => Promise<undefined>, context: Context): Promise<unknown>;
	readonly snapshot: DocumentReader["snapshot"];
	conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
	submission(id: SubmissionId, context: Context): Promise<Submission | undefined>;
};

/** Where children live: the store, the models they run on, and the tools that `Spec.tools` names. */
export type Place = {
	readonly store: Store;
	readonly models: Models;
	/** The tools that `Spec.tools` names resolve among, by name; the last of a name wins. */
	readonly registry: RegistrySnapshot;
};

/**
 * Who owns a child, which decides what aborts reach it: a running task in `conversation`, whose abort aborts the child,
 * or an anchor task of its own in `root`, the store's root conversation, so the child outlives every request. The
 * owner's conversation gives the spec what it leaves out.
 */
export type Owner =
	| { readonly kind: "task"; readonly taskId: TaskId; readonly conversation: ConversationId }
	| { readonly kind: "detached"; readonly root: Conversation };

/** What a child runs with. JSON only, so a socket can carry it. A field left out comes from the owner's agent. */
export type Spec = {
	/** The root of the tree, for a child of a caller outside this store: a Pi session, a caller name. */
	readonly root?: string;
	/** The conversation in this store that spawns the child. */
	readonly parent?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly cwd?: string;
	/** The only tools the child gets, by name. */
	readonly tools?: readonly string[];
	readonly instructions?: string;
};

/** Where a child sits in its tree. */
export type Lineage = {
	readonly key: string;
	readonly root: string;
	readonly parent?: string;
	/** 1 for a child of a root. */
	readonly depth: number;
	/** The deepest depth of the tree. */
	readonly limit: number;
};

export type ChildState = "busy" | "idle" | "error" | "closed";

/**
 * What a turn returns: its text, or a named failure. `cut` stopped before its end, such as at its length limit, and
 * keeps its text. `no-respond` is a schema ask with no accepted `respond` call. `unanswered` settled with no answer,
 * after a provider error, an abort or a close; `cause` is the settlement's reason, or `queued` when the child stopped
 * with the request still queued after a failed turn.
 */
export type Answer =
	| { readonly status: "ok"; readonly text: string; readonly entry: EntryId }
	| {
			readonly status: "failed";
			readonly reason: "cut";
			readonly text: string;
			readonly entry: EntryId;
			readonly stopReason: string;
	  }
	| { readonly status: "failed"; readonly reason: "no-respond"; readonly text: string; readonly entry: EntryId }
	| { readonly status: "failed"; readonly reason: "unanswered"; readonly cause: string; readonly detail?: unknown };

/** Input to a child, at most once per request ID. */
export type Input = Parameters<Conversation["submit"]>[0] & { readonly type: "input"; readonly requestId: string };

/** One child, driven by its operations. Failures are returned, not thrown, so each caller keeps its own policy. */
export type Child = {
	readonly id: ConversationId;
	readonly lineage: Lineage;
	/** The child's conversation, for what the library does not cover: its agent, a watch, an abort of its turn. */
	readonly conversation: Conversation;
	/**
	 * Admits `input` and returns. A request ID admitted before is not admitted again, and a closed child refuses input.
	 * A new request ID becomes the last request before the submit, so a crash between the two still finds it.
	 */
	send(input: Input, context: Context): Promise<void>;
	/**
	 * Waits until `request` (default: the last one) settles, then gives its answer. Cancelling the wait through
	 * `context` stops only the wait; the child runs until `close()`.
	 */
	settled(context: Context, request?: string): Promise<Answer>;
	state(context: Context): Promise<ChildState>;
	/** The spend of the child and everything under it, for reports. */
	usage(context: Context): Promise<UsageState>;
	/**
	 * Withdraws the queued input of the child and its subtree, aborts them, background work included, and marks them
	 * closed. Gives the conversations it closed, the child first.
	 */
	close(context: Context): Promise<ConversationId[]>;
};

export type Children = {
	/** The extension with the library's task; the caller installs it in its registry. */
	readonly extension: Extension;
	/**
	 * The child of `key`: created the first time `key` is seen, with its lineage, in one commit, and the same child after.
	 * `setup` runs in the creating commit. Before creating anything, it refuses a spec whose model neither it nor the
	 * owner's agent names, an unknown model or tool, and a parent at its depth limit. Keys are global in a store, so
	 * callers prefix them.
	 */
	open(
		place: Place,
		owner: Owner,
		key: string,
		spec: Spec,
		context: Context,
		setup?: (tx: Tx, id: ConversationId) => Promise<void>,
	): Promise<Child>;
	/**
	 * The child of `owner` with a key or a conversation ID opened earlier, also after a restart. A child of another
	 * owner is refused.
	 */
	find(
		place: Place,
		owner: Owner,
		which: { readonly key: string } | { readonly id: string },
		context: Context,
	): Promise<Child | undefined>;
	/** Where the conversation `id` sits in its tree; nothing for a root, or another conversation the library did not open. */
	lineage(store: Pick<Store, "snapshot">, id: string, context: Context): Promise<Lineage | undefined>;
};

type OwnerState = { kind: "task"; taskId: number } | { kind: "detached" };

type ChildDocState = {
	key: string;
	root: string;
	parent: string | null;
	depth: number;
	limit: number;
	owner: OwnerState;
	/** The children of this child, in creation order. */
	children: number[];
	/** The newest request ID admitted, which `settled` defaults to. */
	lastRequest: string | null;
	closed: boolean;
};

export function createChildren(durable: typeof Durable): Children {
	const ChildDoc = durable.defineDoc<ChildDocState>({
		kind: "pi-subagent.child",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "initial",
		initial: () => ({
			key: "",
			root: "",
			parent: null,
			depth: 0,
			limit: 0,
			owner: { kind: "detached" },
			children: [],
			lastRequest: null,
			closed: false,
		}),
	});
	/** The conversation of each key; 0 before it exists. */
	const Keys = durable.defineDocFamily<{ conversation: number }, null>({
		kind: "pi-subagent.key",
		version: 1,
		scope: "session",
		family: true,
		initial: () => ({ conversation: 0 }),
	});
	/**
	 * Owns a detached child's conversation. It is a background task of the root conversation that finishes at once, so
	 * the child outlives any one request and only an abort with `background: true` reaches it.
	 */
	const Anchor = durable.defineTask<null, { phase: "done" }, null>({
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

	const ownerState = (owner: Owner): OwnerState =>
		owner.kind === "task" ? { kind: "task", taskId: owner.taskId } : { kind: "detached" };
	const sameOwner = (a: Readonly<OwnerState>, b: OwnerState) =>
		a.kind === b.kind && (a.kind === "detached" || (b.kind === "task" && a.taskId === b.taskId));

	const lineageOf = (doc: Readonly<ChildDocState>): Lineage => ({
		key: doc.key,
		root: doc.root,
		...(doc.parent === null ? {} : { parent: doc.parent }),
		depth: doc.depth,
		limit: doc.limit,
	});

	async function childDoc(store: Pick<Store, "snapshot">, id: ConversationId, context: Context) {
		const doc = await store.snapshot(ChildDoc, id, context);
		return doc === undefined || doc.key === "" ? undefined : doc;
	}

	async function lineage(store: Pick<Store, "snapshot">, id: string, context: Context) {
		const conversation = conversationIdOf(id);
		const doc = conversation === undefined ? undefined : await childDoc(store, conversation, context);
		return doc === undefined ? undefined : lineageOf(doc);
	}

	/** Reads through a commit, which returns nothing on a task's runtime. */
	async function read<T>(place: Place, reader: (tx: Tx) => Promise<T>, context: Context): Promise<T> {
		let value: T | undefined;
		await place.store.commit(async (tx) => {
			value = await reader(tx);
			return undefined;
		}, context);
		return value as T;
	}

	/** `id` and every child under it, parents first. */
	async function subtree(place: Place, id: ConversationId, context: Context): Promise<ConversationId[]> {
		const ids = [id];
		for (let i = 0; i < ids.length; i++) {
			const doc = await childDoc(place.store, ids[i] as ConversationId, context);
			for (const child of doc?.children ?? []) ids.push(child as ConversationId);
		}
		return ids;
	}

	/** The answer of the settled input `request` of `id`. */
	async function answerOf(place: Place, id: ConversationId, request: string, context: Context): Promise<Answer> {
		const settled = await read(place, (tx) => tx.submissionByRequest(id, request), context);
		if (settled?.status === "unanswered") {
			return { status: "failed", reason: "unanswered", cause: settled.reason, detail: settled.detail };
		}
		if (settled?.status !== "done") return { status: "failed", reason: "unanswered", cause: "queued" };
		const entry = settled.answer;
		if (entry === undefined) return { status: "failed", reason: "unanswered", cause: "missing answer" };
		const message = (await read(place, (tx) => tx.entry(durable.AssistantEntry, entry), context))?.model?.[0];
		if (message?.role !== "assistant") return { status: "failed", reason: "unanswered", cause: "missing answer" };
		const text = message.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n")
			.trim();
		if (message.stopReason !== "stop" && message.stopReason !== "toolUse") {
			return { status: "failed", reason: "cut", text, entry, stopReason: message.stopReason };
		}
		return { status: "ok", text, entry };
	}

	function makeChild(place: Place, id: ConversationId, childLineage: Lineage, conversation: Conversation): Child {
		const lastRequest = async (context: Context) => (await place.store.snapshot(ChildDoc, id, context))?.lastRequest;
		return {
			id,
			lineage: childLineage,
			conversation,
			async send(input, context) {
				await place.store.commit(async (tx) => {
					const doc = await tx.doc(ChildDoc, id);
					if (doc.closed) throw new Error(`The child ${id} is closed`);
					if ((await tx.submissionByRequest(id, input.requestId)) !== undefined) return undefined;
					doc.lastRequest = input.requestId;
					return undefined;
				}, context);
				await conversation.submit(input, context);
			},
			async settled(context, request) {
				const requestId = request ?? (await lastRequest(context));
				if (requestId == null) return { status: "failed", reason: "unanswered", cause: "no request" };
				const record = await read(place, (tx) => tx.submissionByRequest(id, requestId), context);
				if (record === undefined) return { status: "failed", reason: "unanswered", cause: "no request" };
				const submission = await place.store.submission(record.id, context);
				// A request still queued when the child stops after a failed turn never settles, so idle ends the wait too.
				const wait = withCancel(context);
				try {
					await Promise.race([
						...(submission === undefined ? [] : [submission.wait(wait.context)]),
						conversation.waitForIdle(wait.context),
					]);
				} finally {
					wait.cancel();
				}
				context.abortSignal?.throwIfAborted();
				return answerOf(place, id, requestId, context);
			},
			async state(context) {
				if ((await place.store.snapshot(ChildDoc, id, context))?.closed === true) return "closed";
				const live = await place.store.snapshot(durable.LiveDoc, id, context);
				if (live?.run !== undefined) return "busy";
				const requestId = await lastRequest(context);
				const settled =
					requestId == null ? undefined : await read(place, (tx) => tx.submissionByRequest(id, requestId), context);
				// An aborted turn leaves the child idle.
				return settled?.status === "unanswered" && settled.reason !== "aborted" ? "error" : "idle";
			},
			async usage(context) {
				let sum: unknown = { models: {}, tools: {} };
				for (const member of await subtree(place, id, context)) {
					sum = addNumbers(sum, await place.store.snapshot(durable.UsageDoc, member, context));
				}
				return sum as UsageState;
			},
			async close(context) {
				const ids = await subtree(place, id, context);
				for (const member of ids) {
					await (await place.store.conversation(member, context))?.abort(context, { background: true });
					await place.store.commit(async (tx) => {
						(await tx.doc(ChildDoc, member)).closed = true;
						return undefined;
					}, context);
				}
				return ids;
			},
		};
	}

	const find: Children["find"] = async (place, owner, which, context) => {
		const id =
			"key" in which
				? (await place.store.snapshot(Keys, which.key, context))?.conversation
				: conversationIdOf(which.id);
		if (id === undefined || id === 0) return undefined;
		const doc = await childDoc(place.store, id as ConversationId, context);
		const conversation = await place.store.conversation(id as ConversationId, context);
		if (doc === undefined || conversation === undefined) return undefined;
		if (!sameOwner(doc.owner, ownerState(owner))) throw new Error(`The child ${id} belongs to another owner`);
		return makeChild(place, id as ConversationId, lineageOf(doc), conversation);
	};

	return {
		extension: durable.defineExtension({ name: "pi-subagent-children", tasks: [Anchor] }),
		lineage,
		find,
		async open(place, owner, key, spec, context, setup) {
			const existing = await find(place, owner, { key }, context);
			if (existing !== undefined) return existing;
			const ownerConversation =
				owner.kind === "task" ? await place.store.conversation(owner.conversation, context) : owner.root;
			const agent = await ownerConversation?.agent(context);
			const provider = spec.provider ?? agent?.model?.provider;
			const modelId = spec.model ?? agent?.model?.modelId;
			if (provider === undefined || modelId === undefined) {
				throw new Error("No model: neither the spec nor the owner's agent names one");
			}
			if (place.models.getModel(provider, modelId) === undefined) {
				throw new Error(`Unknown model: ${provider}/${modelId}`);
			}
			const thinking = spec.thinking ?? agent?.thinkingLevel;
			const cwd = spec.cwd ?? agent?.cwd;
			let tools: ToolRegistration[] | undefined;
			if (spec.tools !== undefined) {
				const installed = place.registry.tools();
				tools = spec.tools.map((name) => {
					const found = installed.findLast(({ tool }) => tool.name === name);
					if (found === undefined) throw new Error(`Unknown tool: ${name}`);
					return found.tool;
				});
			}
			const parentId = spec.parent === undefined ? undefined : conversationIdOf(spec.parent);
			const parent = spec.parent === undefined ? undefined : await lineage(place.store, spec.parent, context);
			const depth = (parent?.depth ?? 0) + 1;
			const limit = parent?.limit ?? DEFAULT_DEPTH_LIMIT;
			if (depth > limit) throw new Error("Nested subagents are disabled");
			const root = parent?.root ?? spec.root ?? spec.parent;
			if (root === undefined) throw new Error("A child needs a root or a parent");

			const create = async (tx: Tx, ownerTask: TaskId) => {
				const known = await tx.doc(Keys, key, null);
				if (known.conversation !== 0) return undefined;
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: ownerTask } });
				await durable.configure(tx, child.id, {
					model: { provider, modelId },
					...(thinking === undefined ? {} : { thinkingLevel: thinking as ModelThinkingLevel }),
					...(cwd === undefined ? {} : { cwd }),
					...(tools === undefined ? {} : { tools }),
					...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
				});
				const state: ChildDocState = {
					key,
					root,
					parent: spec.parent ?? null,
					depth,
					limit,
					owner: ownerState(owner),
					children: [],
					lastRequest: null,
					closed: false,
				};
				Object.assign(await tx.doc(ChildDoc, child.id), state);
				// A parent that the library opened lists the child, so closing the parent closes it too.
				if (parent !== undefined && parentId !== undefined) (await tx.doc(ChildDoc, parentId)).children.push(child.id);
				known.conversation = child.id;
				await setup?.(tx, child.id);
				return undefined;
			};
			if (owner.kind === "detached") {
				await owner.root.commit(async (tx) => {
					if ((await tx.doc(Keys, key, null)).conversation !== 0) return undefined;
					const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
					return create(tx, anchor);
				}, context);
			} else {
				await place.store.commit((tx) => create(tx, owner.taskId), context);
			}
			const opened = await find(place, owner, { key }, context);
			if (opened === undefined) throw new Error(`The child of ${key} is missing`);
			return opened;
		},
	};
}

/** The conversation ID that `value` spells, as callers write it; nothing for another caller, such as a Pi session. */
function conversationIdOf(value: string): ConversationId | undefined {
	return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))
		? (Number(value) as ConversationId)
		: undefined;
}

/** `a` with every number in `b` added at the same path; `b` undefined adds nothing. */
function addNumbers(a: unknown, b: unknown): unknown {
	if (typeof b === "number") return (typeof a === "number" ? a : 0) + b;
	if (b === null || typeof b !== "object") return a ?? b;
	const sum: Record<string, unknown> = { ...(a !== null && typeof a === "object" ? a : {}) };
	for (const [key, value] of Object.entries(b)) sum[key] = addNumbers(sum[key], value);
	return sum;
}
