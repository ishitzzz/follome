/**
 * FolloMe — Context Extractor
 * Extracts meaningful visible content from the current page.
 * Keeps extraction lightweight and size-limited.
 */

const ContextExtractor = (() => {
  const MAX_TEXT_LENGTH = 3000; // chars — keeps prompts manageable
  const IGNORED_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'META', 'LINK',
    'IFRAME', 'OBJECT', 'EMBED', 'NAV', 'FOOTER', 'HEADER'
  ]);

  /**
   * Check if an element is visible
   */
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  /**
   * Extract page metadata
   */
  function getMetadata() {
    return {
      title: document.title || '',
      url: window.location.href,
      description: document.querySelector('meta[name="description"]')?.content || '',
    };
  }

  /**
   * Extract visible text content from the page
   */
  function getVisibleText() {
    const textParts = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (IGNORED_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
          const text = node.textContent.trim();
          if (text.length < 2) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    let totalLength = 0;
    while ((node = walker.nextNode()) && totalLength < MAX_TEXT_LENGTH) {
      const text = node.textContent.trim();
      textParts.push(text);
      totalLength += text.length;
    }

    return textParts.join(' ').substring(0, MAX_TEXT_LENGTH);
  }

  /**
   * Get interactive elements on the page (buttons, inputs, links)
   */
  function getInteractiveElements() {
    const selectors = 'button, input, textarea, select, a[href], [role="button"]';
    const elements = [];
    const matched = document.querySelectorAll(selectors);

    for (let i = 0; i < Math.min(matched.length, 20); i++) {
      const el = matched[i];
      if (!isVisible(el)) continue;

      elements.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        text: (el.textContent || el.value || el.placeholder || el.ariaLabel || '').trim().substring(0, 80),
        id: el.id || '',
        name: el.name || '',
      });
    }

    return elements;
  }

  /**
   * Build full context object
   */
  function extract() {
    const metadata = getMetadata();
    const visibleText = getVisibleText();
    const interactiveElements = getInteractiveElements();

    return {
      metadata,
      visibleText,
      interactiveElements,
    };
  }

  /**
   * Build a clean prompt from extracted context
   */
  function buildPrompt(context, userQuestion = '') {
    const { metadata, visibleText, interactiveElements } = context;

    let prompt = `I'm currently on a webpage and need your help.\n\n`;
    prompt += `**Page Title:** ${metadata.title}\n`;
    prompt += `**URL:** ${metadata.url}\n`;

    if (metadata.description) {
      prompt += `**Description:** ${metadata.description}\n`;
    }

    prompt += `\n**Visible Content (excerpt):**\n${visibleText}\n`;

    if (interactiveElements.length > 0) {
      prompt += `\n**Interactive Elements on page:**\n`;
      interactiveElements.forEach((el, i) => {
        prompt += `${i + 1}. <${el.tag}> "${el.text}"${el.type ? ` (type: ${el.type})` : ''}${el.id ? ` [id: ${el.id}]` : ''}\n`;
      });
    }

    if (userQuestion) {
      prompt += `\n**My Question:** ${userQuestion}\n`;
    } else {
      prompt += `\n**Help me understand what to do next on this page. Give me clear, step-by-step instructions.**\n`;
    }

    prompt += `\nPlease be specific about which buttons to click, which fields to fill, and in what order. Keep instructions concise and actionable.`;

    return prompt;
  }

  return { extract, buildPrompt, getMetadata };
})();

if (typeof window !== 'undefined') {
  window.ContextExtractor = ContextExtractor;
}
