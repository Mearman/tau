/**
 * Pi Chrome Bridge — Background Service Worker
 *
 * Communicates with the Pi Chrome Bridge native messaging host.
 * Chrome launches the native host process when we call
 * chrome.runtime.connectNative(). The host relays commands
 * from the pi agent (via Unix domain socket) to this extension.
 *
 * No HTTP polling or separate bridge server needed.
 */

const NATIVE_HOST_NAME = "io.pi.chrome_bridge";

let port = null;
let reconnectTimer = null;
let profileMarkerName = null;

// ── Shared helpers ────────────────────────────────────────────────

/**
 * Run a function in the MAIN world of a tab. Returns the result or
 * throws on error. Bypasses page CSP.
 */
async function executeInPage(tabId, func, args = []) {
	const results = await chrome.scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		func,
		args,
	});
	const result = results[0]?.result;
	if (result && typeof result === "object" && result.__error) {
		throw new Error(result.__error);
	}
	return result;
}

/** Search through shadow roots recursively. */
function deepQuerySelectorScript() {
	return (sel) => {
		function queryDeep(root, sel) {
			const el = root.querySelector(sel);
			if (el) return el;
			for (const child of root.querySelectorAll('*')) {
				if (child.shadowRoot) {
					const found = queryDeep(child.shadowRoot, sel);
					if (found) return found;
				}
			}
			return null;
		}
		function findByText(root, text) {
			const interactive = 'a, button, [role=link], [role=button], [role=row], [role=gridcell], [role=option], [role=tab], [role=menuitem]';
			const candidates = [];
			function collect(r) {
				for (const el of r.querySelectorAll(interactive)) candidates.push(el);
				for (const el of r.querySelectorAll('*')) {
					if (el.shadowRoot) collect(el.shadowRoot);
				}
			}
			collect(root);
			const lower = text.toLowerCase();
			return candidates.find(c =>
				(c.textContent || '').trim().toLowerCase().includes(lower) ||
				(c.getAttribute('aria-label') || '').toLowerCase().includes(lower)
			);
		}
		const el = queryDeep(document, sel) || findByText(document, sel);
		if (!el) return { __error: `Element not found: ${sel}` };
		return el;
	};
}

// ── Command handlers ───────────────────────────────────────────────

const handlers = {
	"ping": async () => ({ ok: true, extensionId: chrome.runtime.id }),

	// Profile identity
	"get-profile-info": async () => {
		const markerName = await getOrCreateProfileMarkerName();
		return { markerName, extensionId: chrome.runtime.id };
	},

	// Tab operations
	"list-tabs": listTabs,
	"new-tab": newTab,
	"close-tab": closeTab,
	"activate-tab": activateTab,
	"duplicate-tab": duplicateTab,
	"move-tab": moveTab,
	"update-tab": updateTab,
	"go-back": goBack,
	"go-forward": goForward,
	"reload-tab": reloadTab,
	"get-tab-url": getTabUrl,

	// Window operations
	"list-windows": listWindows,
	"get-window": getWindow,
	"create-window": createWindow,
	"close-window": closeWindow,
	"update-window": updateWindow,

	// Page interaction
	"get-text": getText,
	"evaluate": evaluateJS,
	"click": click,
	"fill": fill,
	"select-option": selectOption,
	"hover": hover,
	"press-key": pressKey,
	"scroll": scroll,
	"upload-file": uploadFile,
	"get-attributes": getAttributes,
	"wait-for-element": waitForElement,

	// Navigation
	"navigate": navigate,

	// Screenshot
	"screenshot": screenshot,

	// Debugger (CDP)
	"attach-debugger": attachDebugger,
	"detach-debugger": detachDebugger,
	"send-cdp": sendCdp,
};

