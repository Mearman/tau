#!/usr/bin/env node
/**
 * Pi Chrome Bridge — Native Messaging Host
 *
 * Chrome launches this process when the extension calls
 * chrome.runtime.connectNative(). Communication is via stdin/stdout
 * using Chrome's native messaging protocol (4-byte LE length prefix + JSON).
 *
 * The host also opens a Unix domain socket so the pi extension can
 * connect and send commands to the Chrome extension.
 *
 * Architecture:
 *   pi extension → Unix socket → native host → stdout → Chrome extension
 *   Chrome extension → stdin → native host → Unix socket → pi extension
 *
 * Modeled on Claude Code's chromeNativeHost.ts.
 */

import {
	appendFile,
	chmod,
	mkdir,
	readdir,
	rmdir,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, platform } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";

// ── Configuration ────────────────────────────────────────────────────

const MAX_MESSAGE_SIZE = 1024 * 1024; // 1 MB
const SOCKET_DIR = `/tmp/pi-chrome-bridge-${getUsername()}`;
const SOCKET_PATH = join(SOCKET_DIR, `${process.pid}.sock`);
const SIDECAR_PATH = join(SOCKET_DIR, `${process.pid}.profile.json`);

function getUsername(): string {
	try {
		return process.env.USER ?? process.env.USERNAME ?? "default";
	} catch {
		return "default";
	}
}

// ── Logging ──────────────────────────────────────────────────────────

const LOG_FILE = join(homedir(), ".pi", "agent", "extensions", "tau", "bridge", "debug.log");

async function log(message: string, ...args: unknown[]): Promise<void> {
	const timestamp = new Date().toISOString();
	const formattedArgs = args.length > 0 ? " " + JSON.stringify(args) : "";
	const logLine = `[${timestamp}] ${message}${formattedArgs}\n`;
	process.stderr.write(`[Pi Chrome Bridge] ${message}${formattedArgs}`);
	void appendFile(LOG_FILE, logLine).catch(() => {});
}

// ── Chrome profile resolution ────────────────────────────────────────

const CHROME_USER_DATA_DIR =
	platform() === "darwin"
		? join(homedir(), "Library", "Application Support", "Google", "Chrome")
		: join(homedir(), ".config", "google-chrome");
const LOCAL_STATE_FILE = join(CHROME_USER_DATA_DIR, "Local State");
const execFileAsync = promisify(execFile);

interface ProfileIdentity {
	profileDir: string;
	profileName: string;
	email: string;
}

interface ProfileInfo {
	name: string;
	userName: string;
	gaiaId: string;
	gaiaName: string;
}

/** Resolved profile identity for this host's Chrome profile. */
let profileIdentity: ProfileIdentity | null = null;

function parseLocalStateProfiles(): Map<string, ProfileInfo> {
	try {
		const content = readFileSync(LOCAL_STATE_FILE, "utf-8");
		const state = JSON.parse(content) as {
			profile?: {
				info_cache?: Record<
					string,
					{ name?: string; user_name?: string; gaia_id?: string; gaia_name?: string }
				>;
			};
		};
		const profiles = new Map<string, ProfileInfo>();
		for (const [dirName, info] of Object.entries(state.profile?.info_cache ?? {})) {
			profiles.set(dirName, {
				name: info.name ?? dirName,
				userName: info.user_name ?? "",
				gaiaId: info.gaia_id ?? "",
				gaiaName: info.gaia_name ?? "",
			});
		}
		return profiles;
	} catch {
		return new Map();
	}
}

async function cookieMarkerExists(dbPath: string, markerName: string): Promise<boolean> {
	const script = [
		"import sqlite3, sys",
		"db_path = sys.argv[1]",
		"marker = sys.argv[2]",
		"try:",
		"    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)",
		"    cur = conn.cursor()",
		"    cur.execute('select 1 from cookies where name=? limit 1', (marker,))",
		"    row = cur.fetchone()",
		"    print('1' if row else '0')",
		"except Exception:",
		"    print('0')",
		"finally:",
		"    try:",
		"        conn.close()",
		"    except Exception:",
		"        pass",
	].join("\n");

	const { stdout } = await execFileAsync("python3", ["-c", script, dbPath, markerName], {
		timeout: 5000,
	});
	return stdout.trim() === "1";
}

