/**
 * FolloMe — Main Content Script
 * Runs on all pages. Handles:
 * → DOM reading via ContextExtractor
 * → Overlay rendering via FolloOverlay
 * → Message routing from popup/background
 */

(() => {
  // Prevent double injection
  if (window.__follomeContentLoaded) return;
  window.__follomeContentLoaded = true;

  // Initialize analytics
  FolloAnalytics.init();

  /**
   * Listen for messages from popup and background
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'ANALYZE_PAGE':
        handleAnalyzePage(message.question);
        sendResponse({ status: 'started' });
        break;

      case 'SHOW_RESPONSE':
        handleShowResponse(message.response);
        sendResponse({ status: 'shown' });
        break;

      case 'SHOW_ERROR':
        FolloOverlay.showError(message.error);
        sendResponse({ status: 'shown' });
        break;

      case 'SHOW_LOADING':
        FolloOverlay.showLoading(message.message || 'Processing...');
        sendResponse({ status: 'shown' });
        break;

      case 'PING':
        sendResponse({ status: 'alive' });
        break;

      default:
        sendResponse({ status: 'unknown_type' });
    }
    return true; // Keep message channel open for async
  });

  /**
   * Handle page analysis request from popup
   */
  async function handleAnalyzePage(userQuestion = '') {
    try {
      // Show overlay with loading state
      FolloOverlay.showLoading('Reading page content...');

      // Track event
      await FolloAnalytics.track('page_analyzed', {
        url: window.location.href,
        hasQuestion: !!userQuestion
      });

      // Extract context
      const context = ContextExtractor.extract();
      const prompt = ContextExtractor.buildPrompt(context, userQuestion);

      // Send to background to route to AI tab
      chrome.runtime.sendMessage({
        type: 'SEND_TO_AI',
        prompt,
        sourceTabUrl: window.location.href
      });

      FolloOverlay.showLoading('Sending to AI...');
    } catch (err) {
      console.error('[FolloMe] Analysis error:', err);
      FolloOverlay.showError(`Failed to analyze page: ${err.message}`);
    }
  }

  /**
   * Handle AI response display
   */
  async function handleShowResponse(response) {
    if (!response) {
      FolloOverlay.showError('No response received from AI.');
      return;
    }

    FolloOverlay.showResponse(response);

    await FolloAnalytics.track('ai_response_received', {
      responseLength: response.length
    });
  }

  console.log('[FolloMe] Content script loaded on:', window.location.href);
})();
