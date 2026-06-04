/**
 * Plan file management — create, resolve, read, and write plan files.
 *
 * Plan files live at `{sessionDir}/plans/{timestamp}-{name}.md` where
 * `{sessionDir}` is the session manager directory for the current project
 * (e.g. `~/.pi/agent/sessions/--Users-joe-project--/`) and `{name}` is a
 * filesystem-safe version of the plan title.
 *
 * During plan mode, only the plan file and task tree are writable.
 * This module provides the path resolution and I/O for plan files.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ─── Plan file location ────────────────────────────────────────────

/** Subdirectory for plan files within a session directory */
const PLANS_SUBDIR = "plans";

/**
 * Create a filesystem-safe name from a plan title.
 * Lowercases, replaces non-alphanumeric sequences with hyphens, trims.
 */
export function slugifyTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64);
}

/**
 * Generate a plan ID (filename stem) from a title.
 * Format: `{ISO-date}-{slugified-title}`.
 * If the title produces an empty slug, the date alone is used.
 */
export function planIdFromTitle(title: string): string {
    const now = new Date();
    const ts = now
        .toISOString()
        .replace(/:/g, "-")
        .replace(/\.\d+Z$/, "");
    const slug = slugifyTitle(title);
    return slug ? `${ts}-${slug}` : ts;
}

/**
 * Derive a plan ID from a session ID (fallback when no title is available).
 * Uses the first UUID segment prefixed with a timestamp.
 */
export function planIdFromSession(sessionId: string): string {
    const segment = sessionId.split("-")[0] ?? sessionId.slice(0, 8);
    const now = new Date();
    const ts = now
        .toISOString()
        .replace(/:/g, "-")
        .replace(/\.\d+Z$/, "");
    return `${ts}-${segment}`;
}

/**
 * Get the plan file directory path (absolute).
 * Lives at `{sessionDir}/plans/`.
 */
export function getPlansDir(sessionDir: string): string {
    return join(sessionDir, PLANS_SUBDIR);
}

/**
 * Get the absolute path to a plan file.
 * The file is `{sessionDir}/plans/{planId}.md`.
 */
export function getPlanFilePath(sessionDir: string, planId: string): string {
    return join(getPlansDir(sessionDir), `${planId}.md`);
}

/**
 * Ensure the plans directory exists, creating it if needed.
 * Returns the directory path.
 */
export function ensurePlansDir(sessionDir: string): string {
    const dir = getPlansDir(sessionDir);
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
    sessionDir: string,
    planId: string,
    title?: string
): string {
    const filePath = getPlanFilePath(sessionDir, planId);
    ensurePlansDir(sessionDir);

    if (!existsSync(filePath)) {
        const template = buildPlanTemplate(planId, title);
        writeFileSync(filePath, template, "utf-8");
    }

    return filePath;
}

/**
 * Read the plan file content. Returns undefined if the file doesn't exist.
 */
export function readPlanFile(
    sessionDir: string,
    planId: string
): string | undefined {
    const filePath = getPlanFilePath(sessionDir, planId);
    if (!existsSync(filePath)) return undefined;
    return readFileSync(filePath, "utf-8");
}

/**
 * Write content to the plan file. Creates the directory if needed.
 */
export function writePlanFile(
    sessionDir: string,
    planId: string,
    content: string
): void {
    ensurePlansDir(sessionDir);
    const filePath = getPlanFilePath(sessionDir, planId);
    writeFileSync(filePath, content, "utf-8");
}

/**
 * Check whether a given path is the plan file for the current session.
 * Used by the permission system to allow writes to the plan file during plan mode.
 */
export function isPlanFilePath(
    path: string,
    sessionDir: string,
    planId: string
): boolean {
    const planPath = resolve(getPlanFilePath(sessionDir, planId));
    const resolvedPath = resolve(path);
    return resolvedPath === planPath;
}

/**
 * Check whether a given path is inside the plans directory.
 * Less strict than `isPlanFilePath` — used for general plan directory access.
 */
export function isInPlansDir(path: string, sessionDir: string): boolean {
    const plansDir = resolve(getPlansDir(sessionDir));
    const resolvedPath = resolve(dirname(path));
    return resolvedPath.startsWith(plansDir);
}

// ─── Plan file template ─────────────────────────────────────────────

function buildPlanTemplate(planId: string, title?: string): string {
    const planTitle = title ?? `Plan ${planId}`;
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
