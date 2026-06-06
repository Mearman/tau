/**
 * Web Browse feature for tau — web browsing with multiple browser backends.
 *
 * Browser modes:
 *   - bridge     (Chrome extension, no prompts) — default for chrome_list
 *   - isolated   (fresh headless Chromium per call) — requires patchright, default for browse/screenshot/interact
 *   - cdp        (connect to running Chrome via DevTools Protocol)
 *   - applescript (read-only queries on macOS Chrome via AppleScript)
 *
 * The Pi Chrome Bridge extension (when installed) provides the best
 * experience: no approval prompts, no Chrome relaunch, per-profile
 * access.
 *
 * Tools:
 *   - chrome_list    List open Chrome tabs (bridge, CDP, or AppleScript)
 *   - web_browse     Fetch page text, Markdown, or structured JSON
 *   - web_screenshot Capture full-page or viewport screenshots
 *   - web_interact   Multi-step interaction (click, fill, scroll, etc.)
 *
 * Patchright (a patched Playwright fork that removes CDP-leak signals) is
 * an optional dependency — only needed for isolated and CDP modes. Bridge
 * and AppleScript modes work without it. When CloakBrowser is also
 * installed, the isolated mode uses its C++-patched Chromium binary for
 * source-level fingerprint resistance.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { domToMarkdown } from "./markdown.ts";
import { domToStructure } from "./structure.ts";

/** Types for DOM converter scripts injected into pages at runtime. */
declare global {
    interface Window {
        __domToMarkdown: () => string;
        __domToStructure: () => unknown;
    }
}

// Lazy-loaded patchright (optional dependency — patched Playwright fork
// that removes CDP-leak signals from the automation protocol handshake).
type PlaywrightBrowser = import("patchright").Browser;
type PlaywrightPage = import("patchright").Page;

let _patchright: typeof import("patchright") | undefined;
async function getPlaywright(): Promise<typeof import("patchright")> {
    if (_patchright) return _patchright;
    try {
        _patchright = await import("patchright");
        return _patchright;
    } catch {
        throw new Error(
            "patchright is not installed. Install it with:\n" +
                "  cd ~/.pi/agent/extensions/tau && pnpm add patchright\n" +
                "\nAlternatively, use browser: 'bridge' or browser: 'applescript' which don't require it."
        );
    }
}

// Lazy-loaded CloakBrowser (optional — provides a C++-patched Chromium
// binary with source-level fingerprint resistance). When available, the
// isolated browser mode uses its binary instead of vanilla Chromium,
// combining CloakBrowser's C++ stealth patches with Patchright's
// protocol-level patches.
//
// If CloakBrowser is not installed, it is installed automatically on
// first use of isolated mode. The npm package (~5 MB) and the stealth
// Chromium binary (~140 MB) are downloaded once and cached at
// ~/.cloakbrowser/.
let _cloakBinaryPath: string | undefined;
let _cloakInstallAttempted = false;

/** Resolve the tau extension root directory for running pnpm. */
function getExtensionDir(): string {
    // src/features/web-browse/index.ts → ../../.. = tau root
    return join(import.meta.dirname, "..", "..", "..");
}

/**
 * Install CloakBrowser via pnpm if it's not already importable.
 * Returns true if installation succeeded (or was already installed).
 */
