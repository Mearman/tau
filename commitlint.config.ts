import type { UserConfig } from "@commitlint/types";

const config: UserConfig = {
    extends: ["@commitlint/config-conventional"],
    rules: {
        "scope-enum": [
            2,
            "always",
            [
                "bash",
                "bg",
                "jobs",
                "notify",
                "status",
                "titlebar",
                "loop",
                "plan",
                "task",
                "todo",
                "ui",
                "build",
                "release",
                "ci",
                "deps",
                "permissions",
                "workflow",
                "goal",
                "context-files",
                "web-browse",
                "web-search",
            ],
        ],
    },
};

export default config;
