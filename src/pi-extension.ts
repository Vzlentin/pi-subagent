import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { request } from "./client.ts";
import { savedTrust } from "./context.ts";
import { openViewerTab } from "./herdr.ts";
import { childLine, runDisplayName } from "./protocol.ts";
import { runTool, sendToHost, TOOL_DESCRIPTION, toolSchemas } from "./tool.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

export const SESSION_TRUST_HINT =
	"The child gets no project skills (.pi/skills, .agents/skills): this project is trusted for this Pi session only, and children see only the trust saved for future sessions. To give children project skills, run /trust and choose Trust.";

export default function subagentExtension(pi: ExtensionAPI) {
	pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "..", "skills")] }));

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
			// Children follow only the saved trust, so a session that trusts its project for itself says what the child misses.
			const sessionOnly =
				args.action === "spawn" &&
				ctx.isProjectTrusted() &&
				!savedTrust(ctx.cwd) &&
				!savedTrust(resolve(ctx.cwd, args.cwd ?? "."));
			const hint = sessionOnly ? `\n${SESSION_TRUST_HINT}\n` : "";
			return { content: [{ type: "text", text: text + hint }], details: undefined, structuredContent: data };
		},
	});

	pi.registerCommand("subagent", {
		description: "Open the viewer of a subagent spawned by this session",
		handler: async (_args, ctx) => {
			const children = await request({ type: "list", caller: ctx.sessionManager.getSessionId() }, { start: true });
			if (children.length === 0) {
				ctx.ui.notify("No subagents spawned by this session", "info");
				return;
			}
			const chosen = await ctx.ui.select("Attach to subagent", children.map(childLine));
			// A name can start with the display name of another child, so the longest match is the chosen child.
			const child = children
				.filter((c) => chosen?.startsWith(`${runDisplayName(c)}  `))
				.sort((a, b) => runDisplayName(b).length - runDisplayName(a).length)[0];
			if (child === undefined) return;
			const command = `subagent attach ${child.handle}`;
			if (!process.env.HERDR_ENV) {
				ctx.ui.notify(`Run in another terminal: ${command}`, "info");
				return;
			}
			try {
				await openViewerTab(child, process.env);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not open a Herdr tab: ${message}. Run in another terminal: ${command}`, "error");
			}
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
