/**
 * FolloMe — Popup Script
 * Handles popup UI interactions and communicates with background service worker.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // ── DOM Elements ──
  const btnAnalyze = document.getElementById('btnAnalyze');
  const btnAsk = document.getElementById('btnAsk');
  const questionInput = document.getElementById('questionInput');
  const pageTitle = document.getElementById('pageTitle');
  const pageUrl = document.getElementById('pageUrl');
  const statusText = document.getElementById('statusText');
  const statusBar = document.getElementById('statusBar');
  const eventCount = document.getElementById('eventCount');
  const aiOptions = document.querySelectorAll('.ai-option');

  // ── Load page info ──
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      pageTitle.textContent = tab.title || 'Untitled Page';
      pageUrl.textContent = tab.url || '';
    }
  } catch (err) {
    pageTitle.textContent = 'Unable to read page';
  }

  // ── Load event count ──
  try {
    const result = await chrome.storage.local.get(['follome_events']);
    const events = result.follome_events || [];
    eventCount.textContent = `${events.length} events tracked`;
  } catch (err) {
    // Ignore
  }

  // ── Main button click ──
  btnAnalyze.addEventListener('click', () => {
    startAnalysis();
  });

  // ── Custom question ──
  btnAsk.addEventListener('click', () => {
    const question = questionInput.value.trim();
    if (question) {
      startAnalysis(question);
    }
  });

  questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const question = questionInput.value.trim();
      if (question) {
        startAnalysis(question);
      }
    }
  });

  // ── AI platform selector ──
  aiOptions.forEach((option) => {
    option.addEventListener('click', () => {
      aiOptions.forEach((o) => o.classList.remove('active'));
      option.classList.add('active');

      // Store preference
      chrome.storage.local.set({
        follome_ai_preference: option.dataset.ai
      });
    });
  });

  // Load AI preference
  try {
    const result = await chrome.storage.local.get(['follome_ai_preference']);
    if (result.follome_ai_preference) {
      aiOptions.forEach((o) => {
        o.classList.toggle('active', o.dataset.ai === result.follome_ai_preference);
      });
    }
  } catch (err) {
    // Use default (ChatGPT)
  }

  /**
   * Start page analysis
   */
  function startAnalysis(question = '') {
    setStatus('loading', 'Analyzing page...');
    btnAnalyze.classList.add('loading');

    // Track button click
    chrome.storage.local.get(['follome_events', 'follome_user_id'], (result) => {
      const events = result.follome_events || [];
      events.push({
        user_id: result.follome_user_id || 'unknown',
        timestamp: new Date().toISOString(),
        event_type: 'button_clicked',
        metadata: { action: 'analyze_page', hasQuestion: !!question }
      });
      chrome.storage.local.set({ follome_events: events });
      eventCount.textContent = `${events.length} events tracked`;
    });

    // Send message to background
    chrome.runtime.sendMessage({
      type: 'START_ANALYSIS',
      question
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[FolloMe:popup] sendMessage error:', chrome.runtime.lastError.message);
        setStatus('error', 'Extension error — try reloading');
        btnAnalyze.classList.remove('loading');
        return;
      }

      if (response?.status === 'started') {
        setStatus('loading', 'Context sent to AI...');
        // Close popup after a short delay
        setTimeout(() => window.close(), 1500);
      } else if (response?.status === 'error') {
        setStatus('error', response.error || 'Failed to start analysis');
        btnAnalyze.classList.remove('loading');
      } else {
        setStatus('error', 'Unexpected response from extension');
        btnAnalyze.classList.remove('loading');
      }
    });
  }

  /**
   * Update status bar
   */
  function setStatus(type, text) {
    statusBar.className = `status-bar ${type}`;
    statusText.textContent = text;
  }
});
