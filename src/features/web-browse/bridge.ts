/**
 * Chrome Bridge client for the web-browse extension.
 *
 * Communicates with Pi Chrome Bridge native messaging hosts
 * via Unix domain sockets. Chrome launches one native host process
 * per profile when the extension calls chrome.runtime.connectNative().
 *
 * Each native host opens a socket at /tmp/pi-chrome-bridge-$USER/$PID.sock.
 * This client connects to ALL active sockets to aggregate tabs across
 * all Chrome profiles.
 *
 * Protocol: 4-byte LE length prefix + JSON (same as Chrome native messaging).
 *
 * No separate HTTP server needed — Chrome manages the native host lifecycle.
 */

import { connect, type Socket } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { redactText } from "./redact.ts";

const SOCKET_DIR = `/tmp/pi-chrome-bridge-${getUsername()}`;
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1 MB
const CONNECT_TIMEOUT = 5_000;
const COMMAND_TIMEOUT = 35_000;

function getUsername(): string {
    try {
        return userInfo().username || "default";
    } catch {
        return process.env.USER || process.env.USERNAME || "default";
    }
}

// ── Types ────────────────────────────────────────────────────────────

export interface BridgeTabInfo {
    id: number;
    windowId: number;
    index: number;
    title: string;
    url: string;
    active: boolean;
    profile: string;
}

interface PendingCommand {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

interface SocketConnection {
    socket: Socket;
    buffer: Buffer;
    socketPath: string;
}

/** Resolved profile metadata from a native host's sidecar file. */
interface SocketProfile {
    socketPath: string;
    profile: string;
    profileDir: string;
    email: string;
}
// ── Socket discovery ─────────────────────────────────────────────────

/** Get all active socket paths (belonging to living processes). */
function findActiveSockets(): string[] {
    const paths: string[] = [];
    try {
        const files = readdirSync(SOCKET_DIR);
        for (const file of files) {
            if (!file.endsWith(".sock")) continue;
            const pid = parseInt(file.replace(".sock", ""), 10);
            if (isNaN(pid)) continue;
            try {
                process.kill(pid, 0); // Check if alive
                paths.push(join(SOCKET_DIR, file));
            } catch {
                // Dead process — skip stale socket
            }
        }
    } catch {
        // Directory doesn't exist — native host not running
    }
    return paths;
}

/** Read a sidecar file for a socket PID. Returns null if unreadable. */
function readSidecar(pid: number): {
    profile: string;
    profileDir: string;
    email: string;
} | null {
    const sidecarPath = join(SOCKET_DIR, `${pid}.profile.json`);
    try {
        const data = JSON.parse(readFileSync(sidecarPath, "utf-8")) as {
            profile?: string;
            profileDir?: string;
            email?: string;
        };
        if (data.profile) {
            return {
                profile: data.profile,
                profileDir: data.profileDir ?? "",
                email: data.email ?? "",
            };
        }
    } catch {
        // Sidecar doesn't exist or isn't ready yet
    }
    return null;
}

/** Get profile metadata for all active sockets. */
function resolveSocketProfiles(): SocketProfile[] {
    const profiles: SocketProfile[] = [];
    try {
        const files = readdirSync(SOCKET_DIR);
        for (const file of files) {
            if (!file.endsWith(".sock")) continue;
            const pid = parseInt(file.replace(".sock", ""), 10);
            if (isNaN(pid)) continue;
            try {
                process.kill(pid, 0);
            } catch {
                continue;
            }
            const socketPath = join(SOCKET_DIR, file);
            const sidecar = readSidecar(pid);
            profiles.push({
                socketPath,
                profile: sidecar?.profile ?? "Unknown",
                profileDir: sidecar?.profileDir ?? "",
                email: sidecar?.email ?? "",
            });
        }
    } catch {
        // Directory doesn't exist
    }
    return profiles;
}

/**
 * Find which socket owns a specific profile by name.
 * Returns the socket path, or null if no match found.
 */
function findSocketForProfile(profileName: string): string | null {
    const profiles = resolveSocketProfiles();
    const normalised = profileName.toLowerCase();
    for (const p of profiles) {
        if (p.profile.toLowerCase() === normalised) {
            return p.socketPath;
        }
    }
    return null;
}

/** Get the profile name for a given socket path from sidecar data. */
function getProfileForSocket(socketPath: string): string {
    const profiles = resolveSocketProfiles();
    const found = profiles.find((p) => p.socketPath === socketPath);
    return found?.profile ?? "Unknown";
}

// ── Multi-socket connection pool ─────────────────────────────────────

const connections = new Map<string, SocketConnection>();
const pendingCommands = new Map<number, PendingCommand>();
let nextCommandId = 1;

/** Check if the bridge is available (at least one native host running). */
export async function isAvailable(): Promise<boolean> {
    const socketPaths = findActiveSockets();
    if (socketPaths.length === 0) return false;

    // Try connecting to the first one
    return new Promise((resolve) => {
        const socket = connect(socketPaths[0]);
        const timer = setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, CONNECT_TIMEOUT);

        socket.on("error", () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(false);
        });

        socket.on("connect", () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(true);
        });
    });
}

