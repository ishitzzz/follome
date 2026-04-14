/**
 * FolloMe — Background Service Worker
 * Handles tab management and message routing between popup and content scripts.
 * Manifest V3 service worker (no DOM access).
 */

// ── State ──
let sourceTabId = null;
let aiTabId = null;

// ── AI Platform URLs ──
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
 * Check if a URL is an AI platform
 */
function isAIUrl(url) {
  return AI_PATTERNS.some((pattern) => url?.includes(pattern));
}

/**
 * Find an existing AI tab
 */
async function findAITab() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && isAIUrl(tab.url)) {
      return tab;
    }
  }
  return null;
}

/**
 * Ensure content script is injected into a tab
 */
async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return response?.status === 'alive';
  } catch {
    return false;
  }
}

/**
 * Wait for tab to be ready
 */
function waitForTabLoad(tabId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = async () => {
      if (Date.now() - startTime > timeout) {
        reject(new Error('Tab load timeout'));
        return;
      }

      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          // Give the page a moment to initialize
          setTimeout(() => resolve(tab), 2000);
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }

      setTimeout(check, 500);
    };

    check();
  });
}

/**
 * Wait for content script to be ready in a tab
 */
async function waitForContentScript(tabId, timeout = 10000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const alive = await ensureContentScript(tabId);
    if (alive) return true;
    await new Promise((r) => setTimeout(r, 500));
  }

  return false;
}

// ── Message Handler ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true; // Keep channel open for async
});

async function handleMessage(message, sender, sendResponse) {
  try {
    switch (message.type) {
      // ── From Popup: Start analysis ──
      case 'START_ANALYSIS': {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const activeTab = tabs[0];

        if (!activeTab) {
          sendResponse({ status: 'error', error: 'No active tab found' });
          return;
        }

        sourceTabId = activeTab.id;

        // Tell content script to analyze the page
        chrome.tabs.sendMessage(sourceTabId, {
          type: 'ANALYZE_PAGE',
          question: message.question || ''
        });

        sendResponse({ status: 'started' });
        break;
      }

      // ── From Content Script: Send prompt to AI ──
      case 'SEND_TO_AI': {
        const { prompt } = message;
        sourceTabId = sender.tab?.id || sourceTabId;

        // Find or create AI tab
        let aiTab = await findAITab();

        if (aiTab) {
          aiTabId = aiTab.id;
          // Focus the AI tab
          await chrome.tabs.update(aiTabId, { active: true });
          await chrome.windows.update(aiTab.windowId, { focused: true });
        } else {
          // Open ChatGPT as default
          const newTab = await chrome.tabs.create({
            url: AI_URLS.chatgpt,
            active: true
          });
          aiTabId = newTab.id;

          // Wait for tab to load
          await waitForTabLoad(aiTabId);
        }

        // Wait for content script on AI tab
        const ready = await waitForContentScript(aiTabId);

        if (ready) {
          // Send prompt to AI tab's content script
          chrome.tabs.sendMessage(aiTabId, {
            type: 'INJECT_PROMPT',
            prompt,
            sourceTabId
          });
        } else {
          // Notify source tab of error
          if (sourceTabId) {
            chrome.tabs.sendMessage(sourceTabId, {
              type: 'SHOW_ERROR',
              error: 'Could not connect to AI page. Please make sure the AI chat is open and try again.'
            });
          }
        }

        sendResponse({ status: 'routing' });
        break;
      }

      // ── Relay message to a specific tab ──
      case 'RELAY_TO_TAB': {
        const { targetTabId, message: innerMessage } = message;
        if (targetTabId) {
          try {
            await chrome.tabs.sendMessage(targetTabId, innerMessage);

            // If it's a response, switch back to source tab
            if (innerMessage.type === 'SHOW_RESPONSE' && targetTabId) {
              const tab = await chrome.tabs.get(targetTabId);
              await chrome.tabs.update(targetTabId, { active: true });
              await chrome.windows.update(tab.windowId, { focused: true });
            }
          } catch (err) {
            console.warn('[FolloMe] Relay failed:', err);
          }
        }
        sendResponse({ status: 'relayed' });
        break;
      }

      // ── Follow-up question ──
      case 'FOLLOWUP_QUESTION': {
        if (!aiTabId) {
          // No AI tab — start fresh
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          sourceTabId = tabs[0]?.id;

          if (sourceTabId) {
            chrome.tabs.sendMessage(sourceTabId, {
              type: 'ANALYZE_PAGE',
              question: message.question
            });
          }
        } else {
          const followUpPrompt = `Follow-up question: ${message.question}`;

          // Focus AI tab
          const aiTab = await chrome.tabs.get(aiTabId);
          await chrome.tabs.update(aiTabId, { active: true });
          await chrome.windows.update(aiTab.windowId, { focused: true });

          chrome.tabs.sendMessage(aiTabId, {
            type: 'INJECT_PROMPT',
            prompt: followUpPrompt,
            sourceTabId: sender.tab?.id || sourceTabId
          });
        }
        sendResponse({ status: 'sent' });
        break;
      }

      default:
        sendResponse({ status: 'unknown' });
    }
  } catch (err) {
    console.error('[FolloMe] Background error:', err);
    sendResponse({ status: 'error', error: err.message });
  }
}

// ── Track tab closures ──
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === aiTabId) aiTabId = null;
  if (tabId === sourceTabId) sourceTabId = null;
});

console.log('[FolloMe] Service worker initialized');
