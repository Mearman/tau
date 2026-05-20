/**
 * CDP (Chrome DevTools Protocol) connection manager for the web-browse extension.
 *
 * Connects to a running Chrome instance via CDP. Supports two startup modes:
 *   - Classic: Chrome started with --remote-debugging-port
 *   - Approval mode: Chrome with --enable-features=DevToolsAcceptDebuggingConnections
 *     and devtools.remote_debugging.user-enabled pref set via chrome://inspect.
 *     Each new connection requires user approval in Chrome.
 *
 * Multi-profile: Chrome profiles appear as separate browser contexts in CDP.
 * Tab listing includes profile names resolved from Chrome's Local State.
 * New tabs can be opened in a specific profile by name.
 *
 * Discovery reads the DevToolsActivePort file first (avoids HTTP probing that
 * would trigger approval-mode prompts), then falls back to port probing.
 *
 * The Playwright connection persists across tool calls within a session.
 * Chrome is never closed by this module — only the Playwright connection is dropped.
 */

import type { Browser, Page } from "playwright-core";

// Dynamic import — playwright-core is an optional dependency
let chromium: typeof import("playwright-core").chromium | undefined;
async function getChromium(): Promise<
    typeof import("playwright-core").chromium
> {
    if (chromium) return chromium;
    try {
        const pw = await import("playwright-core");
        chromium = pw.chromium;
        return chromium;
    } catch {
        throw new Error(
            "playwright-core is not installed. Install it with:\n" +
                "  cd ~/.pi/agent/extensions/tau && pnpm add playwright-core"
        );
    }
}
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_CDP_PORTS = [9222, 9229, 9333];
const PROBE_TIMEOUT_MS = 3_000;

/** Chrome user data directory on macOS. */
const CHROME_USER_DATA_DIR = join(
    homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome"
);

/** File written by Chrome containing the active CDP port and WebSocket path. */
const DEVTOOLS_ACTIVE_PORT_FILE = join(
    CHROME_USER_DATA_DIR,
    "DevToolsActivePort"
);

/** Chrome's Local State file containing profile metadata. */
const LOCAL_STATE_FILE = join(CHROME_USER_DATA_DIR, "Local State");

export interface TabInfo {
    /** Numeric ID for use as tabId in other tools. */
    id: number;
    /** Page title. */
    title: string;
    /** Page URL. */
    url: string;
    /** Chrome profile name (e.g. "Personal", "ExaDev"). */
    profile: string;
    /** Whether this tab is the active tab in its window. */
    active: boolean;
}

let cdpBrowser: Browser | null = null;
let cdpPort: number | null = null;
let cdpWsUrl: string | null = null;
/** Ordered list of pages, indexed by TabInfo.id. */
let tabPages: Page[] = [];
/** Map from Playwright page to profile name. */
let pageProfiles: Map<Page, string> = new Map();
/** Cached profile directory → name mapping from Local State. */
const profileNames: Map<string, string> = new Map();

// ── Profile resolution ──────────────────────────────────────────────

/**
 * Read Chrome's Local State to build a profile directory → name mapping.
 * Caches the result for the session.
 */
function loadProfileNames(): Map<string, string> {
    if (profileNames.size > 0) return profileNames;

    try {
        if (!existsSync(LOCAL_STATE_FILE)) return profileNames;
        const content = readFileSync(LOCAL_STATE_FILE, "utf-8");
        const state = JSON.parse(content) as {
            profile?: {
                info_cache?: Record<string, { name?: string }>;
                last_used?: string;
            };
        };
        const infoCache = state.profile?.info_cache ?? {};
        for (const [dirName, info] of Object.entries(infoCache)) {
            if (info.name) {
                profileNames.set(dirName, info.name);
            }
        }
    } catch {
        // Local State may not exist or be parseable — profile names will be "Default"
    }
    return profileNames;
}

// ── Discovery ────────────────────────────────────────────────────────

/**
 * Read the DevToolsActivePort file written by Chrome into the user data dir.
 * Returns the port number, or null if the file doesn't exist or is invalid.
 *
 * This is the preferred discovery method — it avoids HTTP probing which would
 * trigger an approval-mode prompt for each new connection.
 */
function readDevToolsActivePort(): { port: number; wsPath: string } | null {
    try {
        if (!existsSync(DEVTOOLS_ACTIVE_PORT_FILE)) return null;
        const content = readFileSync(DEVTOOLS_ACTIVE_PORT_FILE, "utf-8");
        const lines = content
            .split("\n")
            .filter((l: string) => l.trim() !== "");
        if (lines.length === 0) return null;
        const port = parseInt(lines[0], 10);
        if (Number.isNaN(port) || port < 0 || port > 65535) return null;
        const wsPath = lines.length > 1 ? lines[1].trim() : "";
        return { port, wsPath };
    } catch {
        return null;
    }
}