async function handleToolRequest(msg) {
	const handler = handlers[msg.method];
	if (!handler) {
		return { id: msg.id, error: `Unknown command: ${msg.method}` };
	}
	try {
		const result = await handler(msg.params ?? {});
		return { id: msg.id, type: "tool_response", result };
	} catch (err) {
		return {
			id: msg.id,
			type: "tool_response",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ── Tab listing ─────────────────────────────────────────────────────

async function listTabs(params) {
	const query = {};
	if (params?.windowId) query.windowId = Number(params.windowId);
	const allTabs = await chrome.tabs.query(query);
	return {
		tabs: allTabs
			.filter((tab) => tab.url && !tab.url.startsWith("chrome://"))
			.map((tab) => ({
				id: tab.id,
				windowId: tab.windowId,
				index: tab.index,
				title: tab.title ?? "",
				url: tab.url,
				active: tab.active,
				pinned: tab.pinned,
				audible: tab.audible,
			})),
	};
}

// ── Tab management ──────────────────────────────────────────────────

async function newTab(params) {
	const createOpts = { url: params.url ?? "about:blank" };
	if (params.windowId) createOpts.windowId = Number(params.windowId);
	if (params.active !== undefined) createOpts.active = params.active;
	if (params.index !== undefined) createOpts.index = Number(params.index);
	const tab = await chrome.tabs.create(createOpts);
	return {
		id: tab.id, windowId: tab.windowId, index: tab.index,
		title: tab.title ?? "", url: tab.url ?? (params.url ?? "about:blank"),
		active: tab.active,
	};
}

async function closeTab(params) {
	await chrome.tabs.remove(Number(params.tabId));
	return "ok";
}

async function activateTab(params) {
	const tabId = Number(params.tabId);
	const tab = await chrome.tabs.get(tabId);
	await chrome.tabs.update(tabId, { active: true });
	await chrome.windows.update(tab.windowId, { focused: true });
	return { id: tab.id, windowId: tab.windowId, active: true };
}

async function duplicateTab(params) {
	const tabId = Number(params.tabId);
	const tab = await chrome.tabs.get(tabId);
	const newTab = await chrome.tabs.create({
		url: tab.url,
		windowId: tab.windowId,
		index: tab.index + 1,
		active: params.active ?? false,
	});
	return {
		id: newTab.id, windowId: newTab.windowId, index: newTab.index,
		title: newTab.title ?? "", url: newTab.url,
		active: newTab.active,
	};
}

async function moveTab(params) {
	const tabId = Number(params.tabId);
	const windowId = params.windowId ? Number(params.windowId) : undefined;
	const index = params.index !== undefined ? Number(params.index) : -1;
	const moveOpts = { index };
	if (windowId !== undefined) moveOpts.windowId = windowId;
	const result = await chrome.tabs.move(tabId, moveOpts);
	return { id: result.id, windowId: result.windowId, index: result.index };
}

async function updateTab(params) {
	const tabId = Number(params.tabId);
	const updateOpts = {};
	if (params.url) updateOpts.url = params.url;
	if (params.active !== undefined) updateOpts.active = params.active;
	if (params.pinned !== undefined) updateOpts.pinned = params.pinned;
	if (params.muted !== undefined) updateOpts.muted = params.muted;
	await chrome.tabs.update(tabId, updateOpts);
	return "ok";
}

async function goBack(params) {
	const tabId = Number(params.tabId);
	await executeInPage(tabId, () => {
		history.back();
		return "ok";
	});
	return "ok";
}

async function goForward(params) {
	const tabId = Number(params.tabId);
	await executeInPage(tabId, () => {
		history.forward();
		return "ok";
	});
	return "ok";
}

async function reloadTab(params) {
	const tabId = Number(params.tabId);
	const reloadOpts = {};
	if (params.bypassCache) reloadOpts.bypassCache = true;
	await chrome.tabs.reload(tabId, reloadOpts);
	return "ok";
}

async function getTabUrl(params) {
	const tab = await chrome.tabs.get(Number(params.tabId));
	return { id: tab.id, url: tab.url, title: tab.title };
}

// ── Window management ───────────────────────────────────────────────

async function listWindows() {
	const windows = await chrome.windows.getAll({ populate: true });
	return {
		windows: windows.map((w) => ({
			id: w.id,
			type: w.type,
			state: w.state,
			focused: w.focused,
			top: w.top,
			left: w.left,
			width: w.width,
			height: w.height,
			tabs: (w.tabs || [])
				.filter(t => t.url && !t.url.startsWith("chrome://"))
				.map(t => ({
					id: t.id,
					index: t.index,
					title: t.title ?? "",
					url: t.url,
					active: t.active,
				})),
		})),
	};
}

async function getWindow(params) {
	const windowId = params.windowId ? Number(params.windowId) : chrome.windows.WINDOW_ID_CURRENT;
	const w = await chrome.windows.get(windowId, { populate: true });
	return {
		id: w.id, type: w.type, state: w.state, focused: w.focused,
		top: w.top, left: w.left, width: w.width, height: w.height,
		tabs: (w.tabs || []).map(t => ({
			id: t.id, index: t.index, title: t.title ?? "",
			url: t.url, active: t.active,
		})),
	};
}

async function createWindow(params) {
	const createOpts = {};
	if (params.url) createOpts.url = params.url;
	if (params.width) createOpts.width = Number(params.width);
	if (params.height) createOpts.height = Number(params.height);
	if (params.top !== undefined) createOpts.top = Number(params.top);
	if (params.left !== undefined) createOpts.left = Number(params.left);
	if (params.focused !== undefined) createOpts.focused = params.focused;
	if (params.incognito) createOpts.incognito = true;
	if (params.type) createOpts.type = params.type;
	const w = await chrome.windows.create(createOpts);
	return {
		id: w.id, type: w.type, state: w.state, focused: w.focused,
		tabs: (w.tabs || []).map(t => ({
			id: t.id, index: t.index, title: t.title ?? "",
			url: t.url, active: t.active,
		})),
	};
}

async function closeWindow(params) {
	await chrome.windows.remove(Number(params.windowId));
	return "ok";
}

async function updateWindow(params) {
	const windowId = Number(params.windowId);
	const updateOpts = {};
	if (params.focused !== undefined) updateOpts.focused = params.focused;
	if (params.state) updateOpts.state = params.state;
	if (params.width) updateOpts.width = Number(params.width);
	if (params.height) updateOpts.height = Number(params.height);
	if (params.top !== undefined) updateOpts.top = Number(params.top);
	if (params.left !== undefined) updateOpts.left = Number(params.left);
	await chrome.windows.update(windowId, updateOpts);
	return "ok";
}

// ── Content extraction ───────────────────────────────────────────────

async function getText(params) {
	const tabId = Number(params.tabId);
	const selector = params.selector;
	const results = await chrome.scripting.executeScript({
		target: { tabId },
		func: (sel) => {
			const title = document.title;
			const url = window.location.href;
			const meta = document.querySelector('meta[name="description"]');
			const description = meta?.getAttribute("content") ?? "";
			const container = sel
				? document.querySelector(sel)
				: document.querySelector("main") ??
					document.querySelector("article") ??
					document.querySelector("#content") ??
					document.querySelector(".content") ??
					document.body;
			return { title, url, description, text: container?.innerText ?? "" };
		},
		args: [selector || null],
	});
	const r = results[0]?.result;
	if (!r) return "";
	let out = `Title: ${r.title}\nURL: ${r.url}\n`;
	if (r.description) out += `Description: ${r.description}\n`;
	out += `\n---\n\n${r.text}`;
	return out;
}

// ── Shadow DOM-aware click ─────────────────────────────────────────

async function click(params) {
	const tabId = Number(params.tabId);
	const result = await executeInPage(tabId, (sel) => {
		function queryDeep(root, sel) {
			const el = root.querySelector(sel);
			if (el) return el;
			for (const child of root.querySelectorAll('*')) {
				if (child.shadowRoot) {
					const found = queryDeep(child.shadowRoot, sel);
					if (found) return found;
				}
			}
			return null;
		}
		function findByText(root, text) {
			const interactive = 'a, button, [role=link], [role=button], [role=row], [role=gridcell], [role=option], [role=tab], [role=menuitem]';
			const candidates = [];
			function collect(r) {
				for (const el of r.querySelectorAll(interactive)) candidates.push(el);
				for (const el of r.querySelectorAll('*')) {
					if (el.shadowRoot) collect(el.shadowRoot);
				}
			}
			collect(root);
			const lower = text.toLowerCase();
			return candidates.find(c =>
				(c.textContent || '').trim().toLowerCase().includes(lower) ||
				(c.getAttribute('aria-label') || '').toLowerCase().includes(lower)
			);
		}
		const el = queryDeep(document, sel) || findByText(document, sel);
		if (!el) return { __error: `Element not found: ${sel}` };
		el.click();
		return 'clicked';
	}, [params.selector]);
	return result;
}

// ── Fill input ───────────────────────────────────────────────────────

async function fill(params) {
	const tabId = Number(params.tabId);
	const result = await executeInPage(tabId, (sel, value, clearFirst) => {
		function queryDeep(root, sel) {
			const el = root.querySelector(sel);
			if (el) return el;
			for (const child of root.querySelectorAll('*')) {
				if (child.shadowRoot) {
					const found = queryDeep(child.shadowRoot, sel);
					if (found) return found;
				}
			}
			return null;
		}
		const el = queryDeep(document, sel);
		if (!el) return { __error: `Element not found: ${sel}` };
		if (clearFirst) {
			el.focus();
			el.value = '';
		}
		// Use insertText for native-like input behaviour when clearing
		if (clearFirst && el.value === '') {
			document.execCommand('insertText', false, value);
		} else {
			el.value = value;
		}
		// Dispatch events that frameworks listen to
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
		return 'filled';
	}, [params.selector, params.value, params.clear !== false]);
	return result;
}

// ── Select dropdown option ───────────────────────────────────────────

async function selectOption(params) {
	const tabId = Number(params.tabId);
	const result = await executeInPage(tabId, (sel, value) => {
		function queryDeep(root, sel) {
			const el = root.querySelector(sel);
			if (el) return el;
			for (const child of root.querySelectorAll('*')) {
				if (child.shadowRoot) {
					const found = queryDeep(child.shadowRoot, sel);
					if (found) return found;
				}
			}
			return null;
		}
		const el = queryDeep(document, sel);
		if (!el) return { __error: `Element not found: ${sel}` };
		if (el.tagName !== 'SELECT') return { __error: `Element is not a <select>: ${el.tagName}` };
		el.value = value;
		el.dispatchEvent(new Event('change', { bubbles: true }));
		return 'selected';
	}, [params.selector, params.value]);
	return result;
}

// ── Hover ────────────────────────────────────────────────────────────

async function hover(params) {
	const tabId = Number(params.tabId);
	const result = await executeInPage(tabId, (sel) => {
		function queryDeep(root, sel) {
			const el = root.querySelector(sel);
			if (el) return el;
			for (const child of root.querySelectorAll('*')) {
				if (child.shadowRoot) {
					const found = queryDeep(child.shadowRoot, sel);
					if (found) return found;
				}
			}
			return null;
		}
		const el = queryDeep(document, sel);
		if (!el) return { __error: `Element not found: ${sel}` };
		const rect = el.getBoundingClientRect();
		const x = rect.left + rect.width / 2;
		const y = rect.top + rect.height / 2;
		el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX: x, clientY: y }));
		el.dispatchEvent(new MouseEvent('pointerenter', { bubbles: false, clientX: x, clientY: y }));
		el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
		el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: x, clientY: y }));
		el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
		return 'hovered';
	}, [params.selector]);
	return result;
}

