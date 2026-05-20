/**
 * AppleScript bridge for read-only Chrome access on macOS.
 *
 * Provides tab listing and text/JS extraction without requiring
 * --remote-debugging-port or any special Chrome setup.
 *
 * Limitations:
 * - No DOM interaction (click, fill, scroll)
 * - No screenshots
 * - JS execution requires Chrome's "Allow JavaScript from Apple Events" enabled
 *   (View → Developer → Allow JavaScript from Apple Events)
 * - macOS only
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const APPLESCRIPT_TIMEOUT = 10_000;

export interface AppleScriptTabInfo {
    /** Numeric ID for use as tabId in other tools. */
    id: number;
    /** Chrome window index (1-based, AppleScript convention). */
    windowIndex: number;
    /** Tab index within the window (1-based, AppleScript convention). */
    tabIndex: number;
    /** Page title. */
    title: string;
    /** Page URL. */
    url: string;
    /** Whether this is the active tab in its window. */
    active: boolean;
}

/** Stored mapping from flat tab ID → (windowIndex, tabIndex). */
let tabIdMap: Map<number, { windowIndex: number; tabIndex: number }> =
    new Map();

/**
 * Run an AppleScript string by writing it to a temp file first.
 * This avoids shell quoting issues with osascript -e.
 */
async function runAppleScript(script: string): Promise<string> {
    const tmpScript = join(tmpdir(), `pi_chrome_${Date.now()}.scpt`);
    writeFileSync(tmpScript, script);
    try {
        const { stdout } = await execFileAsync("osascript", [tmpScript], {
            timeout: APPLESCRIPT_TIMEOUT,
        });
        return stdout;
    } finally {
        try {
            unlinkSync(tmpScript);
        } catch {
            // Best-effort cleanup
        }
    }
}

// ── Availability ─────────────────────────────────────────────────────

/** Check if AppleScript can control Google Chrome. */
export async function isAvailable(): Promise<boolean> {
    try {
        await execFileAsync(
            "osascript",
            ["-e", 'tell application "Google Chrome" to get count of windows'],
            { timeout: APPLESCRIPT_TIMEOUT }
        );
        return true;
    } catch {
        return false;
    }
}

// ── Tab listing ──────────────────────────────────────────────────────

/**
 * List all open Chrome tabs across all windows.
 * Returns an ordered array with numeric IDs for use in other tools.
 */
export async function listTabs(): Promise<AppleScriptTabInfo[]> {
    const script = `
tell application "Google Chrome"
	set output to ""
	repeat with w from 1 to count of windows
		repeat with t from 1 to count of tabs of window w
			set tabTitle to name of tab t of window w
			set tabUrl to URL of tab t of window w
			set isActive to (t = active tab index of window w)
			set output to output & w & "||" & t & "||" & isActive & "||" & tabTitle & "||" & tabUrl & linefeed
		end repeat
	end repeat
	return output
end tell`;

    const stdout = await runAppleScript(script);

    // Reset the tab ID map
    tabIdMap = new Map();
    const tabs: AppleScriptTabInfo[] = [];
    let globalId = 0;

    for (const line of stdout.trim().split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("||");
        if (parts.length < 5) continue;

        const windowIndex = parseInt(parts[0], 10);
        const tabIndex = parseInt(parts[1], 10);
        const isActive = parts[2] === "true";
        // Title may contain "||" — rejoin everything between index 3 and the last part
        const url = parts[parts.length - 1];
        const title = parts.slice(3, parts.length - 1).join("||");

        tabIdMap.set(globalId, { windowIndex, tabIndex });
        tabs.push({
            id: globalId++,
            windowIndex,
            tabIndex,
            title,
            url,
            active: isActive,
        });
    }

    return tabs;
}

// ── Content extraction ───────────────────────────────────────────────

/** Get text content from a specific tab. */
export async function getTabText(tabId: number): Promise<string> {
    const mapping = tabIdMap.get(tabId);
    if (!mapping) {
        throw new Error(
            `Tab ID ${tabId} not found. Call chrome_list to refresh the tab index.`
        );
    }

    const { windowIndex, tabIndex } = mapping;

    // Get title and URL via AppleScript properties (doesn't require JS execution)
    const infoScript = `
tell application "Google Chrome"
	set tabTitle to name of tab ${tabIndex} of window ${windowIndex}
	set tabUrl to URL of tab ${tabIndex} of window ${windowIndex}
	return tabTitle & "||" & tabUrl
end tell`;

    const infoOut = await runAppleScript(infoScript);
    const infoParts = infoOut.trim().split("||");
    const title = infoParts[0] ?? "";
    const url = infoParts.slice(1).join("||");

    // Get text content via JavaScript execution in the tab
    // Escape double quotes and backslashes for AppleScript string embedding
    const jsExpression = "document.body.innerText";
    const escaped = jsExpression.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    const textScript = `
tell application "Google Chrome"
	execute tab ${tabIndex} of window ${windowIndex} javascript "${escaped}"
end tell`;

    let text: string;
    try {
        const textOut = await runAppleScript(textScript);
        text = textOut.trim();
    } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.includes("Allow JavaScript from Apple Events")) {
            throw new Error(
                "JavaScript execution in Chrome is disabled. " +
                    "Enable it in Chrome: View → Developer → Allow JavaScript from Apple Events. " +
                    "See https://support.google.com/chrome/?p=applescript",
                { cause: e }
            );
        }
        throw new Error(`Failed to get tab text: ${errMsg}`, { cause: e });
    }

    let output = `Title: ${title}\nURL: ${url}\n`;
    output += `\n---\n\n${text}`;
    return output;
}

/**
 * Execute JavaScript in a specific tab and return the result as a string.
 * The expression must evaluate to a serialisable value.
 *
 * Requires Chrome's "Allow JavaScript from Apple Events" to be enabled.
 */
export async function executeJS(
    tabId: number,
    expression: string
): Promise<string> {
    const mapping = tabIdMap.get(tabId);
    if (!mapping) {
        throw new Error(
            `Tab ID ${tabId} not found. Call chrome_list to refresh the tab index.`
        );
    }

    const { windowIndex, tabIndex } = mapping;

    // Escape double quotes and backslashes for AppleScript string embedding
    const escaped = expression.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    const script = `
tell application "Google Chrome"
	execute tab ${tabIndex} of window ${windowIndex} javascript "${escaped}"
end tell`;

    try {
        const stdout = await runAppleScript(script);
        return stdout.trim();
    } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.includes("Allow JavaScript from Apple Events")) {
            throw new Error(
                "JavaScript execution in Chrome is disabled. " +
                    "Enable it in Chrome: View → Developer → Allow JavaScript from Apple Events. " +
                    "See https://support.google.com/chrome/?p=applescript",
                { cause: e }
            );
        }
        throw new Error(`JavaScript execution failed: ${errMsg}`, { cause: e });
    }
}

/** Get the (windowIndex, tabIndex) mapping for a tab ID. */
export function getTabMapping(
    tabId: number
): { windowIndex: number; tabIndex: number } | undefined {
    return tabIdMap.get(tabId);
}
