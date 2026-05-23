#!/usr/bin/env node

/**
 * pi-callback — deliver a message to an active pi CLI session.
 *
 * Usage:
 *   pi-callback <session-id> "check the deploy status"
 *   pi-callback <session-id> --file message.json
 *   echo '{"message":"done"}' | pi-callback <session-id> -
 *
 * The script writes a JSON file to ~/.pi/callbacks/<session-id>/
 * which is picked up by the tau extension's filesystem watcher.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);

if (args.length < 2) {
    process.stderr.write(
        "Usage: pi-callback <session-id> <message>\n" +
            "       pi-callback <session-id> --file <path>\n" +
            '       echo \'{"message":"..."}\' | pi-callback <session-id> -\n'
    );
    process.exit(1);
}

const sessionId = args[0];
const source = args[1];

let payload: { message: string; source?: string };

if (source === "--file") {
    const filePath = args[2];
    if (!filePath) {
        process.stderr.write("Error: --file requires a path argument\n");
        process.exit(1);
    }
    const raw = readFileSync(filePath, "utf-8");
    payload = JSON.parse(raw) as { message: string; source?: string };
} else if (source === "-") {
    // Read from stdin (synchronous for simplicity)
    const chunks: Buffer[] = [];
    let chunk: Buffer;
    while ((chunk = process.stdin.read()) !== null) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf-8");
    payload = JSON.parse(raw) as { message: string; source?: string };
} else {
    // Message is the remaining arguments joined
    payload = { message: args.slice(1).join(" "), source: "external-cli" };
}

if (!payload.message) {
    process.stderr.write("Error: message is required\n");
    process.exit(1);
}

const dir = join(homedir(), ".pi", "callbacks", sessionId);
mkdirSync(dir, { recursive: true });

const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.json`;
const filepath = join(dir, filename);

writeFileSync(filepath, JSON.stringify(payload, null, 2));

process.stdout.write(`Callback delivered to session ${sessionId}: ${filepath}\n`);
