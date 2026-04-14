/**
 * FolloMe — Gemini Adapter
 * Handles interaction with Google Gemini web UI (gemini.google.com)
 */

class GeminiAdapter extends BaseAIAdapter {
  constructor() {
    super('Gemini');
  }

  findInputElement() {
    return (
      document.querySelector('.ql-editor[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"][aria-label*="prompt"]') ||
      document.querySelector('rich-textarea .ql-editor') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  findSendButton() {
    return (
      document.querySelector('button[aria-label="Send message"]') ||
      document.querySelector('button.send-button') ||
      document.querySelector('button[mattooltip="Send message"]') ||
      document.querySelector('button[aria-label*="Send"]')
    );
  }

  async injectPrompt(text) {
    const input = this.findInputElement();
    if (!input) return false;

    input.focus();
    await this._delay(200);

    // Gemini uses Quill editor — set content via innerHTML
    input.innerHTML = `<p>${text}</p>`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await this._delay(500);
    return true;
  }

  readLatestResponse() {
    // Gemini response containers
    const messages = document.querySelectorAll(
      'message-content .markdown, ' +
      '.model-response-text .markdown, ' +
      '.response-container .markdown, ' +
      'model-response message-content'
    );

    if (messages.length === 0) {
      // Fallback: look for any model response text
      const fallback = document.querySelectorAll('.model-response-text');
      if (fallback.length > 0) {
        return fallback[fallback.length - 1]?.textContent?.trim() || '';
      }
      return '';
    }

    return messages[messages.length - 1]?.textContent?.trim() || '';
  }
}

if (typeof window !== 'undefined') {
  window.GeminiAdapter = GeminiAdapter;
}