// ── Press key ────────────────────────────────────────────────────────

async function pressKey(params) {
	const tabId = Number(params.tabId);
	const result = await executeInPage(tabId, (key, selector) => {
		let target;
		if (selector) {
			function queryDeep(root, sel) {
				const el = root.querySelector(sel);
				if (el) return el;
				for (const child of root.querySelectorAll('*')) {
					if (child.shadowRoot) {
						const found = queryDeep(child.shadowRoot, sel);
						if (found) return found;
					}
				}
				return null;
			}
			target = queryDeep(document, selector);
		}
		if (!target) target = document.activeElement || document.body;
		const keyEventOpts = { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true };
		// Common key code mappings
		const codeMap = {
			'Enter': 'Enter', 'Tab': 'Tab', 'Escape': 'Escape', 'Backspace': 'Backspace',
			'Delete': 'Delete', 'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
			'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight', ' ': 'Space',
			'Shift': 'ShiftLeft', 'Control': 'ControlLeft', 'Alt': 'AltLeft',
		};
		if (codeMap[key]) keyEventOpts.code = codeMap[key];
		target.dispatchEvent(new KeyboardEvent('keydown', keyEventOpts));
		target.dispatchEvent(new KeyboardEvent('keypress', keyEventOpts));
		target.dispatchEvent(new KeyboardEvent('keyup', keyEventOpts));
		return 'pressed';
	}, [params.key, params.selector || null]);
	return result;
}

