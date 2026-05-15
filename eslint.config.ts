import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintPluginPrettier from "eslint-plugin-prettier";
import { configs } from "typescript-eslint";

export default defineConfig(
    { ignores: ["dist/", "node_modules/"] },

    // All TypeScript files — type-checked via tsconfig.json
    {
        files: ["**/*.ts"],
        extends: [
            eslint.configs.recommended,
            ...configs.recommendedTypeChecked,
        ],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: {
            prettier: eslintPluginPrettier,
        },
        rules: {
            "prettier/prettier": "error",
            // Extension handlers must be async (API contract) even when they don't await
            "@typescript-eslint/require-await": "off",
            // Underscore-prefixed params are intentional — API contract signatures
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
        },
    },

    eslintConfigPrettier
);
