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

  // ── Settings DOM Elements ──
  const settingsToggle = document.getElementById('settingsToggle');
  const settingsBody = document.getElementById('settingsBody');
  const settingsChevron = document.getElementById('settingsChevron');
  const groqApiKeyInput = document.getElementById('groq-api-key');
  const saveKeyBtn = document.getElementById('save-key-btn');
  const keyStatus = document.getElementById('keyStatus');

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

  // ═══════════════════════════════════════════
  //  SETTINGS: Groq API Key Management
  // ═══════════════════════════════════════════

  // ── Toggle settings panel ──
  settingsToggle.addEventListener('click', () => {
    const isOpen = settingsBody.classList.toggle('open');
    settingsChevron.classList.toggle('open', isOpen);
  });

  // ── Load existing API key on popup open ──
  try {
    const result = await chrome.storage.sync.get('groqApiKey');
    if (result.groqApiKey) {
      groqApiKeyInput.value = result.groqApiKey;
      keyStatus.textContent = '✓ Key loaded';
      keyStatus.className = 'key-status loaded';
    }
  } catch (err) {
    console.warn('[FolloMe:popup] Failed to load API key:', err);
  }

  // ── Save API key on button click ──
  saveKeyBtn.addEventListener('click', async () => {
    const value = groqApiKeyInput.value.trim();

    if (!value) {
      keyStatus.textContent = 'Please enter an API key';
      keyStatus.className = 'key-status error';
      return;
    }

    try {
      // Save to chrome.storage.sync (persists across devices)
      await chrome.storage.sync.set({ groqApiKey: value });

      // Also save to chrome.storage.local under the key groq-mapper.js reads
      await chrome.storage.local.set({ follome_groq_api_key: value });

      // Show success feedback
      keyStatus.textContent = '✓ Saved!';
      keyStatus.className = 'key-status saved';

      // Clear the success message after 2.5 seconds
      setTimeout(() => {
        keyStatus.textContent = '';
        keyStatus.className = 'key-status';
      }, 2500);

      console.log('[FolloMe:popup] Groq API key saved successfully');
    } catch (err) {
      console.error('[FolloMe:popup] Failed to save API key:', err);
      keyStatus.textContent = 'Failed to save — try again';
      keyStatus.className = 'key-status error';
    }
  });

  // ── Save on Enter key in the input field ──
  groqApiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      saveKeyBtn.click();
    }
  });
});
