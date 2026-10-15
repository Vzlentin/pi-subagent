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
import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import {
	type Component,
	Container,
	Editor,
	matchesKey,
	type Terminal,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { type Client, connect, runDisplayName, type WatchLine, watch } from "./client.ts";
import { agentReporter } from "./herdr.ts";

export type AttachOptions = { readonly terminal: Terminal; readonly env: NodeJS.ProcessEnv };

/**
 * Shows the conversation of the child `handle` in `terminal` and sends what the user types to it. It starts the host
 * when none runs, and rejects before the terminal starts when the handle is unknown. It resolves with the exit code:
 * 0 after Ctrl+C or when the child is stopped, 1 when the host closes the connection. The child keeps running.
 */
export async function attach(handle: string, options: AttachOptions): Promise<number> {
	const { terminal, env } = options;
	const watcher = await watch(handle);
	let control: Client;
	try {
		control = await hostClient();
	} catch (error) {
		watcher.close();
		throw error;
	}
	let { view, child } = watcher;

	initTheme();
	const markdown = getMarkdownTheme();
	const muted = getSelectListTheme().description;
	const tui = new TuiMainScreen(terminal);
	const transcript = new Container();
	const notice = new Text("", 1, 0);
	const status = new Text("", 1, 0);
	const editor = new Editor(tui, { borderColor: markdown.hr, selectList: getSelectListTheme() });
	tui.addChild(transcript);
	tui.addChild(notice);
	tui.addChild(status);
	tui.addChild(editor);
	tui.setFocus(editor);

	const components = new Map<EntryRecord["id"], Component>();
	const partial = new AssistantMessageComponent(undefined, false, markdown);
	const render = () => {
		transcript.clear();
		for (const component of transcriptOf(view, components, partial, markdown, muted)) transcript.addChild(component);
		status.setText(
			muted(`${runDisplayName(child)}  ${child.provider}/${child.model}  ${child.thinking}  ${child.state}`),
		);
		tui.requestRender();
	};

	const { report, release } = agentReporter(env, child.name ?? child.handle, handle);

	const { promise: exited, resolve: exit } = Promise.withResolvers<number>();
	let done = false;
	const finish = async (code: number, message?: string) => {
		if (done) return;
		done = true;
		tui.stop();
		if (message !== undefined) terminal.write(`${message}\n`);
		watcher.close();
		control.close();
		await release();
		exit(code);
	};
	const showError = (error: unknown) => {
		notice.setText(`Error: ${error instanceof Error ? error.message : String(error)}`);
		tui.requestRender();
	};
	const send = (message: string, followUp: boolean) => {
		if (message.trim() === "") return;
		editor.addToHistory(message);
		const request = { type: "send", requestId: randomUUID(), caller: "viewer", handle, message, followUp } as const;
		control.request({ ...request, viewer: true }).then(() => notice.setText(""), showError);
	};

	editor.onSubmit = (text) => send(text, false);
	tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) {
			void finish(0);
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			// An idle child has no turn to abort.
			if (child.state === "busy") control.request({ type: "abort", handle }).then(() => notice.setText(""), showError);
			return { consume: true };
		}
		if (matchesKey(data, "alt+enter")) {
			const text = editor.getText();
			editor.setText("");
			send(text, true);
			return { consume: true };
		}
		return undefined;
	});

	tui.start();
	render();
	report(child.state === "busy");
	watcher.listen(
		(line: WatchLine) => {
			if (done) return;
			if (line.stopped) {
				void finish(0, `${runDisplayName(child)} was stopped`);
				return;
			}
			view = apply(view, line.ops);
			child = line.child;
			render();
			report(child.state === "busy");
		},
		() => void finish(1, "The subagent host closed the connection"),
	);
	return exited;
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
	const live = view.docs["pi.live"] as LiveState | undefined;
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
	const streaming = live?.generation?.message as AssistantMessage | undefined;
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