async function resolveProfileFromMarker(markerName: string): Promise<ProfileIdentity | null> {
	if (!markerName) return null;
	const profiles = parseLocalStateProfiles();
	for (let attempt = 0; attempt < 10; attempt++) {
		for (const [dirName, info] of profiles) {
			const cookieDb = join(CHROME_USER_DATA_DIR, dirName, "Cookies");
			try {
				if (await cookieMarkerExists(cookieDb, markerName)) {
					return {
						profileDir: dirName,
						profileName: info.name,
						email: info.userName,
					};
				}
			} catch {
				// Ignore per-profile query failures
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return null;
}

/** Write the profile sidecar file. */
async function writeSidecar(identity: ProfileIdentity): Promise<void> {
	const data = JSON.stringify({ pid: process.pid, profileDir: identity.profileDir, profile: identity.profileName, email: identity.email }, null, 2);
	await writeFile(SIDECAR_PATH, data, "utf-8");
	await chmod(SIDECAR_PATH, 0o600).catch(() => {});
}

/** Remove the sidecar file. */
async function removeSidecar(): Promise<void> {
	try { await unlink(SIDECAR_PATH); } catch { /* fine */ }
}

/** Handle the "identify" message from the Chrome extension. */
async function handleIdentify(markerName: string): Promise<void> {
	await removeSidecar();
	const resolved = await resolveProfileFromMarker(markerName);
	if (resolved) {
		profileIdentity = resolved;
		await writeSidecar(resolved);
		await log(`Profile resolved: ${resolved.profileName} (${resolved.profileDir}) via marker ${markerName}`);
		return;
	}
	await log(`Could not resolve profile for marker="${markerName}". Writing unknown sidecar.`);
	const fallback: ProfileIdentity = { profileDir: "unknown", profileName: "Unknown Profile", email: "" };
	profileIdentity = fallback;
	await writeSidecar(fallback);
}

// ── Chrome native messaging protocol ─────────────────────────────────

/** Read a native messaging message from stdin (4-byte LE length + JSON). */
function readChromeMessage(): Promise<string | null> {
	return new Promise((resolve) => {
		const tryRead = (): void => {
			// Need at least 4 bytes for length
			if (stdinBuffer.length < 4) {
				if (stdinClosed) {
					resolve(null);
					return;
				}
				stdinResolve = resolve;
				return;
			}

			const length = stdinBuffer.readUInt32LE(0);
			if (length === 0 || length > MAX_MESSAGE_SIZE) {
				log(`Invalid message length: ${length}`);
				resolve(null);
				return;
			}

			if (stdinBuffer.length < 4 + length) {
				if (stdinClosed) {
					resolve(null);
					return;
				}
				stdinResolve = resolve;
				return;
			}

			const message = stdinBuffer.subarray(4, 4 + length).toString("utf-8");
			stdinBuffer = stdinBuffer.subarray(4 + length);
			resolve(message);
		};

		tryRead();
	});
}

/** Write a native messaging message to stdout (4-byte LE length + JSON). */
function sendChromeMessage(message: Record<string, unknown>): void {
	const jsonBytes = Buffer.from(JSON.stringify(message), "utf-8");
	const lengthBuffer = Buffer.alloc(4);
	lengthBuffer.writeUInt32LE(jsonBytes.length, 0);
	process.stdout.write(lengthBuffer);
	process.stdout.write(jsonBytes);
}

// ── Stdin buffer management ──────────────────────────────────────────

let stdinBuffer = Buffer.alloc(0);
let stdinClosed = false;
let stdinResolve: ((value: string | null) => void) | null = null;

process.stdin.on("data", (chunk: Buffer) => {
	stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
	if (stdinResolve) {
		const resolve = stdinResolve;
		stdinResolve = null;
		// Re-enter readChromeMessage logic
		const tryRead = (): void => {
			if (stdinBuffer.length < 4) {
				stdinResolve = resolve;
				return;
			}
			const length = stdinBuffer.readUInt32LE(0);
			if (length === 0 || length > MAX_MESSAGE_SIZE) {
				resolve(null);
				return;
			}
			if (stdinBuffer.length < 4 + length) {
				stdinResolve = resolve;
				return;
			}
			const message = stdinBuffer.subarray(4, 4 + length).toString("utf-8");
			stdinBuffer = stdinBuffer.subarray(4 + length);
			resolve(message);
		};
		tryRead();
	}
});

process.stdin.on("end", () => {
	stdinClosed = true;
	if (stdinResolve) {
		const resolve = stdinResolve;
		stdinResolve = null;
		resolve(null);
	}
});

process.stdin.on("error", () => {
	stdinClosed = true;
	if (stdinResolve) {
		const resolve = stdinResolve;
		stdinResolve = null;
		resolve(null);
	}
});

// ── Pi agent socket clients ──────────────────────────────────────────

interface PiClient {
	id: number;
	socket: Socket;
	buffer: Buffer;
}

const piClients = new Map<number, PiClient>();
let nextClientId = 1;

// ── Command routing ──────────────────────────────────────────────────

interface PendingCommand {
	id: number;
	method: string;
	params?: unknown;
}

interface PendingResponse {
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

const pendingResponses = new Map<number, PendingResponse>();
let nextCommandId = 1;

function handleChromeMessage(rawMessage: string): void {
	let message: Record<string, unknown>;
	try {
		message = JSON.parse(rawMessage);
	} catch {
		log("Invalid JSON from Chrome extension");
		sendChromeMessage({ type: "error", error: "Invalid message format" });
		return;
	}

	const msgType = message.type as string | undefined;
	log(`Chrome message: ${msgType}`);

	switch (msgType) {
		case "ping":
			sendChromeMessage({ type: "pong", timestamp: Date.now() });
			break;

		case "identify": {
			const markerName = (message.markerName as string) ?? "";
			void log(`identify received: marker="${markerName}"`);
			handleIdentify(markerName).catch((err) => { log(`Profile resolution failed: ${err}`); });
			break;
		}

		case "get_status":
			sendChromeMessage({
				type: "status_response",
				native_host_version: "1.1.0",
				pi_clients: piClients.size,
				profile: profileIdentity?.profileName ?? null,
			});
			break;

		case "tool_response": {
			const id = message.id as number;
			const pending = pendingResponses.get(id);
			if (pending) {
				clearTimeout(pending.timeout);
				pendingResponses.delete(id);
				if (message.error) {
					pending.reject(new Error(message.error as string));
				} else {
					pending.resolve(message.result);
				}
			}
			// Do NOT forward — the pending promise resolution
			// already sends the response back to the pi client
			break;
		}

		case "notification": {
			// Forward notifications from extension to all pi clients
			if (piClients.size > 0) {
				const { type: _, ...data } = message;
				const notificationData = Buffer.from(JSON.stringify(data), "utf-8");
				const lengthBuffer = Buffer.alloc(4);
				lengthBuffer.writeUInt32LE(notificationData.length, 0);
				const notificationMsg = Buffer.concat([lengthBuffer, notificationData]);
				for (const [, client] of piClients) {
					try { client.socket.write(notificationMsg); } catch {}
				}
			}
			break;
		}

		default:
			log(`Unknown message type from Chrome: ${msgType}`);
	}
}

// ── Unix domain socket server ────────────────────────────────────────

let server: Server | null = null;

async function startSocketServer(): Promise<void> {
	// Clean up stale sockets from dead processes
	try {
		const dirStats = await stat(SOCKET_DIR);
		if (!dirStats.isDirectory()) {
			await unlink(SOCKET_DIR);
		}
	} catch {
		// Doesn't exist, fine
	}

	await mkdir(SOCKET_DIR, { recursive: true, mode: 0o700 });
	await chmod(SOCKET_DIR, 0o700).catch(() => {});

	// Remove stale .sock files for dead PIDs
	try {
		const files = await readdir(SOCKET_DIR);
		for (const file of files) {
			if (!file.endsWith(".sock") && !file.endsWith(".profile.json")) continue;
			const base = file.replace(/\.sock$|\.profile\.json$/, "");
			const pid = parseInt(base, 10);
			if (isNaN(pid)) continue;
			try {
				process.kill(pid, 0);
				// Process is alive — leave its files
			} catch {
				// Process is dead — clean up
				await unlink(join(SOCKET_DIR, file)).catch(() => {});
				log(`Removed stale file for PID ${pid}: ${file}`);
			}
		}
	} catch {
		// Ignore
	}

	server = createServer((socket) => handlePiClient(socket));

	await new Promise<void>((resolve, reject) => {
		server!.listen(SOCKET_PATH, () => {
			log(`Socket server listening at ${SOCKET_PATH}`);
			resolve();
		});
		server!.on("error", reject);
	});

	await chmod(SOCKET_PATH, 0o600).catch(() => {});
}

function handlePiClient(socket: Socket): void {
	const clientId = nextClientId++;
	const client: PiClient = {
		id: clientId,
		socket,
		buffer: Buffer.alloc(0),
	};
	piClients.set(clientId, client);
	log(`Pi client ${clientId} connected. Total: ${piClients.size}`);

	// Notify Chrome extension
	sendChromeMessage({ type: "pi_connected" });

	socket.on("data", (data: Buffer) => {
		client.buffer = Buffer.concat([client.buffer, data]);

		// Process complete messages (4-byte LE length prefix)
		while (client.buffer.length >= 4) {
			const length = client.buffer.readUInt32LE(0);
			if (length === 0 || length > MAX_MESSAGE_SIZE) {
				log(`Invalid message from pi client ${clientId}: length=${length}`);
				socket.destroy();
				return;
			}
			if (client.buffer.length < 4 + length) break;

			const messageBytes = client.buffer.subarray(4, 4 + length);
			client.buffer = client.buffer.subarray(4 + length);

			try {
				const request = JSON.parse(messageBytes.toString("utf-8")) as {
				id?: number;
					method: string;
					params?: unknown;
				};
				log(`Pi client ${clientId} → Chrome: ${request.method}`);

				// Use the client's ID if provided, otherwise generate one
				const id = request.id ?? nextCommandId++;
				const timeout = setTimeout(() => {
					pendingResponses.delete(id);
					// Send error back to pi client
					const errMsg = Buffer.from(
						JSON.stringify({ id, error: `Extension timed out for: ${request.method}` }),
						"utf-8",
					);
					const errLen = Buffer.alloc(4);
					errLen.writeUInt32LE(errMsg.length, 0);
					socket.write(Buffer.concat([errLen, errMsg]));
				}, 30_000);

				pendingResponses.set(id, {
					resolve: (result) => {
						const respBytes = Buffer.from(
							JSON.stringify({ id, result }),
							"utf-8",
						);
						const respLen = Buffer.alloc(4);
						respLen.writeUInt32LE(respBytes.length, 0);
						socket.write(Buffer.concat([respLen, respBytes]));
					},
					reject: (err) => {
						const errMsg = Buffer.from(
							JSON.stringify({ id, error: err instanceof Error ? err.message : String(err) }),
							"utf-8",
						);
						const errLen = Buffer.alloc(4);
						errLen.writeUInt32LE(errMsg.length, 0);
						socket.write(Buffer.concat([errLen, errMsg]));
					},
					timeout,
				});

				// Forward to Chrome extension
				sendChromeMessage({
					type: "tool_request",
					id,
					method: request.method,
					params: request.params,
				});
			} catch (e) {
				log(`Failed to parse pi client ${clientId} message: ${e}`);
			}
		}
	});

	socket.on("error", (err) => {
		log(`Pi client ${clientId} error: ${err}`);
	});

	socket.on("close", () => {
		piClients.delete(clientId);
		log(`Pi client ${clientId} disconnected. Remaining: ${piClients.size}`);
		sendChromeMessage({ type: "pi_disconnected" });
	});
}

async function stopSocketServer(): Promise<void> {
	for (const [, client] of piClients) {
		client.socket.destroy();
	}
	piClients.clear();

	if (server) {
		await new Promise<void>((resolve) => {
			server!.close(() => resolve());
		});
		server = null;
	}

	// Clean up socket and sidecar files
	await unlink(SOCKET_PATH).catch(() => {});
	await removeSidecar();

	// Remove directory if empty
	try {
		const remaining = await readdir(SOCKET_DIR);
		if (remaining.length === 0) {
			await rmdir(SOCKET_DIR);
		}
	} catch {
		// Fine
	}
}

// ── Main loop ────────────────────────────────────────────────────────

async function main(): Promise<void> {
	await log("Native messaging host starting (v1.1.0)...");
	await startSocketServer();
	await log("Ready — waiting for Chrome extension messages on stdin");

	// Process messages from Chrome until stdin closes
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const message = await readChromeMessage();
		if (message === null) {
			// Chrome disconnected (stdin closed)
			await log("Chrome disconnected (stdin closed). Shutting down.");
			break;
		}
		handleChromeMessage(message);
	}

	await stopSocketServer();
	await log("Native messaging host shut down.");
}

main().catch((err) => {
	log(`Fatal error: ${err}`);
	process.exit(1);
});
