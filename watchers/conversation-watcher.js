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

  // Task 6.3: Two-way relay listener
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ASK_TEACHER') {
      const promptText = message.prompt;

      // 1. Locate the ChatGPT input box
      const inputBox = document.querySelector('div#prompt-textarea') || document.querySelector('textarea');
      if (!inputBox) {
        sendResponse({ status: 'error', error: 'Input box not found' });
        return true;
      }

      // 2. React Text Injector
      inputBox.focus();
      document.execCommand('insertText', false, promptText);
      inputBox.dispatchEvent(new Event('input', { bubbles: true }));

      // 3. Auto-Sender
      setTimeout(() => {
        const sendBtn = document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[aria-label*="Send"]');
        if (sendBtn) {
          sendBtn.click();
        }

        // 4. Response Harvester
        let attempts = 0;
        const intervalId = setInterval(() => {
          attempts++;
          const isGenerating = document.querySelector('button[aria-label*="Stop"], button[data-testid*="stop"]');
          const sendBtnActive = document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"]');
          
          if (!isGenerating && sendBtnActive && attempts > 2) {
            clearInterval(intervalId);
            
            setTimeout(() => {
              let responseText = '';
              if (adapter && typeof adapter.extractLatestMessage === 'function') {
                responseText = adapter.extractLatestMessage();
              } else {
                const messages = document.querySelectorAll('[data-message-author-role="assistant"] .markdown');
                if (messages.length > 0) {
                  responseText = messages[messages.length - 1].innerText;
                }
              }

              chrome.runtime.sendMessage({ type: 'TEACHER_RESPONSE', text: responseText });
              sendResponse({ status: 'completed', text: responseText });
            }, 1000);
          }
        }, 1000);
      }, 500);

      return true; // Crucial: async sendResponse
    }
  });

})();