/** Probe a single port for a Chrome CDP endpoint. */
async function probePort(port: number, signal?: AbortSignal): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        if (signal) signal.addEventListener("abort", () => controller.abort());

        const response = await fetch(`http://localhost:${port}/json/version`, {
            signal: controller.signal,
        });
        clearTimeout(timeout);
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Discover a running Chrome CDP endpoint.
 * Reads the DevToolsActivePort file first (no network probing needed),
 * then falls back to probing common ports.
 * Returns the port number if found, or null.
 */
export async function discover(signal?: AbortSignal): Promise<number | null> {
    // Prefer the DevToolsActivePort file — avoids HTTP probing which triggers
    // approval-mode prompts in Chrome.
    const portInfo = readDevToolsActivePort();
    if (portInfo !== null) {
        // Cache the WS URL for later use (approval mode doesn't serve /json/version)
        if (portInfo.wsPath) {
            cdpWsUrl = `ws://127.0.0.1:${portInfo.port}${portInfo.wsPath}`;
        }
        return portInfo.port;
    }

    // Fallback: probe common ports (only for classic --remote-debugging-port mode,
    // where HTTP connections don't require approval).
    for (const port of DEFAULT_CDP_PORTS) {
        if (await probePort(port, signal)) return port;
    }
    return null;
}

// ── Connection ───────────────────────────────────────────────────────

/**
 * Ensure a CDP connection is established. Connects lazily on first call,
 * and reconnects if the previous connection is dead.
 *
 * Uses the WebSocket URL from DevToolsActivePort when available
 * (required for approval mode, which doesn't serve /json/version).
 *
 * @throws Error if no CDP endpoint is found.
 */
export async function ensureConnected(
    port?: number,
    signal?: AbortSignal
): Promise<void> {
    // Check if existing connection is still alive
    if (cdpBrowser) {
        try {
            cdpBrowser.contexts();
            return;
        } catch {
            // Connection is dead — discard and reconnect
            cdpBrowser = null;
            tabPages = [];
            pageProfiles = new Map();
            cdpPort = null;
            cdpWsUrl = null;
        }
    }

    const targetPort = port ?? (await discover(signal));
    if (targetPort === null) {
        throw new Error(
            "No Chrome CDP endpoint found. Enable remote debugging in Chrome:\n" +
                "\n" +
                "Option 1 — Approval mode (recommended, keeps your session):\n" +
                "  1. Set enterprise policy: defaults write com.google.Chrome DevToolsRemoteDebuggingAllowed -bool true\n" +
                '  2. Relaunch Chrome: open -a "Google Chrome" --args --enable-features=DevToolsAcceptDebuggingConnections\n' +
                "  3. Go to chrome://inspect and enable remote debugging\n" +
                "  4. Approve the connection when prompted\n" +
                "\n" +
                "Option 2 — Classic mode (requires dedicated profile):\n" +
                '  open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=$HOME/.chrome-debug\n' +
                "\n" +
                'Alternatively, use browser: "applescript" for read-only access without CDP setup.'
        );
    }

    cdpPort = targetPort;

    // Prefer the cached WS URL (approval mode doesn't serve /json/version over HTTP)
    const connectUrl = cdpWsUrl ?? `http://localhost:${targetPort}`;
    const pw = await getChromium();
    cdpBrowser = await pw.connectOverCDP(connectUrl);

    // Load profile names for tab listing
    loadProfileNames();

    refreshTabPages();
}

/** Rebuild the tab page index from the current browser state. */
function refreshTabPages(): void {
    tabPages = [];
    pageProfiles = new Map();
    if (!cdpBrowser) return;

    // Build a mapping of browser context index → profile name
    // by using CDP's Target.getBrowserContexts + Local State
    const contexts = cdpBrowser.contexts();

    // The first context is usually the default/active profile.
    // Additional contexts correspond to other Chrome profiles opened
    // via --profile-directory or Chrome's profile switcher.
    //
    // We can't reliably map context index to profile directory from
    // Playwright alone, so we tag pages with context index and
    // resolve profile names using the pages' cookies/storage or
    // just label them by context order.
    //
    // For now: tag each page with its context's index-based profile label.
    for (let ctxIdx = 0; ctxIdx < contexts.length; ctxIdx++) {
        const context = contexts[ctxIdx];
        const pages = context.pages();
        const profileName = "Default";

        // Try to detect the profile from the first page in this context.
        // Chrome associates pages with profiles; we can read the profile
        // directory from Chrome's internal state, but Playwright doesn't
        // expose this. Instead, we use heuristics:
        // - If a page has chrome-extension URLs, check the extension's
        //   profile-specific path.
        // - Otherwise, label by context index.
        //
        // The most reliable approach: use CDP Target.getTargets and
        // match browserContextId to profile directories.

        for (const page of pages) {
            pageProfiles.set(page, profileName);
            tabPages.push(page);
        }
    }
}

