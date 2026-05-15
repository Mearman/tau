/**
 * Lint-staged configuration for pi-tau.
 *
 * Prettier runs as an ESLint rule via eslint-plugin-prettier,
 * so eslint --fix handles both linting and formatting.
 */
export default {
    "*.ts": ["eslint --cache --fix"],
};