// ── Scroll ───────────────────────────────────────────────────────────

async function scroll(params) {
	const tabId = Number(params.tabId);
	const result = await executeInPage(tabId, (sel, direction, amount) => {
		let target = document;
		if (sel) {
			const el = document.querySelector(sel);
			if (el) target = el;
		}
		const scrollTarget = sel ? target : (target.scrollingElement || document.documentElement);
		const px = amount || 300;
		switch (direction) {
			case 'up': scrollTarget.scrollBy(0, -px); break;
			case 'bottom': scrollTarget.scrollTo(0, scrollTarget.scrollHeight); break;
			case 'left': scrollTarget.scrollBy(-px, 0); break;
			case 'right': scrollTarget.scrollBy(px, 0); break;
			case 'top': scrollTarget.scrollTo(0, 0); break;
			default: scrollTarget.scrollBy(0, px); break; // 'down'
		}
		return 'scrolled';
	}, [params.selector || null, params.direction || 'down', params.amount || 300]);
	return result;
}

// ── Upload file ──────────────────────────────────────────────────────

async function uploadFile(params) {
	const tabId = Number(params.tabId);
	// chrome.scripting.executeScript cannot pass File objects across worlds.
	// Instead, set the files property directly via the debugger or DOM.
	// For security, Chrome restricts programmatic file input setting.
	// We use a datasTransfer approach via the isolated world.
	const result = await executeInPage(tabId, (sel, fileNames) => {
		const el = document.querySelector(sel);
		if (!el) return { __error: `Element not found: ${sel}` };
		if (el.type !== 'file') return { __error: `Element is not a file input: ${el.type}` };
		// We can't create real File objects from the extension context,
		// but we can set the value to trigger change events for testing.
		// For real file uploads, the user needs to use the native file picker
		// or the debugger protocol.
		return { __error: 'File upload requires CDP. Use send-cdp with Page.setFileInputFiles.' };
	}, [params.selector, params.files || []]);

	// If the page-level script returned an error about CDP, use the debugger instead
	if (result && typeof result === 'object' && result.__error) {
		// Try via CDP if debugger is attached
		const tab = await chrome.tabs.get(tabId);
		if (attachedTargets.has(tabId)) {
			// Use CDP to set files
			await chrome.debugger.sendCommand(
				attachedTargets.get(tabId),
				'DOM.setFileInputFiles',
				{ objectId: params.selector, files: params.files || [] },
			);
			return 'uploaded';
		}
		throw new Error(result.__error);
	}
	return result;
}