// ── Tab listing ──────────────────────────────────────────────────────

/**
 * List all open tabs across all browser contexts/profiles.
 * Returns an ordered array with numeric IDs matching the tab index.
 * Includes profile names resolved from Chrome's Local State.
 */
export async function listTabs(signal?: AbortSignal): Promise<TabInfo[]> {
    await ensureConnected(undefined, signal);
    refreshTabPages();

    // Resolve profile names using CDP Target.getTargets + Local State
    const profileMap = await resolveBrowserContextProfiles();

    const tabs: TabInfo[] = [];

    for (let i = 0; i < tabPages.length; i++) {
        const page: Page = tabPages[i];
        // These are initialised as fallbacks and overwritten in the try block.
        // The linter sees the initial assignment as useless, but removing it
        // would narrow the type to string | undefined after the catch.
        let pageTitle: string | undefined;
        let pageUrl: string | undefined;
        let pageProfile: string | undefined;
        try {
            pageTitle = await page.title();
            pageUrl = page.url();
            pageProfile = profileMap.get(page) ?? "Default";
        } catch {
            // Page may have been closed between refresh and query
            continue;
        }

        tabs.push({
            id: i,
            title: pageTitle ?? "",
            url: pageUrl ?? "",
            profile: pageProfile ?? "Default",
            active: false, // Active-tab detection over CDP is unreliable
        });
    }

    return tabs;
}

/**
 * Resolve each Playwright page to its Chrome profile name by querying
 * CDP for browser context IDs and matching them against Chrome's profile dirs.
 */
async function resolveBrowserContextProfiles(): Promise<Map<Page, string>> {
    const result = new Map<Page, string>();
    if (!cdpBrowser) return result;

    try {
        // Get the CDP session from any page to query targets
        const contexts = cdpBrowser.contexts();
        if (contexts.length === 0) return result;

        // Find a page with a CDP session
        let cdpSession: import("playwright-core").CDPSession | null = null;
        for (const ctx of contexts) {
            for (const page of ctx.pages()) {
                try {
                    cdpSession = await page.context().newCDPSession(page);
                    break;
                } catch {
                    continue;
                }
            }
            if (cdpSession) break;
        }

        if (!cdpSession) return result;

        // Get all targets with their browser context IDs
        await cdpSession.send("Target.getTargets");

        // Get browser contexts
        const contextsResp = await cdpSession.send("Target.getBrowserContexts");
        const contextIds =
            (
                contextsResp as {
                    browserContextIds?: string[];
                    defaultBrowserContextId?: string;
                }
            ).browserContextIds ?? [];

        // Map browser context ID → profile name
        // The default context corresponds to the last-used profile.
        // Additional contexts correspond to other profiles opened via --profile-directory.
        const profiles = loadProfileNames();
        const lastUsedProfile = getLastUsedProfile();

        // Build contextId → profile name mapping
        const contextToProfile = new Map<string, string>();
        const defaultCtxId = (
            contextsResp as { defaultBrowserContextId?: string }
        ).defaultBrowserContextId;

        if (defaultCtxId) {
            contextToProfile.set(defaultCtxId, lastUsedProfile);
        }

        // Assign remaining contexts to profiles not yet assigned
        const usedProfiles = new Set([lastUsedProfile]);
        const unassignedContextIds = contextIds.filter(
            (id) => !contextToProfile.has(id)
        );

        for (const ctxId of unassignedContextIds) {
            // Try to find a profile name not yet assigned
            for (const [_dirName, name] of profiles) {
                if (!usedProfiles.has(name)) {
                    contextToProfile.set(ctxId, name);
                    usedProfiles.add(name);
                    break;
                }
            }
        }

        // Map each Playwright page to a profile via its target's browserContextId
        const pageTargetIds = new Map<Page, string>();
        for (const ctx of contexts) {
            for (const page of ctx.pages()) {
                try {
                    const pageSession = await page
                        .context()
                        .newCDPSession(page);
                    const targetInfo = await pageSession.send(
                        "Target.getTargetInfo"
                    );
                    const bcId = (
                        targetInfo as {
                            targetInfo?: { browserContextId?: string };
                        }
                    ).targetInfo?.browserContextId;
                    if (bcId) {
                        pageTargetIds.set(page, bcId);
                    }
                } catch {
                    // Page may not support CDP session
                }
            }
        }

        // Resolve page → profile name
        for (const [page, bcId] of pageTargetIds) {
            const profile = contextToProfile.get(bcId) ?? "Default";
            result.set(page, profile);
        }

        // Detach sessions
        try {
            await cdpSession.detach();
        } catch {
            // Session may already be closed
        }
    } catch {
        // If CDP queries fail, fall back to default profile names
    }

    return result;
}