/** Get or create a connection to a specific native host socket. */
function getConnection(socketPath: string): Promise<SocketConnection> {
    const existing = connections.get(socketPath);
    if (existing && !existing.socket.destroyed) {
        return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
        const socket = connect(socketPath);
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`Timed out connecting to ${socketPath}`));
        }, CONNECT_TIMEOUT);

        socket.on("connect", () => {
            clearTimeout(timer);
            const conn: SocketConnection = {
                socket,
                buffer: Buffer.alloc(0),
                socketPath,
            };
            connections.set(socketPath, conn);

            socket.on("data", (data: Buffer) => {
                conn.buffer = Buffer.concat([conn.buffer, data]);
                processBuffer(conn);
            });

            socket.on("error", () => {
                connections.delete(socketPath);
            });

            socket.on("close", () => {
                connections.delete(socketPath);
            });

            resolve(conn);
        });

        socket.on("error", (err) => {
            clearTimeout(timer);
            reject(
                new Error(`Failed to connect to ${socketPath}: ${err.message}`)
            );
        });
    });
}

/** Process complete messages from a socket's buffer. */
function processBuffer(conn: SocketConnection): void {
    while (conn.buffer.length >= 4) {
        const length = conn.buffer.readUInt32LE(0);
        if (length === 0 || length > MAX_MESSAGE_SIZE) {
            conn.buffer = Buffer.alloc(0);
            return;
        }
        if (conn.buffer.length < 4 + length) break;

        const messageBytes = conn.buffer.subarray(4, 4 + length);
        conn.buffer = conn.buffer.subarray(4 + length);

        try {
            const message = JSON.parse(messageBytes.toString("utf-8")) as {
                id?: number;
                result?: unknown;
                error?: string;
            };

            if (message.id !== undefined) {
                const pending = pendingCommands.get(message.id);
                if (pending) {
                    clearTimeout(pending.timeout);
                    pendingCommands.delete(message.id);
                    if (message.error) {
                        pending.reject(new Error(message.error));
                    } else {
                        pending.resolve(message.result);
                    }
                }
            }
        } catch {
            // Invalid JSON — ignore
        }
    }
}

/** Send a command to a specific native host socket. */
async function sendCommand(
    socketPath: string,
    method: string,
    params?: unknown
): Promise<unknown> {
    const conn = await getConnection(socketPath);
    const id = nextCommandId++;

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingCommands.delete(id);
            reject(new Error(`Command timed out: ${method}`));
        }, COMMAND_TIMEOUT);

        pendingCommands.set(id, { resolve, reject, timeout });

        const request = JSON.stringify({ id, method, params });
        const requestBytes = Buffer.from(request, "utf-8");
        const lengthBuffer = Buffer.alloc(4);
        lengthBuffer.writeUInt32LE(requestBytes.length, 0);
        conn.socket.write(Buffer.concat([lengthBuffer, requestBytes]));
    });
}

/** Send a command to the first available native host socket. */
async function sendCommandAny(
    method: string,
    params?: unknown
): Promise<{ result: unknown; socketPath: string }> {
    const socketPaths = findActiveSockets();
    if (socketPaths.length === 0) {
        throw new Error(
            "Pi Chrome Bridge native host is not running. " +
                "Ensure the Chrome extension is loaded and Developer Mode is enabled.\n" +
                "The native host is launched automatically by Chrome when the extension calls connectNative()."
        );
    }
    const socketPath = socketPaths[0];
    const result = await sendCommand(socketPath, method, params);
    return { result, socketPath };
}

/** Get the first available socket path (for commands that don't target a specific tab). */
async function getDefaultSocketPath(): Promise<string> {
    const socketPaths = findActiveSockets();
    if (socketPaths.length === 0) {
        throw new Error("Pi Chrome Bridge native host is not running.");
    }
    return socketPaths[0];
}

