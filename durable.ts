/**
 * The `subagent` tool for hosts that run agents on pi-durable. The host passes its pi-durable and pi-ai modules, so
 * this package loads no second copy of either.
 */
import { randomUUID } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type * as Ai from "@earendil-works/pi-ai";
import type * as Durable from "@earendil-works/pi-durable";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import { request } from "./client.ts";
import { runTool, type Send, TOOL_DESCRIPTION, toolSchemas } from "./tool.ts";

/** How a host reaches the subagent host. */
export type DurableScope = {
	/** The caller that owns the children of the calling conversation. */
	caller(api: ToolExecutionApi, context: Context): Promise<string>;
	readonly send: Send;
};

/**
 * The extension with the `subagent` tool. A call that runs again after a restart has the same task, so its spawn or
 * send has the same request ID and does not repeat.
 */
export function subagentTool(durable: typeof Durable, ai: typeof Ai, scope: DurableScope): Extension {
	const { parameters, output } = toolSchemas(ai.Type);
	const tool = durable.defineTool({
		name: "subagent",
		description: TOOL_DESCRIPTION,
		parameters,
		structuredOutputSchema: output,
		replay: "safe",
		async execute(args, api, context) {
			const caller = await scope.caller(api, context);
			const agent = await api.agent(context);
			const { text, data } = await runTool(args, {
				caller,
				requestId: (key) => `${caller}:${key ?? api.taskId}`,
				provider: agent.model?.provider,
				model: agent.model?.modelId,
				thinking: agent.thinkingLevel,
				cwd: agent.cwd ?? process.cwd(),
				send: scope.send,
				signal: context.abortSignal,
			});
			return { output: [{ type: "text", text }], structuredOutput: data as JsonValue };
		},
	});
	return durable.defineExtension({ name: "pi-subagent", tools: [tool] });
}

/**
 * The `piDurable` entry. The caller is `<store>:<conversation ID>`, where the store is a random ID that the store keeps,
 * so conversations of two stores do not share children.
 */
export default function subagentEntry({ durable, ai }: { readonly durable: typeof Durable; readonly ai: typeof Ai }) {
	const Store = durable.defineDoc<{ id: string }>({
		kind: "pi-subagent.store",
		version: 1,
		scope: "session",
		initial: () => ({ id: "" }),
	});
	const extension = subagentTool(durable, ai, {
		caller: async (api, context) => {
			const id = await api.commit(async (tx) => {
				const store = await tx.doc(Store);
				if (store.id === "") store.id = randomUUID();
				return store.id;
			}, context);
			return `${id}:${api.conversationId}`;
		},
		send: (message, signal) => request(message, { start: true, signal }),
	});
	return { extensions: [extension], close: async () => {} };
}
