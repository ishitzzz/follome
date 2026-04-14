/**
 * FolloMe — Overlay UI
 * Creates and manages the on-screen guidance overlay.
 * Minimal, non-intrusive, removable.
 * Includes playback controls for cursor guidance.
 */

const FolloOverlay = (() => {
  let overlayEl = null;
  let isMinimized = false;
  let guideControlsEl = null;

  // SVG icons for playback controls
  const CTRL_ICONS = {
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
    play: '<svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    skip: '<svg viewBox="0 0 24 24"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',
    replay: '<svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
  };

  /**
   * Create the overlay container
   */
  function create() {
    if (overlayEl) return overlayEl;

    overlayEl = document.createElement('div');
    overlayEl.id = 'follome-overlay';
    overlayEl.innerHTML = `
      <div class="follome-header">
        <div class="follome-logo">
          <span class="follome-icon">✦</span>
          <span class="follome-title">FolloMe</span>
        </div>
        <div class="follome-controls">
          <button class="follome-btn-minimize" title="Minimize">—</button>
          <button class="follome-btn-close" title="Close">✕</button>
        </div>
      </div>
      <div class="follome-body">
        <div class="follome-status">
          <div class="follome-pulse"></div>
          <span>Ready to help</span>
        </div>
        <div class="follome-content"></div>
        <div class="follome-guide-controls" id="follome-guide-controls">
          <span class="follome-guide-progress">
            <span class="step-current">—</span>
          </span>
          <button class="follome-ctrl-pause" title="Pause guidance">${CTRL_ICONS.pause}</button>
          <button class="follome-ctrl-skip" title="Skip step">${CTRL_ICONS.skip}</button>
          <button class="follome-ctrl-replay" title="Replay all">${CTRL_ICONS.replay}</button>
        </div>
        <div class="follome-followup">
          <input type="text" class="follome-input" placeholder="Ask a follow-up..." />
          <button class="follome-btn-send" title="Send">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlayEl);

    // Event listeners
    overlayEl.querySelector('.follome-btn-close').addEventListener('click', destroy);
    overlayEl.querySelector('.follome-btn-minimize').addEventListener('click', toggleMinimize);
    overlayEl.querySelector('.follome-btn-send').addEventListener('click', handleFollowUp);
    overlayEl.querySelector('.follome-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleFollowUp();
    });

    // Playback control listeners
    overlayEl.querySelector('.follome-ctrl-pause').addEventListener('click', handlePauseResume);
    overlayEl.querySelector('.follome-ctrl-skip').addEventListener('click', handleSkip);
    overlayEl.querySelector('.follome-ctrl-replay').addEventListener('click', handleReplay);

    guideControlsEl = overlayEl.querySelector('#follome-guide-controls');

    // Register state callback with CursorGuide
    if (typeof FolloCursorGuide !== 'undefined') {
      FolloCursorGuide.onGuideStateChange(updateGuideControls);
    }

    // Listen for no-match events from cursor guide
    window.addEventListener('follome-guide-nomatch', handleNoMatch);

    // Make draggable
    makeDraggable(overlayEl);

    // Animate in
    requestAnimationFrame(() => {
      overlayEl.classList.add('follome-visible');
    });

    return overlayEl;
  }

  /**
   * Show loading state
   */
  function showLoading(message = 'Analyzing page...') {
    create();
    const content = overlayEl.querySelector('.follome-content');
    const status = overlayEl.querySelector('.follome-status');

    status.innerHTML = `
      <div class="follome-pulse active"></div>
      <span>${message}</span>
    `;

    content.innerHTML = `
      <div class="follome-loading">
        <div class="follome-shimmer"></div>
        <div class="follome-shimmer short"></div>
        <div class="follome-shimmer"></div>
      </div>
    `;
  }

  /**
   * Display AI response/instructions.
   * Handles both structured (```actions JSON) and free-text responses.
   */
  function showResponse(text) {
    if (!overlayEl) create();

    const content = overlayEl.querySelector('.follome-content');
    const status = overlayEl.querySelector('.follome-status');

    status.innerHTML = `
      <div class="follome-pulse success"></div>
      <span>AI Response</span>
    `;

    // For structured responses, show only the human explanation (not the JSON block)
    let displayText = text;
    const hasStructuredBlock = /```actions\s*\n?[\s\S]*?\n?```/i.test(text);

    if (hasStructuredBlock && typeof FolloCursorGuide !== 'undefined') {
      const explanation = FolloCursorGuide.getExplanation(text);
      displayText = explanation || text;
    }

    // Parse response text into formatted HTML
    const formatted = formatResponse(displayText);
    content.innerHTML = formatted;

    // Show follow-up input
    overlayEl.querySelector('.follome-followup').style.display = 'flex';

    // Trigger cursor guidance system to parse and animate (pass full text with JSON)
    if (typeof FolloCursorGuide !== 'undefined') {
      // Slight delay so the overlay settles before visual guides appear
      setTimeout(() => {
        FolloCursorGuide.processResponse(text);
      }, 600);
    }
  }

  /**
   * Show error state
   */
  function showError(message) {
    if (!overlayEl) create();

    const content = overlayEl.querySelector('.follome-content');
    const status = overlayEl.querySelector('.follome-status');

    status.innerHTML = `
      <div class="follome-pulse error"></div>
      <span>Error</span>
    `;

    content.innerHTML = `<div class="follome-error">${message}</div>`;
  }

  /**
   * Format response text to HTML
   */
  function formatResponse(text) {
    if (!text) return '<p>No response received.</p>';

    // Simple markdown-like formatting
    let html = text
      // Bold
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      // Numbered lists
      .replace(/^(\d+)\.\s(.+)$/gm, '<li class="follome-step"><span class="step-num">$1</span> $2</li>')
      // Bullet points
      .replace(/^[-•]\s(.+)$/gm, '<li class="follome-bullet">$1</li>')
      // Line breaks
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');

    // Wrap list items
    html = html.replace(
      /(<li class="follome-step">.*?<\/li>)+/gs,
      '<ol class="follome-steps">$&</ol>'
    );

    return `<div class="follome-response"><p>${html}</p></div>`;
  }

  /**
   * Highlight an element on the page
   */
  function highlightElement(selector) {
    try {
      const el = document.querySelector(selector);
      if (!el) return;

      const highlight = document.createElement('div');
      highlight.className = 'follome-highlight';
      const rect = el.getBoundingClientRect();

      Object.assign(highlight.style, {
        position: 'fixed',
        top: `${rect.top - 4}px`,
        left: `${rect.left - 4}px`,
        width: `${rect.width + 8}px`,
        height: `${rect.height + 8}px`,
        pointerEvents: 'none',
        zIndex: '2147483645',
      });

      document.body.appendChild(highlight);

      // Also trigger the richer cursor guide if available
      if (typeof FolloCursorGuide !== 'undefined') {
        FolloCursorGuide.guideTo(selector, 'click');
      }

      // Auto-remove after animation
      setTimeout(() => highlight.remove(), 4000);
    } catch (err) {
      console.warn('[FolloMe] Highlight failed:', err);
    }
  }

  /**
   * Toggle minimize state
   */
  function toggleMinimize() {
    if (!overlayEl) return;
    isMinimized = !isMinimized;
    overlayEl.classList.toggle('follome-minimized', isMinimized);
  }

  /**
   * Destroy overlay
   */
  function destroy() {
    if (overlayEl) {
      overlayEl.classList.remove('follome-visible');
      setTimeout(() => {
        overlayEl?.remove();
        overlayEl = null;
        guideControlsEl = null;
      }, 300);
    }

    // Remove no-match listener
    window.removeEventListener('follome-guide-nomatch', handleNoMatch);

    // Remove any highlights
    document.querySelectorAll('.follome-highlight').forEach((el) => el.remove());

    // Clean up cursor guide elements
    if (typeof FolloCursorGuide !== 'undefined') {
      FolloCursorGuide.clearAll();
    }
  }

  // ──────────────────────────────────────────
  //  PLAYBACK CONTROLS
  // ──────────────────────────────────────────

  /**
   * Update the guide control bar based on cursor guide state
   */
  function updateGuideControls(state) {
    if (!guideControlsEl || !overlayEl) return;

    if (state.totalSteps > 0 && state.isRunning) {
      guideControlsEl.classList.add('active');

      // Update progress text
      const progressEl = guideControlsEl.querySelector('.follome-guide-progress');
      if (progressEl) {
        const current = state.currentStep + 1;
        const total = state.totalSteps;

        // Show step info with confidence dot
        let confClass = 'high';
        if (state.steps && state.steps[state.currentStep]) {
          confClass = state.steps[state.currentStep].confidence || 'high';
        }

        progressEl.innerHTML = `
          Step <span class="step-current">${current}</span>/${total}
          <span class="follome-confidence-dot ${confClass}" title="${confClass} confidence"></span>
        `;
      }

      // Update pause/play button
      const pauseBtn = guideControlsEl.querySelector('.follome-ctrl-pause');
      if (pauseBtn) {
        if (state.isPaused) {
          pauseBtn.innerHTML = CTRL_ICONS.play;
          pauseBtn.title = 'Resume guidance';
          pauseBtn.classList.add('active');
        } else {
          pauseBtn.innerHTML = CTRL_ICONS.pause;
          pauseBtn.title = 'Pause guidance';
          pauseBtn.classList.remove('active');
        }
      }
    } else {
      // Guidance not running — hide controls unless steps exist for replay
      if (state.totalSteps > 0 && !state.isRunning) {
        guideControlsEl.classList.add('active');
        const progressEl = guideControlsEl.querySelector('.follome-guide-progress');
        if (progressEl) {
          progressEl.innerHTML = `<span class="step-current">Complete</span> — ${state.totalSteps} steps`;
        }
        // Show only replay button as active
        const pauseBtn = guideControlsEl.querySelector('.follome-ctrl-pause');
        if (pauseBtn) {
          pauseBtn.innerHTML = CTRL_ICONS.play;
          pauseBtn.title = 'Resume';
          pauseBtn.classList.remove('active');
          pauseBtn.disabled = true;
          pauseBtn.style.opacity = '0.3';
        }
        const skipBtn = guideControlsEl.querySelector('.follome-ctrl-skip');
        if (skipBtn) {
          skipBtn.disabled = true;
          skipBtn.style.opacity = '0.3';
        }
      } else {
        guideControlsEl.classList.remove('active');
      }
    }
  }

  function handlePauseResume() {
    if (typeof FolloCursorGuide === 'undefined') return;
    const state = FolloCursorGuide.getState();
    if (state.isPaused) {
      FolloCursorGuide.resume();
    } else {
      FolloCursorGuide.pause();
    }
  }

  function handleSkip() {
    if (typeof FolloCursorGuide !== 'undefined') {
      FolloCursorGuide.skip();
    }
  }

  function handleReplay() {
    if (typeof FolloCursorGuide !== 'undefined') {
      // Re-enable buttons since we're replaying
      if (guideControlsEl) {
        guideControlsEl.querySelectorAll('button').forEach(btn => {
          btn.disabled = false;
          btn.style.opacity = '';
        });
      }
      FolloCursorGuide.replay();
    }
  }

  // ──────────────────────────────────────────
  //  NO-MATCH HANDLING
  // ──────────────────────────────────────────

  /**
   * Handle no-match event from cursor guide
   */
  function handleNoMatch(event) {
    if (!overlayEl) return;

    const { action, description } = event.detail;
    const content = overlayEl.querySelector('.follome-content');
    if (!content) return;

    // Append no-match message to content area
    const msg = document.createElement('div');
    msg.className = 'follome-nomatch';
    msg.innerHTML = `
      <span class="follome-nomatch-icon">⚠</span>
      <span class="follome-nomatch-text">
        Couldn't find <strong>"${description}"</strong> on this page.
        Try ${action === 'click' || action === 'tap' ? 'clicking' : action === 'type' ? 'typing into' : 'interacting with'} it manually.
      </span>
    `;

    content.appendChild(msg);

    // Scroll to show the message
    content.scrollTop = content.scrollHeight;
  }

  /**
   * Handle follow-up question
   */
  function handleFollowUp() {
    const input = overlayEl?.querySelector('.follome-input');
    if (!input || !input.value.trim()) return;

    const question = input.value.trim();
    input.value = '';

    // Send follow-up via message to background
    chrome.runtime.sendMessage({
      type: 'FOLLOWUP_QUESTION',
      question
    });

    showLoading('Sending follow-up...');
  }

  /**
   * Make element draggable
   */
  function makeDraggable(el) {
    const header = el.querySelector('.follome-header');
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      offsetX = e.clientX - el.getBoundingClientRect().left;
      offsetY = e.clientY - el.getBoundingClientRect().top;
      el.style.transition = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = `${e.clientX - offsetX}px`;
      el.style.top = `${e.clientY - offsetY}px`;
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      if (el) el.style.transition = '';
    });
  }

  /**
   * Guide cursor to specific element (delegates to CursorGuide)
   */
  function guideTo(selector, actionType = 'click', labelText = null) {
    if (typeof FolloCursorGuide !== 'undefined') {
      FolloCursorGuide.guideTo(selector, actionType, labelText);
    }
  }

  return {
    create,
    showLoading,
    showResponse,
    showError,
    highlightElement,
    guideTo,
    toggleMinimize,
    destroy,
  };
})();

if (typeof window !== 'undefined') {
  window.FolloOverlay = FolloOverlay;
}
