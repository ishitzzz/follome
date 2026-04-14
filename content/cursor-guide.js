/**
 * FolloMe — Cursor Guide System v2
 * Confidence-scored, curve-pathed, user-controllable guidance.
 *
 * When an AI response contains action directives (click, type, select, scroll),
 * this module:
 * 1. Parses the response text for action markers
 * 2. Locates target elements with confidence scoring
 * 3. Renders animated pointer with curved Bézier travel
 * 4. Sequences multi-step guidance with pause/skip/replay controls
 *
 * Does NOT move the user's real cursor — visual overlay only.
 */

const FolloCursorGuide = (() => {
  // ── Active guide elements ──
  let activeDot = null;
  let activeLabel = null;
  let activeHighlight = null;
  let activeBadge = null;
  let activeRings = [];
  let activeCandidates = [];  // Low-confidence candidate elements
  let trailDots = [];

  // ── Last extracted UI elements (for matcher) ──
  let lastUIElements = [];

  // ── Playback state ──
  let guideSteps = [];         // Resolved steps with elements + confidence
  let currentStepIndex = -1;
  let isRunning = false;
  let isPaused = false;
  let currentAbortController = null;
  let pauseResolver = null;    // Resolves when unpaused

  // ── Callbacks for overlay UI sync ──
  let onStateChange = null;

  // ── Confidence thresholds ──
  const CONFIDENCE = {
    HIGH: 60,      // Animate directly
    LOW: 30,       // Show candidates
    NONE: 0,       // Show fallback message
  };

  // ── Action verb patterns to detect ──
  const ACTION_PATTERNS = [
    { regex: /\b(?:click|tap|press|hit)\s+(?:on\s+)?(?:the\s+|a\s+)?['"]?(.+?)['"]?\s*(?:button|link|icon|tab|menu|option|checkbox|radio|toggle|element|field|area)?(?:\s*$|[.,;!])/gim, action: 'click' },
    { regex: /\b(?:type|enter|input|write|fill\s+in)\s+['"]?(.+?)['"]?\s+(?:in(?:to)?|on)\s+(?:the\s+|a\s+)?['"]?(.+?)['"]?(?:\s*$|[.,;!])/gim, action: 'type' },
    { regex: /\b(?:select|choose|pick)\s+['"]?(.+?)['"]?\s+(?:from|in)\s+(?:the\s+|a\s+)?['"]?(.+?)['"]?(?:\s*$|[.,;!])/gim, action: 'select' },
    { regex: /\b(?:scroll)\s+(?:down\s+|up\s+)?(?:to|until)\s+(?:the\s+|a\s+)?['"]?(.+?)['"]?(?:\s*$|[.,;!])/gim, action: 'scroll' },
    { regex: /\b(?:focus|navigate\s+to|go\s+to|find|locate|look\s+(?:for|at))\s+(?:on\s+)?(?:the\s+|a\s+)?['"]?(.+?)['"]?(?:\s*$|[.,;!])/gim, action: 'focus' },
  ];

  // ── Label text for actions ──
  const ACTION_LABELS = {
    click:  { text: 'Click here',  icon: 'pointer' },
    type:   { text: 'Type here',   icon: 'keyboard' },
    select: { text: 'Select here', icon: 'list' },
    scroll: { text: 'Scroll here', icon: 'arrow' },
    focus:  { text: 'Look here',   icon: 'eye' },
  };

  // ── SVG icons for labels ──
  const LABEL_ICONS = {
    pointer: '<svg viewBox="0 0 24 24"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>',
    keyboard: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="8" y1="16" x2="16" y2="16"/></svg>',
    list: '<svg viewBox="0 0 24 24"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    question: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  };

  // ══════════════════════════════════════════
  //  CONFIDENCE SCORING
  // ══════════════════════════════════════════

  /**
   * Score a single element against a text description.
   * Returns { element, score, reasons[] }
   */
  function scoreElement(el, desc) {
    let score = 0;
    const reasons = [];
    const descLower = desc.toLowerCase().replace(/['"]/g, '').trim();
    if (!descLower) return { element: el, score: 0, reasons: ['empty description'] };

    // ── Text content match ──
    const elText = (el.textContent || el.innerText || '').toLowerCase().trim();
    const directText = getDirectTextContent(el).toLowerCase().trim();

    if (directText === descLower) {
      score += 40;
      reasons.push('exact text match');
    } else if (directText.includes(descLower)) {
      score += 30;
      reasons.push('text contains query');
    } else if (descLower.includes(directText) && directText.length > 2) {
      score += 20;
      reasons.push('query contains text');
    } else if (elText.includes(descLower)) {
      score += 15;
      reasons.push('nested text match');
    } else if (descLower.includes(elText) && elText.length > 2) {
      score += 10;
      reasons.push('partial nested match');
    }

    // ── Attribute matches ──
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel && (ariaLabel.includes(descLower) || descLower.includes(ariaLabel))) {
      score += 20;
      reasons.push('aria-label match');
    }

    const placeholder = (el.placeholder || '').toLowerCase();
    if (placeholder && (placeholder.includes(descLower) || descLower.includes(placeholder))) {
      score += 20;
      reasons.push('placeholder match');
    }

    const title = (el.getAttribute('title') || '').toLowerCase();
    if (title && (title.includes(descLower) || descLower.includes(title))) {
      score += 15;
      reasons.push('title match');
    }

    const name = (el.name || '').toLowerCase();
    if (name && (name.includes(descLower) || descLower.includes(name))) {
      score += 12;
      reasons.push('name match');
    }

    // Check associated <label>
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) {
        const labelText = (label.textContent || '').toLowerCase();
        if (labelText.includes(descLower) || descLower.includes(labelText)) {
          score += 18;
          reasons.push('label match');
        }
      }
    }

    // ── Interactivity bonus ──
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const interactiveTags = ['button', 'a', 'input', 'textarea', 'select', 'details', 'summary'];
    const interactiveRoles = ['button', 'link', 'textbox', 'combobox', 'menuitem', 'tab', 'checkbox', 'radio', 'switch'];

    if (interactiveTags.includes(tag) || interactiveRoles.includes(role)) {
      score += 10;
      reasons.push('interactive element');
    }

    // ── Visibility quality ──
    const rect = el.getBoundingClientRect();
    const inViewport = rect.top >= 0 && rect.bottom <= window.innerHeight;
    if (inViewport) {
      score += 5;
      reasons.push('in viewport');
    }

    // Reasonable size (not tiny, not huge)
    if (rect.width >= 20 && rect.width <= 600 && rect.height >= 16 && rect.height <= 300) {
      score += 5;
      reasons.push('good size');
    }

    // ── Specificity bonus (shorter text = more specific match) ──
    if (directText.length > 0 && directText.length < 50) {
      score += 5;
      reasons.push('specific element');
    }

    return { element: el, score: Math.min(score, 100), reasons };
  }

  /**
   * Find all candidate elements for a description, each with confidence score.
   * Returns sorted array of { element, score, reasons } — best first.
   */
  function findCandidates(description) {
    if (!description) return [];
    const desc = description.toLowerCase().replace(/['"]/g, '').trim();
    const candidates = [];
    const seen = new Set();

    // Gather candidates from multiple strategies
    const selectors = [
      'button', 'a', '[role="button"]', '[role="link"]', '[role="menuitem"]',
      '[role="tab"]', '[role="checkbox"]', '[role="radio"]',
      'input', 'textarea', 'select', '[contenteditable="true"]',
      'summary', 'details',
    ];

    // Strategy 1: Interactive elements
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          if (!seen.has(el) && isVisible(el)) {
            seen.add(el);
            const scored = scoreElement(el, desc);
            if (scored.score > 0) candidates.push(scored);
          }
        });
      } catch (e) { /* skip invalid selectors */ }
    }

    // Strategy 2: Attribute selectors
    try {
      const escapedDesc = CSS.escape(desc);
      const attrSelectors = [
        `[aria-label*="${desc}" i]`,
        `[title*="${desc}" i]`,
        `[placeholder*="${desc}" i]`,
        `[data-testid*="${desc}" i]`,
      ];
      for (const sel of attrSelectors) {
        try {
          document.querySelectorAll(sel).forEach((el) => {
            if (!seen.has(el) && isVisible(el)) {
              seen.add(el);
              const scored = scoreElement(el, desc);
              if (scored.score > 0) candidates.push(scored);
            }
          });
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* skip */ }

    // Strategy 3: ID-based lookup
    for (const sep of ['-', '_', '']) {
      const id = desc.replace(/\s+/g, sep);
      const el = document.getElementById(id);
      if (el && !seen.has(el) && isVisible(el)) {
        seen.add(el);
        const scored = scoreElement(el, desc);
        if (scored.score > 0) candidates.push(scored);
      }
    }

    // Strategy 4: TreeWalker text search
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          if (node.closest('#follome-overlay') || node.closest('[class*="follome-"]')) {
            return NodeFilter.FILTER_REJECT;
          }
          if (!isVisible(node) || seen.has(node)) return NodeFilter.FILTER_SKIP;
          const nodeText = getDirectTextContent(node).toLowerCase().trim();
          if (nodeText && nodeText.length < 100 && (nodeText.includes(desc) || desc.includes(nodeText))) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }
      }
    );

    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!seen.has(node)) {
        seen.add(node);
        const scored = scoreElement(node, desc);
        if (scored.score > 0) candidates.push(scored);
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    return candidates;
  }

  /**
   * Resolve a single action to an element with confidence.
   * Uses ElementMatcher when available for fuzzy matching against structured UI elements.
   * Falls back to the DOM-scanning findCandidates approach.
   *
   * Returns { element, score, reasons, confidence: 'high'|'low'|'none', candidates[] }
   */
  function resolveAction(action) {
    // Strategy 1: Use ElementMatcher + structured UI elements (most reliable)
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

    // Strategy 2: Fallback to DOM-scanning approach
    const desc = action.target || action.description;
    const candidates = findCandidates(desc);

    if (candidates.length === 0) {
      return { element: null, score: 0, reasons: [], confidence: 'none', candidates: [] };
    }

    const best = candidates[0];

    if (best.score >= CONFIDENCE.HIGH) {
      return {
        element: best.element,
        score: best.score,
        reasons: best.reasons,
        confidence: 'high',
        candidates: candidates.slice(0, 3),
      };
    }

    if (best.score >= CONFIDENCE.LOW) {
      return {
        element: best.element,
        score: best.score,
        reasons: best.reasons,
        confidence: 'low',
        candidates: candidates.slice(0, 3),
      };
    }

    return {
      element: best.element,
      score: best.score,
      reasons: best.reasons,
      confidence: 'none',
      candidates: candidates.slice(0, 3),
    };
  }

  // ══════════════════════════════════════════
  //  PARSING
  // ══════════════════════════════════════════

  /**
   * Try to parse structured JSON actions from AI response.
   * Looks for ```actions [...] ``` blocks.
   * Returns null if not found.
   */
  function parseStructuredActions(responseText) {
    if (!responseText) return null;

    // Match ```actions ... ``` code blocks
    const blockMatch = responseText.match(/```actions\s*\n?([\s\S]*?)\n?```/i);
    if (!blockMatch) return null;

    try {
      const parsed = JSON.parse(blockMatch[1].trim());
      if (!Array.isArray(parsed) || parsed.length === 0) return null;

      // Validate structure
      const valid = parsed.every(a => a && typeof a.action === 'string' && typeof a.target === 'string');
      if (!valid) return null;

      return parsed.map((a, i) => ({
        action: a.action.toLowerCase(),
        target: a.target,
        description: a.target,
        idx: a.idx !== undefined ? a.idx : null,
        value: a.value || '',
        explanation: a.explanation || '',
        stepNum: i + 1,
        rawLine: a.explanation || a.target,
        structured: true,
      }));
    } catch (e) {
      console.warn('[FolloMe] CursorGuide: Failed to parse structured actions:', e);
      return null;
    }
  }

  /**
   * Extract the human-readable explanation from a structured response.
   * Returns the text after the ```actions``` block.
   */
  function extractExplanation(responseText) {
    if (!responseText) return '';
    // Remove the actions block and return the rest
    const cleaned = responseText.replace(/```actions\s*\n?[\s\S]*?\n?```/gi, '').trim();
    return cleaned;
  }

  /**
   * Parse AI response text for action directives using regex (fallback).
   */
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
          const stepNum = stepMatch ? parseInt(stepMatch[1], 10) : null;

          actions.push({
            action: pattern.action,
            description: (match[2] || match[1] || '').trim(),
            target: (match[2] || match[1] || '').trim(),
            stepNum,
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
   * Parse actions — tries structured JSON first, falls back to regex.
   */
  function parseActions(responseText) {
    // Try structured first
    const structured = parseStructuredActions(responseText);
    if (structured && structured.length > 0) {
      console.log('[FolloMe] CursorGuide: Parsed structured actions from AI response');
      return structured;
    }

    // Fallback to regex
    console.log('[FolloMe] CursorGuide: No structured block found, using regex fallback');
    return parseActionsRegex(responseText);
  }

  // ══════════════════════════════════════════
  //  DOM HELPERS
  // ══════════════════════════════════════════

  function getDirectTextContent(el) {
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      }
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
    } catch (e) {
      return false;
    }
  }

  function getElementCenter(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      rect,
    };
  }

  // ══════════════════════════════════════════
  //  CURVED PATH MOVEMENT
  // ══════════════════════════════════════════

  /**
   * Animate the dot along a quadratic Bézier curve from current pos to (toX, toY).
   * The control point is offset perpendicular to the straight path for a natural arc.
   */
  function moveDotCurved(toX, toY, duration = 800) {
    return new Promise((resolve) => {
      if (!activeDot) {
        createDot(toX, toY);
        resolve();
        return;
      }

      const fromX = parseFloat(activeDot.style.left) || 0;
      const fromY = parseFloat(activeDot.style.top) || 0;
      const dist = Math.hypot(toX - fromX, toY - fromY);

      // If very close, just snap
      if (dist < 30) {
        activeDot.style.left = `${toX}px`;
        activeDot.style.top = `${toY}px`;
        resolve();
        return;
      }

      // Compute Bézier control point — perpendicular offset for arc feel
      const midX = (fromX + toX) / 2;
      const midY = (fromY + toY) / 2;
      const perpAngle = Math.atan2(toY - fromY, toX - fromX) + Math.PI / 2;
      const arcOffset = Math.min(dist * 0.3, 120) * (Math.random() > 0.5 ? 1 : -1);
      const cpX = midX + Math.cos(perpAngle) * arcOffset;
      const cpY = midY + Math.sin(perpAngle) * arcOffset;

      // Remove CSS transitions for manual animation
      activeDot.style.transition = 'none';
      activeDot.classList.remove('idle', 'moving');
      activeDot.classList.add('in-flight');

      const startTime = performance.now();
      const scaledDuration = Math.min(duration, 300 + dist * 0.8);

      // Spawn trail along the curve
      const trailCount = Math.min(6, Math.floor(dist / 60));

      function animate(now) {
        const elapsed = now - startTime;
        const t = Math.min(elapsed / scaledDuration, 1);

        // Ease-in-out cubic
        const ease = t < 0.5
          ? 4 * t * t * t
          : 1 - Math.pow(-2 * t + 2, 3) / 2;

        // Quadratic Bézier
        const x = (1 - ease) * (1 - ease) * fromX + 2 * (1 - ease) * ease * cpX + ease * ease * toX;
        const y = (1 - ease) * (1 - ease) * fromY + 2 * (1 - ease) * ease * cpY + ease * ease * toY;

        activeDot.style.left = `${x}px`;
        activeDot.style.top = `${y}px`;

        // Spawn trail dots at regular intervals
        if (trailCount > 0 && t > 0.1 && t < 0.9) {
          const trailInterval = 1 / (trailCount + 1);
          const trailIndex = Math.floor(t / trailInterval);
          if (trailIndex > 0 && trailIndex <= trailCount) {
            const trailId = `trail-${trailIndex}`;
            if (!activeDot.dataset[trailId]) {
              activeDot.dataset[trailId] = '1';
              spawnSingleTrail(x, y, 0.5 - t * 0.4);
            }
          }
        }

        if (t < 1) {
          requestAnimationFrame(animate);
        } else {
          // Arrival — restore transition, add scale-up pop
          activeDot.classList.remove('in-flight');
          activeDot.style.transition = '';
          activeDot.classList.add('arriving');

          // Clean up trail markers
          Object.keys(activeDot.dataset).forEach(k => {
            if (k.startsWith('trail-')) delete activeDot.dataset[k];
          });

          // Scale-up pop on arrival, then settle to idle
          setTimeout(() => {
            if (activeDot) {
              activeDot.classList.remove('arriving');
              activeDot.classList.add('idle');
            }
            resolve();
          }, 350);
        }
      }

      requestAnimationFrame(animate);
    });
  }

  /**
   * Spawn a single trail dot at position
   */
  function spawnSingleTrail(x, y, opacity) {
    const dot = document.createElement('div');
    dot.className = 'follome-trail-dot';
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
    dot.style.opacity = `${opacity}`;
    document.body.appendChild(dot);
    trailDots.push(dot);

    setTimeout(() => {
      dot.classList.add('fading');
      setTimeout(() => dot.remove(), 400);
    }, 250);
  }

  // ══════════════════════════════════════════
  //  RENDERING
  // ══════════════════════════════════════════

  function createDot(x, y) {
    removeDot();
    const dot = document.createElement('div');
    dot.className = 'follome-cursor-dot';
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
    document.body.appendChild(dot);
    activeDot = dot;

    requestAnimationFrame(() => {
      dot.classList.add('visible');
    });

    return dot;
  }

  function createPulseRings(x, y) {
    removeRings();
    for (let i = 0; i < 2; i++) {
      const ring = document.createElement('div');
      ring.className = `follome-pulse-ring ${i > 0 ? `ring-${i + 1}` : ''}`;
      ring.style.left = `${x}px`;
      ring.style.top = `${y}px`;
      ring.style.width = '18px';
      ring.style.height = '18px';
      document.body.appendChild(ring);
      activeRings.push(ring);
    }

    setTimeout(() => {
      removeRings();
      for (let i = 0; i < 2; i++) {
        const ring = document.createElement('div');
        ring.className = `follome-pulse-ring repeating ${i > 0 ? 'ring-2' : ''}`;
        ring.style.left = `${x}px`;
        ring.style.top = `${y}px`;
        ring.style.width = '18px';
        ring.style.height = '18px';
        document.body.appendChild(ring);
        activeRings.push(ring);
      }
    }, 1900);
  }

  function createLabel(x, y, actionType, customText, rect) {
    removeLabel();
    const config = ACTION_LABELS[actionType] || ACTION_LABELS.click;
    const icon = LABEL_ICONS[config.icon] || LABEL_ICONS.pointer;
    const text = customText || config.text;

    const label = document.createElement('div');
    label.className = 'follome-guide-label';

    const viewportH = window.innerHeight;
    const isNearBottom = y > viewportH - 100;

    if (isNearBottom) {
      label.classList.add('above');
      label.style.left = `${(rect ? rect.left : x) + 4}px`;
      label.style.top = `${(rect ? rect.top : y) - 40}px`;
    } else {
      label.style.left = `${(rect ? rect.left : x) + 4}px`;
      label.style.top = `${(rect ? rect.bottom || y : y) + 10}px`;
    }

    label.innerHTML = `
      <span class="follome-label-icon">${icon}</span>
      <span>${text}</span>
    `;

    document.body.appendChild(label);
    activeLabel = label;

    requestAnimationFrame(() => {
      label.classList.add('visible');
    });

    return label;
  }

  /**
   * Create label for low-confidence candidate (different styling)
   */
  function createCandidateLabel(el, index) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.bottom + 8;

    const label = document.createElement('div');
    label.className = 'follome-guide-label follome-candidate-label';
    label.style.left = `${rect.left + 4}px`;
    label.style.top = `${y}px`;

    label.innerHTML = `
      <span class="follome-label-icon candidate">${LABEL_ICONS.question}</span>
      <span>Possible match ${index + 1}</span>
    `;

    document.body.appendChild(label);

    // Highlight the candidate
    const hl = document.createElement('div');
    hl.className = 'follome-target-highlight follome-candidate-highlight';
    hl.style.left = `${rect.left - 4}px`;
    hl.style.top = `${rect.top - 4}px`;
    hl.style.width = `${rect.width + 8}px`;
    hl.style.height = `${rect.height + 8}px`;
    document.body.appendChild(hl);

    requestAnimationFrame(() => {
      label.classList.add('visible');
      hl.classList.add('visible');
    });

    activeCandidates.push(label, hl);
  }

  function createHighlight(rect) {
    removeHighlight();
    const hl = document.createElement('div');
    hl.className = 'follome-target-highlight';
    hl.style.left = `${rect.left - 4}px`;
    hl.style.top = `${rect.top - 4}px`;
    hl.style.width = `${rect.width + 8}px`;
    hl.style.height = `${rect.height + 8}px`;
    document.body.appendChild(hl);
    activeHighlight = hl;

    requestAnimationFrame(() => {
      hl.classList.add('visible');
    });

    return hl;
  }

  function createStepBadge(x, y, stepNum) {
    removeBadge();
    const badge = document.createElement('div');
    badge.className = 'follome-step-badge';
    badge.textContent = stepNum;
    badge.style.left = `${x - 20}px`;
    badge.style.top = `${y - 20}px`;
    document.body.appendChild(badge);
    activeBadge = badge;

    requestAnimationFrame(() => {
      badge.classList.add('visible');
    });

    return badge;
  }

  /**
   * Show "thinking" state on the dot before moving
   */
  function showThinking() {
    if (activeDot) {
      activeDot.classList.add('thinking');
    }
  }

  function hideThinking() {
    if (activeDot) {
      activeDot.classList.remove('thinking');
    }
  }

  // ══════════════════════════════════════════
  //  CLEANUP
  // ══════════════════════════════════════════

  function removeDot() {
    if (activeDot) {
      activeDot.classList.add('exiting');
      const dot = activeDot;
      setTimeout(() => dot.remove(), 300);
      activeDot = null;
    }
  }

  function removeLabel() {
    if (activeLabel) {
      activeLabel.classList.add('exiting');
      const lbl = activeLabel;
      setTimeout(() => lbl.remove(), 300);
      activeLabel = null;
    }
  }

  function removeHighlight() {
    if (activeHighlight) {
      activeHighlight.classList.add('exiting');
      const hl = activeHighlight;
      setTimeout(() => hl.remove(), 300);
      activeHighlight = null;
    }
  }

  function removeRings() {
    activeRings.forEach((r) => r.remove());
    activeRings = [];
  }

  function removeBadge() {
    if (activeBadge) {
      activeBadge.classList.add('exiting');
      const b = activeBadge;
      setTimeout(() => b.remove(), 300);
      activeBadge = null;
    }
  }

  function removeTrailDots() {
    trailDots.forEach((d) => d.remove());
    trailDots = [];
  }

  function removeCandidates() {
    activeCandidates.forEach((el) => {
      el.classList.add('exiting');
      setTimeout(() => el.remove(), 300);
    });
    activeCandidates = [];
  }

  function clearAllVisuals() {
    removeDot();
    removeLabel();
    removeHighlight();
    removeRings();
    removeBadge();
    removeTrailDots();
    removeCandidates();
  }

  function clearAll() {
    clearAllVisuals();
    guideSteps = [];
    currentStepIndex = -1;
    isRunning = false;
    isPaused = false;
    pauseResolver = null;
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    emitState();
  }

  // ══════════════════════════════════════════
  //  STATE MANAGEMENT & EVENTS
  // ══════════════════════════════════════════

  function emitState() {
    if (onStateChange) {
      onStateChange({
        isRunning,
        isPaused,
        currentStep: currentStepIndex,
        totalSteps: guideSteps.length,
        steps: guideSteps.map((s, i) => ({
          action: s.action,
          description: s.description,
          confidence: s.confidence,
          score: s.score,
          isCurrent: i === currentStepIndex,
        })),
      });
    }
  }

  // ══════════════════════════════════════════
  //  ORCHESTRATION
  // ══════════════════════════════════════════

  /**
   * Abortable delay that also respects pause state
   */
  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }
    });
  }

  /**
   * Wait if paused — returns a promise that resolves when unpaused
   */
  async function waitIfPaused(signal) {
    while (isPaused) {
      await new Promise((resolve) => {
        pauseResolver = resolve;
        // Also abort if signal fires
        if (signal) {
          signal.addEventListener('abort', resolve, { once: true });
        }
      });
      if (signal && signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
    }
  }

  /**
   * Guide to a single HIGH-confidence element
   */
  async function guideToHighConfidence(step, signal) {
    const el = step.element;
    const { x, y, rect } = getElementCenter(el);

    // Scroll into view if needed
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await wait(500, signal);
    }

    const pos = getElementCenter(el);

    // "Thinking" delay — dot pauses with visual feedback
    showThinking();
    await wait(400 + Math.random() * 200, signal);
    hideThinking();

    await waitIfPaused(signal);

    // Create dot if needed (start off-screen)
    if (!activeDot) {
      createDot(window.innerWidth + 30, pos.y);
      await wait(100, signal);
    }

    // Curved movement to target
    await moveDotCurved(pos.x, pos.y);
    await wait(200, signal);

    // Pulse rings on arrival
    createPulseRings(pos.x, pos.y);
    await wait(300, signal);

    // Highlight target
    createHighlight(pos.rect);
    await wait(200, signal);

    // Step badge
    if (step.stepNum) {
      createStepBadge(pos.rect.left, pos.rect.top, step.stepNum);
    }

    // Label
    const config = ACTION_LABELS[step.action] || ACTION_LABELS.click;
    createLabel(pos.x, pos.y, step.action, config.text, pos.rect);
  }

  /**
   * Show LOW-confidence candidates
   */
  async function guideToLowConfidence(step, signal) {
    const candidates = step.candidates.slice(0, 3);

    removeCandidates();

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (!isVisible(c.element)) continue;

      const rect = c.element.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        c.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await wait(300, signal);
      }

      createCandidateLabel(c.element, i);
      await wait(200, signal);
    }

    // Also show a label on the best candidate with the dot
    if (candidates[0] && isVisible(candidates[0].element)) {
      const best = candidates[0];
      const pos = getElementCenter(best.element);

      if (!activeDot) {
        createDot(window.innerWidth + 30, pos.y);
        await wait(100, signal);
      }

      showThinking();
      await wait(500, signal);
      hideThinking();

      await moveDotCurved(pos.x, pos.y);
    }
  }

  /**
   * Show fallback message for NO match via overlay
   */
  function showNoMatchMessage(step) {
    // Emit a special event so overlay can display the message
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('follome-guide-nomatch', {
        detail: {
          action: step.action,
          description: step.description,
          rawLine: step.rawLine,
        }
      }));
    }
  }

  /**
   * Run the full guidance sequence
   */
  async function runGuideSequence() {
    if (isRunning) clearAll();
    if (guideSteps.length === 0) return;

    isRunning = true;
    isPaused = false;
    currentStepIndex = 0;
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    emitState();

    try {
      for (let i = 0; i < guideSteps.length; i++) {
        if (signal.aborted) break;

        currentStepIndex = i;
        emitState();

        await waitIfPaused(signal);

        const step = guideSteps[i];

        // Clean previous step visuals (keep dot for travel)
        removeLabel();
        removeHighlight();
        removeRings();
        removeBadge();
        removeCandidates();

        if (step.confidence === 'high') {
          await guideToHighConfidence(step, signal);
        } else if (step.confidence === 'low') {
          await guideToLowConfidence(step, signal);
        } else {
          showNoMatchMessage(step);
        }

        // Dwell on this step before moving to next
        if (i < guideSteps.length - 1) {
          await wait(2800, signal);
          await waitIfPaused(signal);
        }
      }

      // Keep last guide visible, then auto-dismiss
      if (isRunning && !signal.aborted) {
        await wait(6000, signal);
        clearAll();
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('[FolloMe] Cursor guide error:', err);
      }
    }
  }

  // ══════════════════════════════════════════
  //  PLAYBACK CONTROLS
  // ══════════════════════════════════════════

  function pause() {
    if (!isRunning || isPaused) return;
    isPaused = true;
    emitState();
  }

  function resume() {
    if (!isPaused) return;
    isPaused = false;
    if (pauseResolver) {
      pauseResolver();
      pauseResolver = null;
    }
    emitState();
  }

  function skip() {
    if (!isRunning) return;

    // Clear current step visuals
    removeLabel();
    removeHighlight();
    removeRings();
    removeBadge();
    removeCandidates();

    // If paused, resume first
    if (isPaused) {
      isPaused = false;
      if (pauseResolver) {
        pauseResolver();
        pauseResolver = null;
      }
    }

    // The current wait/animation will resolve on next tick, and the loop
    // will pick up the next step. We force-advance by aborting the current
    // controller and restarting from the next step.
    const nextIndex = currentStepIndex + 1;
    if (nextIndex >= guideSteps.length) {
      clearAll();
      return;
    }

    // Abort current, restart from next
    if (currentAbortController) {
      currentAbortController.abort();
    }

    currentStepIndex = nextIndex;
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    emitState();

    // Restart loop from the next step
    (async () => {
      try {
        for (let i = nextIndex; i < guideSteps.length; i++) {
          if (signal.aborted) break;

          currentStepIndex = i;
          emitState();

          await waitIfPaused(signal);

          const step = guideSteps[i];

          removeLabel();
          removeHighlight();
          removeRings();
          removeBadge();
          removeCandidates();

          if (step.confidence === 'high') {
            await guideToHighConfidence(step, signal);
          } else if (step.confidence === 'low') {
            await guideToLowConfidence(step, signal);
          } else {
            showNoMatchMessage(step);
          }

          if (i < guideSteps.length - 1) {
            await wait(2800, signal);
            await waitIfPaused(signal);
          }
        }

        if (isRunning && !signal.aborted) {
          await wait(6000, signal);
          clearAll();
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.warn('[FolloMe] Cursor guide error (skip):', err);
        }
      }
    })();
  }

  function replay() {
    if (guideSteps.length === 0) return;

    // Abort current run
    if (currentAbortController) {
      currentAbortController.abort();
    }
    clearAllVisuals();

    // Re-resolve elements (they may have moved)
    const actions = guideSteps.map(s => ({
      action: s.action,
      description: s.description,
      target: s.target,
      stepNum: s.stepNum,
      rawLine: s.rawLine,
    }));

    guideSteps = resolveAllActions(actions);
    isRunning = false;
    isPaused = false;
    currentStepIndex = -1;

    runGuideSequence();
  }

  // ══════════════════════════════════════════
  //  MAIN ENTRY POINTS
  // ══════════════════════════════════════════

  /**
   * Resolve all actions to elements with confidence scoring
   */
  function resolveAllActions(actions) {
    return actions.map((action, i) => {
      const resolved = resolveAction(action);
      return {
        ...action,
        ...resolved,
        stepNum: action.stepNum || (actions.length > 1 ? i + 1 : null),
      };
    });
  }

  /**
   * Main entry point — process AI response text.
   * Supports both structured JSON actions and free-text regex parsing.
   */
  function processResponse(responseText) {
    // Refresh UI elements snapshot for matching
    if (typeof ContextExtractor !== 'undefined') {
      try {
        lastUIElements = ContextExtractor.getUIElements();
        console.log(`[FolloMe] CursorGuide: Extracted ${lastUIElements.length} UI elements for matching`);
      } catch (e) {
        console.warn('[FolloMe] CursorGuide: Failed to extract UI elements:', e);
        lastUIElements = [];
      }
    }

    const actions = parseActions(responseText);

    if (actions.length === 0) {
      console.log('[FolloMe] CursorGuide: No actionable directives found.');
      return;
    }

    const isStructured = actions[0]?.structured === true;
    console.log(`[FolloMe] CursorGuide: Found ${actions.length} action(s) [${isStructured ? 'structured' : 'regex'}]`);

    // Resolve each action to elements with confidence
    guideSteps = resolveAllActions(actions);

    // Log confidence report
    guideSteps.forEach((s, i) => {
      console.log(
        `[FolloMe]   Step ${i + 1}: ${s.action} "${s.description}" — ` +
        `confidence: ${s.confidence} (${s.score}) [${s.reasons.join(', ')}]`
      );
    });

    // Check if we have any matches at all
    const hasAnyMatch = guideSteps.some(s => s.confidence !== 'none');
    if (!hasAnyMatch) {
      guideSteps.forEach(showNoMatchMessage);
      emitState();
      return;
    }

    runGuideSequence();
  }

  /**
   * Get the human explanation portion of a response (for overlay display)
   */
  function getExplanation(responseText) {
    return extractExplanation(responseText);
  }

  /**
   * Manually guide to a specific CSS selector
   */
  function guideTo(selector, actionType = 'click', labelText = null) {
    try {
      const el = document.querySelector(selector);
      if (!el || !isVisible(el)) {
        console.warn(`[FolloMe] CursorGuide: Element not found: ${selector}`);
        return;
      }

      clearAll();
      guideSteps = [{
        action: actionType,
        description: selector,
        target: selector,
        element: el,
        score: 100,
        confidence: 'high',
        reasons: ['direct selector'],
        candidates: [],
        stepNum: null,
        rawLine: '',
      }];

      // Override label text if provided
      if (labelText) {
        const origLabel = ACTION_LABELS[actionType];
        ACTION_LABELS[actionType] = { ...origLabel, text: labelText };
        runGuideSequence().then(() => {
          ACTION_LABELS[actionType] = origLabel;
        });
      } else {
        runGuideSequence();
      }
    } catch (err) {
      console.warn('[FolloMe] CursorGuide: guideTo error:', err);
    }
  }

  /**
   * Register callback for state changes (used by overlay for playback controls)
   */
  function onGuideStateChange(callback) {
    onStateChange = callback;
  }

  /**
   * Legacy compat — find best single element
   */
  function findElement(description) {
    const candidates = findCandidates(description);
    return candidates.length > 0 && candidates[0].score >= CONFIDENCE.LOW
      ? candidates[0].element
      : null;
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
    // Playback controls
    pause,
    resume,
    skip,
    replay,
    // State
    onGuideStateChange,
    getState: () => ({
      isRunning,
      isPaused,
      currentStep: currentStepIndex,
      totalSteps: guideSteps.length,
    }),
  };
})();

// Expose globally
if (typeof window !== 'undefined') {
  window.FolloCursorGuide = FolloCursorGuide;
}
