import { randomUUID } from "node:crypto";
import { apply } from "@earendil-works/chord/delta";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	getSelectListTheme,
	initTheme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import {
	type Component,
	Container,
	Editor,
	matchesKey,
	type Terminal,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { type Client, connect } from "./client.ts";
import { agentReporter } from "./herdr.ts";
import { type ChildInfo, childLabel, liveState, runDisplayName, type WatchLine } from "./protocol.ts";

export type AttachOptions = { readonly terminal: Terminal; readonly env: NodeJS.ProcessEnv };

/**
 * Shows the conversation of the child `handle` in `terminal` and sends what the user types to it. It starts the host
 * when none runs, and rejects before the terminal starts when the handle is unknown. It resolves with the exit code:
 * 0 after Ctrl+C or when the child is stopped, 1 when the host closes the connection. The child keeps running.
 */
export async function attach(handle: string, options: AttachOptions): Promise<number> {
	const client = await connect({ start: true });
	if (client === undefined) throw new Error("Could not connect to the subagent host");
	let watched: Awaited<ReturnType<Client["watch"]>>;
	try {
		watched = await client.watch(handle);
	} catch (error) {
		client.close();
		throw error;
	}
	return new Viewer(handle, options, client, watched).start();
}

/** The terminal screen of one attached child, and the state that its handlers share. */
class Viewer {
	private readonly tui: TuiMainScreen;
	private readonly transcript = new Container();
	private readonly notice = new Text("", 1, 0);
	private readonly status = new Text("", 1, 0);
	private readonly editor: Editor;
	private readonly components = new Map<EntryRecord["id"], Component>();
	private readonly partial: AssistantMessageComponent;
	private readonly markdown: ReturnType<typeof getMarkdownTheme>;
	private readonly muted: (text: string) => string;
	private readonly reporter: ReturnType<typeof agentReporter>;
	private readonly exited: Promise<number>;
	readonly #exit: (code: number) => void;
	private readonly handle: string;
	private readonly terminal: Terminal;
	private readonly client: Client;
	private view: ConversationView;
	private readonly lines: AsyncIterable<WatchLine>;
	private child: ChildInfo;
	private done = false;

	constructor(handle: string, options: AttachOptions, client: Client, watched: Awaited<ReturnType<Client["watch"]>>) {
		this.handle = handle;
		this.terminal = options.terminal;
		this.client = client;
		this.view = watched.view;
		this.child = watched.child;
		this.lines = watched.lines;

		initTheme();
		this.markdown = getMarkdownTheme();
		this.muted = getSelectListTheme().description;
		this.tui = new TuiMainScreen(this.terminal);
		this.editor = new Editor(this.tui, { borderColor: this.markdown.hr, selectList: getSelectListTheme() });
		this.tui.addChild(this.transcript);
		this.tui.addChild(this.notice);
		this.tui.addChild(this.status);
		this.tui.addChild(this.editor);
		this.tui.setFocus(this.editor);
		this.partial = new AssistantMessageComponent(undefined, false, this.markdown);
		this.reporter = agentReporter(options.env, childLabel(this.child), handle);
		const { promise, resolve } = Promise.withResolvers<number>();
		this.exited = promise;
		this.#exit = resolve;

		this.editor.onSubmit = (text) => this.send(text, false);
		this.tui.addInputListener((data) => this.handleKey(data));
	}

	/** Starts the terminal and the watch, and resolves with the exit code. */
	start(): Promise<number> {
		this.tui.start();
		this.render();
		this.reporter.report(this.child.state === "busy");
		void this.follow(this.lines);
		return this.exited;
	}

	private render(): void {
		this.transcript.clear();
		for (const component of this.transcriptOf()) {
			this.transcript.addChild(component);
		}
		const child = this.child;
		this.status.setText(
			this.muted(`${runDisplayName(child)}  ${child.provider}/${child.model}  ${child.thinking}  ${child.state}`),
		);
		this.tui.requestRender();
	}

	private handleKey(data: string): { consume: true } | undefined {
		if (matchesKey(data, "ctrl+c")) {
			void this.finish(0);
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			// An idle child has no turn to abort.
			if (this.child.state === "busy") {
				this.client.request({ type: "abort", handle: this.handle }).then(() => this.notice.setText(""), this.showError);
			}
			return { consume: true };
		}
		if (matchesKey(data, "alt+enter")) {
			const text = this.editor.getText();
			this.editor.setText("");
			this.send(text, true);
			return { consume: true };
		}
		return undefined;
	}

	private send(message: string, followUp: boolean): void {
		if (message.trim() === "") return;
		this.editor.addToHistory(message);
		const request = {
			type: "input",
			requestId: randomUUID(),
			handle: this.handle,
			message,
			followUp,
		} as const;
		this.client.request(request).then(() => this.notice.setText(""), this.showError);
	}

	/** Shows each event of the watch, and finishes when the connection closes. */
	private async follow(lines: AsyncIterable<WatchLine>): Promise<void> {
		for await (const line of lines) this.onLine(line);
		await this.finish(1, "The subagent host closed the connection");
	}

	private onLine(line: WatchLine): void {
		if (this.done) return;
		if (line.stopped) {
			void this.finish(0, `${runDisplayName(this.child)} was stopped`);
			return;
		}
		this.view = apply(this.view, line.ops);
		this.child = line.child;
		this.render();
		this.reporter.report(this.child.state === "busy");
	}

	private async finish(code: number, message?: string): Promise<void> {
		if (this.done) return;
		this.done = true;
		this.tui.stop();
		if (message !== undefined) this.terminal.write(`${message}\n`);
		this.client.close();
		await this.reporter.release();
		this.#exit(code);
	}

	private readonly showError = (error: unknown): void => {
		this.notice.setText(`Error: ${error instanceof Error ? error.message : String(error)}`);
		this.tui.requestRender();
	};

	/** The components of the transcript: each user and assistant message, one line for each tool call, and the partial. */
	private transcriptOf(): Component[] {
		const live = liveState(this.view);
		const results = new Map<string, string>();
		for (const entry of this.view.entries) {
			const message = entry.model?.[0];
			if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
				results.set(message.toolCallId, message.isError ? "error" : "done");
			}
		}
		const toolLines = (message: AssistantMessage) =>
			message.content.flatMap((part) => {
				if (part.type !== "toolCall") return [];
				const state = results.get(part.id) ?? live?.tools?.find((slot) => slot.callId === part.id)?.status ?? "pending";
				return [new Text(this.muted(`${part.name}  ${state}`), 1, 0)];
			});
		const shown: Component[] = [];
		for (const entry of this.view.entries) {
			const message = entry.model?.[0];
			if (message === undefined) continue;
			const component = this.componentOf(entry, message);
			if (component !== undefined) shown.push(component);
			if (message.role === "assistant") shown.push(...toolLines(message));
		}
		const streaming = live?.generation?.message;
		if (streaming !== undefined) {
			this.partial.updateContent(streaming, true);
			shown.push(this.partial, ...toolLines(streaming));
		}
		return shown;
	}

	/** The component of a user or assistant entry, made once for each entry. */
	private componentOf(entry: EntryRecord, message: Message): Component | undefined {
		const cached = this.components.get(entry.id);
		if (cached !== undefined) return cached;
		let component: Component | undefined;
		if (entry.kind === "pi.user" && message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			component = new UserMessageComponent(text, this.markdown);
		} else if (entry.kind === "pi.assistant" && message.role === "assistant") {
			component = new AssistantMessageComponent(message, false, this.markdown);
		}
		if (component !== undefined) this.components.set(entry.id, component);
		return component;
	}
}
