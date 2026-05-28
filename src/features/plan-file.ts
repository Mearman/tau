/**
 * Plan file management — create, resolve, read, and write plan files.
 *
 * Plan files live at `.pi/plans/<slug>.md` relative to the working directory.
 * The slug is derived from the session ID for unique identification.
 *
 * During plan mode, only the plan file and task tree are writable.
 * This module provides the path resolution and I/O for plan files.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ─── Plan file location ────────────────────────────────────────────

/** Directory for plan files, relative to cwd */
const PLANS_DIR = ".pi/plans";

/**
 * Derive a filesystem-safe slug from a session ID.
 *
 * Session IDs are UUIDs like "a1b2c3d4-e5f6-7890-abcd-ef1234567890".
 * We use the first segment as the slug for brevity.
 */
export function sessionSlug(sessionId: string): string {
    // Take the first segment of the UUID for a short, unique slug
    const segment = sessionId.split("-")[0];
    return segment ?? sessionId.slice(0, 8);
}

/**
 * Get the plan file directory path (absolute).
 */
export function getPlansDir(cwd: string): string {
    return resolve(cwd, PLANS_DIR);
}

/**
 * Get the absolute path to a plan file.
 *
 * If `slug` is provided, uses it directly. Otherwise derives from `sessionId`.
 * The file is `<plans-dir>/<slug>.md`.
 */
export function getPlanFilePath(cwd: string, slug: string): string {
    return join(getPlansDir(cwd), `${slug}.md`);
}

/**
 * Ensure the plans directory exists, creating it if needed.
 * Returns the directory path.
 */
export function ensurePlansDir(cwd: string): string {
    const dir = getPlansDir(cwd);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * Create a new plan file with frontmatter template.
 *
 * Returns the absolute path to the created file.
 * If the file already exists, returns its path without modifying it.
 */
export function createPlanFile(
    cwd: string,
    slug: string,
    title?: string
): string {
    const filePath = getPlanFilePath(cwd, slug);
    ensurePlansDir(cwd);

    if (!existsSync(filePath)) {
        const template = buildPlanTemplate(slug, title);
        writeFileSync(filePath, template, "utf-8");
    }

    return filePath;
}

/**
 * Read the plan file content. Returns undefined if the file doesn't exist.
 */
export function readPlanFile(cwd: string, slug: string): string | undefined {
    const filePath = getPlanFilePath(cwd, slug);
    if (!existsSync(filePath)) return undefined;
    return readFileSync(filePath, "utf-8");
}

/**
 * Write content to the plan file. Creates the directory if needed.
 */
export function writePlanFile(
    cwd: string,
    slug: string,
    content: string
): void {
    ensurePlansDir(cwd);
    const filePath = getPlanFilePath(cwd, slug);
    writeFileSync(filePath, content, "utf-8");
}

/**
 * Check whether a given path is the plan file for the current session.
 * Used by the permission system to allow writes to the plan file during plan mode.
 */
export function isPlanFilePath(
    path: string,
    cwd: string,
    slug: string
): boolean {
    const planPath = resolve(getPlanFilePath(cwd, slug));
    const resolvedPath = resolve(path);
    return resolvedPath === planPath;
}

/**
 * Check whether a given path is inside the plans directory.
 * Less strict than `isPlanFilePath` — used for general plan directory access.
 */
export function isInPlansDir(path: string, cwd: string): boolean {
    const plansDir = resolve(getPlansDir(cwd));
    const resolvedPath = resolve(dirname(path));
    return resolvedPath.startsWith(plansDir);
}

// ─── Plan file template ─────────────────────────────────────────────

function buildPlanTemplate(slug: string, title?: string): string {
    const planTitle = title ?? `Plan ${slug}`;
    return `# ${planTitle}

## Context

<!-- Why this change is needed, what prompted it, intended outcome -->

## Approach

<!-- Recommended implementation strategy -->

## Files

<!-- Paths to modify, with what changes -->

## Reuse

<!-- Existing functions/utilities to reuse, with file paths -->

## Verification

<!-- How to test the changes end-to-end -->
`;
}
