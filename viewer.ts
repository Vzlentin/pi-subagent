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
import {
	type ChildInfo,
	type Client,
	connect,
	liveState,
	runDisplayName,
	type Watch,
	type WatchLine,
	watch,
} from "./client.ts";
import { agentReporter } from "./herdr.ts";

export type AttachOptions = { readonly terminal: Terminal; readonly env: NodeJS.ProcessEnv };

/**
 * Shows the conversation of the child `handle` in `terminal` and sends what the user types to it. It starts the host
 * when none runs, and rejects before the terminal starts when the handle is unknown. It resolves with the exit code:
 * 0 after Ctrl+C or when the child is stopped, 1 when the host closes the connection. The child keeps running.
 */
export async function attach(handle: string, options: AttachOptions): Promise<number> {
	const watcher = await watch(handle);
	let control: Client;
	try {
		control = await hostClient();
	} catch (error) {
		watcher.close();
		throw error;
	}
	const viewer = new Viewer(handle, options, watcher, control);
	viewer.tui.start();
	viewer.render();
	viewer.reporter.report(viewer.child.state === "busy");
	watcher.listen(
		(line) => viewer.onLine(line),
		() => void viewer.finish(1, "The subagent host closed the connection"),
	);
	return viewer.exited;
}

/** The terminal screen of one attached child, and the state that its handlers share. */
class Viewer {
	readonly tui: TuiMainScreen;
	readonly transcript = new Container();
	readonly notice = new Text("", 1, 0);
	readonly status = new Text("", 1, 0);
	readonly editor: Editor;
	readonly components = new Map<EntryRecord["id"], Component>();
	readonly partial: AssistantMessageComponent;
	readonly markdown: ReturnType<typeof getMarkdownTheme>;
	readonly muted: (text: string) => string;
	readonly reporter: ReturnType<typeof agentReporter>;
	readonly exited: Promise<number>;
	readonly #exit: (code: number) => void;
	readonly handle: string;
	readonly terminal: Terminal;
	readonly watcher: Watch;
	readonly control: Client;
	view: ConversationView;
	child: ChildInfo;
	done = false;

	constructor(handle: string, options: AttachOptions, watcher: Watch, control: Client) {
		this.handle = handle;
		this.terminal = options.terminal;
		this.watcher = watcher;
		this.control = control;
		this.view = watcher.view;
		this.child = watcher.child;

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
		this.reporter = agentReporter(options.env, this.child.name ?? this.child.handle, handle);
		const { promise, resolve } = Promise.withResolvers<number>();
		this.exited = promise;
		this.#exit = resolve;

		this.editor.onSubmit = (text) => this.send(text, false);
		this.tui.addInputListener((data) => this.handleKey(data));
	}

	render(): void {
		this.transcript.clear();
		for (const component of transcriptOf(this.view, this.components, this.partial, this.markdown, this.muted)) {
			this.transcript.addChild(component);
		}
		const child = this.child;
		this.status.setText(
			this.muted(`${runDisplayName(child)}  ${child.provider}/${child.model}  ${child.thinking}  ${child.state}`),
		);
		this.tui.requestRender();
	}

	handleKey(data: string): { consume: true } | undefined {
		if (matchesKey(data, "ctrl+c")) {
			void this.finish(0);
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			// An idle child has no turn to abort.
			if (this.child.state === "busy") {
				this.control
					.request({ type: "abort", handle: this.handle })
					.then(() => this.notice.setText(""), this.showError);
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

	send(message: string, followUp: boolean): void {
		if (message.trim() === "") return;
		this.editor.addToHistory(message);
		const request = {
			type: "send",
			requestId: randomUUID(),
			caller: this.watcher.caller,
			handle: this.handle,
			message,
			followUp,
		} as const;
		this.control.request(request).then(() => this.notice.setText(""), this.showError);
	}

	onLine(line: WatchLine): void {
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

	async finish(code: number, message?: string): Promise<void> {
		if (this.done) return;
		this.done = true;
		this.tui.stop();
		if (message !== undefined) this.terminal.write(`${message}\n`);
		this.watcher.close();
		this.control.close();
		await this.reporter.release();
		this.#exit(code);
	}

	readonly showError = (error: unknown): void => {
		this.notice.setText(`Error: ${error instanceof Error ? error.message : String(error)}`);
		this.tui.requestRender();
	};
}

async function hostClient(): Promise<Client> {
	const client = await connect({ start: true });
	if (client === undefined) throw new Error("Could not connect to the subagent host");
	return client;
}

/** The components of the transcript: each user and assistant message, one line for each tool call, and the partial. */
function transcriptOf(
	view: ConversationView,
	components: Map<EntryRecord["id"], Component>,
	partial: AssistantMessageComponent,
	markdown: ReturnType<typeof getMarkdownTheme>,
	muted: (text: string) => string,
): Component[] {
	const live = liveState(view);
	const results = new Map<string, string>();
	for (const entry of view.entries) {
		const message = entry.model?.[0];
		if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			results.set(message.toolCallId, message.isError ? "error" : "done");
		}
	}
	const toolLines = (message: AssistantMessage) =>
		message.content.flatMap((part) => {
			if (part.type !== "toolCall") return [];
			const state = results.get(part.id) ?? live?.tools?.find((slot) => slot.callId === part.id)?.status ?? "pending";
			return [new Text(muted(`${part.name}  ${state}`), 1, 0)];
		});
	const shown: Component[] = [];
	for (const entry of view.entries) {
		const message = entry.model?.[0];
		if (message === undefined) continue;
		const component = componentOf(entry, message, components, markdown);
		if (component !== undefined) shown.push(component);
		if (message.role === "assistant") shown.push(...toolLines(message));
	}
	const streaming = live?.generation?.message;
	if (streaming !== undefined) {
		partial.updateContent(streaming, true);
		shown.push(partial, ...toolLines(streaming));
	}
	return shown;
}

/** The component of a user or assistant entry, made once for each entry. */
function componentOf(
	entry: EntryRecord,
	message: Message,
	components: Map<EntryRecord["id"], Component>,
	markdown: ReturnType<typeof getMarkdownTheme>,
): Component | undefined {
	const cached = components.get(entry.id);
	if (cached !== undefined) return cached;
	let component: Component | undefined;
	if (entry.kind === "pi.user" && message.role === "user") {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		component = new UserMessageComponent(text, markdown);
	} else if (entry.kind === "pi.assistant" && message.role === "assistant") {
		component = new AssistantMessageComponent(message, false, markdown);
	}
	if (component !== undefined) components.set(entry.id, component);
	return component;
}
