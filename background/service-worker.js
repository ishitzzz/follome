/**
 * FolloMe — Background Service Worker
 * Handles tab management and message routing between popup and content scripts.
 */

const AI_URLS = {
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/app',
  claude: 'https://claude.ai/new'
};

const AI_PATTERNS = [
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'claude.ai'
];

/**
 * Restricted URL patterns where content scripts cannot run.
 * Messaging to these pages must be blocked before any sendMessage call.
 */
const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'devtools://',
  'view-source:',
  'chrome-search://',
  'chrome-untrusted://',
];

const RESTRICTED_DOMAINS = [
  'chromewebstore.google.com',
  'addons.mozilla.org',
  'microsoftedge.microsoft.com/addons',
];

let sourceTabId = null;
let aiTabId = null;

function isAIUrl(url) {
  return AI_PATTERNS.some(p => url?.includes(p));
}

/**
 * Check if a URL is restricted (cannot host content scripts).
 * @param {string|undefined} url
 * @returns {{ restricted: boolean, reason: string }}
 */
function checkRestricted(url) {
  if (!url) {
    return { restricted: true, reason: 'no URL available' };
  }

  for (const prefix of RESTRICTED_PREFIXES) {
    if (url.startsWith(prefix)) {
      return { restricted: true, reason: `restricted prefix: ${prefix}` };
    }
  }

  for (const domain of RESTRICTED_DOMAINS) {
    if (url.includes(domain)) {
      return { restricted: true, reason: `restricted domain: ${domain}` };
    }
  }

  // data: and blob: URLs also can't host content scripts
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    return { restricted: true, reason: `unsupported scheme: ${url.split(':')[0]}` };
  }

  return { restricted: false, reason: '' };
}

async function findAITab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find(tab => tab.url && isAIUrl(tab.url)) || null;
}

/**
 * Inject content scripts into a tab.
 * Returns true if injection succeeded, false otherwise.
 */
async function injectContentScripts(tabId, tab) {
  try {
    if (isAIUrl(tab.url)) {
      let adapterJs = 'adapters/chatgpt-adapter.js';
      if (tab.url.includes('gemini')) adapterJs = 'adapters/gemini-adapter.js';
      if (tab.url.includes('claude')) adapterJs = 'adapters/claude-adapter.js';

      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'utils/storage.js', 'utils/analytics.js',
          'adapters/base-adapter.js', adapterJs,
          'adapters/router.js', 'content/ai-content.js'
        ]
      });
      console.log(`[FolloMe] Injected AI content scripts into tab ${tabId}`);
    } else {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'utils/storage.js', 'utils/analytics.js',
          'utils/context-extractor.js', 'utils/element-matcher.js',
          'content/cursor-guide.js', 'content/overlay.js',
          'content/speech.js', 'content/content.js'
        ]
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/overlay.css', 'content/cursor-guide.css']
      });
      console.log(`[FolloMe] Injected main content scripts + CSS into tab ${tabId}`);
    }
    return true;
  } catch (err) {
    console.error(`[FolloMe] Script injection failed for tab ${tabId}: ${err.message}`);
    return false;
  }
}

/**
 * Verify a content script listener is alive on a tab.
 * @param {number} tabId
 * @param {'PING'|'PING_AI'} pingType
 * @returns {Promise<boolean>}
 */
async function pingTab(tabId, pingType = 'PING') {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: pingType });
    const alive = pingType === 'PING_AI'
      ? response?.status === 'alive_ai'
      : response?.status === 'alive';
    return alive;
  } catch {
    return false;
  }
}

/**
 * Safely send a message to a tab.
 * - Blocks restricted pages before any sendMessage call.
 * - If receiver is missing, injects content scripts and retries once.
 * - Logs full diagnostics on every outcome.
 */
