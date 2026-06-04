/**
 * Pi Chrome Bridge — DOM-to-Markdown converter (injected on demand).
 *
 * Plain-JS port of src/features/web-browse/markdown.ts. Loaded by the
 * background service worker via chrome.scripting.executeScript with
 * world: "MAIN" and injects window.__domToMarkdown into the page.
 *
 * Idempotent: skips re-injection if the global is already present.
 *
 * Keep in sync with the TypeScript source. The two diverge when the
 * converter logic itself changes; both are tested via the Node-side
 * addInitScript path.
 */
(function () {
    if (typeof window.__domToMarkdown === "function") return;

    window.__domToMarkdown = function () {
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

        var BLOCK_TAGS = new Set([
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

        function isBlock(el) {
            return BLOCK_TAGS.has(el.tagName.toLowerCase());
        }

        function isExcluded(el) {
            return EXCLUDED_TAGS.has(el.tagName.toLowerCase());
        }

        function escapeInline(text) {
            return text.replace(/([*_[\]`~>|])/g, "\\$1");
        }

        function processInline(node, out) {
            if (node.nodeType === Node.TEXT_NODE) {
                var text = node.textContent || "";
                if (text) out.push(escapeInline(text));
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;

            var el = node;
            var tag = el.tagName.toLowerCase();

            switch (tag) {
                case "strong":
                case "b":
                    out.push("**");
                    el.childNodes.forEach(function (c) {
                        processInline(c, out);
                    });
                    out.push("**");
                    break;
                case "em":
                case "i":
                    out.push("*");
                    el.childNodes.forEach(function (c) {
                        processInline(c, out);
                    });
                    out.push("*");
                    break;
                case "code":
                    out.push("`");
                    out.push(el.textContent || "");
                    out.push("`");
                    break;
                case "a": {
                    var href = el.getAttribute("href") || "";
                    var aText = (el.textContent || "").trim();
                    if (href && aText) {
                        out.push("[");
                        out.push(aText);
                        out.push("](");
                        out.push(href);
                        out.push(")");
                    } else {
                        el.childNodes.forEach(function (c) {
                            processInline(c, out);
                        });
                    }
                    break;
                }
                case "br":
                    out.push("  \n");
                    break;
                case "img": {
                    var src = el.getAttribute("src") || "";
                    var alt = el.getAttribute("alt") || "";
                    out.push("![" + alt + "](" + src + ")");
                    break;
                }
                case "del":
                case "s":
                    out.push("~~");
                    el.childNodes.forEach(function (c) {
                        processInline(c, out);
                    });
                    out.push("~~");
                    break;
                default:
                    el.childNodes.forEach(function (c) {
                        processInline(c, out);
                    });
            }
        }

        function processBlock(el, out, depth) {
            if (depth > 50) return;
            if (isExcluded(el)) return;

            var tag = el.tagName.toLowerCase();

            switch (tag) {
                case "h1":
                case "h2":
                case "h3":
                case "h4":
                case "h5":
                case "h6": {
                    var level = parseInt(tag[1]);
                    var inline = [];
                    el.childNodes.forEach(function (c) {
                        processInline(c, inline);
                    });
                    out.push("#".repeat(level) + " " + inline.join(""));
                    out.push("");
                    break;
                }
                case "p": {
                    var pInline = [];
                    el.childNodes.forEach(function (c) {
                        processInline(c, pInline);
                    });
                    out.push(pInline.join(""));
                    out.push("");
                    break;
                }
                case "pre": {
                    var codeEl = el.querySelector("code");
                    var preText = (codeEl || el).textContent || "";
                    var preLang =
                        (codeEl &&
                            codeEl.className &&
                            codeEl.className.match(/language-(\w+)/)
                                ? codeEl.className.match(/language-(\w+)/)[1]
                                : "") || "";
                    out.push("```" + preLang);
                    out.push(preText);
                    out.push("```");
                    out.push("");
                    break;
                }
                case "blockquote": {
                    var inner = [];
                    Array.from(el.children).forEach(function (child) {
                        processBlock(child, inner, depth + 1);
                    });
                    inner.forEach(function (line) {
                        out.push("> " + line);
                    });
                    out.push("");
                    break;
                }
                case "ul":
                case "ol": {
                    var ordered = tag === "ol";
                    Array.from(el.children)
                        .filter(function (c) {
                            return c.tagName.toLowerCase() === "li";
                        })
                        .forEach(function (li, i) {
                            var liInline = [];
                            li.childNodes.forEach(function (c) {
                                if (
                                    c.nodeType === Node.ELEMENT_NODE &&
                                    isBlock(c)
                                ) {
                                    var text = liInline.join("").trim();
                                    if (text)
                                        out.push(
                                            (ordered ? i + 1 + "." : "-") +
                                                " " +
                                                text
                                        );
                                    liInline.length = 0;
                                    processBlock(c, out, depth + 1);
                                } else {
                                    processInline(c, liInline);
                                }
                            });
                            var text = liInline.join("").trim();
                            if (text)
                                out.push(
                                    (ordered ? i + 1 + "." : "-") + " " + text
                                );
                        });
                    out.push("");
                    break;
                }
                case "table": {
                    var rows = Array.from(
                        el.querySelectorAll(
                            "thead tr, tbody tr, tfoot tr, tr"
                        )
                    );
                    var parsed = rows.map(function (row) {
                        return Array.from(
                            row.querySelectorAll("th, td")
                        ).map(function (cell) {
                            var cellInline = [];
                            cell.childNodes.forEach(function (c) {
                                processInline(c, cellInline);
                            });
                            return cellInline.join("").trim();
                        });
                    });
                    if (parsed.length === 0) break;
                    out.push("| " + parsed[0].join(" | ") + " |");
                    out.push(
                        "| " +
                            parsed[0]
                                .map(function () {
                                    return "---";
                                })
                                .join(" | ") +
                            " |"
                    );
                    for (var t = 1; t < parsed.length; t++) {
                        out.push("| " + parsed[t].join(" | ") + " |");
                    }
                    out.push("");
                    break;
                }
                case "hr":
                    out.push("---");
                    out.push("");
                    break;
                case "figure":
                    Array.from(el.children).forEach(function (child) {
                        processBlock(child, out, depth + 1);
                    });
                    break;
                case "figcaption": {
                    var figInline = [];
                    el.childNodes.forEach(function (c) {
                        processInline(c, figInline);
                    });
                    out.push("*" + figInline.join("").trim() + "*");
                    out.push("");
                    break;
                }
                case "dl":
                    Array.from(el.children).forEach(function (child) {
                        var childTag = child.tagName.toLowerCase();
                        if (childTag === "dt") {
                            var dtInline = [];
                            child.childNodes.forEach(function (c) {
                                processInline(c, dtInline);
                            });
                            out.push("**" + dtInline.join("").trim() + "**");
                        } else if (childTag === "dd") {
                            var ddInline = [];
                            child.childNodes.forEach(function (c) {
                                processInline(c, ddInline);
                            });
                            out.push(": " + ddInline.join("").trim());
                        }
                    });
                    out.push("");
                    break;
                case "details": {
                    var summary = el.querySelector("summary");
                    if (summary) {
                        var sumInline = [];
                        summary.childNodes.forEach(function (c) {
                            processInline(c, sumInline);
                        });
                        out.push("**" + sumInline.join("").trim() + "**");
                        out.push("");
                    }
                    Array.from(el.children)
                        .filter(function (c) {
                            return c.tagName.toLowerCase() !== "summary";
                        })
                        .forEach(function (child) {
                            processBlock(child, out, depth + 1);
                        });
                    break;
                }
                default:
                    Array.from(el.children).forEach(function (child) {
                        processBlock(child, out, depth + 1);
                    });
            }
        }

        var container =
            document.querySelector("main") ||
            document.querySelector("article") ||
            document.querySelector("#content") ||
            document.querySelector(".content") ||
            document.body;

        var result = [];

        if (document.title) {
            result.push("# " + document.title);
            result.push("");
        }

        var meta = document.querySelector('meta[name="description"]');
        var description = meta ? meta.getAttribute("content") : null;
        if (description) {
            result.push("> " + description);
            result.push("");
        }

        result.push("Source: " + window.location.href);
        result.push("");
        result.push("---");
        result.push("");

        Array.from(container.children).forEach(function (child) {
            processBlock(child, result, 0);
        });

        return result.join("\n");
    };
})();
