/**
 * Pi Chrome Bridge — DOM-to-Structure converter (injected on demand).
 *
 * Plain-JS port of src/features/web-browse/structure.ts. Loaded by the
 * background service worker via chrome.scripting.executeScript with
 * world: "MAIN" and injects window.__domToStructure into the page.
 *
 * Idempotent: skips re-injection if the global is already present.
 *
 * Keep in sync with the TypeScript source. The two diverge when the
 * converter logic itself changes; both are tested via the Node-side
 * addInitScript path.
 */
(function () {
    if (typeof window.__domToStructure === "function") return;

    window.__domToStructure = function () {
        var EXCLUDED_TAGS = new Set([
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

        function text(el) {
            var t = el.textContent;
            return t ? t.trim() : "";
        }

        function parseList(listEl, kind) {
            var items = Array.from(listEl.children)
                .filter(function (c) {
                    return c.tagName.toLowerCase() === "li";
                })
                .map(function (li) {
                    var nestedList = li.querySelector("ul, ol");
                    if (nestedList) {
                        var liText = text(li.cloneNode(true)).split("\n")[0];
                        var cleanLiText = liText ? liText.trim() : "";
                        var nested = parseList(
                            nestedList,
                            nestedList.tagName.toLowerCase() === "ol"
                                ? "ordered"
                                : "unordered"
                        );
                        return { text: cleanLiText, children: nested };
                    }
                    return { text: text(li) };
                });
            return { ordered: kind === "ordered", items: items };
        }

        function parseTable(tableEl) {
            var allRows = Array.from(
                tableEl.querySelectorAll("thead tr, tbody tr, tfoot tr, tr")
            );
            var parsed = allRows.map(function (row) {
                return Array.from(row.querySelectorAll("th, td")).map(function (
                    cell
                ) {
                    return text(cell);
                });
            });
            if (parsed.length === 0) return { headers: [], rows: [] };
            return { headers: parsed[0], rows: parsed.slice(1) };
        }

        var container =
            document.querySelector("main") ||
            document.querySelector("article") ||
            document.querySelector("#content") ||
            document.querySelector(".content") ||
            document.body;

        var headings = [];
        container.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach(function (
            h
        ) {
            var heading = {
                level: parseInt(h.tagName[1]),
                text: text(h),
            };
            if (h.id) heading.id = h.id;
            headings.push(heading);
        });

        var links = [];
        container.querySelectorAll("a[href]").forEach(function (a) {
            var t = text(a);
            if (t && a.href && !a.href.startsWith("javascript:")) {
                links.push({ text: t, href: a.href });
            }
        });

        var sections = [];
        var current = { heading: null, level: 0, content: [] };

        function push() {
            if (current.content.length > 0 || current.heading !== null) {
                sections.push(current);
            }
        }

        function walk(el) {
            var tag = el.tagName.toLowerCase();
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
                    var t = text(el);
                    if (t) current.content.push({ type: "paragraph", text: t });
                    break;
                }
                case "ul":
                case "ol":
                    current.content.push({
                        type: "list",
                        ordered: tag === "ol",
                        items: parseList(
                            el,
                            tag === "ol" ? "ordered" : "unordered"
                        ).items,
                    });
                    break;
                case "table":
                    current.content.push({
                        type: "table",
                        headers: parseTable(el).headers,
                        rows: parseTable(el).rows,
                    });
                    break;
                case "pre": {
                    var codeEl = el.querySelector("code");
                    var preText = (codeEl || el).textContent || "";
                    var preLang =
                        (codeEl &&
                            codeEl.className &&
                            codeEl.className.match(/language-(\w+)/)
                                ? codeEl.className.match(/language-(\w+)/)[1]
                                : "") || "";
                    current.content.push({
                        type: "code",
                        language: preLang,
                        text: preText,
                    });
                    break;
                }
                case "blockquote":
                    current.content.push({
                        type: "blockquote",
                        text: text(el),
                    });
                    break;
                case "img":
                    current.content.push({
                        type: "image",
                        src: el.getAttribute("src") || "",
                        alt: el.getAttribute("alt") || "",
                    });
                    break;
                case "hr":
                    current.content.push({ type: "hr" });
                    break;
                case "figure":
                    Array.from(el.children).forEach(walk);
                    break;
                case "figcaption": {
                    var figText = text(el);
                    if (figText)
                        current.content.push({
                            type: "paragraph",
                            text: figText,
                        });
                    break;
                }
                default:
                    Array.from(el.children).forEach(walk);
            }
        }

        Array.from(container.children).forEach(walk);
        push();

        var descEl = document.querySelector('meta[name="description"]');
        var description = descEl ? descEl.getAttribute("content") || "" : "";

        return {
            title: document.title,
            url: window.location.href,
            description: description,
            headings: headings,
            sections: sections,
            links: links,
        };
    };
})();
