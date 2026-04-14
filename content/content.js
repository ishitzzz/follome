/**
 * FolloMe — Main Content Script
 * Runs on all web pages. Handles page analysis, overlay display, and cursor guidance.
 * Listener is registered immediately and unconditionally to ensure the
 * background service worker can always reach this script.
 */

(() => {
  // Register message listener IMMEDIATELY — even if this script runs multiple times.
  // The guard flag only protects against duplicate DOM/logic setup, not the listener.
  const alreadyLoaded = !!window.__follomeContentLoaded;

  // Always register listener so injection-retry can reach us
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(`[FolloMe:content] Received message: ${message.type}`);

    if (message.type === 'ANALYZE_PAGE') {
      handleAnalyzePage(message.question);
      sendResponse({ status: 'started' });
    } else if (message.type === 'SHOW_RESPONSE') {
      handleShowResponse(message.response);
      sendResponse({ status: 'shown' });
    } else if (message.type === 'SHOW_ERROR') {
      if (typeof FolloOverlay !== 'undefined') {
        FolloOverlay.showError(message.error);
      } else {
        console.error(`[FolloMe:content] FolloOverlay not available to show error: ${message.error}`);
      }
      sendResponse({ status: 'shown' });
    } else if (message.type === 'SHOW_LOADING') {
      if (typeof FolloOverlay !== 'undefined') {
        FolloOverlay.showLoading(message.message || 'Processing...');
      }
      sendResponse({ status: 'shown' });
    } else if (message.type === 'PING') {
      sendResponse({ status: 'alive' });
    } else {
      console.log(`[FolloMe:content] Unknown message type: ${message.type}`);
      sendResponse({ status: 'unknown_type' });
    }
    return true;
  });

  // If already loaded, skip the rest (prevents duplicate DOM setup)
  if (alreadyLoaded) {
    console.log('[FolloMe:content] Already loaded — listener re-registered, skipping init.');
    return;
  }
  window.__follomeContentLoaded = true;

  async function handleAnalyzePage(userQuestion = '') {
    try {
      if (typeof FolloOverlay !== 'undefined') {
        FolloOverlay.showLoading('Reading page content...');
      }
      console.log('[FolloMe:content] Analyzing page...');

      if (typeof ContextExtractor === 'undefined') {
        console.error('[FolloMe:content] ContextExtractor is not available');
        if (typeof FolloOverlay !== 'undefined') {
          FolloOverlay.showError('Page analyzer not loaded. Try reloading the page.');
        }
        return;
      }

      const context = ContextExtractor.extract();
      console.log('[FolloMe:content] Context extracted');
      const prompt = ContextExtractor.buildPrompt(context, userQuestion);

      chrome.runtime.sendMessage({
        type: 'SEND_TO_AI',
        prompt,
        sourceTabUrl: window.location.href
      });

      if (typeof FolloOverlay !== 'undefined') {
        FolloOverlay.showLoading('Sending to AI...');
      }
    } catch (err) {
      console.error('[FolloMe:content] Analysis error:', err);
      if (typeof FolloOverlay !== 'undefined') {
        FolloOverlay.showError(`Failed to analyze page: ${err.message}`);
      }
    }
  }

  function handleShowResponse(response) {
    if (!response) {
      if (typeof FolloOverlay !== 'undefined') {
        FolloOverlay.showError('No response received from AI.');
      }
      return;
    }

    console.log('[FolloMe:content] Displaying AI response');

    if (typeof FolloOverlay !== 'undefined') {
      FolloOverlay.showResponse(response);
    } else {
      console.error('[FolloMe:content] FolloOverlay not available to show response');
    }
  }

  console.log('[FolloMe:content] Content script loaded and listening');
})();