async function ensureCloakBrowserInstalled(): Promise<boolean> {
    if (_cloakInstallAttempted) return _cloakBinaryPath !== undefined;
    _cloakInstallAttempted = true;

    // First check: is it already importable?
    try {
        const { ensureBinary } = await import("cloakbrowser");
        const path = await ensureBinary();
        if (typeof path === "string" && path) {
            _cloakBinaryPath = path;
            return true;
        }
    } catch {
        // Not installed — proceed to install
    }

    // Install the npm package
    const { execFileSync } = await import("node:child_process");
    const extDir = getExtensionDir();

    try {
        execFileSync("pnpm", ["add", "-O", "cloakbrowser@0.3.29"], {
            cwd: extDir,
            stdio: "pipe",
            timeout: 60_000,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
            `[tau] Failed to install CloakBrowser: ${msg}` +
                "\nFalling back to Patchright-only mode."
        );
        return false;
    }

    // Now import the freshly installed module and download the binary
    try {
        const { ensureBinary } = await import("cloakbrowser");
        const path = await ensureBinary();
        if (typeof path === "string" && path) {
            _cloakBinaryPath = path;
            return true;
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
            `[tau] CloakBrowser installed but binary download failed: ${msg}` +
                "\nFalling back to Patchright-only mode."
        );
    }

    return false;
}

async function getCloakBinaryPath(): Promise<string | undefined> {
    if (_cloakBinaryPath !== undefined) return _cloakBinaryPath;
    await ensureCloakBrowserInstalled();
    return _cloakBinaryPath;
}

let _cloakStealthArgs: string[] | undefined;

async function getCloakStealthArgs(): Promise<string[]> {
    if (_cloakStealthArgs) return _cloakStealthArgs;
    try {
        const { getDefaultStealthArgs } = await import("cloakbrowser");
        _cloakStealthArgs = getDefaultStealthArgs();
        return _cloakStealthArgs;
    } catch {
        return [];
    }
}

import {
    collectConsole,
    appendConsoleLog,
    type ConsoleCollector,
} from "./console-collector.ts";
import * as cdp from "./cdp.ts";
import * as applescript from "./applescript.ts";
import * as bridge from "./bridge.ts";
import { matchGitHubRepo, extractRepoStructure } from "./github-structure.ts";
import type { TauState } from "../../state.ts";
import { isFeatureEnabled } from "../features-helpers.ts";

// ── Constants ────────────────────────────────────────────────────────

const TIMEOUT = 30_000;
const VIEWPORT = { width: 1280, height: 720 } as const;
const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Page-side converter scripts. The arrow functions in markdown.ts and
// structure.ts are self-contained (no closures, no imports — see their
// file headers) and serialised to strings here so they can be injected
// into the page without depending on files on disk.
const MARKDOWN_INIT = `window.__domToMarkdown = ${domToMarkdown.toString()};`;
const STRUCTURE_INIT = `window.__domToStructure = ${domToStructure.toString()};`;

// ── Shared browser mode parameter ────────────────────────────────────

const BROWSER_PARAM = StringEnum(
    ["bridge", "isolated", "cdp", "applescript"] as const,
    {
        description:
            "Browser mode: 'bridge' (Chrome extension, no prompts), " +
            "'isolated' (fresh headless Chromium, default), " +
            "'cdp' (user's Chrome via DevTools Protocol — requires approval-mode or --remote-debugging-port), " +
            "'applescript' (read-only access to user's Chrome tabs on macOS — no setup required)",
        default: "isolated",
    }
);

const TAB_ID_PARAM = Type.Optional(
    Type.Number({
        description:
            "Tab ID from chrome_list output. Tab IDs are specific to the browser mode — " +
            "a tab ID from bridge mode will NOT work in CDP mode and vice versa. " +
            "Always use chrome_list with the same browser mode you plan to use for the subsequent operation. " +
            "Required for browser: 'cdp' and browser: 'applescript'.",
    })
);

const WAIT_UNTIL_PARAM = Type.Optional(
    StringEnum(["load", "domcontentloaded", "networkidle"] as const, {
        description:
            "Navigation wait strategy. Use 'networkidle' only for fully-rendered SPAs; 'domcontentloaded' (default) is faster and avoids timeouts on pages with persistent connections.",
        default: "domcontentloaded",
    })
);

const SESSION_PARAM = Type.Optional(
    StringEnum(["fresh"] as const, {
        description:
            "Session isolation hint. 'fresh' opens a new incognito window so " +
            "the call does not mutate the user's actual Chrome (cookies, history, " +
            "logins). The incognito window is closed when the call finishes. " +
            "Only honoured in browser: 'bridge' mode. In browser: 'isolated' mode " +
            "the browser is already fresh per call, so this is a no-op. " +
            "In browser: 'cdp' and 'applescript' modes it is rejected.",
    })
);

// ── Persistent isolated browser ────────────────────────────────────
//
// Instead of launching a fresh Chromium per call, the browser instance
// persists across calls within a session. Pages are created and closed
// per call, but the browser process stays alive for 60 seconds of
// inactivity before shutting down.

const BROWSER_IDLE_TIMEOUT_MS = 60_000;

let persistentBrowser: PlaywrightBrowser | undefined;
let browserIdleTimer: ReturnType<typeof setTimeout> | undefined;
let browserLaunching: Promise<PlaywrightBrowser> | undefined;

/** Get or launch the persistent isolated browser. Serialises concurrent launches. */
async function getBrowser(): Promise<PlaywrightBrowser> {
    // If a browser exists and is connected, reuse it
    if (persistentBrowser) {
        try {
            persistentBrowser.contexts(); // health check
            resetIdleTimer();
            return persistentBrowser;
        } catch {
            // Dead — discard
            persistentBrowser = undefined;
        }
    }

    // If a launch is already in flight, wait for it
    if (browserLaunching) {
        return browserLaunching;
    }

    // Launch a new browser
    browserLaunching = launchBrowser();
    try {
        persistentBrowser = await browserLaunching;
        resetIdleTimer();
        return persistentBrowser;
    } finally {
        browserLaunching = undefined;
    }
}

/** Reset the idle shutdown timer. Call on every browser use. */
function resetIdleTimer(): void {
    if (browserIdleTimer) clearTimeout(browserIdleTimer);
    browserIdleTimer = setTimeout(() => {
        if (persistentBrowser) {
            persistentBrowser.close().catch(() => {});
            persistentBrowser = undefined;
        }
        browserIdleTimer = undefined;
    }, BROWSER_IDLE_TIMEOUT_MS);
}

/** Shut down the persistent browser immediately (session shutdown). */
async function shutdownBrowser(): Promise<void> {
    if (browserIdleTimer) {
        clearTimeout(browserIdleTimer);
        browserIdleTimer = undefined;
    }
    if (persistentBrowser) {
        const b = persistentBrowser;
        persistentBrowser = undefined;
        await b.close().catch(() => {});
    }
}

async function launchBrowser(): Promise<PlaywrightBrowser> {
    const pw = await getPlaywright();
    const cloakPath = await getCloakBinaryPath();

    if (cloakPath) {
        // CloakBrowser binary + Patchright protocol patches: C++ fingerprint
        // resistance combined with a clean CDP handshake.
        const stealthArgs = await getCloakStealthArgs();
        return pw.chromium.launch({
            headless: true,
            executablePath: cloakPath,
            args: stealthArgs,
        });
    }

    // Patchright only — protocol-level patches, standard Chromium binary.
    return pw.chromium.launch({ headless: true });
}

async function createPage(browser: PlaywrightBrowser): Promise<PlaywrightPage> {
    const page = await browser.newPage({
        viewport: VIEWPORT,
        userAgent: USER_AGENT,
    });

    // Dismiss JS dialogs (alert, confirm, prompt) to prevent unhandled
    // ProtocolError from crashing the process. The default auto-accept
    // can race with the browser dismissing the dialog first.
    page.on("dialog", async (dialog) => {
        try {
            await dialog.dismiss();
        } catch {
            /* already dismissed */
        }
    });

    // navigator.webdriver shim — redundant when CloakBrowser's C++ patches
    // already hide it at the binary level. Kept as fallback for vanilla
    // Chromium via Patchright.
    if (!_cloakBinaryPath) {
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "webdriver", {
                get: () => false,
            });
        });
    }
    await page.addInitScript({ content: MARKDOWN_INIT });
    await page.addInitScript({ content: STRUCTURE_INIT });
    page.setDefaultTimeout(TIMEOUT);
    return page;
}

async function navigateTo(
    page: PlaywrightPage,
    url: string,
    waitUntil: "load" | "domcontentloaded" | "networkidle" = "domcontentloaded"
): Promise<void> {
    await page.goto(url, { waitUntil, timeout: TIMEOUT });
}

async function getPageText(page: PlaywrightPage): Promise<string> {
    const result = await page.evaluate(() => {
        const title = document.title;
        const url = window.location.href;
        const meta = document.querySelector('meta[name="description"]');
        const description = meta?.getAttribute("content") ?? "";

        const container =
            document.querySelector("main") ??
            document.querySelector("article") ??
            document.querySelector("#content") ??
            document.querySelector(".content") ??
            document.body;

        const text = container?.innerText ?? "";
        return { title, url, description, text };
    });

    let output = `Title: ${result.title}\nURL: ${result.url}\n`;
    if (result.description) output += `Description: ${result.description}\n`;
    output += `\n---\n\n${result.text}`;
    return output;
}

// ── CDP page helpers ─────────────────────────────────────────────────

/**
 * Ensure converter scripts are injected into an already-loaded page.
 * Idempotent — checks if converters are present before injecting.
 */
async function ensureConverters(page: PlaywrightPage): Promise<void> {
    const hasConverters: boolean = await page.evaluate(
        () => typeof window.__domToMarkdown === "function"
    );
    if (hasConverters) return;

    await page.addScriptTag({ content: MARKDOWN_INIT });
    await page.addScriptTag({ content: STRUCTURE_INIT });
}

/**
 * Resolve a Page object for CDP mode.
 * Returns a Playwright Page attached to the user's Chrome tab.
 */
