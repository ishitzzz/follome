/**
 * FolloMe — Overlay UI
 * Creates and manages the on-screen guidance overlay.
 * Minimal, non-intrusive, removable.
 */

const FolloOverlay = (() => {
  let overlayEl = null;
  let isMinimized = false;

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
   * Display AI response/instructions
   */
  function showResponse(text) {
    if (!overlayEl) create();

    const content = overlayEl.querySelector('.follome-content');
    const status = overlayEl.querySelector('.follome-status');

    status.innerHTML = `
      <div class="follome-pulse success"></div>
      <span>AI Response</span>
    `;

    // Parse response text into formatted HTML
    const formatted = formatResponse(text);
    content.innerHTML = formatted;

    // Show follow-up input
    overlayEl.querySelector('.follome-followup').style.display = 'flex';
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
      }, 300);
    }

    // Remove any highlights
    document.querySelectorAll('.follome-highlight').forEach((el) => el.remove());
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

  return {
    create,
    showLoading,
    showResponse,
    showError,
    highlightElement,
    toggleMinimize,
    destroy,
  };
})();

if (typeof window !== 'undefined') {
  window.FolloOverlay = FolloOverlay;
}
