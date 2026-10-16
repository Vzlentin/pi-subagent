/**
 * What a child sees of its working directory, as a Pi session there sees it: the coding tools, and the system prompt
 * sections with the project instructions, the skills and the working directory.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ImageContent, Static, TextContent, TSchema } from "@earendil-works/pi-ai";
import {
	createFindTool,
	createGrepTool,
	createLsTool,
	DefaultPackageManager,
	formatSkillsForPrompt,
	getAgentDir,
	hasTrustRequiringProjectResources,
	loadProjectContextFiles,
	loadSkills,
	ProjectTrustStore,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	defineDoc,
	defineExtension,
	defineTool,
	type PromptInput,
	section,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

/** Whether a conversation's project is trusted, decided when the conversation is created; without a decision, not. */
export const Trust = defineDoc<{ trusted: boolean }>({
	kind: "pi-subagent.trust",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ trusted: false }),
});

/**
 * Whether Pi trusts the project in `cwd` with no one to ask: a directory without project resources is trusted, then a
 * decision saved with `/trust` counts, then the `defaultProjectTrust` setting, where `ask` means not trusted.
 */
export function savedTrust(cwd: string): boolean {
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	const agentDir = getAgentDir();
	const decision = new ProjectTrustStore(agentDir).get(cwd);
	if (decision !== null) return decision;
	return SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always";
}

/** The part of a Pi coding agent tool that a durable tool needs. */
type PiTool<T extends TSchema> = {
	readonly name: string;
	readonly description: string;
	readonly parameters: T;
	execute(
		id: string,
		args: Static<T>,
		signal?: AbortSignal,
	): Promise<{ readonly content: (TextContent | ImageContent)[] }>;
};

/** A Pi coding agent tool as a durable tool that runs in the calling conversation's directory. */
function piTool<T extends TSchema>(create: (cwd: string) => PiTool<T>): ToolRegistration {
	const { name, description, parameters } = create(".");
	return defineTool({
		name,
		description,
		parameters,
		replay: "safe",
		execute: async (args, api, context) => {
			const { cwd } = await api.agent(context);
			if (cwd === undefined) throw new Error(`${name} needs a working directory`);
			const result = await create(cwd).execute(api.callId, args, context.abortSignal);
			return { output: result.content };
		},
	});
}

type Resources = {
	readonly context: readonly { readonly path: string; readonly content: string }[];
	readonly skills: ReturnType<typeof loadSkills>["skills"];
};
const resources = new Map<string, Promise<Resources>>();

/**
 * The project instructions and skills of `cwd`, loaded once per directory and trust as Pi loads them at startup.
 * Project skills load only for a trusted project. Missing packages are skipped, not installed. A directory whose
 * resources fail to load gets none, with a warning, as Pi skips a resource it cannot load.
 */
function resourcesOf(cwd: string, trusted: boolean): Promise<Resources> {
	const key = `${trusted}:${cwd}`;
	let found = resources.get(key);
	if (found === undefined) {
		found = (async () => {
			const agentDir = getAgentDir();
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
			const resolved = await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve(async () => "skip");
			const skillPaths = resolved.skills.filter(({ enabled }) => enabled).map(skillPath);
			return {
				context: loadProjectContextFiles({ cwd, agentDir }),
				skills: loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false }).skills,
			};
		})().catch((error: unknown) => {
			process.stderr.write(
				`warning: ${cwd}: ${error instanceof Error ? error.message : String(error)}; no project instructions or skills\n`,
			);
			return { context: [], skills: [] };
		});
		resources.set(key, found);
	}
	return found;
}

/** The path that Pi loads a resolved skill from: the `SKILL.md` of a discovered or packaged skill directory. */
function skillPath(resource: {
	readonly path: string;
	readonly metadata: { readonly source: string; readonly origin: string };
}): string {
	if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") return resource.path;
	const file = join(resource.path, "SKILL.md");
	try {
		return statSync(resource.path).isDirectory() && existsSync(file) ? file : resource.path;
	} catch {
		return resource.path;
	}
}

const cwdOf = (input: PromptInput): string | undefined => input.env?.cwd ?? input.agent.cwd;

/** The resources of the conversation's directory, with the trust decided at its creation. */
async function inputResources(input: PromptInput, context: Context): Promise<Resources | undefined> {
	const cwd = cwdOf(input);
	if (cwd === undefined) return undefined;
	const trust = await input.read.snapshot(Trust, input.conversationId, context);
	return resourcesOf(cwd, trust?.trusted ?? false);
}

/** The tools and sections that children get; a conversation selects it by default. */
export const ChildContext = defineExtension({
	name: "pi-subagent-context",
	tools: [
		createReadTool(),
		piTool(createGrepTool),
		piTool(createFindTool),
		piTool(createLsTool),
		createWriteTool(),
		createEditTool(),
		createBashTool(),
	],
	sections: [
		section("project_context", async (input, context) => {
			const files = (await inputResources(input, context))?.context ?? [];
			if (files.length === 0) return undefined;
			return [
				"Project-specific instructions and guidelines:",
				...files.map(
					({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
				),
			].join("\n\n");
		}),
		section("skills", async (input, context) => {
			// As in Pi, skills need a tool that reads their files, and the hint names the first one offered.
			const offered = input.agent.tools.map(({ name }) => name);
			const callable = input.agent.callable.map(({ name }) => name);
			const reader =
				(["read", "bash"] as const).find((name) => offered.includes(name)) ??
				(callable.includes("read") || callable.includes("bash") ? "indirect" : undefined);
			if (reader === undefined) return undefined;
			const skills = (await inputResources(input, context))?.skills ?? [];
			return formatSkillsForPrompt(skills, reader).trim() || undefined;
		}),
		section("cwd", (input) => cwdOf(input)?.replace(/\\/g, "/")),
	],
});