async function resolveCDPPage(
    tabId: number | undefined,
    signal?: AbortSignal,
    profileName?: string
): Promise<PlaywrightPage> {
    if (tabId === undefined) {
        const page = await cdp.newPage(signal, profileName);
        await ensureConverters(page);
        return page;
    }
    const page = await cdp.getPage(tabId, signal);
    await ensureConverters(page);
    return page;
}

// ── Registration ─────────────────────────────────────────────────────

export function registerWebBrowse(pi: ExtensionAPI, state: TauState): void {
    // Clean up connections on session shutdown
    pi.on("session_shutdown", async () => {
        cdp.disconnect();
        bridge.disconnect();
        tabCache.clear();
        await shutdownBrowser();
    });

    // ── chrome_list TTL cache ────────────────────────────────────────
    const TAB_CACHE_TTL_MS = 30_000;
    const tabCache = new Map<
        string,
        {
            tabs: Array<
                | cdp.TabInfo
                | applescript.AppleScriptTabInfo
                | bridge.BridgeTabInfo
            >;
            fetchedAt: number;
        }
    >();

    // ── chrome_list ─────────────────────────────────────────────────
    pi.registerTool({
        name: "chrome_list",
        label: "Chrome List",
        description:
            "List all open Chrome tabs across all profiles. Returns tab IDs, titles, and URLs. " +
            "Use the tab IDs with web_browse, web_screenshot, or web_interact " +
            "(browser: 'cdp' or 'applescript').",
        promptSnippet: "List the user's open Chrome tabs",
        promptGuidelines: [
            "Use chrome_list to see what tabs the user has open before operating on a specific tab.",
            "Tab IDs are mode-specific — a tab ID from bridge mode will NOT work in CDP or applescript mode.",
            "Always call chrome_list with the same browser mode you will use for subsequent operations on those tabs.",
            "If you get 'Tab ID not found', you likely mixed modes. Re-list with the correct browser mode.",
        ],
        parameters: Type.Object({
            browser: Type.Optional(
                StringEnum(["bridge", "cdp", "applescript"] as const, {
                    description:
                        "Discovery mode: 'bridge' (Chrome extension, no prompts — default), 'cdp' (DevTools Protocol), " +
                        "'applescript' (AppleScript, read-only). Default: 'bridge'.",
                    default: "bridge",
                })
            ),
        }),
        async execute(_toolCallId, params, signal) {
            if (!isFeatureEnabled(state, "web-browse")) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Web browsing is disabled — run /tau to enable",
                        },
                    ],
                    details: undefined,
                };
            }
            const mode = params.browser ?? "bridge";
            let usedMode: string = "bridge";
            let tabs: Array<
                | cdp.TabInfo
                | applescript.AppleScriptTabInfo
                | bridge.BridgeTabInfo
            > = [];

            // Check TTL cache for this mode
            const cached = tabCache.get(mode);
            if (cached && Date.now() - cached.fetchedAt < TAB_CACHE_TTL_MS) {
                tabs = cached.tabs;
                usedMode = mode;
            } else if (mode === "bridge") {
                if (!(await bridge.isAvailable())) {
                    throw new Error(
                        "Pi Chrome Bridge is not available. Install the extension and native host:\n" +
                            "  1. Load ~/.pi/agent/extensions/tau/chrome-extension as unpacked extension in Chrome\n" +
                            "  2. Run: ~/.pi/agent/extensions/tau/install.sh\n" +
                            "  3. The native host starts automatically when Chrome connects"
                    );
                }
                tabs = await bridge.listTabs();
                usedMode = "bridge";
            } else if (mode === "cdp") {
                tabs = await cdp.listTabs(signal);
                usedMode = "cdp";
            } else if (mode === "applescript") {
                tabs = await applescript.listTabs();
                usedMode = "applescript";
            }

            // Update cache (only after a fresh fetch, not a cache hit)
            if (!cached || Date.now() - cached.fetchedAt >= TAB_CACHE_TTL_MS) {
                tabCache.set(mode, { tabs, fetchedAt: Date.now() });
            }

            if (tabs.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "No Chrome tabs found. Chrome may not be running.",
                        },
                    ],
                    details: {
                        mode: usedMode,
                        tabCount: 0,
                        tabs: [] as Array<
                            | cdp.TabInfo
                            | applescript.AppleScriptTabInfo
                            | bridge.BridgeTabInfo
                        >,
                        cdpAvailable: false,
                    },
                };
            }

            // Format tab list
            const lines: string[] = [`Chrome tabs (via ${usedMode}):\n`];

            const cdpTabs = tabs as Array<
                cdp.TabInfo | applescript.AppleScriptTabInfo
            >;
            const hasProfiles = cdpTabs.some(
                (t): t is cdp.TabInfo =>
                    "profile" in t && t.profile !== undefined
            );

            if (hasProfiles) {
                const byProfile = new Map<string, Array<cdp.TabInfo>>();
                for (const tab of cdpTabs) {
                    const profile = "profile" in tab ? tab.profile : "Default";
                    if (!byProfile.has(profile)) byProfile.set(profile, []);
                    byProfile.get(profile)!.push(tab as cdp.TabInfo);
                }

                for (const [profile, profileTabs] of byProfile) {
                    lines.push(`\n  [${profile}]`);
                    for (const tab of profileTabs) {
                        const active = tab.active ? " [active]" : "";
                        const truncatedTitle =
                            tab.title.length > 80
                                ? tab.title.slice(0, 77) + "..."
                                : tab.title;
                        const truncatedUrl =
                            tab.url.length > 100
                                ? tab.url.slice(0, 97) + "..."
                                : tab.url;
                        lines.push(
                            `    ${tab.id}. ${truncatedTitle}${active}\n       ${truncatedUrl}`
                        );
                    }
                }
            } else {
                for (const tab of tabs) {
                    const active = tab.active ? " [active]" : "";
                    const truncatedTitle =
                        tab.title.length > 80
                            ? tab.title.slice(0, 77) + "..."
                            : tab.title;
                    const truncatedUrl =
                        tab.url.length > 100
                            ? tab.url.slice(0, 97) + "..."
                            : tab.url;
                    lines.push(
                        `  ${tab.id}. ${truncatedTitle}${active}\n     ${truncatedUrl}`
                    );
                }
            }

            if (usedMode === "cdp" && cdp.isConnected()) {
                const availableProfiles = cdp.getAvailableProfiles();
                if (availableProfiles.length > 0) {
                    lines.push(
                        `\nAvailable profiles: ${availableProfiles.join(", ")}`
                    );
                }
            }

            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: {
                    mode: usedMode,
                    tabCount: tabs.length,
                    tabs,
                    cdpAvailable:
                        usedMode === "cdp" ? cdp.isConnected() : false,
                },
            };
        },
    });

    // ── web_browse ──────────────────────────────────────────────────
    pi.registerTool({
        name: "web_browse",
        label: "Web Browse",
        description:
            "Fetch a web page and return its content. Supports three output formats: " +
            "'text' (plain text from the page), 'markdown' (page converted to Markdown preserving " +
            "headings, links, lists, tables, code blocks), and 'structure' (structured JSON with " +
            "title, headings tree, sections, content blocks, and links). " +
            "Four browser modes: 'bridge' (Chrome extension, no prompts), 'isolated' (fresh headless Chromium, default), " +
            "'cdp' (user's Chrome via DevTools Protocol), 'applescript' (read-only macOS Chrome). " +
            "Use browser: 'cdp' with tabId to read a specific open tab. Use this instead of " +
            "curl/wget when pages need JavaScript to render.",
        promptSnippet: "Browse web pages to read online content",
        promptGuidelines: [
            "Use web_browse instead of bash with curl/wget when the page requires JavaScript rendering.",
            "Use 'markdown' format when you need structured content with headings, links, and tables.",
            "Use 'structure' format when you need machine-readable JSON data from the page.",
            "Tab IDs are mode-specific. If you got a tab ID from chrome_list with browser: 'bridge', " +
                "use browser: 'bridge' for the subsequent web_browse call — NOT 'cdp' or 'applescript'.",
            "Use browser: 'cdp' with tabId to read content from the user's open Chrome tabs (call chrome_list first to get tab IDs).",
            "Use browser: 'applescript' with tabId for read-only access to the user's Chrome without needing CDP setup.",
        ],
        parameters: Type.Object({
            url: Type.String({ description: "The URL to fetch" }),
            format: Type.Optional(
                StringEnum(["text", "markdown", "structure"] as const, {
                    description:
                        "Output format: 'text' for plain text, 'markdown' for Markdown conversion, 'structure' for structured JSON",
                    default: "text",
                })
            ),
            selector: Type.Optional(
                Type.String({
                    description:
                        "CSS selector to extract text from a specific region (only used with 'text' format)",
                })
            ),
            waitUntil: WAIT_UNTIL_PARAM,
            browser: Type.Optional(BROWSER_PARAM),
            tabId: TAB_ID_PARAM,
            session: SESSION_PARAM,
        }),
        async execute(_toolCallId, params, signal) {
            if (!isFeatureEnabled(state, "web-browse")) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Web browsing is disabled — run /tau to enable",
                        },
                    ],
                    details: undefined,
                };
            }
            const browserMode = params.browser ?? "isolated";
            const format = params.format ?? "text";
            const session = params.session;

            if (session === "fresh" && browserMode === "cdp") {
                throw new Error(
                    "session: 'fresh' is only supported in browser: 'bridge' mode. " +
                        "browser: 'cdp' operates on the user's existing Chrome tabs and cannot open an isolated window. " +
                        "Use browser: 'bridge' (default for the fresh session) or drop session: 'fresh'."
                );
            }
            if (session === "fresh" && browserMode === "applescript") {
                throw new Error(
                    "session: 'fresh' is only supported in browser: 'bridge' mode. " +
                        "browser: 'applescript' is read-only and operates on the user's existing Chrome tabs."
                );
            }

            // ── Bridge mode ──────────────────────────────────────────
            if (browserMode === "bridge") {
                if (!(await bridge.isAvailable())) {
                    throw new Error(
                        "Pi Chrome Bridge is not available. Ensure the Chrome extension is loaded and the native host is running."
                    );
                }

                let tabId = params.tabId;
                let socketPath: string | undefined;
                let incognitoWindowId: number | undefined;

                if (session === "fresh") {
                    // Open a new incognito window; any provided tabId is
                    // ignored — session: 'fresh' always uses a fresh tab.
                    const result = await bridge.newTabInIncognitoWindow(
                        params.url
                    );
                    tabId = result.tabInfo.id;
                    socketPath = result.socketPath;
                    incognitoWindowId = result.windowId;
                    await new Promise((r) => setTimeout(r, 3000));
                } else if (tabId === undefined) {
                    const newTabResult = await bridge.newTab(params.url);
                    tabId = newTabResult.tabInfo.id;
                    socketPath = newTabResult.socketPath;
                    await new Promise((r) => setTimeout(r, 3000));
                }

                try {
                    if (format === "text") {
                        const text = await bridge.getTabText(
                            tabId,
                            params.selector,
                            socketPath
                        );
                        return {
                            content: [{ type: "text", text }],
                            details: {
                                format: "text",
                                browser: "bridge",
                                tabId: tabId,
                                session,
                            },
                        };
                    }

                    if (format === "markdown") {
                        await bridge.injectConverters(tabId, socketPath);
                        const md = await bridge.evaluate(
                            tabId,
                            "window.__domToMarkdown()",
                            socketPath
                        );
                        return {
                            content: [{ type: "text", text: String(md) }],
                            details: {
                                format: "markdown",
                                browser: "bridge",
                                tabId: tabId,
                                session,
                            },
                        };
                    }

                    if (format === "structure") {
                        // GitHub-aware: shallow-clone repo instead of DOM walk
                        const gh = matchGitHubRepo(params.url);
                        if (gh) {
                            try {
                                const repoData = extractRepoStructure(
                                    gh.owner,
                                    gh.repo
                                );
                                return {
                                    content: [
                                        {
                                            type: "text",
                                            text: JSON.stringify(
                                                repoData,
                                                null,
                                                2
                                            ),
                                        },
                                    ],
                                    details: {
                                        format: "github-repo",
                                        browser: "bridge",
                                        tabId: tabId,
                                        session,
                                    },
                                };
                            } catch {
                                // Clone failed — fall through to DOM extraction
                            }
                        }

                        await bridge.injectConverters(tabId, socketPath);
                        const data = await bridge.evaluate(
                            tabId,
                            "JSON.stringify(window.__domToStructure())",
                            socketPath
                        );
                        return {
                            content: [{ type: "text", text: String(data) }],
                            details: {
                                format: "structure",
                                browser: "bridge",
                                tabId: tabId,
                                session,
                            },
                        };
                    }

                    throw new Error(`Unknown format: ${String(format)}`);
                } finally {
                    if (incognitoWindowId !== undefined) {
                        try {
                            await bridge.closeWindow(
                                incognitoWindowId,
                                socketPath
                            );
                        } catch {
                            // Best-effort cleanup — the original result
                            // (or error) is what the caller cares about.
                        }
                    }
                }
            }

            // ── AppleScript mode ───────────────────────────────────
            if (browserMode === "applescript") {
                if (params.tabId === undefined) {
                    throw new Error(
                        "tabId is required for browser: 'applescript'. Call chrome_list to see available tabs."
                    );
                }
                const text = await applescript.getTabText(params.tabId);
                return {
                    content: [{ type: "text", text }],
                    details: {
                        format,
                        browser: "applescript",
                        tabId: params.tabId ?? 0,
                        consoleErrors: 0,
                    },
                };
            }

            // ── CDP mode ────────────────────────────────────────────
            if (browserMode === "cdp") {
                const page = await resolveCDPPage(params.tabId, signal);
                const consoleCollector = collectConsole(page);

                if (params.url && params.url !== "about:blank") {
                    const currentUrl = page.url();
                    if (
                        currentUrl !== params.url &&
                        !currentUrl.startsWith(params.url)
                    ) {
                        await navigateTo(page, params.url, params.waitUntil);
                    }
                }

                if (signal?.aborted) throw new Error("Cancelled");

                return await extractPageContent(
                    page,
                    { ...params, format },
                    consoleCollector,
                    "cdp"
                );
            }

            // ── Isolated mode (default) ──────────────────────────────
            const browser = await getBrowser();
            let page: PlaywrightPage | undefined;
            try {
                page = await createPage(browser);
                const consoleCollector = collectConsole(page);
                await navigateTo(page, params.url, params.waitUntil);

                if (signal?.aborted) throw new Error("Cancelled");

                return await extractPageContent(
                    page,
                    { ...params, format },
                    consoleCollector,
                    "isolated"
                );
            } finally {
                if (page) await page.close().catch(() => {});
            }
        },
    });

    // ── web_screenshot ──────────────────────────────────────────────
    pi.registerTool({
        name: "web_screenshot",
        label: "Web Screenshot",
        description:
            "Capture a full-page or viewport screenshot of a web page. Returns the file path " +
            "to a PNG image. Use 'read' on the returned path to view the image. " +
            "Four browser modes: 'bridge' (Chrome extension), 'isolated' (fresh headless Chromium, default), " +
            "'cdp' (user's Chrome tab — requires tabId), 'applescript' (not supported for screenshots).",
        promptSnippet: "Capture screenshots of web pages",
        promptGuidelines: [
            "After capturing a screenshot, use the read tool on the returned file path to view it.",
            "Use browser: 'cdp' with tabId to screenshot a specific open Chrome tab.",
        ],
        parameters: Type.Object({
            url: Type.String({ description: "The URL to screenshot" }),
            outputPath: Type.Optional(
                Type.String({
                    description:
                        "File path for the PNG. Defaults to /tmp/screenshot-<timestamp>.png",
                })
            ),
            fullPage: Type.Optional(
                Type.Boolean({
                    description:
                        "Capture the entire scrollable page (default: true)",
                    default: true,
                })
            ),
            waitUntil: WAIT_UNTIL_PARAM,
            browser: Type.Optional(BROWSER_PARAM),
            tabId: TAB_ID_PARAM,
            session: SESSION_PARAM,
        }),
        async execute(_toolCallId, params, signal) {
            if (!isFeatureEnabled(state, "web-browse")) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Web browsing is disabled — run /tau to enable",
                        },
                    ],
                    details: undefined,
                };
            }
            const browserMode = params.browser ?? "isolated";
            const session = params.session;

            if (browserMode === "applescript") {
                throw new Error(
                    "Screenshots are not supported in AppleScript mode. Use browser: 'bridge', 'cdp', or 'isolated'."
                );
            }

            if (session === "fresh" && browserMode === "cdp") {
                throw new Error(
                    "session: 'fresh' is only supported in browser: 'bridge' mode. " +
                        "browser: 'cdp' operates on the user's existing Chrome tabs and cannot open an isolated window. " +
                        "Use browser: 'bridge' (default for the fresh session) or drop session: 'fresh'."
                );
            }

            // ── Bridge mode ──────────────────────────────────────────
            if (browserMode === "bridge") {
                if (!(await bridge.isAvailable())) {
                    throw new Error(
                        "Pi Chrome Bridge is not available. Ensure the Chrome extension is loaded and the native host is running."
                    );
                }

                let tabId = params.tabId;
                let socketPath: string | undefined;
                let incognitoWindowId: number | undefined;

                if (session === "fresh") {
                    // Open a new incognito window; any provided tabId is
                    // ignored — session: 'fresh' always uses a fresh tab.
                    const result = await bridge.newTabInIncognitoWindow(
                        params.url
                    );
                    tabId = result.tabInfo.id;
                    socketPath = result.socketPath;
                    incognitoWindowId = result.windowId;
                    await new Promise((r) => setTimeout(r, 3000));
                } else if (tabId === undefined) {
                    const newTabResult = await bridge.newTab(params.url);
                    tabId = newTabResult.tabInfo.id;
                    socketPath = newTabResult.socketPath;
                    await new Promise((r) => setTimeout(r, 3000));
                }

                try {
                    const path =
                        params.outputPath ??
                        join("/tmp", `screenshot-${Date.now()}.png`);

                    const base64Png = await bridge.screenshot(
                        tabId,
                        socketPath
                    );
                    const buffer = Buffer.from(base64Png, "base64");
                    const dir = path.substring(0, path.lastIndexOf("/"));
                    if (dir) mkdirSync(dir, { recursive: true });
                    writeFileSync(path, buffer);

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Screenshot saved to: ${path}`,
                            },
                        ],
                        details: {
                            path,
                            browser: "bridge",
                            tabId: tabId,
                            consoleErrors: 0,
                            url: params.url,
                            session,
                        },
                    };
                } finally {
                    if (incognitoWindowId !== undefined) {
                        try {
                            await bridge.closeWindow(
                                incognitoWindowId,
                                socketPath
                            );
                        } catch {
                            // Best-effort cleanup
                        }
                    }
                }
            }

            // ── CDP mode ────────────────────────────────────────────
            if (browserMode === "cdp") {
                const page = await resolveCDPPage(params.tabId, signal);

                if (params.url && params.url !== "about:blank") {
                    const currentUrl = page.url();
                    if (
                        currentUrl !== params.url &&
                        !currentUrl.startsWith(params.url)
                    ) {
                        await navigateTo(page, params.url, params.waitUntil);
                    }
                }

                if (signal?.aborted) throw new Error("Cancelled");

                const path =
                    params.outputPath ??
                    join("/tmp", `screenshot-${Date.now()}.png`);
                const dir = path.substring(0, path.lastIndexOf("/"));
                if (dir) mkdirSync(dir, { recursive: true });

                await page.screenshot({
                    path,
                    fullPage: params.fullPage !== false,
                });

                return {
                    content: [
                        {
                            type: "text",
                            text: `Screenshot saved to: ${path}`,
                        },
                    ],
                    details: {
                        path,
                        url: page.url(),
                        browser: "cdp",
                        tabId: params.tabId ?? 0,
                        consoleErrors: 0,
                        session: undefined,
                    },
                };
            }

            // ── Isolated mode (default) ──────────────────────────────
            const browser = await getBrowser();
            let page: PlaywrightPage | undefined;
            try {
                page = await createPage(browser);
                const consoleCollector = collectConsole(page);
                await navigateTo(page, params.url, params.waitUntil);

                if (signal?.aborted) throw new Error("Cancelled");

                const path =
                    params.outputPath ??
                    join("/tmp", `screenshot-${Date.now()}.png`);
                const dir = path.substring(0, path.lastIndexOf("/"));
                if (dir) mkdirSync(dir, { recursive: true });

                await page.screenshot({
                    path,
                    fullPage: params.fullPage !== false,
                });

                const errorCount = consoleCollector.messages.filter(
                    (m) => m.type === "error"
                ).length;
                const consoleNote =
                    errorCount > 0
                        ? `\nBrowser console had ${String(errorCount)} error(s).`
                        : "";

                return {
                    content: [
                        {
                            type: "text",
                            text: `Screenshot saved to: ${path}${consoleNote}`,
                        },
                    ],
                    details: {
                        path,
                        url: params.url,
                        browser: "isolated",
                        tabId: params.tabId ?? 0,
                        consoleErrors: errorCount,
                        session: undefined,
                    },
                };
            } finally {
                if (page) await page.close().catch(() => {});
            }
        },
    });

    // ── web_interact ────────────────────────────────────────────────
    pi.registerTool({
        name: "web_interact",
        label: "Web Interact",
        description:
            "Perform a sequence of interactions on a web page (click, fill, press, scroll, " +
            "evaluate JS, etc.) and return the final page content. " +
            "Four browser modes: 'bridge' (Chrome extension), 'isolated' (fresh headless browser, default), " +
            "'cdp' (user's Chrome tab — requires tabId, page is already loaded), " +
            "'applescript' (not supported for interaction). " +
            "Use 'console' to dump collected browser console logs, 'evaluate' to run JavaScript " +
            "in the page context, or 'inject_script' to load an external script.",
        promptSnippet: "Interact with web pages (click, fill forms, navigate)",
        promptGuidelines: [
            "Use web_interact for pages requiring interaction: form fills, button clicks, infinite scroll.",
            "Always include a 'wait' action after navigation or form submission to let content load.",
            "Use 'console' action to inspect browser console logs when debugging page issues.",
            "Use 'evaluate' action to run JavaScript in the page and get the result as JSON.",
            "Use 'inject_script' action to load an external JS file or URL into the page.",
            "Use browser: 'cdp' with tabId to interact with an open Chrome tab (call chrome_list first to get tab IDs).",
        ],
        parameters: Type.Object({
            url: Type.String({ description: "Starting URL" }),
            waitUntil: WAIT_UNTIL_PARAM,
            actions: Type.Array(
                Type.Object({
                    type: StringEnum([
                        "click",
                        "fill",
                        "press",
                        "select",
                        "hover",
                        "wait",
                        "scroll",
                        "screenshot",
                        "extract",
                        "navigate",
                        "content",
                        "console",
                        "evaluate",
                        "inject_script",
                    ] as const),
                    selector: Type.Optional(
                        Type.String({ description: "CSS selector" })
                    ),
                    value: Type.Optional(
                        Type.String({
                            description:
                                "Value for fill/select, or inline JS for evaluate",
                        })
                    ),
                    key: Type.Optional(
                        Type.String({
                            description: "Key for press (e.g. Enter, Tab)",
                        })
                    ),
                    direction: Type.Optional(
                        StringEnum(["up", "down", "bottom"] as const, {
                            description: "Scroll direction",
                        })
                    ),
                    ms: Type.Optional(
                        Type.Number({
                            description: "Wait duration in milliseconds",
                        })
                    ),
                    url: Type.Optional(
                        Type.String({
                            description:
                                "URL for navigate action, or script URL for inject_script",
                        })
                    ),
                    path: Type.Optional(
                        Type.String({
                            description: "Output path for screenshot action",
                        })
                    ),
                    expression: Type.Optional(
                        Type.String({
                            description:
                                "JavaScript expression to evaluate in the page context (for evaluate action)",
                        })
                    ),
                })
            ),
            returnFormat: Type.Optional(
                StringEnum(["text", "markdown", "structure"] as const, {
                    description: "Format for the final page output",
                    default: "text",
                })
            ),
            browser: Type.Optional(BROWSER_PARAM),
            tabId: TAB_ID_PARAM,
            session: SESSION_PARAM,
        }),
        async execute(_toolCallId, params, signal) {
            if (!isFeatureEnabled(state, "web-browse")) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Web browsing is disabled — run /tau to enable",
                        },
                    ],
                    details: undefined,
                };
            }
            const browserMode = params.browser ?? "isolated";
            const returnFormat = params.returnFormat ?? "text";
            const session = params.session;

            if (browserMode === "applescript") {
                throw new Error(
                    "Interaction is not supported in AppleScript mode. Use browser: 'bridge', 'cdp', or 'isolated'."
                );
            }

            if (session === "fresh" && browserMode === "cdp") {
                throw new Error(
                    "session: 'fresh' is only supported in browser: 'bridge' mode. " +
                        "browser: 'cdp' operates on the user's existing Chrome tabs and cannot open an isolated window. " +
                        "Use browser: 'bridge' (default for the fresh session) or drop session: 'fresh'."
                );
            }

            // ── Bridge mode ──────────────────────────────────────────
            if (browserMode === "bridge") {
                if (!(await bridge.isAvailable())) {
                    throw new Error(
                        "Pi Chrome Bridge is not available. Ensure the Chrome extension is loaded and the native host is running."
                    );
                }

                let tabId = params.tabId;
                let socketPath: string | undefined;
                let incognitoWindowId: number | undefined;

                if (session === "fresh") {
                    // Open a new incognito window; any provided tabId is
                    // ignored — session: 'fresh' always uses a fresh tab.
                    const result = await bridge.newTabInIncognitoWindow(
                        params.url
                    );
                    tabId = result.tabInfo.id;
                    socketPath = result.socketPath;
                    incognitoWindowId = result.windowId;
                    await new Promise((r) => setTimeout(r, 3000));
                } else if (tabId === undefined) {
                    const newTabResult = await bridge.newTab(params.url);
                    tabId = newTabResult.tabInfo.id;
                    socketPath = newTabResult.socketPath;
                    await new Promise((r) => setTimeout(r, 3000));
                }

                try {
                    const outputs: string[] = [];

                    for (const action of params.actions) {
                        switch (action.type) {
                            case "navigate":
                                await bridge.navigate(
                                    tabId,
                                    action.url ?? params.url,
                                    socketPath
                                );
                                await new Promise((r) => setTimeout(r, 2000));
                                break;
                            case "click":
                                await bridge.click(
                                    tabId,
                                    action.selector!,
                                    socketPath
                                );
                                await new Promise((r) => setTimeout(r, 1000));
                                break;
                            case "fill":
                                await bridge.fill(
                                    tabId,
                                    action.selector!,
                                    action.value ?? "",
                                    socketPath
                                );
                                break;
                            case "select":
                                await bridge.selectOption(
                                    tabId,
                                    action.selector!,
                                    action.value ?? "",
                                    socketPath
                                );
                                break;
                            case "press": {
                                await bridge.pressKey(
                                    tabId,
                                    action.key!,
                                    action.selector,
                                    socketPath
                                );
                                break;
                            }
                            case "hover": {
                                await bridge.hover(
                                    tabId,
                                    action.selector!,
                                    socketPath
                                );
                                await new Promise((r) => setTimeout(r, 500));
                                break;
                            }
                            case "scroll": {
                                await bridge.scroll(
                                    tabId,
                                    action.direction ?? "down",
                                    action.selector,
                                    undefined,
                                    socketPath
                                );
                                break;
                            }
                            case "wait": {
                                if (action.selector) {
                                    const waited = await bridge.waitForElement(
                                        tabId,
                                        action.selector,
                                        action.ms,
                                        socketPath
                                    );
                                    if (!waited.found)
                                        outputs.push(
                                            `Element not found: ${action.selector}`
                                        );
                                } else {
                                    await new Promise((r) =>
                                        setTimeout(r, action.ms ?? 1000)
                                    );
                                }
                                break;
                            }
                            case "evaluate": {
                                const expr =
                                    action.expression ?? action.value ?? "";
                                const result = await bridge.evaluate(
                                    tabId,
                                    expr,
                                    socketPath
                                );
                                outputs.push(
                                    `Evaluate result: ${String(result)}`
                                );
                                break;
                            }
                            case "extract": {
                                const attrs = await bridge.getAttributes(
                                    tabId,
                                    action.selector!,
                                    undefined,
                                    socketPath
                                );
                                outputs.push(JSON.stringify(attrs, null, 2));
                                break;
                            }
                            case "content": {
                                const text = await bridge.getTabText(
                                    tabId,
                                    undefined,
                                    socketPath
                                );
                                outputs.push(text);
                                break;
                            }
                            case "screenshot": {
                                const path =
                                    action.path ??
                                    join(
                                        "/tmp",
                                        `screenshot-${Date.now()}.png`
                                    );
                                const base64Png = await bridge.screenshot(
                                    tabId,
                                    socketPath
                                );
                                writeFileSync(
                                    path,
                                    Buffer.from(base64Png, "base64")
                                );
                                outputs.push(`Screenshot saved: ${path}`);
                                break;
                            }
                            default:
                                outputs.push(
                                    `(Action '${action.type}' not yet supported in bridge mode)`
                                );
                        }
                    }

                    let finalContent: string;
                    if (returnFormat === "markdown") {
                        finalContent = String(
                            await bridge.evaluate(
                                tabId,
                                "(() => { if (typeof window.__domToMarkdown !== 'function') return document.body.innerText; return window.__domToMarkdown(); })()",
                                socketPath
                            )
                        );
                    } else if (returnFormat === "structure") {
                        finalContent = String(
                            await bridge.evaluate(
                                tabId,
                                "(() => { if (typeof window.__domToStructure !== 'function') return JSON.stringify({error:'Converters not injected'}); return JSON.stringify(window.__domToStructure()); })()",
                                socketPath
                            )
                        );
                    } else {
                        finalContent = await bridge.getTabText(
                            tabId,
                            undefined,
                            socketPath
                        );
                    }

                    const parts = outputs.join("\n\n");
                    const fullText = parts
                        ? `${parts}\n\n---\n\n${finalContent}`
                        : finalContent;

                    return {
                        content: [{ type: "text", text: fullText }],
                        details: {
                            url: params.url,
                            actionCount: params.actions.length,
                            returnFormat,
                            browser: "bridge",
                            tabId: tabId,
                            consoleErrors: 0,
                            session,
                        },
                    };
                } finally {
                    if (incognitoWindowId !== undefined) {
                        try {
                            await bridge.closeWindow(
                                incognitoWindowId,
                                socketPath
                            );
                        } catch {
                            // Best-effort cleanup
                        }
                    }
                }
            }

            // ── CDP mode ────────────────────────────────────────────
            if (browserMode === "cdp") {
                const page = await resolveCDPPage(params.tabId, signal);
                const consoleCollector = collectConsole(page);

                if (params.url && params.url !== "about:blank") {
                    const currentUrl = page.url();
                    if (
                        currentUrl !== params.url &&
                        !currentUrl.startsWith(params.url)
                    ) {
                        await navigateTo(page, params.url, params.waitUntil);
                    }
                }

                const outputs = await executeActions(
                    page,
                    params.actions,
                    consoleCollector,
                    signal
                );

                if (signal?.aborted) throw new Error("Cancelled");

                const finalContent = await extractFinalContent(
                    page,
                    returnFormat
                );

                const parts = outputs.join("\n\n");
                const fullText = parts
                    ? `${parts}\n\n---\n\n${finalContent}`
                    : finalContent;

                return {
                    content: [{ type: "text", text: fullText }],
                    details: {
                        url: page.url(),
                        actionCount: params.actions.length,
                        returnFormat,
                        browser: "cdp",
                        tabId: params.tabId ?? 0,
                        consoleErrors: consoleCollector.messages.filter(
                            (m) => m.type === "error"
                        ).length,
                        session: undefined,
                    },
                };
            }

            // ── Isolated mode (default) ──────────────────────────────
            const browser = await getBrowser();
            let page: PlaywrightPage | undefined;
            try {
                page = await createPage(browser);
                const consoleCollector = collectConsole(page);
                await navigateTo(page, params.url, params.waitUntil);

                const outputs = await executeActions(
                    page,
                    params.actions,
                    consoleCollector,
                    signal
                );

                if (signal?.aborted) throw new Error("Cancelled");

                const finalContent = await extractFinalContent(
                    page,
                    returnFormat
                );

                const parts = outputs.join("\n\n");
                const fullText = parts
                    ? `${parts}\n\n---\n\n${finalContent}`
                    : finalContent;

                return {
                    content: [{ type: "text", text: fullText }],
                    details: {
                        url: params.url,
                        actionCount: params.actions.length,
                        returnFormat,
                        browser: "isolated",
                        tabId: params.tabId ?? 0,
                        consoleErrors: consoleCollector.messages.filter(
                            (m) => m.type === "error"
                        ).length,
                        session: undefined,
                    },
                };
            } finally {
                if (page) await page.close().catch(() => {});
            }
        },
    });
}

// ── Shared content extraction ───────────────────────────────────────

async function extractPageContent(
    page: PlaywrightPage,
    params: {
        format: "text" | "markdown" | "structure";
        selector?: string;
        url: string;
    },
    consoleCollector: ConsoleCollector,
    browserMode: "isolated" | "cdp"
): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
}> {
    switch (params.format) {
        case "markdown": {
            const md: string = await page.evaluate(() =>
                window.__domToMarkdown()
            );
            return {
                content: [
                    {
                        type: "text",
                        text: appendConsoleLog(md, consoleCollector),
                    },
                ],
                details: {
                    format: "markdown",
                    url: params.url,
                    browser: browserMode,
                    consoleErrors: consoleCollector.messages.filter(
                        (m) => m.type === "error"
                    ).length,
                },
            };
        }
        case "structure": {
            // GitHub-aware: shallow-clone repo instead of DOM walk
            const gh = matchGitHubRepo(params.url);
            if (gh) {
                try {
                    const repoData = extractRepoStructure(gh.owner, gh.repo);
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(repoData, null, 2),
                            },
                        ],
                        details: {
                            format: "github-repo",
                            url: params.url,
                            browser: browserMode,
                            consoleErrors: 0,
                        },
                    };
                } catch {
                    // Clone failed — fall through to DOM extraction
                }
            }

            const data: unknown = await page.evaluate(() =>
                window.__domToStructure()
            );
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(data, null, 2),
                    },
                ],
                details: {
                    format: "structure",
                    url: params.url,
                    browser: browserMode,
                    consoleErrors: consoleCollector.messages.filter(
                        (m) => m.type === "error"
                    ).length,
                },
            };
        }
        default: {
            if (params.selector) {
                const elements = await page.evaluate((sel) => {
                    return Array.from(document.querySelectorAll(sel)).map(
                        (el) => ({
                            tag: el.tagName.toLowerCase(),
                            text: el.textContent?.trim() ?? "",
                        })
                    );
                }, params.selector);
                return {
                    content: [
                        {
                            type: "text",
                            text: appendConsoleLog(
                                JSON.stringify(elements, null, 2),
                                consoleCollector
                            ),
                        },
                    ],
                    details: {
                        format: "text",
                        url: params.url,
                        selector: params.selector,
                        browser: browserMode,
                        consoleErrors: consoleCollector.messages.filter(
                            (m) => m.type === "error"
                        ).length,
                    },
                };
            }

            const text = await getPageText(page);
            return {
                content: [
                    {
                        type: "text",
                        text: appendConsoleLog(text, consoleCollector),
                    },
                ],
                details: {
                    format: "text",
                    url: params.url,
                    browser: browserMode,
                    consoleErrors: consoleCollector.messages.filter(
                        (m) => m.type === "error"
                    ).length,
                },
            };
        }
    }
}

async function extractFinalContent(
    page: PlaywrightPage,
    returnFormat: "text" | "markdown" | "structure"
): Promise<string> {
    switch (returnFormat) {
        case "markdown":
            await ensureConverters(page);
            return await page.evaluate((): string => window.__domToMarkdown());
        case "structure": {
            await ensureConverters(page);
            const data: unknown = await page.evaluate(() =>
                window.__domToStructure()
            );
            return JSON.stringify(data, null, 2);
        }
        default:
            return await getPageText(page);
    }
}

async function executeActions(
    page: PlaywrightPage,
    actions: Array<{
        type: string;
        selector?: string;
        value?: string;
        key?: string;
        direction?: string;
        ms?: number;
        url?: string;
        path?: string;
        expression?: string;
    }>,
    consoleCollector: ConsoleCollector,
    signal?: AbortSignal
): Promise<string[]> {
    const outputs: string[] = [];

    for (const action of actions) {
        if (signal?.aborted) throw new Error("Cancelled");

        switch (action.type) {
            case "click":
                await page.click(action.selector!);
                break;
            case "fill":
                await page.fill(action.selector!, action.value!);
                break;
            case "press":
                await page.keyboard.press(action.key!);
                break;
            case "select":
                await page.selectOption(action.selector!, action.value!);
                break;
            case "hover":
                await page.hover(action.selector!);
                break;
            case "wait":
                if (action.selector) {
                    await page.waitForSelector(action.selector, {
                        timeout: TIMEOUT,
                    });
                } else if (action.ms) {
                    await page.waitForTimeout(action.ms);
                }
                break;
            case "scroll": {
                const dir = action.direction ?? "down";
                if (dir === "down") {
                    await page.evaluate(() =>
                        window.scrollBy(0, window.innerHeight)
                    );
                } else if (dir === "up") {
                    await page.evaluate(() =>
                        window.scrollBy(0, -window.innerHeight)
                    );
                } else {
                    await page.evaluate(() =>
                        window.scrollTo(0, document.body.scrollHeight)
                    );
                }
                break;
            }
            case "screenshot": {
                const path =
                    action.path ?? join("/tmp", `screenshot-${Date.now()}.png`);
                await page.screenshot({ path, fullPage: false });
                outputs.push(`Screenshot saved: ${path}`);
                break;
            }
            case "extract": {
                const extracted = await page.evaluate((sel) => {
                    return Array.from(document.querySelectorAll(sel)).map(
                        (el) => ({
                            tag: el.tagName.toLowerCase(),
                            text: el.textContent?.trim() ?? "",
                        })
                    );
                }, action.selector!);
                outputs.push(JSON.stringify(extracted, null, 2));
                break;
            }
            case "navigate":
                await navigateTo(page, action.url!);
                break;
            case "content":
                outputs.push(await getPageText(page));
                break;
            case "console":
                outputs.push(
                    consoleCollector.getFormatted() || "(no console messages)"
                );
                break;
            case "evaluate": {
                const expression = action.expression ?? action.value ?? "";
                const result: string = await page.evaluate((expr) => {
                    const value: unknown = eval(expr);
                    if (value === undefined) return "(undefined)";
                    if (typeof value === "symbol") return value.toString();
                    if (typeof value === "string") return value;
                    try {
                        return JSON.stringify(value);
                    } catch {
                        // If both JSON.stringify attempts fail, value is not serialisable
                        return "(unserialisable value)";
                    }
                }, expression);
                outputs.push(
                    `Evaluate result: ${JSON.stringify(result, null, 2)}`
                );
                break;
            }
            case "inject_script": {
                const scriptUrl = action.url;
                const inlineScript = action.value;
                if (scriptUrl) {
                    await page.addScriptTag({ url: scriptUrl });
                    outputs.push(`Injected script: ${scriptUrl}`);
                } else if (inlineScript) {
                    await page.addScriptTag({ content: inlineScript });
                    outputs.push("Injected inline script");
                }
                break;
            }
        }

        await page.waitForTimeout(100);
    }

    return outputs;
}
