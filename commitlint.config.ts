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
            ],
        ],
    },
};

export default config;