/**
 * Get the name of the last-used Chrome profile from Local State.
 */
function getLastUsedProfile(): string {
    const profiles = loadProfileNames();
    const lastUsedDir = readLastUsedProfileDir();
    return profiles.get(lastUsedDir) ?? "Default";
}

/**
 * Read the last-used profile directory from Chrome's Local State.
 */
function readLastUsedProfileDir(): string {
    try {
        if (!existsSync(LOCAL_STATE_FILE)) return "Default";
        const content = readFileSync(LOCAL_STATE_FILE, "utf-8");
        const state = JSON.parse(content) as {
            profile?: { last_used?: string };
        };
        return state.profile?.last_used ?? "Default";
    } catch {
        return "Default";
    }
}

// ── Page access ──────────────────────────────────────────────────────

/**
 * Get a Playwright Page object by tab ID (from chrome_list output).
 * Refreshes the tab index if the ID is out of date.
 *
 * @throws Error if the tab ID is not found.
 */
export async function getPage(
    tabId: number,
    signal?: AbortSignal
): Promise<Page> {
    await ensureConnected(undefined, signal);

    // Try the cached index first
    if (tabId >= 0 && tabId < tabPages.length) {
        const page: Page = tabPages[tabId];
        try {
            // Verify the page is still alive
            await page.title();
            return page;
        } catch {
            // Page was closed — refresh
        }
    }

    // Refresh and try again
    refreshTabPages();

    if (tabId < 0 || tabId >= tabPages.length) {
        throw new Error(
            `Tab ID ${tabId} not found. Call chrome_list to see available tabs.`
        );
    }
    return tabPages[tabId];
}

/**
 * Create a new tab in the CDP-connected browser and return its Page.
 * If a profile name is given, opens the tab in that profile's context.
 * Otherwise, uses the default context.
 */
export async function newPage(
    signal?: AbortSignal,
    profileName?: string
): Promise<Page> {
    await ensureConnected(undefined, signal);

    const contexts = cdpBrowser!.contexts();

    // If a specific profile is requested, find its context
    if (profileName) {
        const profileMap = await resolveBrowserContextProfiles();
        for (const ctx of contexts) {
            const pages = ctx.pages();
            if (pages.length === 0) continue;
            // Check if any page in this context belongs to the requested profile
            for (const page of pages) {
                if (profileMap.get(page) === profileName) {
                    const newPage = await ctx.newPage();
                    refreshTabPages();
                    return newPage;
                }
            }
        }
        // Profile context not found — fall through to default
    }

    // Default: use the first context
    const context = contexts[0] ?? cdpBrowser!.contexts()[0];
    const page = await context.newPage();
    refreshTabPages();
    return page;
}

/**
 * Open a Chrome window in a specific profile.
 * Uses the macOS `open` command with --profile-directory.
 * Returns the profile directory name used.
 */
export async function openProfileWindow(
    profileName: string,
    url?: string
): Promise<string> {
    const profiles = loadProfileNames();

    // Find the profile directory for the given name
    let profileDir: string | null = null;
    for (const [dirName, name] of profiles) {
        if (name === profileName) {
            profileDir = dirName;
            break;
        }
    }

    if (!profileDir) {
        throw new Error(
            `Chrome profile "${profileName}" not found. Available profiles: ${[...profiles.values()].join(", ")}`
        );
    }

    // Use macOS open command to launch a window in the specified profile
    const targetUrl = url ?? "about:blank";
    const { execSync } = await import("node:child_process");
    execSync(
        `open -na "Google Chrome" --args --profile-directory="${profileDir}" "${targetUrl}"`,
        { timeout: 10_000 }
    );

    return profileDir;
}

// ── Lifecycle ────────────────────────────────────────────────────────

/**
 * Drop the CDP connection without closing Chrome.
 * Call this on session shutdown to clean up.
 */
export function disconnect(): void {
    // Do NOT call cdpBrowser.close() — that sends Browser.close to Chrome,
    // which would quit the user's browser. Just drop our reference.
    cdpBrowser = null;
    tabPages = [];
    pageProfiles = new Map();
    cdpPort = null;
    cdpWsUrl = null;
}

/** Check if a CDP connection is currently active. */
export function isConnected(): boolean {
    if (!cdpBrowser) return false;
    try {
        cdpBrowser.contexts();
        return true;
    } catch {
        return false;
    }
}

/** Get the port of the active CDP connection, if any. */
export function getConnectedPort(): number | null {
    return cdpPort;
}

/** Get the list of available Chrome profile names from Local State. */
export function getAvailableProfiles(): string[] {
    const profiles = loadProfileNames();
    return [...profiles.values()];
}
