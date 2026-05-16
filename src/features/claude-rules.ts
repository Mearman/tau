/**
 * Claude Rules feature — scans the project's .claude/rules/ folder for
 * rule files and lists them in the system prompt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function findMarkdownFiles(
    dir: string,
    basePath: string = ""
): string[] {
    const results: string[] = [];

    if (!fs.existsSync(dir)) {
        return results;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const relativePath = basePath
            ? `${basePath}/${entry.name}`
            : entry.name;

        if (entry.isDirectory()) {
            results.push(
                ...findMarkdownFiles(path.join(dir, entry.name), relativePath)
            );
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
            results.push(relativePath);
        }
    }

    return results;
}

export function registerClaudeRules(pi: ExtensionAPI): void {
    let ruleFiles: string[] = [];
    let rulesDir = "";

    pi.on("session_start", async (_event, ctx) => {
        rulesDir = path.join(ctx.cwd, ".claude", "rules");
        ruleFiles = findMarkdownFiles(rulesDir);

        if (ruleFiles.length > 0) {
            ctx.ui.notify(
                `Found ${ruleFiles.length} rule(s) in .claude/rules/`,
                "info"
            );
        }
    });

    pi.on("before_agent_start", async (event) => {
        if (ruleFiles.length === 0) {
            return;
        }

        const rulesList = ruleFiles
            .map((f) => `- .claude/rules/${f}`)
            .join("\n");

        return {
            systemPrompt:
                event.systemPrompt +
                `\n\n## Project Rules\n\nThe following project rules are available in .claude/rules/:\n\n${rulesList}\n\nWhen working on tasks related to these rules, use the read tool to load the relevant rule files for guidance.`,
        };
    });
}