// ── Get attributes ───────────────────────────────────────────────────

async function getAttributes(params) {
	const tabId = Number(params.tabId);
	const result = await executeInPage(tabId, (sel, attrs) => {
		function queryDeep(root, sel) {
			const el = root.querySelector(sel);
			if (el) return el;
			for (const child of root.querySelectorAll('*')) {
				if (child.shadowRoot) {
					const found = queryDeep(child.shadowRoot, sel);
					if (found) return found;
				}
			}
			return null;
		}
		// Multiple elements mode
		const elements = [];
		const found = document.querySelectorAll(sel);
		for (const el of found) elements.push(el);

		if (elements.length === 0) {
			// Try shadow DOM
			for (const child of document.querySelectorAll('*')) {
				if (child.shadowRoot) {
					const found = child.shadowRoot.querySelectorAll(sel);
					for (const el of found) elements.push(el);
				}
			}
		}

		if (elements.length === 0) return { __error: `No elements found: ${sel}` };

		return elements.map(el => {
			if (attrs && attrs.length > 0) {
				const obj = {};
				for (const a of attrs) obj[a] = el.getAttribute(a);
				return obj;
			}
			// Return all attributes
			const obj = {};
			for (const attr of el.attributes) {
				obj[attr.name] = attr.value;
			}
			// Include computed properties
			obj['_text'] = el.textContent?.trim() ?? '';
			obj['_value'] = el.value ?? '';
			obj['_checked'] = el.checked;
			obj['_disabled'] = el.disabled;
			obj['_tagName'] = el.tagName.toLowerCase();
			return obj;
		});
	}, [params.selector, params.attributes || null]);
	return result;
}

