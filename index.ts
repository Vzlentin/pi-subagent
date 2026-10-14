import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { childLine, request } from "./client.ts";
import { runTool, sendToHost, TOOL_DESCRIPTION, toolSchemas } from "./tool.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

export default function subagentExtension(pi: ExtensionAPI) {
	pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));

	const { parameters, output } = toolSchemas(Type);
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: TOOL_DESCRIPTION,
		parameters,
		outputSchema: output,
		executionMode: "sequential",
		async execute(toolCallId, args, signal, _onUpdate, ctx) {
			const { text, data } = await runTool(args, {
				caller: ctx.sessionManager.getSessionId(),
				callKey: toolCallId,
				provider: ctx.model?.provider,
				model: ctx.model?.id,
				thinking: pi.getThinkingLevel(),
				cwd: ctx.cwd,
				send: sendToHost,
				signal,
			});
			return { content: [{ type: "text", text }], details: undefined, structuredContent: data };
		},
	});

	pi.registerCommand("subagent", {
		description: "List the subagents spawned by this session",
		handler: async (_args, ctx) => {
			const children = await request({ type: "list", caller: ctx.sessionManager.getSessionId() }, { start: true });
			if (children.length === 0) {
				ctx.ui.notify("No subagents spawned by this session", "info");
				return;
			}
			ctx.ui.notify(children.map(childLine).join("\n"), "info");
		},
	});

	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let widgetContext: ExtensionContext | undefined;
	let refreshing = false;

	// The widget does not start the host: when none runs, it shows nothing.
	const refreshWidget = async (): Promise<void> => {
		if (!widgetContext || refreshing) return;
		refreshing = true;
		try {
			const context = widgetContext;
			const children = await request(
				{ type: "list", caller: context.sessionManager.getSessionId() },
				{ start: false },
			).catch(() => undefined);
			if (context !== widgetContext) return;
			if (children === undefined || children.length === 0) {
				context.ui.setWidget("subagents", undefined);
				return;
			}
			const theme = context.ui.theme;
			const visible = children.slice(0, 5).map(({ name, handle, state }) => {
				const color = state === "busy" ? "warning" : state === "idle" ? "success" : "error";
				return theme.fg(color, `${name ?? handle}:${state}`);
			});
			if (children.length > visible.length) visible.push(theme.fg("muted", `+${children.length - visible.length}`));
			context.ui.setWidget("subagents", [theme.fg("dim", "subagents: ") + visible.join(theme.fg("dim", " | "))], {
				placement: "belowEditor",
			});
		} finally {
			refreshing = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		widgetContext = ctx;
		void refreshWidget();
		widgetTimer = setInterval(() => void refreshWidget(), 1000);
		widgetTimer.unref();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
		widgetContext = undefined;
		ctx.ui.setWidget("subagents", undefined);
	});
}
