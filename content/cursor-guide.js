/**
 * FolloMe — Persistent Cursor Guide Engine
 *
 * Architecture:
 *   - ONE cursor div, ONE label div — created once, never removed
 *   - Global state on window (folloSteps, currentStep)
 *   - requestAnimationFrame loop drives smooth lerp movement
 *   - No async/await chains for rendering
 *   - Steps advance ONLY on real user interaction (not timers)
 *   - Cursor stays visible at all times once activated
 *
 * Step State Machine: idle → guiding → waiting → completed
 *
 * Public API (consumed by overlay.js):
 *   processResponse, getExplanation, guideTo, clearAll,
 *   pause, resume, skip, replay, onGuideStateChange, getState
 */

const FolloCursorGuide = (() => {

  // ══════════════════════════════════════════
  //  GLOBAL STATE
  // ══════════════════════════════════════════

  // Persisted on window so they survive across calls
  window.folloSteps = [];
  window.folloCurrentStep = 0;

  let cursorEl = null;       // single cursor div
  let labelEl = null;        // single label div
  let highlightEl = null;    // single highlight div
  let badgeEl = null;        // single step-badge div

  let currentX = -100;       // cursor's current position (off-screen start)
  let currentY = -100;
  let targetX = -100;        // where cursor wants to go
  let targetY = -100;
  let targetRect = null;     // bounding rect of current target element

  let isActive = false;      // guide loop running
  let isPaused = false;
  let arrived = false;       // cursor reached target
  const LERP_SPEED = 0.12;   // movement smoothing factor
  const NEAR_THRESHOLD = 8;  // px distance to consider "arrived"

  // ── Step state machine ──
  // Each step progresses: idle → guiding → waiting → completed
  const STEP_STATE = { IDLE: 'idle', GUIDING: 'guiding', WAITING: 'waiting', COMPLETED: 'completed' };
  let currentStepState = STEP_STATE.IDLE;
  let activeInteractionCleanup = null; // function to remove current event listener

  let onStateChange = null;  // overlay callback

  // ── Last extracted UI elements (for matcher) ──
  let lastUIElements = [];

  // ── Confidence thresholds (raised — reject below 40) ──
  const CONFIDENCE = { HIGH: 60, LOW: 40, NONE: 0 };

  // ── Action patterns for regex parsing ──
  const ACTION_PATTERNS = [
    { regex: /\b(?:click|tap|press|hit)\s+(?:on\s+)?(?:the\s+|a\s+)?['"]?(.+?)['"]?\s*(?:button|link|icon|tab|menu|option|checkbox|radio|toggle|element|field|area)?(?:\s*$|[.,;!])/gim, action: 'click' },
    { regex: /\b(?:type|enter|input|write|fill\s+in)\s+['"]?(.+?)['"]?\s+(?:in(?:to)?|on)\s+(?:the\s+|a\s+)?['"]?(.+?)['"]?(?:\s*$|[.,;!])/gim, action: 'type' },
    { regex: /\b(?:select|choose|pick)\s+['"]?(.+?)['"]?\s+(?:from|in)\s+(?:the\s+|a\s+)?['"]?(.+?)['"]?(?:\s*$|[.,;!])/gim, action: 'select' },
    { regex: /\b(?:scroll)\s+(?:down\s+|up\s+)?(?:to|until)\s+(?:the\s+|a\s+)?['"]?(.+?)['"]?(?:\s*$|[.,;!])/gim, action: 'scroll' },
    { regex: /\b(?:focus|navigate\s+to|go\s+to|find|locate|look\s+(?:for|at))\s+(?:on\s+)?(?:the\s+|a\s+)?['"]?(.+?)['"]?(?:\s*$|[.,;!])/gim, action: 'focus' },
  ];

  const ACTION_LABELS = {
    click:  'Click here',
    type:   'Type here',
    select: 'Select here',
    scroll: 'Scroll here',
    focus:  'Look here',
    fallback: 'Here',
  };


  // ══════════════════════════════════════════
  //  DOM HELPERS
  // ══════════════════════════════════════════

  function getDirectTextContent(el) {
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
    }
    return text || el.textContent || '';
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch { return false; }
  }


  // ══════════════════════════════════════════
  //  INTENT DETECTION
  // ══════════════════════════════════════════

  /**
   * Detect if the AI response contains actionable guidance.
   * Returns true only if the response has clear step-based instructions.
   * Informational, explanatory, or descriptive responses return false.
   */
  function isActionableResponse(responseText) {
    if (!responseText) return false;
    const text = responseText.trim();

    // Positive signal: has an actions JSON block
    if (/```actions/i.test(text)) return true;

    // Positive signal: has JSON with "action" keys
    if (/"action"\s*:\s*"(click|type|select|scroll|focus|hover|toggle|wait)"/i.test(text)) return true;

    // Positive signal: has action verbs in imperative form
    const actionVerbs = /\b(click|tap|press|type|enter|select|choose|scroll|navigate|go to|fill in|check|toggle|submit)\b/gi;
    const matches = text.match(actionVerbs) || [];
    if (matches.length >= 2) return true; // at least 2 action verbs suggests steps

    // Positive signal: numbered steps with action verbs
    if (/\d+[.)].*(click|type|enter|select|press|tap|fill|check|submit)/i.test(text)) return true;

    // Negative signals — purely informational
    const informationalPatterns = [
      /^(this|that|the|it|here)\s+(is|are|was|were|page|website|shows|displays)/i,
      /^(you are|you're)\s+(on|at|viewing|looking)/i,
      /^(welcome|hello|hi)\b/i,
    ];
    const isInformational = informationalPatterns.some(p => p.test(text));
    if (isInformational && matches.length < 2) return false;

    // Default: if short and no action verbs, not actionable
    if (text.length < 100 && matches.length === 0) return false;

    return matches.length >= 1;
  }


  // ══════════════════════════════════════════
  //  RESPONSE NORMALIZATION
  // ══════════════════════════════════════════

  /**
   * Normalize raw AI response text into a clean ```actions [...] ``` block.
   * Returns null if the response is not actionable (informational only).
   *
   * Handles malformed patterns:
   *   - actions[{...}]         (no space/backticks)
   *   - ```json [...] ```      (wrong language tag)
   *   - plain JSON array       (no wrapper at all)
   *   - text + JSON mixed      (preamble/postamble junk)
   *   - single JSON object     (not wrapped in array)
   *   - trailing commas        (common LLM mistake)
   *   - unquoted keys          (common LLM mistake)
   *
   * Returns: { normalized: string, method: string } | null
   */
  function normalizeAIResponse(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      console.warn('[FolloMe] normalizeAIResponse: empty/invalid input');
      return null;
    }

    const trimmed = rawText.trim();

    // ── Case 1: Already has a valid ```actions block ──
    const actionsBlockMatch = trimmed.match(/```actions\s*\n?([\s\S]*?)\n?```/i);
    if (actionsBlockMatch) {
      const inner = actionsBlockMatch[1].trim();
      if (tryParseJSON(inner)) {
        return { normalized: trimmed, method: 'already-valid' };
      }
      const repaired = repairJSON(inner);
      if (repaired) {
        return { normalized: wrapActions(repaired), method: 'repaired-block' };
      }
    }

    // ── Case 2: ```json block (wrong tag) ──
    const jsonBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
    if (jsonBlockMatch) {
      const inner = jsonBlockMatch[1].trim();
      const parsed = tryParseJSON(inner) || tryParseJSON(repairJSON(inner));
      if (parsed) {
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        return { normalized: wrapActions(JSON.stringify(arr)), method: 'json-block-retagged' };
      }
    }

    // ── Case 3: "actions[{...}]" or "actions: [{...}]" pattern ──
    const actionsInlineMatch = trimmed.match(/actions\s*:?\s*(\[[\s\S]*\])/i);
    if (actionsInlineMatch) {
      const inner = actionsInlineMatch[1].trim();
      const parsed = tryParseJSON(inner) || tryParseJSON(repairJSON(inner));
      if (parsed) {
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        return { normalized: wrapActions(JSON.stringify(arr)), method: 'actions-inline' };
      }
    }

    // ── Case 4: Bare JSON array anywhere in the text ──
    const jsonArr = extractJSONArray(trimmed);
    if (jsonArr) {
      return { normalized: wrapActions(jsonArr), method: 'bare-json-extracted' };
    }

    // ── Case 5: Single JSON object (not in array) ──
    const singleObjMatch = trimmed.match(/\{[\s\S]*"action"\s*:[\s\S]*"target"\s*:[\s\S]*\}/i);
    if (singleObjMatch) {
      const parsed = tryParseJSON(singleObjMatch[0]) || tryParseJSON(repairJSON(singleObjMatch[0]));
      if (parsed) {
        return { normalized: wrapActions(JSON.stringify([parsed])), method: 'single-object-wrapped' };
      }
    }

    // ── Case 6: Salvage truncated JSON (regex extraction) ──
    const scraped = scrapeJSONObjects(trimmed);
    if (scraped && scraped.length > 0) {
      return { normalized: wrapActions(JSON.stringify(scraped)), method: 'salvaged-regex' };
    }

    // ── Case 7: Nothing parseable — NOT actionable ──
    console.log('[FolloMe] normalizeAIResponse: no structured actions found — response is informational');
    return null;
  }

  /**
   * Salvage actions from a broken/truncated JSON string.
   * Splits by '{' to isolate objects and uses Regex to extract keys to avoid parse failures.
   */
  function scrapeJSONObjects(text) {
    const actions = [];
    const chunks = text.split(/\{/).slice(1);
    for (const chunk of chunks) {
      const actionMatch = chunk.match(/"action"\s*:\s*"([^"]+)"/i);
      const targetMatch = chunk.match(/"target"\s*:\s*"([^"]+)"/i);
      
      if (actionMatch && targetMatch) {
        const obj = { action: actionMatch[1], target: targetMatch[1] };
        
        const idxMatch = chunk.match(/"idx"\s*:\s*(\d+)/i);
        if (idxMatch) obj.idx = parseInt(idxMatch[1], 10);
        
        const valMatch = chunk.match(/"value"\s*:\s*"([^"]*)"/i);
        if (valMatch) obj.value = valMatch[1];
        
        const expMatch = chunk.match(/"explanation"\s*:\s*"([^"]*)"/i);
        if (expMatch) obj.explanation = expMatch[1];
        
        actions.push(obj);
      }
    }
    return actions.length > 0 ? actions : null;
  }

  /** Wrap a JSON string in the canonical ```actions block */
  function wrapActions(jsonStr) {
    return '```actions\n' + jsonStr + '\n```';
  }

  /** Try to JSON.parse, return parsed value or null */
  function tryParseJSON(str) {
    if (!str) return null;
    try {
      const parsed = JSON.parse(str);
      // Validate it's an array of action objects
      if (Array.isArray(parsed) && parsed.length > 0) {
        if (parsed.every(a => a && typeof a === 'object' && a.action)) return parsed;
        if (parsed.every(a => a && typeof a === 'object' && a.target)) return parsed;
      }
      // Single object with action
      if (parsed && typeof parsed === 'object' && (parsed.action || parsed.target)) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract the first valid JSON array from arbitrary text.
   * Finds the first '[' and scans for the matching ']' using bracket counting.
   */
  function extractJSONArray(text) {
    const firstBracket = text.indexOf('[');
    if (firstBracket === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = firstBracket; i < text.length; i++) {
      const ch = text[i];

      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }

      if (ch === '"' && !escape) { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '[') depth++;
      if (ch === ']') {
        depth--;
        if (depth === 0) {
          const candidate = text.substring(firstBracket, i + 1);
          const parsed = tryParseJSON(candidate) || tryParseJSON(repairJSON(candidate));
          if (parsed) {
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            return JSON.stringify(arr);
          }
          // This bracket pair didn't work, try the next '[' after this one
          const nextBracket = text.indexOf('[', firstBracket + 1);
          if (nextBracket !== -1 && nextBracket < i) {
            return extractJSONArray(text.substring(firstBracket + 1));
          }
          return null;
        }
      }
    }
    return null;
  }

  /**
   * Attempt to repair common JSON errors from LLMs:
   *  - trailing commas before ] or }
   *  - unquoted keys
   *  - single quotes instead of double quotes
   */
  function repairJSON(str) {
    if (!str) return null;
    try {
      let fixed = str;
      // Replace single quotes with double quotes (but not inside strings)
      fixed = fixed.replace(/'/g, '"');
      // Remove trailing commas before } or ]
      fixed = fixed.replace(/,\s*([}\]])/g, '$1');
      // Try to quote unquoted keys: word: → "word":
      fixed = fixed.replace(/(\{|\,)\s*([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
      return fixed;
    } catch {
      return null;
    }
  }


  // ══════════════════════════════════════════
  //  PARSING
  // ══════════════════════════════════════════

  function parseStructuredActions(responseText) {
    if (!responseText) return null;
    let jsonStr = null;

    const blockMatch = responseText.match(/```(?:actions|json)?\s*\n?([\s\S]*?)\n?```/i);
    if (blockMatch) {
      jsonStr = blockMatch[1];
    } else {
      const unstructuredMatch = responseText.match(/(?:actions\s*:\s*)?(\[\s*\{\s*"action"[\s\S]*?\])/i);
      if (unstructuredMatch) jsonStr = unstructuredMatch[1];
    }
    if (!jsonStr) return null;

    try {
      const parsed = JSON.parse(jsonStr.trim());
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      // Relaxed validation — only require "action" OR "target"
      const valid = parsed.every(a => a && (typeof a.action === 'string' || typeof a.target === 'string'));
      if (!valid) return null;

      return parsed.map((a, i) => ({
        action: (a.action || 'click').toLowerCase(),
        target: a.target || a.description || 'element',
        description: a.target || a.description || 'element',
        idx: a.idx !== undefined ? a.idx : null,
        value: a.value || '',
        explanation: a.explanation || '',
        stepNum: i + 1,
        rawLine: a.explanation || a.target || 'action',
        structured: true,
      }));
    } catch (e) {
      console.warn('[FolloMe] parseStructuredActions: JSON.parse failed:', e.message);
      return null;
    }
  }

  function parseActionsRegex(responseText) {
    if (!responseText) return [];
    const actions = [];
    const lines = responseText.split('\n');

    for (const line of lines) {
      const cleanLine = line.replace(/<[^>]*>/g, '').trim();
      if (!cleanLine) continue;

      for (const pattern of ACTION_PATTERNS) {
        pattern.regex.lastIndex = 0;
        const match = pattern.regex.exec(cleanLine);
        if (match) {
          const stepMatch = cleanLine.match(/^(\d+)[.)]\s/);
          actions.push({
            action: pattern.action,
            description: (match[2] || match[1] || '').trim(),
            target: (match[2] || match[1] || '').trim(),
            stepNum: stepMatch ? parseInt(stepMatch[1], 10) : null,
            rawLine: cleanLine,
            structured: false,
          });
          break;
        }
      }
    }
    return actions;
  }

  /**
   * Parse actions from AI response.
   * Pipeline: normalize → parse structured → regex fallback.
   * Returns empty array if response is not actionable.
   */
  function parseActions(responseText) {
    // Step 1: Normalize the raw response
    const result = normalizeAIResponse(responseText);

    if (!result) {
      // Response is informational — no actions to parse
      console.log('[FolloMe] Response is not actionable — skipping cursor guidance');

      // Still try regex as last resort (catches "click the button" style instructions)
      const regexActions = parseActionsRegex(responseText);
      if (regexActions.length > 0) {
        console.log(`[FolloMe] Regex found ${regexActions.length} action(s) in informational text`);
        return regexActions;
      }
      return [];
    }

    const { normalized, method } = result;
    console.log(`[FolloMe] Normalization method: ${method}`);
    console.log(`[FolloMe] Normalized preview: ${normalized.substring(0, 200)}`);

    // Step 2: Try structured parse on normalized text
    const structured = parseStructuredActions(normalized);
    if (structured && structured.length > 0) {
      console.log(`[FolloMe] Parsed ${structured.length} structured actions`);
      return structured;
    }

    // Step 3: Regex fallback on ORIGINAL text
    console.log('[FolloMe] Structured parse failed, trying regex on original');
    const regexActions = parseActionsRegex(responseText);
    if (regexActions.length > 0) {
      console.log(`[FolloMe] Regex fallback found ${regexActions.length} actions`);
      return regexActions;
    }

    console.log('[FolloMe] No actions found after all parsing attempts');
    return [];
  }

  function extractExplanation(responseText) {
    if (!responseText) return '';
    let cleaned = responseText.replace(/```(?:actions|json)?\s*\n?[\s\S]*?\n?```/gi, '').trim();
    cleaned = cleaned.replace(/(?:actions\s*:\s*)?(\[\s*\{\s*"action"[\s\S]*?\])/i, '').trim();
    return cleaned;
  }


  // ══════════════════════════════════════════
  //  ELEMENT SCORING & MATCHING
  //  Weighted: +50 label, +40 placeholder,
  //  +30 text, +20 proximity, +10 tag
  //  Reject elements scoring below 40
  // ══════════════════════════════════════════

  function scoreElement(el, desc) {
    let score = 0;
    const reasons = [];
    const descLower = desc.toLowerCase().replace(/['"]/g, '').trim();
    if (!descLower) return { element: el, score: 0, reasons: ['empty description'] };

    // Reject disabled elements immediately
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      return { element: el, score: 0, reasons: ['disabled'] };
    }

    const directText = getDirectTextContent(el).toLowerCase().trim();
    const elText = (el.textContent || el.innerText || '').toLowerCase().trim();

    // ── +50: Exact label match (input label, form label) ──
    if (el.id) {
      const labelFor = document.querySelector(`label[for="${el.id}"]`);
      if (labelFor) {
        const labelText = (labelFor.textContent || '').toLowerCase().trim();
        if (labelText === descLower || descLower === labelText) { score += 50; reasons.push('exact label'); }
        else if (labelText.includes(descLower) || descLower.includes(labelText)) { score += 35; reasons.push('partial label'); }
      }
    }
    // Implicit label (wrapped in <label>)
    const parentLabel = el.closest('label');
    if (parentLabel && score < 50) {
      const labelText = (parentLabel.textContent || '').toLowerCase().replace((el.value || '').toLowerCase(), '').trim();
      if (labelText.includes(descLower) || descLower.includes(labelText)) { score += 40; reasons.push('parent label'); }
    }

    // ── +50: Exact aria-label match ──
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase().trim();
    if (ariaLabel) {
      if (ariaLabel === descLower) { score += 50; reasons.push('exact aria-label'); }
      else if (ariaLabel.includes(descLower) || descLower.includes(ariaLabel)) { score += 35; reasons.push('partial aria-label'); }
    }

    // ── +40: Placeholder match ──
    const placeholder = (el.placeholder || '').toLowerCase().trim();
    if (placeholder) {
      if (placeholder === descLower) { score += 40; reasons.push('exact placeholder'); }
      else if (placeholder.includes(descLower) || descLower.includes(placeholder)) { score += 30; reasons.push('partial placeholder'); }
    }

    // ── +30: Visible text match ──
    if (directText) {
      if (directText === descLower) { score += 30; reasons.push('exact text'); }
      else if (directText.includes(descLower)) { score += 25; reasons.push('text contains'); }
      else if (descLower.includes(directText) && directText.length > 2) { score += 15; reasons.push('query contains text'); }
    } else if (elText) {
      if (elText.includes(descLower)) { score += 15; reasons.push('nested text'); }
    }

    // ── +20: Title / name attribute proximity ──
    const title = (el.getAttribute('title') || '').toLowerCase();
    if (title && (title.includes(descLower) || descLower.includes(title))) { score += 20; reasons.push('title'); }

    const name = (el.name || '').toLowerCase();
    if (name && (name.includes(descLower) || descLower.includes(name))) { score += 15; reasons.push('name attr'); }

    // ── +10: Correct tag type for action ──
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const interactiveTags = ['button', 'a', 'input', 'textarea', 'select', 'details', 'summary'];
    const interactiveRoles = ['button', 'link', 'textbox', 'combobox', 'menuitem', 'tab', 'checkbox', 'radio', 'switch'];
    if (interactiveTags.includes(tag) || interactiveRoles.includes(role)) { score += 10; reasons.push('interactive'); }

    // ── Viewport + size bonuses (small) ──
    const rect = el.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) { score += 5; reasons.push('in viewport'); }
    if (rect.width >= 20 && rect.width <= 600 && rect.height >= 16 && rect.height <= 300) { score += 3; reasons.push('good size'); }

    // ── Prefer visible + enabled ──
    if (score > 0 && isVisible(el)) { score += 2; }

    return { element: el, score: Math.min(score, 100), reasons };
  }

  function findCandidates(description) {
    if (!description) return [];
    const desc = description.toLowerCase().replace(/['"]/g, '').trim();
    const candidates = [];
    const seen = new Set();

    const selectors = [
      'button', 'a', '[role="button"]', '[role="link"]', '[role="menuitem"]',
      '[role="tab"]', '[role="checkbox"]', '[role="radio"]',
      'input', 'textarea', 'select', '[contenteditable="true"]',
      'summary', 'details',
    ];

    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          if (!seen.has(el) && isVisible(el)) {
            seen.add(el);
            const scored = scoreElement(el, desc);
            if (scored.score > 0) candidates.push(scored);
          }
        });
      } catch {}
    }

    // TreeWalker text search
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (node) => {
          if (node.closest('#follome-overlay') || node.closest('[class*="follome-"]')) return NodeFilter.FILTER_REJECT;
          if (!isVisible(node) || seen.has(node)) return NodeFilter.FILTER_SKIP;
          const nodeText = getDirectTextContent(node).toLowerCase().trim();
          if (nodeText && nodeText.length < 100 && (nodeText.includes(desc) || desc.includes(nodeText))) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        }
      });
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!seen.has(node)) {
          seen.add(node);
          const scored = scoreElement(node, desc);
          if (scored.score > 0) candidates.push(scored);
        }
      }
    } catch {}

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  /**
   * Resolve a single action to an element.
   * Tries ElementMatcher first, falls back to DOM scanning.
   */
  function resolveAction(action) {
    // Strategy 1: ElementMatcher + structured UI elements
    if (typeof ElementMatcher !== 'undefined' && lastUIElements.length > 0) {
      const result = ElementMatcher.matchAction(action, lastUIElements);
      return {
        element: result.element,
        score: result.score,
        reasons: result.reasons,
        confidence: result.confidence,
        candidates: result.candidates || [],
      };
    }

    // Strategy 2: DOM-scanning fallback
    const desc = action.target || action.description;
    const candidates = findCandidates(desc);
    if (candidates.length === 0) return { element: null, score: 0, reasons: [], confidence: 'none', candidates: [] };

    const best = candidates[0];
    let confidence = 'none';
    if (best.score >= CONFIDENCE.HIGH) confidence = 'high';
    else if (best.score >= CONFIDENCE.LOW) confidence = 'low';

    return { element: best.element, score: best.score, reasons: best.reasons, confidence, candidates: candidates.slice(0, 3) };
  }

  function resolveAllActions(actions) {
    return actions.map((action, i) => {
      const resolved = resolveAction(action);
      return { ...action, ...resolved, stepNum: action.stepNum || (actions.length > 1 ? i + 1 : null) };
    });
  }


  // ══════════════════════════════════════════
  //  SINGLE-INSTANCE DOM ELEMENTS
  // ══════════════════════════════════════════

  function ensureCursor() {
    if (cursorEl && cursorEl.parentNode) return;

    cursorEl = document.createElement('div');
    cursorEl.id = 'follome-cursor';
    document.body.appendChild(cursorEl);

    labelEl = document.createElement('div');
    labelEl.id = 'follome-cursor-label';
    document.body.appendChild(labelEl);

    highlightEl = document.createElement('div');
    highlightEl.id = 'follome-cursor-highlight';
    document.body.appendChild(highlightEl);

    badgeEl = document.createElement('div');
    badgeEl.id = 'follome-cursor-badge';
    document.body.appendChild(badgeEl);

    // Position off-screen initially
    setCursorPos(-100, -100);
    hideLabel();
    hideHighlight();
    hideBadge();

    console.log('[FolloMe] CursorGuide: Persistent cursor created');
  }

  function setCursorPos(x, y) {
    if (!cursorEl) return;
    cursorEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  function showLabel(text, x, y) {
    if (!labelEl) return;
    labelEl.textContent = text;
    labelEl.style.transform = `translate3d(${x}px, ${y + 20}px, 0)`;
    labelEl.classList.add('visible');
  }

  function hideLabel() {
    if (!labelEl) return;
    labelEl.classList.remove('visible');
  }

  function showHighlight(rect) {
    if (!highlightEl) return;
    highlightEl.style.left = `${rect.left - 4}px`;
    highlightEl.style.top = `${rect.top - 4}px`;
    highlightEl.style.width = `${rect.width + 8}px`;
    highlightEl.style.height = `${rect.height + 8}px`;
    highlightEl.classList.add('visible');
  }

  function hideHighlight() {
    if (!highlightEl) return;
    highlightEl.classList.remove('visible');
  }

  function showBadge(num, x, y) {
    if (!badgeEl) return;
    badgeEl.textContent = num;
    badgeEl.style.transform = `translate3d(${x - 28}px, ${y - 28}px, 0)`;
    badgeEl.classList.add('visible');
  }

  function hideBadge() {
    if (!badgeEl) return;
    badgeEl.classList.remove('visible');
  }


  // ══════════════════════════════════════════
  //  rAF GUIDANCE LOOP
  //  Movement only — NO auto-completion.
  //  Steps advance ONLY via user interaction.
  // ══════════════════════════════════════════

  function runLoop(timestamp) {
    if (!isActive) return;

    requestAnimationFrame(runLoop);

    if (isPaused) return;

    const steps = window.folloSteps;
    const stepIdx = window.folloCurrentStep;

    // All steps done — cursor stays on last target, label says "Complete"
    if (!steps || stepIdx >= steps.length) {
      if (steps && steps.length > 0) {
        showLabel('✓ Guide complete', currentX, currentY);
      }
      return;
    }

    const step = steps[stepIdx];
    if (!step) return;

    // Resolve element (re-resolve each frame so scrolled elements track)
    const el = step.element;
    if (!el || !isVisible(el)) {
      // Element not found or hidden — skip to next step
      console.warn(`[FolloMe] Step ${stepIdx + 1}: element not found/visible, skipping`);
      advanceStep();
      return;
    }

    // Get element center
    const rect = el.getBoundingClientRect();
    targetX = rect.left + rect.width / 2;
    targetY = rect.top + rect.height / 2;
    targetRect = rect;

    // Scroll into view if off-screen
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Lerp cursor toward target
    currentX += (targetX - currentX) * LERP_SPEED;
    currentY += (targetY - currentY) * LERP_SPEED;
    setCursorPos(currentX - 10, currentY - 10); // offset by half dot size (20/2)

    // Check arrival
    const dist = Math.hypot(targetX - currentX, targetY - currentY);

    if (dist < NEAR_THRESHOLD) {
      if (!arrived) {
        // Just arrived at target — enter GUIDING → WAITING state
        arrived = true;
        cursorEl.classList.add('arrived');
        currentStepState = STEP_STATE.WAITING;

        // Show highlight around target
        showHighlight(rect);

        // Show step badge
        if (step.stepNum) {
          showBadge(step.stepNum, rect.left, rect.top);
        }

        // Show label with waiting indicator
        const actionLabel = ACTION_LABELS[step.action] || ACTION_LABELS.fallback;
        const waitMsg = step.explanation || actionLabel;
        const labelText = `${step.stepNum ? step.stepNum + '. ' : ''}${waitMsg}`;
        showLabel(labelText, rect.left, rect.bottom);

        console.log(`[FolloMe] Step ${stepIdx + 1} targeting: <${el.tagName.toLowerCase()}> "${step.description}"`);
        console.log(`[FolloMe] Waiting for user ${step.action}...`);

        // Attach interaction listener — step advances ONLY when user acts
        attachInteractionListener(step, el);
      }

      // NO dwell timer — cursor stays here until user interacts

    } else {
      // Still moving — cursor is in-flight
      if (arrived) {
        arrived = false;
        cursorEl.classList.remove('arrived');
        currentStepState = STEP_STATE.GUIDING;
      }
    }
  }


  // ══════════════════════════════════════════
  //  USER INTERACTION TRACKING
  //  Steps complete ONLY on real user action.
  // ══════════════════════════════════════════

  /**
   * Attach the correct event listener based on action type.
   * When the user performs the action, the step completes.
   */
  function attachInteractionListener(step, el) {
    // Clean up any previous listener
    detachInteractionListener();

    const action = step.action;
    const stepIdx = window.folloCurrentStep;

    function onComplete(eventType) {
      console.log(`[FolloMe] ✓ User ${eventType} — step ${stepIdx + 1} complete`);
      currentStepState = STEP_STATE.COMPLETED;
      detachInteractionListener();
      advanceStep();
    }

    let handler;
    let event;
    let options = { once: true, capture: true };

    switch (action) {
      case 'type':
        // Wait until the input value actually changes
        event = 'input';
        handler = () => onComplete('typed');
        el.addEventListener(event, handler, options);
        break;

      case 'click':
      case 'tap':
      case 'press':
      case 'toggle':
      case 'hover':
        event = 'click';
        handler = () => onComplete('clicked');
        el.addEventListener(event, handler, options);
        break;

      case 'select':
        event = 'change';
        handler = () => onComplete('selected');
        el.addEventListener(event, handler, options);
        break;

      case 'focus':
        event = 'focus';
        handler = () => onComplete('focused');
        el.addEventListener(event, handler, options);
        break;

      case 'scroll':
        // For scroll, listen on window and complete when near element
        event = 'scroll';
        handler = () => {
          const rect = el.getBoundingClientRect();
          if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
            onComplete('scrolled');
          }
        };
        // Scroll may fire many times, so don't use {once: true}
        window.addEventListener(event, handler, { capture: true });
        activeInteractionCleanup = () => window.removeEventListener(event, handler, { capture: true });
        return;

      case 'wait':
        // Wait action — auto-complete after a short delay (this is intentional "wait")
        const waitTime = 2000;
        const timer = setTimeout(() => onComplete('waited'), waitTime);
        activeInteractionCleanup = () => clearTimeout(timer);
        return;

      default:
        // Unknown action type — listen for click as fallback
        event = 'click';
        handler = () => onComplete('interacted');
        el.addEventListener(event, handler, options);
        break;
    }

    // Store cleanup for non-scroll, non-wait actions
    activeInteractionCleanup = () => {
      el.removeEventListener(event, handler, options);
    };
  }

  /** Remove the current interaction listener */
  function detachInteractionListener() {
    if (activeInteractionCleanup) {
      activeInteractionCleanup();
      activeInteractionCleanup = null;
    }
  }

  function advanceStep() {
    arrived = false;
    currentStepState = STEP_STATE.IDLE;
    detachInteractionListener();
    hideLabel();
    hideHighlight();
    hideBadge();
    if (cursorEl) cursorEl.classList.remove('arrived');

    window.folloCurrentStep++;
    emitState();

    if (window.folloCurrentStep >= window.folloSteps.length) {
      console.log('[FolloMe] CursorGuide: All steps complete');
    }
  }


  // ══════════════════════════════════════════
  //  STATE MANAGEMENT
  // ══════════════════════════════════════════

  function emitState() {
    if (onStateChange) {
      onStateChange({
        isRunning: isActive,
        isPaused,
        currentStep: window.folloCurrentStep,
        totalSteps: window.folloSteps.length,
        steps: window.folloSteps.map((s, i) => ({
          action: s.action,
          description: s.description,
          confidence: s.confidence,
          score: s.score,
          isCurrent: i === window.folloCurrentStep,
        })),
      });
    }
  }


  // ══════════════════════════════════════════
  //  MAIN ENTRY POINTS
  // ══════════════════════════════════════════

  /**
   * Main entry — process AI response, extract actions, start guidance loop.
   */
  function processResponse(responseText) {
    console.log('[FolloMe] ▶▶▶ CursorGuide.processResponse CALLED');
    console.log('[FolloMe] Raw response length:', responseText?.length);
    console.log('[FolloMe] Raw response preview:', (responseText || '').substring(0, 300));

    // ── INTENT FILTER: Skip cursor for non-actionable responses ──
    if (!isActionableResponse(responseText)) {
      console.log('[FolloMe] Response is informational — showing overlay text only, no cursor guidance');
      return; // overlay.js already shows the text
    }

    // Refresh UI elements for matching
    if (typeof ContextExtractor !== 'undefined') {
      try {
        lastUIElements = ContextExtractor.getUIElements();
        console.log(`[FolloMe] Extracted ${lastUIElements.length} UI elements for matching`);
      } catch (e) {
        console.warn('[FolloMe] UI element extraction failed:', e);
        lastUIElements = [];
      }
    }

    // Parse actions (may return empty if not actionable)
    const actions = parseActions(responseText);
    console.log(`[FolloMe] Parsed actions: ${actions.length}`);

    if (!actions || actions.length === 0) {
      console.log('[FolloMe] No actionable steps parsed — cursor not activated');
      return;
    }

    // Resolve actions to DOM elements
    const steps = resolveAllActions(actions);

    // Log each step
    steps.forEach((s, i) => {
      const elTag = s.element ? `<${s.element.tagName.toLowerCase()}>` : 'NULL';
      console.log(
        `[FolloMe]   Step ${i + 1}: ${s.action} "${s.description}" → ${elTag} ` +
        `(confidence: ${s.confidence}, score: ${s.score}, reasons: [${s.reasons.join(', ')}])`
      );
    });

    // Filter to steps with visible elements AND sufficient confidence (score >= 40)
    const validSteps = steps.filter(s => s.element && isVisible(s.element) && s.score >= CONFIDENCE.LOW);
    console.log(`[FolloMe] ${validSteps.length}/${steps.length} steps have confident visible elements`);

    if (validSteps.length === 0) {
      console.warn('[FolloMe] No confident matches — cursor not activated');
      steps.forEach(s => {
        window.dispatchEvent(new CustomEvent('follome-guide-nomatch', {
          detail: { action: s.action, description: s.description, rawLine: s.rawLine }
        }));
      });
      return;
    }

    // Store globally and start
    window.folloSteps = validSteps;
    window.folloCurrentStep = 0;
    arrived = false;
    currentStepState = STEP_STATE.IDLE;
    detachInteractionListener();

    // Create cursor elements if needed
    ensureCursor();
    cursorEl.classList.add('active');

    // Position cursor at starting point (top-right of viewport)
    currentX = window.innerWidth - 60;
    currentY = 80;
    setCursorPos(currentX - 10, currentY - 10);

    // Start the loop
    if (!isActive) {
      isActive = true;
      requestAnimationFrame(runLoop);
    }
    isPaused = false;
    emitState();

    console.log(`[FolloMe] ✓ Guidance started: ${validSteps.length} steps (waiting for user interaction)`);
  }

  /**
   * Get explanation text (stripped of action JSON)
   */
  function getExplanation(responseText) {
    return extractExplanation(responseText);
  }

  /**
   * Manually guide cursor to a CSS selector
   */
  function guideTo(selector, actionType = 'click', labelText = null) {
    console.log(`[FolloMe] guideTo: "${selector}"`);
    try {
      const el = document.querySelector(selector);
      if (!el || !isVisible(el)) {
        console.warn(`[FolloMe] guideTo: element not found — ${selector}`);
        return;
      }

      // Set up as single-step guidance
      window.folloSteps = [{
        action: actionType,
        description: labelText || selector,
        target: selector,
        element: el,
        score: 100,
        confidence: 'high',
        reasons: ['manual selector'],
        stepNum: 1,
        rawLine: selector,
      }];
      window.folloCurrentStep = 0;
      arrived = false;

      ensureCursor();
      cursorEl.classList.add('active');

      if (!isActive) {
        isActive = true;
        requestAnimationFrame(runLoop);
      }
      isPaused = false;
      emitState();
    } catch (err) {
      console.warn('[FolloMe] guideTo error:', err);
    }
  }


  // ══════════════════════════════════════════
  //  PLAYBACK CONTROLS
  // ══════════════════════════════════════════

  function pause() {
    if (!isActive || isPaused) return;
    isPaused = true;
    if (cursorEl) cursorEl.classList.add('paused');
    emitState();
  }

  function resume() {
    if (!isPaused) return;
    isPaused = false;
    if (cursorEl) cursorEl.classList.remove('paused');
    emitState();
  }

  function skip() {
    if (!isActive) return;
    advanceStep();
  }

  function replay() {
    if (window.folloSteps.length === 0) return;

    // Re-resolve elements (they may have moved)
    const rawActions = window.folloSteps.map(s => ({
      action: s.action,
      description: s.description,
      target: s.target,
      stepNum: s.stepNum,
      rawLine: s.rawLine,
      idx: s.idx,
      value: s.value,
    }));

    const steps = resolveAllActions(rawActions);
    const validSteps = steps.filter(s => s.element && isVisible(s.element));

    if (validSteps.length === 0) {
      console.warn('[FolloMe] Replay: no valid steps remain');
      return;
    }

    window.folloSteps = validSteps;
    window.folloCurrentStep = 0;
    arrived = false;
    isPaused = false;

    // Reset cursor to start position
    currentX = window.innerWidth - 60;
    currentY = 80;

    hideLabel();
    hideHighlight();
    hideBadge();

    if (!isActive) {
      isActive = true;
      requestAnimationFrame(runLoop);
    }

    if (cursorEl) {
      cursorEl.classList.remove('arrived', 'paused');
      cursorEl.classList.add('active');
    }

    emitState();
    console.log(`[FolloMe] Replay started: ${validSteps.length} steps`);
  }

  /**
   * Clear all — hide cursor and reset state.
   * Cursor DOM elements are NOT removed, just hidden.
   */
  function clearAll() {
    isActive = false;
    isPaused = false;
    arrived = false;
    currentStepState = STEP_STATE.IDLE;
    detachInteractionListener();
    window.folloSteps = [];
    window.folloCurrentStep = 0;

    if (cursorEl) cursorEl.classList.remove('active', 'arrived', 'paused');
    hideLabel();
    hideHighlight();
    hideBadge();

    // Move cursor off-screen
    currentX = -100;
    currentY = -100;
    setCursorPos(-100, -100);

    emitState();
  }


  // ══════════════════════════════════════════
  //  LEGACY COMPAT
  // ══════════════════════════════════════════

  function findElement(description) {
    const candidates = findCandidates(description);
    return candidates.length > 0 && candidates[0].score >= CONFIDENCE.LOW ? candidates[0].element : null;
  }

  function onGuideStateChange(callback) {
    onStateChange = callback;
  }

  function getState() {
    return {
      isRunning: isActive,
      isPaused,
      currentStep: window.folloCurrentStep,
      totalSteps: window.folloSteps.length,
    };
  }


  // ── Public API ──
  return {
    processResponse,
    getExplanation,
    guideTo,
    clearAll,
    parseActions,
    parseStructuredActions,
    findElement,
    findCandidates,
    // Playback
    pause,
    resume,
    skip,
    replay,
    // State
    onGuideStateChange,
    getState,
  };
})();

// Expose globally
if (typeof window !== 'undefined') {
  window.FolloCursorGuide = FolloCursorGuide;
}