/** Find which socket owns a tab by its ID. */
async function findSocketForTab(tabId: number): Promise<string> {
    const socketPaths = findActiveSockets();
    for (const socketPath of socketPaths) {
        try {
            const result = (await sendCommand(socketPath, "list-tabs")) as
                | { tabs?: BridgeTabInfo[] }
                | undefined;
            const tabs = result?.tabs ?? [];
            if (tabs.some((t) => t.id === tabId)) {
                return socketPath;
            }
        } catch {
            // Skip failed sockets
        }
    }
    // Default to first socket if tab not found in any
    return socketPaths[0] ?? "";
}

// ── Public API ───────────────────────────────────────────────────────

/** List all open Chrome tabs across all profiles with correct profile names. */
export async function listTabs(): Promise<BridgeTabInfo[]> {
    const socketProfiles = resolveSocketProfiles();
    const allTabs: BridgeTabInfo[] = [];

    for (const sp of socketProfiles) {
        try {
            const result = (await sendCommand(sp.socketPath, "list-tabs")) as
                | { tabs?: Array<Record<string, unknown>> }
                | undefined;
            const tabs = result?.tabs ?? [];

            for (const tab of tabs) {
                allTabs.push({
                    id: tab.id as number,
                    windowId: tab.windowId as number,
                    index: tab.index as number,
                    title: (tab.title as string) ?? "",
                    url: (tab.url as string) ?? "",
                    active: tab.active as boolean,
                    profile: sp.profile,
                });
            }
        } catch {
            // Skip failed sockets
        }
    }

    return allTabs;
}

/** Send a command to a specific socket (skipping tab lookup). */

/** Get text content from a tab. */
export async function getTabText(
    tabId: number,
    selector?: string,
    socketPath?: string
): Promise<string> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    const result = await sendCommand(resolvedPath, "get-text", {
        tabId,
        selector,
    });
    return redactText((result as string) ?? "");
}

/** Execute JavaScript in a tab. */
export async function evaluate(
    tabId: number,
    expression: string,
    socketPath?: string
): Promise<string> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    const result = await sendCommand(resolvedPath, "evaluate", {
        tabId,
        expression,
    });
    return redactText(result as string);
}

/**
 * Inject the markdown/structure converters into the page's MAIN world.
 * Idempotent: re-injecting into a tab that already has the converters
 * is a no-op (each converter's IIFE checks for the existing global).
 */
export async function injectConverters(
    tabId: number,
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "inject-converters", { tabId });
}

/** Navigate a tab to a URL. */
export async function navigate(
    tabId: number,
    url: string,
    socketPath?: string
): Promise<void> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    await sendCommand(resolvedPath, "navigate", { tabId, url });
}

/** Create a new tab (in the first available profile). */
export interface NewTabResult {
    tabInfo: BridgeTabInfo;
    socketPath: string;
}

export async function newTab(
    url?: string,
    profile?: string
): Promise<NewTabResult> {
    let socketPath: string;
    let createdTab: BridgeTabInfo;

    if (profile) {
        const found = findSocketForProfile(profile);
        if (!found) {
            const available = resolveSocketProfiles().map((p) => p.profile);
            throw new Error(
                `No Chrome profile named "${profile}" found. ` +
                    `Available profiles: ${available.join(", ")}`
            );
        }
        socketPath = found;
        const result = await sendCommand(socketPath, "new-tab", {
            url: url ?? "about:blank",
        });
        createdTab = result as BridgeTabInfo;
    } else {
        const anyResult = await sendCommandAny("new-tab", {
            url: url ?? "about:blank",
        });
        socketPath = anyResult.socketPath;
        createdTab = anyResult.result as BridgeTabInfo;
    }

    // chrome.tabs.create() may return a preliminary tab ID that differs from
    // the final stable ID. Poll list-tabs until the tab appears with the
    // expected URL, or until the created ID is confirmed in the list.
    const targetUrl = url ?? "about:blank";
    const stableTab = await pollForStableTab(
        socketPath,
        createdTab.id,
        targetUrl
    );

    const profileName = getProfileForSocket(socketPath);
    const taggedTab: BridgeTabInfo = {
        ...(stableTab ?? createdTab),
        profile: profileName,
    };

    return { tabInfo: taggedTab, socketPath };
}

/**
 * Open a new incognito window and return its first tab. The window does
 * not steal focus from the user's current work. The caller is
 * responsible for closing the window when finished — use closeWindow()
 * with the returned windowId.
 */
export interface IncognitoTabResult {
    tabInfo: BridgeTabInfo;
    socketPath: string;
    windowId: number;
}

