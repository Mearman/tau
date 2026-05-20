/**
 * DOM → structured content converter.
 *
 * Same constraints as markdown.ts: self-contained, no closures, no imports.
 * Returns a JSON-safe object describing the page structure with sections,
 * content blocks, headings, and links.
 */
export const domToStructure = () => {
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

    function text(el: Element): string {
        return el.textContent?.trim() ?? "";
    }

    function parseList(
        listEl: Element,
        kind: "ordered" | "unordered"
    ): { ordered: boolean; items: unknown[] } {
        const items = Array.from(listEl.children)
            .filter((c) => c.tagName.toLowerCase() === "li")
            .map((li) => {
                const nestedList = li.querySelector("ul, ol");
                if (nestedList) {
                    const liText =
                        text(li.cloneNode(true) as Element)
                            .split("\n")[0]
                            ?.trim() ?? "";
                    const nested = parseList(
                        nestedList,
                        nestedList.tagName.toLowerCase() === "ol"
                            ? "ordered"
                            : "unordered"
                    );
                    return { text: liText, children: nested };
                }
                return { text: text(li) };
            });
        return { ordered: kind === "ordered", items };
    }

    function parseTable(tableEl: Element): {
        headers: string[];
        rows: string[][];
    } {
        const allRows = Array.from(
            tableEl.querySelectorAll("thead tr, tbody tr, tfoot tr, tr")
        );
        const parsed = allRows.map((row) =>
            Array.from(row.querySelectorAll("th, td")).map((cell) => text(cell))
        );
        if (parsed.length === 0) return { headers: [], rows: [] };
        return { headers: parsed[0], rows: parsed.slice(1) };
    }

    const container =
        document.querySelector("main") ??
        document.querySelector("article") ??
        document.querySelector("#content") ??
        document.querySelector(".content") ??
        document.body;

    // Collect all headings
    const headings: { level: number; text: string; id?: string }[] = [];
    container.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
        headings.push({
            level: parseInt(h.tagName[1]),
            text: h.textContent?.trim() ?? "",
            id: h.id || undefined,
        });
    });

    // Collect all links
    const links: { text: string; href: string }[] = [];
    container.querySelectorAll("a[href]").forEach((a) => {
        const anchor = a as HTMLAnchorElement;
        const t = anchor.textContent?.trim() ?? "";
        if (t && anchor.href && !anchor.href.startsWith("javascript:")) {
            links.push({ text: t, href: anchor.href });
        }
    });

    // Walk DOM to build sections
    interface Section {
        heading: string | null;
        level: number;
        content: unknown[];
    }

    const sections: Section[] = [];
    let current: Section = { heading: null, level: 0, content: [] };

    function push(): void {
        if (current.content.length > 0 || current.heading !== null) {
            sections.push(current);
        }
    }

    function walk(el: Element): void {
        const tag = el.tagName.toLowerCase();
        if (EXCLUDED_TAGS.has(tag)) return;

        if (/^h[1-6]$/.test(tag)) {
            push();
            current = {
                heading: text(el),
                level: parseInt(tag[1]),
                content: [],
            };
            return;
        }

        switch (tag) {
            case "p": {
                const t = text(el);
                if (t) current.content.push({ type: "paragraph", text: t });
                break;
            }
            case "ul":
            case "ol":
                current.content.push({
                    type: "list",
                    ...parseList(el, tag === "ol" ? "ordered" : "unordered"),
                });
                break;
            case "table":
                current.content.push({ type: "table", ...parseTable(el) });
                break;
            case "pre": {
                const codeEl = el.querySelector("code");
                const t = (codeEl ?? el).textContent ?? "";
                const lang =
                    codeEl?.className?.match(/language-(\w+)/)?.[1] ?? "";
                current.content.push({ type: "code", language: lang, text: t });
                break;
            }
            case "blockquote":
                current.content.push({ type: "blockquote", text: text(el) });
                break;
            case "img":
                current.content.push({
                    type: "image",
                    src: el.getAttribute("src") ?? "",
                    alt: el.getAttribute("alt") ?? "",
                });
                break;
            case "hr":
                current.content.push({ type: "hr" });
                break;
            case "figure":
                Array.from(el.children).forEach(walk);
                break;
            case "figcaption": {
                const t = text(el);
                if (t) current.content.push({ type: "paragraph", text: t });
                break;
            }
            default:
                Array.from(el.children).forEach(walk);
        }
    }

    Array.from(container.children).forEach(walk);
    push();

    return {
        title: document.title,
        url: window.location.href,
        description:
            document
                .querySelector('meta[name="description"]')
                ?.getAttribute("content") ?? "",
        headings,
        sections,
        links,
    };
};
