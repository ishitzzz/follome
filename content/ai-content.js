/**
 * FolloMe — AI Content Script
 * Runs ONLY on AI platforms (ChatGPT, Gemini, Claude).
 * Handles prompt injection and response reading via adapters.
 */

(() => {
  // Prevent double injection
  if (window.__follomeAIContentLoaded) return;
  window.__follomeAIContentLoaded = true;

  const adapter = AdapterRouter.getAdapter();

  if (!adapter) {
    console.warn('[FolloMe] No adapter found for this page');
    return;
  }

  console.log(`[FolloMe] AI adapter loaded: ${adapter.name}`);

  /**
   * Listen for messages from background
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'INJECT_PROMPT':
        handleInjectPrompt(message.prompt, message.sourceTabId);
        sendResponse({ status: 'injecting' });
        break;

      case 'PING':
        sendResponse({ status: 'alive', adapter: adapter.name });
        break;

      case 'PING_AI':
        sendResponse({ status: 'alive_ai', adapter: adapter.name });
        break;

      default:
        sendResponse({ status: 'unknown_type' });
    }
    return true;
  });

  /**
   * Inject prompt into AI and wait for response
   */
  async function handleInjectPrompt(prompt, sourceTabId) {
    try {
      console.log(`[FolloMe] Injecting prompt into ${adapter.name}...`);

      // Inject and send
      const injected = await adapter.injectPrompt(prompt);
      if (!injected) {
        notifySource(sourceTabId, 'SHOW_ERROR', { error: `Could not find ${adapter.name} input field. Make sure the chat is open and ready.` });
        return;
      }

      await new Promise((r) => setTimeout(r, 500));

      const sent = await adapter.triggerSend();
      if (!sent) {
        notifySource(sourceTabId, 'SHOW_ERROR', { error: `Could not send message in ${adapter.name}. Try again.` });
        return;
      }

      // Notify source that we're waiting
      notifySource(sourceTabId, 'SHOW_LOADING', { message: `Waiting for ${adapter.name} response...` });

      // Wait for response
      const response = await adapter.waitForResponse(45000);

      if (response) {
        await FolloAnalytics.track('ai_response_received', {
          adapter: adapter.name,
          responseLength: response.length
        });

        notifySource(sourceTabId, 'SHOW_RESPONSE', { response });
      } else {
        notifySource(sourceTabId, 'SHOW_ERROR', { error: 'AI took too long to respond. Please try again.' });
      }
    } catch (err) {
      console.error(`[FolloMe] AI injection error:`, err);
      notifySource(sourceTabId, 'SHOW_ERROR', { error: `Error: ${err.message}` });
    }
  }

  /**
   * Send message back to the source tab
   */
  function notifySource(tabId, type, data = {}) {
    chrome.runtime.sendMessage({
      type: 'RELAY_TO_TAB',
      targetTabId: tabId,
      message: { type, ...data }
    });
  }
})();