export async function newTabInIncognitoWindow(
    url?: string
): Promise<IncognitoTabResult> {
    const socketPath = await getDefaultSocketPath();
    const result = (await sendCommand(socketPath, "create-window", {
        url: url ?? "about:blank",
        incognito: true,
        focused: false,
    })) as BridgeWindow;

    const firstTab = result.tabs?.[0];
    if (!firstTab) {
        throw new Error(
            "Failed to create incognito window: Chrome returned no tabs. " +
                "Check that Chrome is running and incognito is not disabled by policy."
        );
    }
    if (result.id === undefined) {
        throw new Error(
            "Failed to create incognito window: Chrome returned no window ID."
        );
    }

    const profileName = getProfileForSocket(socketPath);
    const tabInfo: BridgeTabInfo = {
        id: firstTab.id,
        windowId: result.id,
        index: firstTab.index,
        title: firstTab.title,
        url: firstTab.url,
        active: firstTab.active,
        profile: profileName,
    };
    return { tabInfo, socketPath, windowId: result.id };
}

/**
 * Poll list-tabs until either the created tab ID appears in the list
 * or a tab with the target URL appears (up to 5 attempts over 2.5s).
 */
async function pollForStableTab(
    socketPath: string,
    createdTabId: number,
    targetUrl: string
): Promise<BridgeTabInfo | undefined> {
    const normalisedTarget = targetUrl.replace(/\/$/, "");

    for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, 500));

        const listResult = (await sendCommand(socketPath, "list-tabs")) as
            | { tabs?: BridgeTabInfo[] }
            | undefined;
        const tabs = listResult?.tabs ?? [];

        // First: check if the created ID exists in the list
        const byId = tabs.find((t) => t.id === createdTabId);
        if (byId) return byId;

        // Second: check if a tab with the target URL appeared
        const byUrl = tabs.find(
            (t) =>
                t.url === targetUrl ||
                t.url.replace(/\/$/, "") === normalisedTarget
        );
        if (byUrl) return byUrl;
    }

    return undefined;
}

/** Close a tab. */
export async function closeTab(
    tabId: number,
    socketPath?: string
): Promise<void> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    await sendCommand(resolvedPath, "close-tab", { tabId });
}

/** Activate a tab (bring to front). */
export async function activateTab(
    tabId: number,
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "activate-tab", { tabId });
}

/** Duplicate a tab. */
export async function duplicateTab(
    tabId: number,
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "duplicate-tab", { tabId });
}

/** Move a tab to a different window/position. */
export async function moveTab(
    tabId: number,
    params: { windowId?: number; index?: number },
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "move-tab", { tabId, ...params });
}

/** Update tab properties (url, active, pinned, muted). */
export async function updateTab(
    tabId: number,
    params: {
        url?: string;
        active?: boolean;
        pinned?: boolean;
        muted?: boolean;
    },
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "update-tab", { tabId, ...params });
}

/** Go back in browser history. */
export async function goBack(
    tabId: number,
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "go-back", { tabId });
}

/** Go forward in browser history. */
export async function goForward(
    tabId: number,
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "go-forward", { tabId });
}

/** Reload a tab. */
export async function reloadTab(
    tabId: number,
    bypassCache?: boolean,
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "reload-tab", {
        tabId,
        bypassCache,
    });
}

/** Get just the URL and title of a tab (lightweight). */
export async function getTabUrl(
    tabId: number,
    socketPath?: string
): Promise<{ id: number; url: string; title: string }> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return (await sendCommand(resolvedPath, "get-tab-url", { tabId })) as {
        id: number;
        url: string;
        title: string;
    };
}

// ── Window operations ────────────────────────────────────────────────

export interface BridgeWindow {
    id: number;
    type: string;
    state: string;
    focused: boolean;
    top?: number;
    left?: number;
    width?: number;
    height?: number;
    tabs?: Array<{
        id: number;
        index: number;
        title: string;
        url: string;
        active: boolean;
    }>;
}

/** List all Chrome windows. */
export async function listWindows(
    socketPath?: string
): Promise<BridgeWindow[]> {
    const resolvedPath = socketPath ?? (await getDefaultSocketPath());
    const result = (await sendCommand(resolvedPath, "list-windows")) as
        | { windows?: BridgeWindow[] }
        | undefined;
    return result?.windows ?? [];
}

/** Get a specific window. */
export async function getWindow(
    windowId: number,
    socketPath?: string
): Promise<BridgeWindow> {
    const resolvedPath = socketPath ?? (await getDefaultSocketPath());
    return (await sendCommand(resolvedPath, "get-window", {
        windowId,
    })) as BridgeWindow;
}

