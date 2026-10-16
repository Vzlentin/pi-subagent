import type { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Op } from "@earendil-works/chord/delta";
import { type ConversationView, LiveDoc, type LiveState } from "@earendil-works/pi-durable";

/** The version of the protocol between the CLI and the host. A client refuses a host with another version. */
export const PROTOCOL_VERSION = 3;

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
	 * The viewer's stream of the child: the reply, then one `{ event: WatchLine }` line after each commit to the child's
	 * conversation and after each rename. Every other line on the connection stays a reply, in request order. A
	 * connection carries one watch.
	 */
	| { readonly type: "watch"; readonly handle: string }
	/** Stops the child's current turn. The viewer sends it. */
	| { readonly type: "abort"; readonly handle: string }
	/** The viewer's message to the child. It has no caller. */
	| {
			readonly type: "input";
			readonly requestId: string;
			readonly handle: string;
			readonly message: string;
			readonly followUp: boolean;
	  };

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
	readonly watch: { readonly view: ConversationView; readonly child: ChildInfo };
	readonly abort: ChildInfo;
	readonly input: Replies["send"];
};

/**
 * An event of a watch after its reply, sent as `{ event: WatchLine }`: the changes of one commit or a rename, or the end
 * when the child was stopped.
 */
export type WatchLine =
	| { readonly ops: readonly Op[]; readonly child: ChildInfo; readonly stopped?: undefined }
	| { readonly stopped: true };

/** The live state of a conversation view: the running turn, the streamed message and the tool slots. */
export function liveState(view: ConversationView): LiveState | undefined {
	return view.docs[LiveDoc.definition.kind];
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

/** The label of a child: its name, or its handle when it has no name. */
export function childLabel(child: { readonly handle: string; readonly name?: string | undefined }): string {
	return child.name ?? child.handle;
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