// ── Wait for element ─────────────────────────────────────────────────

async function waitForElement(params) {
	const tabId = Number(params.tabId);
	const selector = params.selector;
	const timeout = params.timeout || 10000;
	const interval = params.interval || 200;

	const result = await executeInPage(tabId, (sel, timeoutMs, intervalMs) => {
		return new Promise((resolve) => {
			const check = () => {
				const el = document.querySelector(sel);
				if (el) {
					resolve({ found: true, text: el.textContent?.trim()?.substring(0, 200) ?? '' });
					return;
				}
				// Also check shadow DOMs
				for (const child of document.querySelectorAll('*')) {
					if (child.shadowRoot) {
						const found = child.shadowRoot.querySelector(sel);
						if (found) {
							resolve({ found: true, text: found.textContent?.trim()?.substring(0, 200) ?? '' });
							return;
						}
					}
				}
			};

			// Check immediately
			if (check()) return;

			const start = Date.now();
			const timer = setInterval(() => {
				if (check()) { clearInterval(timer); return; }
				if (Date.now() - start > timeoutMs) {
					clearInterval(timer);
					resolve({ found: false });
				}
			}, intervalMs);
		});
	}, [selector, timeout, interval]);
	return result;
}

// ── JavaScript evaluation ────────────────────────────────────────────

