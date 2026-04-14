/**
 * FolloMe — AI Content Script
 * Runs on AI platform pages (ChatGPT, Gemini, Claude).
 * Handles prompt injection and response extraction via adapters.
 * Listener is registered immediately and unconditionally.
 */

(() => {
  const alreadyLoaded = !!window.__follomeAIContentLoaded;

  // Resolve adapter early — needed by the listener
  let adapter = null;
  if (typeof AdapterRouter !== 'undefined') {
    adapter = AdapterRouter.getAdapter();
  }

  // ALWAYS register listener so injection-retry can reach us
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(`[FolloMe:ai] Received message: ${message.type}`);

    if (message.type === 'INJECT_PROMPT') {
      if (!adapter) {
        console.error('[FolloMe:ai] No adapter available — cannot inject prompt');
        sendResponse({ status: 'error', error: 'No adapter for this page' });
        return true;
      }
      handleInjectPrompt(message.prompt, message.sourceTabId);
      sendResponse({ status: 'injecting' });
    } else if (message.type === 'PING_AI') {
      sendResponse({
        status: 'alive_ai',
        adapter: adapter?.name || 'none'
      });
    } else {
      sendResponse({ status: 'unknown_type' });
    }
    return true;
  });

  // Skip duplicate init
  if (alreadyLoaded) {
    console.log('[FolloMe:ai] Already loaded — listener re-registered, skipping init.');
    return;
  }
  window.__follomeAIContentLoaded = true;

  if (!adapter) {
    console.warn('[FolloMe:ai] No adapter found for this page');
    return;
  }

  console.log(`[FolloMe:ai] AI adapter loaded: ${adapter.name}`);

  async function handleInjectPrompt(prompt, sourceTabId) {
    try {
      console.log(`[FolloMe:ai] Injecting prompt into ${adapter.name}...`);

      const input = await waitForInput(adapter);
      if (!input) {
        console.error('[FolloMe:ai] Timeout waiting for input field');
        notifySource(sourceTabId, 'SHOW_ERROR', {
          error: 'Timeout waiting for input field. Make sure the chat is open.'
        });
        return;
      }

      console.log('[FolloMe:ai] Input field found');
      const injected = await adapter.injectPrompt(prompt);
      if (!injected) {
        console.error('[FolloMe:ai] Adapter failed to inject prompt');
        notifySource(sourceTabId, 'SHOW_ERROR', { error: 'Could not inject prompt.' });
        return;
      }
      console.log('[FolloMe:ai] Prompt injected');

      const sent = await adapter.triggerSend();
      if (!sent) {
        console.error('[FolloMe:ai] Adapter failed to trigger send');
        notifySource(sourceTabId, 'SHOW_ERROR', { error: 'Could not click send button.' });
        return;
      }
      console.log('[FolloMe:ai] Send button clicked');

      notifySource(sourceTabId, 'SHOW_LOADING', {
        message: `Waiting for ${adapter.name} response...`
      });

      console.log('[FolloMe:ai] Waiting for AI response...');
      const response = await adapter.waitForResponse(45000);

      if (response) {
        console.log(`[FolloMe:ai] Response received (${response.length} chars)`);
        notifySource(sourceTabId, 'SHOW_RESPONSE', { response });
      } else {
        console.warn('[FolloMe:ai] AI did not respond within timeout');
        notifySource(sourceTabId, 'SHOW_ERROR', { error: 'AI did not respond, try again' });
      }
    } catch (err) {
      console.error('[FolloMe:ai] Injection error:', err);
      notifySource(sourceTabId, 'SHOW_ERROR', { error: `Error: ${err.message}` });
    }
  }

  async function waitForInput(adapterInstance, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const input = adapterInstance.findInputElement();
      if (input) return input;
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  function notifySource(tabId, type, data = {}) {
    if (!tabId) {
      console.warn('[FolloMe:ai] notifySource — no tabId, cannot relay');
      return;
    }
    chrome.runtime.sendMessage({
      type: 'RELAY_TO_TAB',
      targetTabId: tabId,
      message: { type, ...data }
    });
  }
})();
