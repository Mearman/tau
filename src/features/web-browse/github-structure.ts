/**
 * GitHub-aware structure extraction.
 *
 * When web_browse (format: 'structure') receives a github.com/<owner>/<repo>
 * URL, this module shallow-clones the repo and returns the file tree, README,
 * and key metadata instead of the rendered DOM. This mirrors what pi-web-access
 * does — the DOM-rendered GitHub page is a poor representation of the actual
 * repository structure.
 *
 * Falls back gracefully: if git is not available, the clone fails, or the URL
 * is not a repo root, the caller should proceed with the normal DOM walk.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Match github.com/<owner>/<repo> with optional trailing path. */
const GITHUB_REPO_RE =
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\/|$)/;

/**
 * Test whether a URL is a GitHub repository root that we can clone.
 * Returns extracted owner/repo or undefined.
 */
export function matchGitHubRepo(
    url: string
): { owner: string; repo: string } | undefined {
    const match = GITHUB_REPO_RE.exec(url);
    if (!match) return undefined;
    const [, owner, repo] = match;
    // Skip non-repo paths (e.g. /features, /settings, /issues when not a repo root)
    if (
        repo === "features" ||
        repo === "settings" ||
        repo === "notifications" ||
        repo === "marketplace"
    ) {
        return undefined;
    }
    return { owner, repo };
}

export interface GitHubStructureResult {
    format: "github-repo";
    owner: string;
    repo: string;
    /** Shallow-clone URL used. */
    cloneUrl: string;
    /** README content (first 5000 chars), or note if absent. */
    readme: string;
    /** File tree as nested paths. */
    files: string[];
    /** Total file count. */
    fileCount: number;
    /** Top-level directory listing with types. */
    topLevel: Array<{ name: string; type: "file" | "dir" }>;
    /** Languages detected from file extensions. */
    languages: string[];
}

/**
 * Attempt to extract structured data from a GitHub repo by shallow-cloning.
 * Returns the structured result, or throws if the clone fails.
 * The caller should catch and fall back to DOM mode.
 */
export function extractRepoStructure(
    owner: string,
    repo: string
): GitHubStructureResult {
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;
    const tmpDir = mkdtempSync(join(tmpdir(), `pi-gh-${repo}-`));

    try {
        // Shallow clone (depth 1, no blobs for large files)
        execSync(
            `git clone --depth 1 --filter=blob:limit=1m "${cloneUrl}" "${tmpDir}" 2>&1`,
            { timeout: 30_000, encoding: "utf-8" }
        );

        // Get the file tree (tracked files only, no .git)
        const filesRaw = execSync(
            `git -C "${tmpDir}" ls-tree -r --name-only HEAD`,
            { encoding: "utf-8" }
        );
        const files = filesRaw.trim().split("\n").filter(Boolean);

        // Top-level listing with types
        const topRaw = execSync(`git -C "${tmpDir}" ls-tree --name-only HEAD`, {
            encoding: "utf-8",
        });
        const topLevelNames = topRaw.trim().split("\n").filter(Boolean);
        const topLevel = topLevelNames.map((name) => ({
            name,
            type:
                existsSync(join(tmpDir, name)) &&
                !existsSync(join(tmpDir, name, "."))
                    ? ("dir" as const)
                    : ("file" as const),
        }));

        // README (try common names)
        const readmeNames = [
            "README.md",
            "README.mkd",
            "README.rst",
            "README.txt",
            "README",
        ];
        let readme = "(no README found)";
        for (const name of readmeNames) {
            const path = join(tmpDir, name);
            if (existsSync(path)) {
                const content = readFileSync(path, "utf-8");
                readme =
                    content.length > 5000
                        ? content.slice(0, 5000) + "\n\n[...truncated]"
                        : content;
                break;
            }
        }

        // Detect languages from file extensions
        const extSet = new Set<string>();
        for (const file of files) {
            const dot = file.lastIndexOf(".");
            if (dot >= 0 && dot > file.lastIndexOf("/")) {
                extSet.add(file.slice(dot + 1).toLowerCase());
            }
        }
        const languages = Array.from(extSet).sort();

        return {
            format: "github-repo",
            owner,
            repo,
            cloneUrl,
            readme,
            files,
            fileCount: files.length,
            topLevel,
            languages,
        };
    } finally {
        // Always clean up the clone
        rmSync(tmpDir, { recursive: true, force: true });
    }
}
