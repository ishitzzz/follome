/**
 * FolloMe — Base AI Adapter
 * Abstract base class for all AI platform adapters.
 * Each adapter handles finding input, sending prompt, and reading response.
 */

class BaseAIAdapter {
  constructor(name) {
    this.name = name;
    this._lastResponse = '';
  }

  /**
   * Find the input element on the AI page
   * @returns {HTMLElement|null}
   */
  findInputElement() {
    throw new Error(`${this.name}: findInputElement() not implemented`);
  }

  /**
   * Find the send/submit button
   * @returns {HTMLElement|null}
   */
  findSendButton() {
    throw new Error(`${this.name}: findSendButton() not implemented`);
  }

  /**
   * Inject text into the input field
   * @param {string} text
   */
  async injectPrompt(text) {
    const input = this.findInputElement();
    if (!input) {
      console.warn(`[FolloMe][${this.name}] Input element not found`);
      return false;
    }

    // Focus the input
    input.focus();

    // Clear existing content
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // ContentEditable div (used by ChatGPT, Claude)
      input.innerHTML = '';
      input.textContent = text;

      // Dispatch input events to trigger framework reactivity
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      
      // Also try setting via clipboard for frameworks that listen to that
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', text);
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text,
        dataTransfer
      }));
    }

    // Small delay to let UI update
    await this._delay(300);
    return true;
  }

  /**
   * Click the send button
   */
  async triggerSend() {
    const btn = this.findSendButton();
    if (btn) {
      btn.click();
      return true;
    }

    // Fallback: try Enter key
    const input = this.findInputElement();
    if (input) {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        bubbles: true
      }));
      return true;
    }

    return false;
  }

  /**
   * Read the latest AI response from the DOM
   * @returns {string}
   */
  readLatestResponse() {
    throw new Error(`${this.name}: readLatestResponse() not implemented`);
  }

  /**
   * Wait for a new response to appear
   * @param {number} timeout - ms to wait
   * @returns {string|null}
   */
  async waitForResponse(timeout = 30000) {
    const startTime = Date.now();
    const initialResponse = this.readLatestResponse();

    while (Date.now() - startTime < timeout) {
      await this._delay(1000);

      const current = this.readLatestResponse();

      // Check if response has changed and is no longer streaming
      if (current && current !== initialResponse) {
        // Wait a bit more to make sure streaming is done
        await this._delay(2000);
        const final = this.readLatestResponse();

        // If response stabilized, we're done
        if (final === current || final.length >= current.length) {
          this._lastResponse = final;
          return final;
        }
      }
    }

    return null;
  }

  /**
   * Full flow: inject prompt -> send -> wait for response
   */
  async sendAndReceive(prompt) {
    const injected = await this.injectPrompt(prompt);
    if (!injected) return null;

    await this._delay(500);

    const sent = await this.triggerSend();
    if (!sent) return null;

    return await this.waitForResponse();
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

if (typeof window !== 'undefined') {
  window.BaseAIAdapter = BaseAIAdapter;
}
