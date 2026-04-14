/**
 * FolloMe — ChatGPT Adapter
 * Handles interaction with ChatGPT web UI (chatgpt.com / chat.openai.com)
 */

class ChatGPTAdapter extends BaseAIAdapter {
  constructor() {
    super('ChatGPT');
  }

  findInputElement() {
    // ChatGPT uses a contenteditable div with id="prompt-textarea"
    // or a <textarea> in some versions
    return (
      document.querySelector('#prompt-textarea') ||
      document.querySelector('div[contenteditable="true"][data-placeholder]') ||
      document.querySelector('textarea[data-id="root"]') ||
      document.querySelector('textarea[placeholder*="Message"]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  findSendButton() {
    return (
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      document.querySelector('form button[type="submit"]') ||
      document.querySelector('button[aria-label*="Send"]')
    );
  }

  async injectPrompt(text) {
    const input = this.findInputElement();
    if (!input) return false;

    input.focus();
    await this._delay(200);

    if (input.tagName === 'TEXTAREA') {
      // Direct textarea
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeInputValueSetter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // ContentEditable div — use paragraph approach
      input.innerHTML = `<p>${text}</p>`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    await this._delay(500);
    return true;
  }

  readLatestResponse() {
    // ChatGPT response messages
    const messages = document.querySelectorAll(
      '[data-message-author-role="assistant"] .markdown, ' +
      '.agent-turn .markdown, ' +
      '[data-testid*="conversation-turn"] .markdown'
    );

    if (messages.length === 0) return '';

    const lastMessage = messages[messages.length - 1];
    return lastMessage?.textContent?.trim() || '';
  }
}

if (typeof window !== 'undefined') {
  window.ChatGPTAdapter = ChatGPTAdapter;
}