async function evaluateJS(params) {
	const tabId = Number(params.tabId);
	const expression = params.expression;
	// chrome.scripting.executeScript with world: "MAIN" runs in the page's
	// JavaScript context but is NOT subject to the page's CSP.
	const result = await executeInPage(tabId, (expr) => {
		try {
			const value = (0, eval)(expr);
			if (value === undefined) return "undefined";
			if (typeof value === "string") return value;
			try {
				JSON.stringify(value);
				return value;
			} catch {
				return String(value);
			}
		} catch (e) {
			return { __error: e.message };
		}
	}, [expression]);
	if (result === undefined) return "undefined";
	return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

// ── Navigation ──────────────────────────────────────────────────────

async function navigate(params) {
	const tabId = Number(params.tabId);
	await chrome.tabs.update(tabId, { url: params.url });
	return new Promise((resolve) => {
		const listener = (updatedTabId, info) => {
			if (updatedTabId === tabId && info.status === "complete") {
				chrome.tabs.onUpdated.removeListener(listener);
				resolve("ok");
			}
		};
		chrome.tabs.onUpdated.addListener(listener);
		setTimeout(() => {
			chrome.tabs.onUpdated.removeListener(listener);
			resolve("timeout");
		}, 30_000);
	});
}

// ── Screenshot ───────────────────────────────────────────────────────

async function screenshot(params) {
	const tabId = Number(params.tabId);
	const tab = await chrome.tabs.get(tabId);
	// captureVisibleTab requires the tab to be the active tab in a focused
	// window. Activate the tab and focus its window first.
	await chrome.tabs.update(tabId, { active: true });
	await chrome.windows.update(tab.windowId, { focused: true });
	await new Promise((r) => setTimeout(r, 100));
	const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
	return dataUrl.replace(/^data:image\/png;base64,/, "");
}

// ── Debugger (CDP) ──────────────────────────────────────────────────

const attachedTargets = new Map();

async function attachDebugger(params) {
	const tabId = Number(params.tabId);
	const target = { tabId };
	await chrome.debugger.attach(target, "1.3");
	attachedTargets.set(tabId, target);
	return "ok";
}

async function detachDebugger(params) {
	const tabId = Number(params.tabId);
	try { await chrome.debugger.detach(attachedTargets.get(tabId) ?? { tabId }); } catch {}
	attachedTargets.delete(tabId);
	return "ok";
}

async function sendCdp(params) {
	const tabId = Number(params.tabId);
	const target = attachedTargets.get(tabId);
	if (!target) return { error: `Debugger not attached to tab ${tabId}` };
	return await chrome.debugger.sendCommand(target, params.method, params.params ?? {});
}

chrome.debugger.onDetach.addListener((source) => {
	if (source.tabId) attachedTargets.delete(source.tabId);
});

// ── Native messaging connection ─────────────────────────────────────

function connectNative() {
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}

	try {
		port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
		console.log("[Pi Bridge] Connected to native host");

		port.onMessage.addListener(async (message) => {
			console.log("[Pi Bridge] ← Chrome:", message.type ?? message.method);

			if (message.type === "tool_request") {
				const response = await handleToolRequest(message);
				port?.postMessage(response);
			} else if (message.type === "pi_connected") {
				console.log("[Pi Bridge] Pi agent connected");
			} else if (message.type === "pi_disconnected") {
				console.log("[Pi Bridge] Pi agent disconnected");
			}
		});

		port.onDisconnect.addListener(() => {
			const error = chrome.runtime.lastError?.message;
			console.log("[Pi Bridge] Disconnected:", error ?? "unknown");
			port = null;
			reconnectTimer = setTimeout(connectNative, 500);
		});

		// Identify ourselves via a per-profile marker cookie.
		const markerName = getOrCreateProfileMarkerName();
		console.log("[Pi Bridge] Profile marker:", markerName);
		port?.postMessage({
			type: "identify",
			markerName,
			extensionId: chrome.runtime.id,
		});
		void writeProfileMarkerCookie(markerName).catch((err) => {
			console.warn("[Pi Bridge] Failed to write marker cookie:", err);
		});
	} catch (err) {
		console.error("[Pi Bridge] Failed to connect:", err);
		reconnectTimer = setTimeout(connectNative, 5000);
	}
}

/** Create or load a per-profile marker name. */
function getOrCreateProfileMarkerName() {
	if (profileMarkerName) return profileMarkerName;
	const randomPart =
		globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
			? globalThis.crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	profileMarkerName = `pi_profile_marker_${randomPart}`;
	return profileMarkerName;
}

/** Write a marker cookie into the current profile. */
async function writeProfileMarkerCookie(markerName) {
	return await new Promise((resolve, reject) => {
		chrome.cookies.set(
			{
				url: "http://localhost/",
				name: markerName,
				value: "1",
				path: "/",
			},
			(cookie) => {
				const error = chrome.runtime.lastError;
				if (error) {
					reject(new Error(error.message));
					return;
				}
				resolve(cookie);
			}
		);
	});
}

// ── Startup ──────────────────────────────────────────────────────────

console.log("[Pi Bridge] Service worker starting, extensionId=" + chrome.runtime.id);
connectNative();

// Keep service worker alive via alarms
chrome.alarms.create("keepalive", { periodInMinutes: 0.1 });
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "keepalive") {
		if (port) {
			port.postMessage({ type: "ping" });
		} else {
			connectNative();
		}
	}
});
