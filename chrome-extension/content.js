/**
 * Pi Chrome Bridge — Content Script
 *
 * Injected into all pages. Provides:
 * - DOM-to-Markdown conversion
 * - DOM-to-Structure extraction
 * - Converter script availability check
 *
 * The converter scripts are injected by the background script via
 * chrome.scripting.executeScript when needed. This content script
 * just marks that the page is ready for bridge operations.
 */

// Signal to the background that this page has a content script
chrome.runtime.sendMessage({
  type: "content-script-ready",
  url: window.location.href,
  title: document.title,
}).catch(() => {
  // Extension context may not be ready
});

// Listen for commands from the background script
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "ping") {
    sendResponse({ ok: true, url: window.location.href });
    return true;
  }

  if (msg.type === "has-converters") {
    const has = typeof window.__domToMarkdown === "function";
    sendResponse({ hasConverters: has });
    return true;
  }

  if (msg.type === "inject-converter") {
    // The converter scripts are loaded as separate files
    // The background will inject them via chrome.scripting.executeScript
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
