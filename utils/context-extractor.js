/**
 * FolloMe — Context Extractor v2
 * Extracts structured UI understanding from the current page.
 *
 * Instead of just text, builds a full interface map:
 * - Detects all interactive elements (buttons, inputs, dropdowns, links)
 * - Captures textContent, placeholder, aria-label, bounding box
 * - Returns structured JSON that gives the AI a spatial map of the UI
 *
 * Keeps extraction lightweight and size-limited.
 */

const ContextExtractor = (() => {
  const MAX_TEXT_LENGTH = 3000;
  const MAX_UI_ELEMENTS = 50;
  const IGNORED_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'META', 'LINK',
    'IFRAME', 'OBJECT', 'EMBED'
  ]);

  // ── Element type classification ──
  const TYPE_MAP = {
    BUTTON:   'button',
    A:        'link',
    INPUT:    'input',
    TEXTAREA: 'textarea',
    SELECT:   'dropdown',
    OPTION:   'option',
    DETAILS:  'expandable',
    SUMMARY:  'expandable_trigger',
    LABEL:    'label',
  };

  const ROLE_TYPE_MAP = {
    button:    'button',
    link:      'link',
    textbox:   'input',
    combobox:  'dropdown',
    listbox:   'dropdown',
    menuitem:  'menu_item',
    tab:       'tab',
    checkbox:  'checkbox',
    radio:     'radio',
    switch:    'toggle',
    slider:    'slider',
    searchbox: 'search',
    navigation:'nav',
    dialog:    'dialog',
    alertdialog:'dialog',
    menu:      'menu',
    menubar:   'menu',
    tablist:   'tab_list',
  };

  /**
   * Check if an element is visible
   */
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    try {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * Check if element is in the viewport (or close to it)
   */
  function isInViewport(rect) {
    const buffer = 100; // Include elements slightly off-screen
    return (
      rect.bottom > -buffer &&
      rect.top < window.innerHeight + buffer &&
      rect.right > -buffer &&
      rect.left < window.innerWidth + buffer
    );
  }

  /**
   * Classify an element's type
   */
  function classifyElement(el) {
    const tag = el.tagName;
    const role = (el.getAttribute('role') || '').toLowerCase();
    const inputType = (el.type || '').toLowerCase();

    // Role-based classification first (most specific)
    if (role && ROLE_TYPE_MAP[role]) {
      return ROLE_TYPE_MAP[role];
    }

    // Tag-based classification
    if (TYPE_MAP[tag]) {
      // Refine INPUT subtypes
      if (tag === 'INPUT') {
        switch (inputType) {
          case 'submit':
          case 'button':
          case 'reset':
            return 'button';
          case 'checkbox':
            return 'checkbox';
          case 'radio':
            return 'radio';
          case 'range':
            return 'slider';
          case 'file':
            return 'file_upload';
          case 'search':
            return 'search';
          case 'email':
          case 'tel':
          case 'url':
          case 'number':
          case 'password':
          case 'text':
          case 'date':
          case 'time':
          case 'datetime-local':
            return 'input';
          default:
            return 'input';
        }
      }
      return TYPE_MAP[tag];
    }

    // Contenteditable
    if (el.getAttribute('contenteditable') === 'true') {
      return 'input';
    }

    // Clickable elements (onclick, tabindex, cursor pointer)
    try {
      const style = window.getComputedStyle(el);
      if (style.cursor === 'pointer' || el.onclick || el.getAttribute('tabindex') !== null) {
        return 'clickable';
      }
    } catch (e) { /* skip */ }

    return null; // Not interactive
  }

  /**
   * Get the best display text for an element
   */
  function getDisplayText(el) {
    // Direct text content (excluding children's text for specificity)
    let directText = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        directText += child.textContent;
      }
    }
    directText = directText.trim();

    // Use direct text if meaningful
    if (directText && directText.length > 0 && directText.length < 200) {
      return directText;
    }

    // Fallback to full textContent
    const fullText = (el.textContent || el.innerText || '').trim();
    if (fullText.length < 200) {
      return fullText;
    }

    // Truncate long text
    return fullText.substring(0, 100) + '…';
  }

  /**
   * Get the associated label text for a form element
   */
  function getLabelText(el) {
    // Explicit label via for attribute
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return (label.textContent || '').trim();
    }

    // Implicit label (element wrapped in <label>)
    const parentLabel = el.closest('label');
    if (parentLabel) {
      // Get label text excluding the input's own text
      const clone = parentLabel.cloneNode(true);
      const inputs = clone.querySelectorAll('input, textarea, select');
      inputs.forEach(i => i.remove());
      return (clone.textContent || '').trim();
    }

    // aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return (labelEl.textContent || '').trim();
    }

    return '';
  }

  /**
   * Build a unique CSS selector path for an element
   */
  function buildSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;

    const parts = [];
    let current = el;
    let depth = 0;

    while (current && current !== document.body && depth < 4) {
      let part = current.tagName.toLowerCase();

      if (current.id) {
        part = `#${CSS.escape(current.id)}`;
        parts.unshift(part);
        break;
      }

      // Add classes (first 2 meaningful ones)
      const classes = Array.from(current.classList)
        .filter(c => !c.startsWith('follome-') && c.length < 30)
        .slice(0, 2);
      if (classes.length > 0) {
        part += '.' + classes.map(c => CSS.escape(c)).join('.');
      }

      // Add nth-child if needed for uniqueness
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(s => s.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          part += `:nth-child(${index})`;
        }
      }

      parts.unshift(part);
      current = current.parentElement;
      depth++;
    }

    return parts.join(' > ');
  }

  /**
   * Compute the viewport region label for an element based on its bounding rect.
   * Returns: 'top', 'bottom', 'left', 'right', 'center', 'top-left', 'top-right',
   *          'bottom-left', 'bottom-right'.
   *
   * Used by getElementsForMapping() to attach positional context to each element
   * for Groq's region-aware matching prompts.
   *
   * @param {{ left: number, top: number, width: number, height: number }} rect
   * @param {number} viewportWidth
   * @param {number} viewportHeight
   * @returns {string}
   */
  function computeRegion(rect, viewportWidth, viewportHeight) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const vertical = cy < viewportHeight * 0.25 ? 'top' :
                     cy > viewportHeight * 0.75 ? 'bottom' : 'center';
    const horizontal = cx < viewportWidth * 0.25 ? 'left' :
                       cx > viewportWidth * 0.75 ? 'right' : 'center';

    if (vertical === 'center' && horizontal === 'center') return 'center';
    if (vertical === 'center') return horizontal;
    if (horizontal === 'center') return vertical;
    return `${vertical}-${horizontal}`;
  }

  /**
   * Extract a single UI element's structured data
   */
  function extractElementData(el, index) {
    const rect = el.getBoundingClientRect();
    const type = classifyElement(el);
    if (!type) return null;

    const data = {
      _idx: index,
      type,
      text: getDisplayText(el),
      placeholder: el.placeholder || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      name: el.name || '',
      value: '',
      label: getLabelText(el),
      domId: el.id || '',
      role: el.getAttribute('role') || '',
      // Bounding box (viewport coordinates)
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      // State
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      checked: el.checked || el.getAttribute('aria-checked') === 'true',
      required: el.required || el.getAttribute('aria-required') === 'true',
      // Internal — not sent to AI but used for matching
      _selector: buildSelector(el),
      _el: el, // Keep DOM reference (stripped before prompt)
    };

    // Capture value for inputs (not passwords)
    if (['input', 'search', 'textarea'].includes(type)) {
      const inputType = (el.type || '').toLowerCase();
      if (inputType !== 'password') {
        data.value = (el.value || '').substring(0, 50);
      }
    }

    // For dropdowns, capture options
    if (type === 'dropdown' && el.tagName === 'SELECT') {
      data.options = Array.from(el.options)
        .slice(0, 10)
        .map(opt => ({ text: opt.text.trim(), value: opt.value, selected: opt.selected }));
    }

    return data;
  }

  // ══════════════════════════════════════════
  //  MAIN EXTRACTION
  // ══════════════════════════════════════════

  /**
   * Extract page metadata
   */
  function getMetadata() {
    return {
      title: document.title || '',
      url: window.location.href,
      description: document.querySelector('meta[name="description"]')?.content || '',
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
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
          if (parent.closest('#follome-overlay')) return NodeFilter.FILTER_REJECT;
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
   * Extract all interactive UI elements with structured data
   */
  function getUIElements() {
    const elements = [];
    const seen = new Set();
    let index = 0;

    // Comprehensive selector for all interactive elements
    const selectors = [
      'button', 'a[href]', '[role="button"]', '[role="link"]',
      '[role="menuitem"]', '[role="tab"]', '[role="checkbox"]',
      '[role="radio"]', '[role="switch"]', '[role="combobox"]',
      '[role="slider"]', '[role="searchbox"]',
      'input:not([type="hidden"])', 'textarea', 'select',
      '[contenteditable="true"]',
      'summary',
      '[tabindex]:not([tabindex="-1"])',
      '[onclick]',
    ];

    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          if (seen.has(el) || !isVisible(el)) return;
          if (el.closest('#follome-overlay') || el.closest('[class*="follome-"]')) return;

          const rect = el.getBoundingClientRect();
          if (!isInViewport(rect)) return;

          seen.add(el);

          const data = extractElementData(el, index);
          if (data) {
            elements.push(data);
            index++;
          }
        });
      } catch (e) { /* skip invalid selectors */ }

      if (elements.length >= MAX_UI_ELEMENTS) break;
    }

    return elements;
  }

  /**
   * Build full context object — structured UI map
   */
  function extract() {
    const metadata = getMetadata();
    const visibleText = getVisibleText();
    const uiElements = getUIElements();

    return {
      metadata,
      visibleText,
      uiElements,
      // Backward compat
      interactiveElements: uiElements.map(el => ({
        tag: el.type,
        type: el.type,
        text: el.text,
        id: el.domId,
        name: el.name,
      })),
    };
  }



  /**
   * Get DOM element reference by extracted element index.
   * Used by the element matcher to resolve AI action indexes to real DOM nodes.
   */
  function getElementByIndex(uiElements, idx) {
    const el = uiElements.find(e => e._idx === idx);
    return el ? el._el : null;
  }

  /**
   * Get selector by index
   */
  function getSelectorByIndex(uiElements, idx) {
    const el = uiElements.find(e => e._idx === idx);
    return el ? el._selector : null;
  }

  /**
   * Returns a minimal, flat, stringifiable list of interactive elements
   * optimised for the Groq mapper prompt. Each entry includes the computed
   * viewport region so Groq can use position hints for disambiguation.
   *
   * Fields: idx, type, text, ariaLabel, placeholder, title, region
   * (plus label and name which the batch prompt may optionally use).
   */
  function getElementsForMapping() {
    const rawElements = getUIElements();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    return rawElements.map(el => {
      // Use the already-captured bounding box coords
      const rect = {
        left: el.x,
        top: el.y,
        width: el.width,
        height: el.height
      };

      const rawEl = el._el;
      const isInput = ['input', 'textarea', 'select'].includes(rawEl.tagName.toLowerCase());
      let text = rawEl.getAttribute('aria-label') || rawEl.placeholder || rawEl.name || '';
      
      if (isInput) {
          // Instagram/React hotfix: Steal the text from the parent wrapper
          const parentLabel = rawEl.closest('label');
          if (parentLabel && parentLabel.innerText) {
              text = parentLabel.innerText;
          } else if (rawEl.parentElement && rawEl.parentElement.innerText) {
              text = rawEl.parentElement.innerText;
          }
      } else {
          text = rawEl.innerText || text;
      }
      
      text = text.trim().replace(/\s+/g, ' ').substring(0, 100);
      
      if (!text && !isInput) return null; 
      
      return {
        idx: el._idx,
        type: isInput ? 'input_field' : rawEl.tagName.toLowerCase(),
        text: text || 'unlabeled_input',
        ariaLabel: el.ariaLabel || '',
        placeholder: el.placeholder || '',
        title: el.title || '',
        label: el.label || '',
        name: el.name || '',
        region: computeRegion(rect, vw, vh)
      };
    }).filter(Boolean);
  }

  /**
   * Return expanded context for a specific element by index.
   * Provides parent containers, sibling elements, and nearby visible text.
   * Used by the Recovery Engine's Tier 1 silent retry to give Groq
   * richer context when the initial match fails.
   *
   * @param {number} idx — the element _idx from getUIElements()
   * @returns {{ parentText: string, parentTag: string, parentClasses: string,
   *             siblings: Array<{type: string, text: string, idx: number}>,
   *             nearbyText: string } | null}
   */
  function getExpandedContext(idx) {
    // Re-scan to get live DOM references
    const elements = getUIElements();
    const target = elements.find(e => e._idx === idx);
    if (!target || !target._el) return null;

    const el = target._el;
    const result = {
      parentText: '',
      parentTag: '',
      parentClasses: '',
      siblings: [],
      nearbyText: ''
    };

    // ── Parent context ──
    const parent = el.parentElement;
    if (parent) {
      result.parentTag = parent.tagName.toLowerCase();
      result.parentClasses = Array.from(parent.classList).slice(0, 4).join(' ');
      // Get parent's direct text (excluding deep children)
      let parentDirectText = '';
      for (const child of parent.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          parentDirectText += child.textContent;
        }
      }
      result.parentText = parentDirectText.trim().substring(0, 120);

      // ── Sibling elements ──
      const siblingEls = Array.from(parent.children).filter(s => s !== el);
      result.siblings = siblingEls.slice(0, 6).map(sib => {
        const sibType = classifyElement(sib);
        const sibIdx = elements.find(e => e._el === sib)?._idx ?? -1;
        return {
          type: sibType || sib.tagName.toLowerCase(),
          text: (sib.textContent || '').trim().substring(0, 60),
          idx: sibIdx
        };
      });
    }

    // ── Nearby text: walk up to 2 levels and collect visible text ──
    const textParts = [];
    let ancestor = parent;
    for (let depth = 0; depth < 2 && ancestor && ancestor !== document.body; depth++) {
      for (const child of ancestor.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent.trim();
          if (t.length > 2) textParts.push(t);
        }
      }
      ancestor = ancestor.parentElement;
    }
    result.nearbyText = textParts.join(' ').substring(0, 200);

    return result;
  }

  return {
    extract,
    getMetadata,
    getUIElements,
    getElementsForMapping,
    getExpandedContext,
    getElementByIndex,
    getSelectorByIndex,
    computeRegion,
  };
})();

if (typeof window !== 'undefined') {
  window.ContextExtractor = ContextExtractor;
}
if (typeof self !== 'undefined') {
  self.ContextExtractor = ContextExtractor;
}
