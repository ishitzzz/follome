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

  let lastSeenMessage = '';

  const observer = new MutationObserver((mutations) => {
    try {
      if (typeof adapter.extractLatestMessage !== 'function') return;
      const newMessage = adapter.extractLatestMessage();
      
      // Definitively check for any new text, ignoring format
      if (newMessage && newMessage !== lastSeenMessage && newMessage.trim().length > 10) {
        lastSeenMessage = newMessage;
        console.log('[FolloMe:Watcher] New message detected. Dispatching silently.');
        chrome.runtime.sendMessage({
          type: 'CONTEXT_UPDATED',
          response: newMessage,
          platform: adapter.name,
          timestamp: Date.now()
        });
      }
    } catch (err) {
      console.debug('[FolloMe:Watcher] Watcher disconnected, waiting for reload');
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
})();
