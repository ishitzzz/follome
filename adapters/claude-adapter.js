/**
 * FolloMe — Claude Adapter
 * Handles interaction with Claude web UI (claude.ai)
 */

class ClaudeAdapter extends BaseAIAdapter {
  constructor() {
    super('Claude');
  }

  findInputElement() {
    return (
      document.querySelector('div[contenteditable="true"].ProseMirror') ||
      document.querySelector('div[contenteditable="true"][aria-label*="message"]') ||
      document.querySelector('fieldset div[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  findSendButton() {
    return (
      document.querySelector('button[aria-label="Send Message"]') ||
      document.querySelector('button[aria-label="Send message"]') ||
      document.querySelector('fieldset button[type="button"]:last-of-type') ||
      document.querySelector('button[aria-label*="Send"]')
    );
  }

  async injectPrompt(text) {
    const input = this.findInputElement();
    if (!input) return false;

    input.focus();
    await this._delay(200);

    // Claude uses ProseMirror — set content as paragraph
    input.innerHTML = `<p>${text}</p>`;
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Also dispatch to trigger ProseMirror's internal state update
    const inputEvent = new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text
    });
    input.dispatchEvent(inputEvent);

    await this._delay(500);
    return true;
  }

  readLatestResponse() {
    // Claude response messages
    const messages = document.querySelectorAll(
      '[data-is-streaming] .markdown, ' +
      '.font-claude-message .markdown, ' +
      '.contents .markdown, ' +
      '[class*="assistant"] .markdown'
    );

    if (messages.length === 0) {
      // Broader fallback
      const allMessages = document.querySelectorAll('.font-claude-message');
      if (allMessages.length > 0) {
        return allMessages[allMessages.length - 1]?.textContent?.trim() || '';
      }
      return '';
    }

    return messages[messages.length - 1]?.textContent?.trim() || '';
  }
}

if (typeof window !== 'undefined') {
  window.ClaudeAdapter = ClaudeAdapter;
}
