/**
 * FolloMe — Conversation Watcher
 * Platform-agnostic passive listener via MutationObserver.
 * Watches the DOM for chat updates and silently fires CONTEXT_UPDATED.
 */

(() => {
  if (window.__follomeWatcherLoaded) return;
  window.__follomeWatcherLoaded = true;

  let adapter = null;
  if (typeof AdapterRouter !== 'undefined') {
    adapter = AdapterRouter.getAdapter();
  }

  if (!adapter) {
    console.warn('[FolloMe:Watcher] No adapter found, watcher disabled.');
    return;
  }

  console.log(`[FolloMe:Watcher] Initialized for ${adapter.name}`);

  let lastSentResponse = '';
  let debounceTimer = null;

  function checkForUpdates() {
    try {
      if (typeof adapter.readLatestResponse !== 'function') return;
      const currentResponse = adapter.readLatestResponse();
      
      if (currentResponse && currentResponse !== lastSentResponse) {
        // Look for our specific JSON bounding signature
        if (currentResponse.includes('```actions') && currentResponse.includes(']')) {
          console.log('[FolloMe:Watcher] New actionable intent detected. Dispatching silently.');
          lastSentResponse = currentResponse;
          
          chrome.runtime.sendMessage({
            type: 'CONTEXT_UPDATED',
            payload: currentResponse,
            source: adapter.name
          });
        }
      }
    } catch (err) {
      // Fail silently to avoid polluting the chat platform's console
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      checkForUpdates();
    }, 500);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
})();