async function safeSendMessage(tabId, message) {
  const logPrefix = `[FolloMe] safeSendMessage(tab=${tabId}, type=${message.type})`;

  // ── Step 1: Get tab info ──
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (err) {
    console.error(`${logPrefix} — tab does not exist or was closed: ${err.message}`);
    return null;
  }

  // ── Step 2: Block restricted pages ──
  const { restricted, reason } = checkRestricted(tab.url);
  if (restricted) {
    console.warn(`${logPrefix} — BLOCKED: ${reason} (url: ${tab.url})`);
    return null;
  }

  console.log(`${logPrefix} — target URL: ${tab.url}`);

  // ── Step 3: Attempt to send message ──
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    console.log(`${logPrefix} — SUCCESS, response:`, response);
    return response;
  } catch (err) {
    // ── Step 4: Handle "Receiving end does not exist" ──
    if (err.message.includes('Receiving end does not exist')) {
      console.warn(`${logPrefix} — no listener found. Attempting script injection...`);

      const injected = await injectContentScripts(tabId, tab);
      if (!injected) {
        console.error(`${logPrefix} — injection FAILED. Cannot deliver message.`);
        return null;
      }

      // Wait for script initialization (300ms gives time for IIFE + listener registration)
      await new Promise(r => setTimeout(r, 300));

      // Verify listener is now present before retrying
      const pingType = isAIUrl(tab.url) ? 'PING_AI' : 'PING';
      const alive = await pingTab(tabId, pingType);
      if (!alive) {
        console.error(`${logPrefix} — injection succeeded but listener is STILL NOT responding. Aborting.`);
        return null;
      }

      // ── Step 5: Retry once ──
      try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        console.log(`${logPrefix} — SUCCESS after injection, response:`, response);
        return response;
      } catch (retryErr) {
        console.error(`${logPrefix} — FAILED after injection retry: ${retryErr.message}`);
        return null;
      }
    }

    // Some other error
    console.error(`${logPrefix} — unexpected error: ${err.message}`);
    return null;
  }
}

/**
 * Ensure an AI content script is alive
 */
async function ensureAIContentScript(tabId) {
  const response = await safeSendMessage(tabId, { type: 'PING_AI' });
  return response?.status === 'alive_ai';
}

/**
 * Wait for an AI tab to load and the content script to be ready
 */
async function waitForAITab(tabId, timeout = 15000) {
  const start = Date.now();
  console.log(`[FolloMe] Waiting for AI tab ${tabId} to be ready...`);

  while (Date.now() - start < timeout) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        const alive = await ensureAIContentScript(tabId);
        if (alive) {
          console.log(`[FolloMe] AI tab ${tabId} is ready and listening.`);
          return true;
        }
      }
    } catch (e) {
      // Tab might have been closed
      console.warn(`[FolloMe] AI tab ${tabId} check failed: ${e.message}`);
      return false;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.error(`[FolloMe] Timeout waiting for AI tab ${tabId}`);
  return false;
}

// ── Message Router ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTabId = sender.tab?.id ?? 'popup/extension';
  const senderUrl = sender.tab?.url ?? sender.url ?? 'unknown';
  console.log(`[FolloMe] onMessage: type=${message.type}, sender tab=${senderTabId}, url=${senderUrl}`);

  handleMessage(message, sender)
    .then(result => {
      sendResponse(result || { status: 'ok' });
    })
    .catch(err => {
      console.error(`[FolloMe] handleMessage error for ${message.type}:`, err);
      sendResponse({ status: 'error', error: err.message });
    });

  return true; // Keep channel open for async sendResponse
});