/** Create a new window. */
export async function createWindow(
    params: {
        url?: string;
        width?: number;
        height?: number;
        focused?: boolean;
    },
    socketPath?: string
): Promise<BridgeWindow> {
    const resolvedPath = socketPath ?? (await getDefaultSocketPath());
    return (await sendCommand(
        resolvedPath,
        "create-window",
        params
    )) as BridgeWindow;
}

/** Close a window. */
export async function closeWindow(
    windowId: number,
    socketPath?: string
): Promise<void> {
    const resolvedPath = socketPath ?? (await getDefaultSocketPath());
    await sendCommand(resolvedPath, "close-window", { windowId });
}

/** Update window properties (focus, state, size). */
export async function updateWindow(
    windowId: number,
    params: {
        focused?: boolean;
        state?: string;
        width?: number;
        height?: number;
    },
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await getDefaultSocketPath());
    return await sendCommand(resolvedPath, "update-window", {
        windowId,
        ...params,
    });
}

// ── Page interaction ─────────────────────────────────────────────────

/** Click an element (shadow-DOM aware, with text fallback). */
export async function click(
    tabId: number,
    selector: string,
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "click", { tabId, selector });
}

/** Fill an input field with proper event dispatch. */
export async function fill(
    tabId: number,
    selector: string,
    value: string,
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "fill", { tabId, selector, value });
}

/** Select an option in a <select> dropdown. */
export async function selectOption(
    tabId: number,
    selector: string,
    value: string,
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "select-option", {
        tabId,
        selector,
        value,
    });
}

/** Hover over an element. */
export async function hover(
    tabId: number,
    selector: string,
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "hover", { tabId, selector });
}

/** Press a key. Optionally target a specific element. */
export async function pressKey(
    tabId: number,
    key: string,
    selector?: string,
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "press-key", {
        tabId,
        key,
        selector,
    });
}

/** Scroll the page or a specific element. */
export async function scroll(
    tabId: number,
    direction: string,
    selector?: string,
    amount?: number,
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "scroll", {
        tabId,
        direction,
        selector,
        amount,
    });
}

/** Get attributes from matched elements. */
export async function getAttributes(
    tabId: number,
    selector: string,
    attributes?: string[],
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "get-attributes", {
        tabId,
        selector,
        attributes,
    });
}

/** Wait for an element to appear in the DOM. */
export async function waitForElement(
    tabId: number,
    selector: string,
    timeout?: number,
    socketPath?: string
): Promise<{ found: boolean; text?: string }> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return (await sendCommand(resolvedPath, "wait-for-element", {
        tabId,
        selector,
        timeout,
    })) as { found: boolean; text?: string };
}

/** Upload files to a file input (requires debugger). */
export async function uploadFile(
    tabId: number,
    selector: string,
    files: string[],
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "upload-file", {
        tabId,
        selector,
        files,
    });
}

/** Capture a screenshot. Returns base64 PNG data. */
export async function screenshot(
    tabId: number,
    socketPath?: string
): Promise<string> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return (await sendCommand(resolvedPath, "screenshot", { tabId })) as string;
}

/** Attach the Chrome debugger. */
export async function attachDebugger(
    tabId: number,
    socketPath?: string
): Promise<void> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    await sendCommand(resolvedPath, "attach-debugger", { tabId });
}

/** Detach the Chrome debugger. */
export async function detachDebugger(
    tabId: number,
    socketPath?: string
): Promise<void> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    await sendCommand(resolvedPath, "detach-debugger", { tabId });
}

/** Send a CDP command. */
export async function sendCdp(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    socketPath?: string
): Promise<unknown> {
    const resolvedPath = socketPath ?? (await findSocketForTab(tabId));
    return await sendCommand(resolvedPath, "send-cdp", {
        tabId,
        method,
        params,
    });
}

/** Get all resolved socket profiles. */
export function getAvailableProfiles(): Array<{
    profile: string;
    email: string;
}> {
    return resolveSocketProfiles().map((sp) => ({
        profile: sp.profile,
        email: sp.email,
    }));
}

/** Disconnect from all native host sockets. */
export function disconnect(): void {
    for (const [, conn] of connections) {
        if (!conn.socket.destroyed) {
            conn.socket.destroy();
        }
    }
    connections.clear();
    for (const [, pending] of pendingCommands) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Disconnected"));
    }
    pendingCommands.clear();
}
