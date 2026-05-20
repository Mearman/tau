/**
 * DOM → Markdown converter.
 *
 * This is serialised to a string and injected via page.evaluate(), so it must:
 * - Be a self-contained arrow function (no closures over outer scope)
 * - Not reference any imports or external variables
 * - Return a plain value (no DOM nodes)
 *
 * It walks the DOM inside the primary content container, converting semantic HTML
 * elements to their Markdown equivalents. Non-content elements (nav, footer, header,
 * aside, script, style) are excluded.
 */
export const domToMarkdown = () => {
    /** Semantic elements that are never content */
    const EXCLUDED_TAGS = new Set([
        "script",
        "style",
        "noscript",
        "svg",
        "nav",
        "footer",
        "header",
        "aside",
        "form",
        "iframe",
    ]);

    /** Elements that create their own block context */
    const BLOCK_TAGS = new Set([
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "div",
        "section",
        "article",
        "main",
        "blockquote",
        "pre",
        "ul",
        "ol",
        "li",
        "table",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "details",
        "summary",
        "figure",
        "figcaption",
        "hr",
        "address",
        "dl",
        "dt",
        "dd",
        "fieldset",
    ]);

    function isBlock(el: Element): boolean {
        return BLOCK_TAGS.has(el.tagName.toLowerCase());
    }

    function isExcluded(el: Element): boolean {
        return EXCLUDED_TAGS.has(el.tagName.toLowerCase());
    }

    function escapeInline(text: string): string {
        return text.replace(/([*_[\]`~>|])/g, "\\$1");
    }

    function processInline(node: Node, out: string[]): void {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent ?? "";
            if (text) out.push(escapeInline(text));
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const el = node as Element;
        const tag = el.tagName.toLowerCase();

        switch (tag) {
            case "strong":
            case "b":
                out.push("**");
                el.childNodes.forEach((c) => processInline(c, out));
                out.push("**");
                break;
            case "em":
            case "i":
                out.push("*");
                el.childNodes.forEach((c) => processInline(c, out));
                out.push("*");
                break;
            case "code":
                // Inline code (not inside <pre>)
                out.push("`");
                out.push(el.textContent ?? "");
                out.push("`");
                break;
            case "a": {
                const href = el.getAttribute("href") ?? "";
                const text = el.textContent?.trim() ?? "";
                if (href && text) {
                    out.push("[");
                    out.push(text);
                    out.push("](");
                    out.push(href);
                    out.push(")");
                } else {
                    el.childNodes.forEach((c) => processInline(c, out));
                }
                break;
            }
            case "br":
                out.push("  \n");
                break;
            case "img": {
                const src = el.getAttribute("src") ?? "";
                const alt = el.getAttribute("alt") ?? "";
                out.push(`![${alt}](${src})`);
                break;
            }
            case "del":
            case "s":
                out.push("~~");
                el.childNodes.forEach((c) => processInline(c, out));
                out.push("~~");
                break;
            default:
                el.childNodes.forEach((c) => processInline(c, out));
        }
    }

    function processBlock(el: Element, out: string[], depth: number): void {
        if (depth > 50) return;
        if (isExcluded(el)) return;

        const tag = el.tagName.toLowerCase();

        switch (tag) {
            case "h1":
            case "h2":
            case "h3":
            case "h4":
            case "h5":
            case "h6": {
                const level = parseInt(tag[1]);
                const inline: string[] = [];
                el.childNodes.forEach((c) => processInline(c, inline));
                out.push(`${"#".repeat(level)} ${inline.join("")}`);
                out.push("");
                break;
            }
            case "p": {
                const inline: string[] = [];
                el.childNodes.forEach((c) => processInline(c, inline));
                out.push(inline.join(""));
                out.push("");
                break;
            }
            case "pre": {
                const codeEl = el.querySelector("code");
                const text = (codeEl ?? el).textContent ?? "";
                const lang =
                    codeEl?.className?.match(/language-(\w+)/)?.[1] ?? "";
                out.push("```" + lang);
                out.push(text);
                out.push("```");
                out.push("");
                break;
            }
            case "blockquote": {
                const inner: string[] = [];
                Array.from(el.children).forEach((child) =>
                    processBlock(child, inner, depth + 1)
                );
                inner.forEach((line) => out.push(`> ${line}`));
                out.push("");
                break;
            }
            case "ul":
            case "ol": {
                const ordered = tag === "ol";
                Array.from(el.children)
                    .filter((c) => c.tagName.toLowerCase() === "li")
                    .forEach((li, i) => {
                        const inline: string[] = [];
                        li.childNodes.forEach((c) => {
                            if (
                                c.nodeType === Node.ELEMENT_NODE &&
                                isBlock(c as Element)
                            ) {
                                const text = inline.join("").trim();
                                if (text)
                                    out.push(
                                        `${ordered ? `${i + 1}.` : "-"} ${text}`
                                    );
                                inline.length = 0;
                                processBlock(c as Element, out, depth + 1);
                            } else {
                                processInline(c, inline);
                            }
                        });
                        const text = inline.join("").trim();
                        if (text)
                            out.push(`${ordered ? `${i + 1}.` : "-"} ${text}`);
                    });
                out.push("");
                break;
            }
            case "table": {
                const rows = Array.from(
                    el.querySelectorAll("thead tr, tbody tr, tfoot tr, tr")
                );
                const parsed = rows.map((row) =>
                    Array.from(row.querySelectorAll("th, td")).map((cell) => {
                        const inline: string[] = [];
                        cell.childNodes.forEach((c) =>
                            processInline(c, inline)
                        );
                        return inline.join("").trim();
                    })
                );
                if (parsed.length === 0) break;
                out.push(`| ${parsed[0].join(" | ")} |`);
                out.push(`| ${parsed[0].map(() => "---").join(" | ")} |`);
                for (let i = 1; i < parsed.length; i++) {
                    out.push(`| ${parsed[i].join(" | ")} |`);
                }
                out.push("");
                break;
            }
            case "hr":
                out.push("---");
                out.push("");
                break;
            case "figure":
                Array.from(el.children).forEach((child) =>
                    processBlock(child, out, depth + 1)
                );
                break;
            case "figcaption": {
                const inline: string[] = [];
                el.childNodes.forEach((c) => processInline(c, inline));
                out.push(`*${inline.join("").trim()}*`);
                out.push("");
                break;
            }
            case "dl":
                Array.from(el.children).forEach((child) => {
                    const childTag = child.tagName.toLowerCase();
                    if (childTag === "dt") {
                        const inline: string[] = [];
                        child.childNodes.forEach((c) =>
                            processInline(c, inline)
                        );
                        out.push(`**${inline.join("").trim()}**`);
                    } else if (childTag === "dd") {
                        const inline: string[] = [];
                        child.childNodes.forEach((c) =>
                            processInline(c, inline)
                        );
                        out.push(`: ${inline.join("").trim()}`);
                    }
                });
                out.push("");
                break;
            case "details": {
                const summary = el.querySelector("summary");
                if (summary) {
                    const inline: string[] = [];
                    summary.childNodes.forEach((c) => processInline(c, inline));
                    out.push(`**${inline.join("").trim()}**`);
                    out.push("");
                }
                Array.from(el.children)
                    .filter((c) => c.tagName.toLowerCase() !== "summary")
                    .forEach((child) => processBlock(child, out, depth + 1));
                break;
            }
            default:
                // Generic container — recurse into children
                Array.from(el.children).forEach((child) =>
                    processBlock(child, out, depth + 1)
                );
        }
    }

    // Find the primary content container
    const container =
        document.querySelector("main") ??
        document.querySelector("article") ??
        document.querySelector("#content") ??
        document.querySelector(".content") ??
        document.body;

    const result: string[] = [];

    if (document.title) {
        result.push(`# ${document.title}`);
        result.push("");
    }

    const meta = document.querySelector('meta[name="description"]');
    const description = meta?.getAttribute("content");
    if (description) {
        result.push(`> ${description}`);
        result.push("");
    }

    result.push(`Source: ${window.location.href}`);
    result.push("");
    result.push("---");
    result.push("");

    Array.from(container.children).forEach((child) =>
        processBlock(child, result, 0)
    );

    return result.join("\n");
};
