/**
 * FolloMe — Element Matcher
 * Maps parsed actions to real DOM elements using a deterministic scoring system.
 */

const ElementMatcher = (() => {

  const INTERACTIVE_SELECTORS = [
    'input', 'button', 'select', 'textarea', 'a[href]',
    '[role="button"]', '[role="link"]', '[role="checkbox"]',
    '[role="radio"]', '[role="switch"]', '[role="combobox"]',
    '[role="listbox"]', '[tabindex]:not([tabindex="-1"])', '[onclick]'
  ].join(', ');

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    
    try {
      const style = window.getComputedStyle(el);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      );
    } catch { return false; }
  }

  function getLabelText(el) {
    let labelText = '';
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) labelText = label.textContent || '';
    }
    if (!labelText) {
      const parentLabel = el.closest('label');
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true);
        clone.querySelectorAll('input, select, textarea').forEach(i => i.remove());
        labelText = clone.textContent || '';
      }
    }
    return labelText.trim().toLowerCase();
  }

  function getDirectTextContent(el) {
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
    }
    return (text || el.textContent || '').trim().toLowerCase();
  }

  function classifyElement(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return 'dropdown';
    if (tag === 'a') return 'link';
    if (tag === 'textarea') return 'input';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(t)) return 'button';
      return 'input';
    }
    if (tag === 'button') return 'button';
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (['button', 'link'].includes(role)) return role;
    if (['combobox', 'listbox'].includes(role)) return 'dropdown';
    if (['checkbox', 'radio', 'switch', 'textbox', 'searchbox'].includes(role)) return 'input';
    return 'unknown';
  }

  function getCandidates() {
    const elements = [];
    const seen = new Set();
    document.querySelectorAll(INTERACTIVE_SELECTORS).forEach(el => {
      if (seen.has(el)) return;
      seen.add(el);
      if (el.closest('#follome-overlay') || el.closest('[class*="follome-"]')) return;
      if (!isVisible(el)) return;
      elements.push(el);
    });
    return elements;
  }

  /**
   * Assigns a deterministic score to an element against the desired action.
   */
  function scoreCandidate(el, actionData) {
    let score = 0;
    const target = (actionData.target || '').toLowerCase().trim();
    if (!target) return 0; // Empty target, avoid blind matching

    const elType = classifyElement(el);
    const expectedType = (actionData.type || '').toLowerCase();

    // 1. Text match (label, innerText) -> +50
    const directText = getDirectTextContent(el);
    const labelText = getLabelText(el);

    if ((directText && directText.includes(target)) || (labelText && labelText.includes(target)) || 
        (target.length > 2 && (directText === target || labelText === target))) {
      score += 50;
    }

    // 2. Type match -> +30 if explicitly matches
    if (expectedType && expectedType !== 'unknown') {
      if (elType === expectedType) {
        score += 30;
      }
    }

    // 3. Placeholder / aria-label -> +20
    const placeholder = (el.placeholder || '').toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    if ((placeholder && placeholder.includes(target)) || (ariaLabel && ariaLabel.includes(target))) {
      score += 20;
    }

    // 4. Priority -> +25 if matches primary action characteristics
    if (actionData.priority === 'primary') {
      const cls = (el.className || '').toString().toLowerCase();
      if (cls.includes('primary') || cls.includes('submit') || (el.tagName === 'BUTTON' && el.type === 'submit')) {
        score += 25;
      }
    }

    // 5. Visibility -> +20 if fully visible in viewport
    const rect = el.getBoundingClientRect();
    if (rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth) {
      score += 20;
    }

    return score;
  }

  function resolveAction(action) {
    const candidates = getCandidates();
    let bestEl = null;
    let bestScore = 0;

    for (const el of candidates) {
      const score = scoreCandidate(el, action);
      if (score > bestScore) {
        bestScore = score;
        bestEl = el;
      }
    }

    // Use a minimum threshold to ensure we don't pick up unrelated junk
    const THRESHOLD = 30;
    if (bestScore >= THRESHOLD) {
      return { element: bestEl, score: bestScore };
    }

    return { element: null, score: 0 };
  }

  function resolveAllActions(actions) {
    return actions.map(action => {
      const result = resolveAction(action);
      return { ...action, element: result.element, score: result.score };
    });
  }

  return {
    resolveAction,
    resolveAllActions
  };
})();

if (typeof window !== 'undefined') window.ElementMatcher = ElementMatcher;
if (typeof module !== 'undefined' && module.exports) module.exports = ElementMatcher;