async function handleMessage(message, sender) {
  if (message.type === 'START_ANALYSIS') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) {
      console.warn('[FolloMe] START_ANALYSIS — no active tab found');
      return { status: 'error', error: 'No active tab' };
    }

    const tab = tabs[0];
    const { restricted, reason } = checkRestricted(tab.url);
    if (restricted) {
      console.warn(`[FolloMe] START_ANALYSIS — active tab is restricted: ${reason}`);
      return { status: 'error', error: `This page is not supported (${reason}). Please navigate to a regular webpage.` };
    }

    sourceTabId = tab.id;
    const result = await safeSendMessage(sourceTabId, { type: 'ANALYZE_PAGE', question: message.question || '' });
    if (result) {
      return { status: 'started' };
    } else {
      return { status: 'error', error: 'Could not communicate with the page. Try reloading.' };
    }
  }

  else if (message.type === 'SEND_TO_AI') {
    console.log('[FolloMe] Context extracted, routing to AI...');
    sourceTabId = sender.tab?.id || sourceTabId;
    const { prompt } = message;

    // STEP 1: Ensure AI tab exists
    let aiTab = await findAITab();
    if (!aiTab) {
      console.log('[FolloMe] Opening new ChatGPT tab...');
      aiTab = await chrome.tabs.create({ url: AI_URLS.chatgpt, active: true });
      console.log('[FolloMe] AI tab opened');
    } else {
      console.log('[FolloMe] Focusing existing AI tab...');
      await chrome.tabs.update(aiTab.id, { active: true });
      await chrome.windows.update(aiTab.windowId, { focused: true });
    }
    aiTabId = aiTab.id;

    // STEP 2: Wait until DOM is ready
    const isReady = await waitForAITab(aiTabId);
    if (!isReady) {
      console.error(`[FolloMe] AI tab ${aiTabId} never became ready`);
      await safeSendMessage(sourceTabId, {
        type: 'SHOW_ERROR',
        error: 'Could not connect to AI page. Please make sure the AI chat is open and try again.'
      });
      return { status: 'error', error: 'AI tab not ready' };
    }

    // STEP 3: Inject prompt
    const injectResult = await safeSendMessage(aiTabId, { type: 'INJECT_PROMPT', prompt, sourceTabId });
    if (!injectResult) {
      console.error('[FolloMe] Failed to deliver INJECT_PROMPT to AI tab');
      await safeSendMessage(sourceTabId, {
        type: 'SHOW_ERROR',
        error: 'Failed to inject prompt into AI page.'
      });
      return { status: 'error', error: 'Prompt injection failed' };
    }

    return { status: 'ok' };
  }

  else if (message.type === 'RELAY_TO_TAB') {
    if (!message.targetTabId) {
      console.warn('[FolloMe] RELAY_TO_TAB — no targetTabId specified');
      return { status: 'error', error: 'No target tab' };
    }

    const result = await safeSendMessage(message.targetTabId, message.message);
    if (!result) {
      console.warn(`[FolloMe] RELAY_TO_TAB — failed to deliver to tab ${message.targetTabId}`);
      return { status: 'error', error: 'Relay delivery failed' };
    }

    // Focus source tab back if we got a response
    if (message.message.type === 'SHOW_RESPONSE') {
      try {
        const tab = await chrome.tabs.get(message.targetTabId);
        await chrome.tabs.update(message.targetTabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch (e) {
        console.warn('[FolloMe] Failed to focus source tab.', e);
      }
    }

    return { status: 'relayed' };
  }

  else if (message.type === 'FOLLOWUP_QUESTION') {
    if (aiTabId) {
      await chrome.tabs.update(aiTabId, { active: true });
      const tab = await chrome.tabs.get(aiTabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await safeSendMessage(aiTabId, {
        type: 'INJECT_PROMPT',
        prompt: `Follow-up question: ${message.question}`,
        sourceTabId
      });
    } else {
      await handleMessage({ type: 'START_ANALYSIS', question: message.question }, sender);
    }
    return { status: 'ok' };
  }

  console.warn(`[FolloMe] Unknown message type: ${message.type}`);
  return { status: 'unknown_type' };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === aiTabId) {
    console.log(`[FolloMe] AI tab ${tabId} closed`);
    aiTabId = null;
  }
  if (tabId === sourceTabId) {
    console.log(`[FolloMe] Source tab ${tabId} closed`);
    sourceTabId = null;
  }
});

// ── Shortcut ──
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'start_listening' || command === 'START_ANALYSIS') {
    console.log('[FolloMe] Keyboard shortcut triggered');
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) {
      console.warn('[FolloMe] Shortcut — no active tab');
      return;
    }

    const tab = tabs[0];
    const { restricted, reason } = checkRestricted(tab.url);
    if (restricted) {
      console.warn(`[FolloMe] Shortcut — restricted page: ${reason} (url: ${tab.url}). Skipping.`);
      // Cannot show overlay on restricted pages, just log
      return;
    }

    sourceTabId = tab.id;
    const result = await safeSendMessage(tab.id, { type: 'ANALYZE_PAGE', question: '' });
    if (result) {
      console.log('[FolloMe] Shortcut trigger delivered successfully');
    } else {
      console.error('[FolloMe] Shortcut trigger failed to deliver to tab');
    }
  }
});

console.log('[FolloMe] Service worker initialized');
