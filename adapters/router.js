/**
 * FolloMe — Adapter Router
 * Routes to the correct AI adapter based on the current URL.
 */

const AdapterRouter = (() => {
  /**
   * Detect which AI platform we're on
   * @returns {BaseAIAdapter|null}
   */
  function getAdapter() {
    const url = window.location.hostname;

    if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
      return new ChatGPTAdapter();
    }

    if (url.includes('gemini.google.com')) {
      return new GeminiAdapter();
    }

    if (url.includes('claude.ai')) {
      return new ClaudeAdapter();
    }

    return null;
  }

  /**
   * Check if we're currently on an AI platform
   */
  function isAIPage() {
    return getAdapter() !== null;
  }

  /**
   * Get the preferred AI URL to open
   */
  function getDefaultAIUrl() {
    return 'https://chatgpt.com/';
  }

  return { getAdapter, isAIPage, getDefaultAIUrl };
})();

if (typeof window !== 'undefined') {
  window.AdapterRouter = AdapterRouter;
}
