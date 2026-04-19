/**
 * FolloMe - Screenshot Manager
 * Conditionally captures screenshots based on the Intent Profile.
 * Uses OffscreenCanvas for Service Worker compatibility to resize and compress images.
 */

const ScreenshotManager = (() => {
  let lastUrl = null;
  let lastDomStructureKey = null;
  let cachedScreenshot = null;

  /**
   * Decide whether to capture a screenshot based on the Intent Profile rules.
   * @param {Object} intent The Intent Profile object 
   * @param {String} confidence 'HIGH' or 'LOW' for element matching
   * @returns {boolean}
   */
  function shouldCapture(intent, confidence) {
    // 1. DO NOT capture if:
    // - mode = act AND domain = web_form AND confidence is HIGH
    // - (Simple, repeated structured UI)
    if (intent.mode === 'act' && intent.domain === 'web_form' && confidence === 'HIGH') {
      return false;
    }

    // 2. CAPTURE screenshot if ANY of the following is true:
    if (
      intent.mode === 'inspect' ||
      intent.mode === 'learn' ||
      intent.needs_explanation === true ||
      intent.domain === 'design_tool' ||
      intent.domain === 'dashboard' ||
      confidence === 'LOW'
    ) {
      return true;
    }

    return false;
  }

  /**
   * Resizes image to max-width 1024px and compresses it to 0.65 JPEG.
   * Compatible with Manifest V3 Service Workers (using OffscreenCanvas).
   * @param {String} dataUrl Base64 image
   * @returns {Promise<String>} Optimized Base64 image
   */
  async function optimizeScreenshot(dataUrl) {
    try {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const imageBitmap = await createImageBitmap(blob);

      const MAX_WIDTH = 1024;
      let width = imageBitmap.width;
      let height = imageBitmap.height;

      // Scale down if necessary
      if (width > MAX_WIDTH) {
        height = Math.round((height * MAX_WIDTH) / width);
        width = MAX_WIDTH;
      }

      const offscreen = new OffscreenCanvas(width, height);
      const ctx = offscreen.getContext('2d');
      ctx.drawImage(imageBitmap, 0, 0, width, height);

      // Compress quality to 0.65 (between 0.6 - 0.7 limit)
      const compressedBlob = await offscreen.convertToBlob({ type: 'image/jpeg', quality: 0.65 });

      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(compressedBlob);
      });
    } catch (err) {
      console.warn('[ScreenshotManager] Optimization failed. Using original capture.', err);
      return dataUrl;
    }
  }

  /**
   * Executes the conditional screenshot logic asynchronously without blocking UI.
   * Returns empty object if screenshot is not taken or fails.
   * 
   * @param {Object} intent The Intent Profile
   * @param {String} confidence 'HIGH' or 'LOW'
   * @param {String} currentUrl The tab URL
   * @param {String} domStructureKey Something representing the current DOM state (e.g. elements string or length)
   * @returns {Promise<{ use_screenshot: boolean, image: string | null }>}
   */
  async function process(intent, confidence, currentUrl, domStructureKey) {
    const captureNeeded = shouldCapture(intent, confidence);

    if (!captureNeeded) {
      return { use_screenshot: false, image: null };
    }

    // ── Caching Logic ──
    // Reuse previous screenshot if URL and DOM structure haven't changed
    if (lastUrl === currentUrl && lastDomStructureKey === domStructureKey && cachedScreenshot) {
      console.log('[ScreenshotManager] Reusing cached screenshot');
      return { use_screenshot: true, image: cachedScreenshot };
    }

    try {
      // Capture Visible Tab — defaults to current window active tab
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 100 });
      
      // Resize & Compress ensuring it stays small (max 1024px, 0.65 quality)
      const optimizedBase64 = await optimizeScreenshot(dataUrl);

      // Update cache
      lastUrl = currentUrl;
      lastDomStructureKey = domStructureKey;
      cachedScreenshot = optimizedBase64;

      return { use_screenshot: true, image: optimizedBase64 };
    } catch (err) {
      // Fail gracefully
      console.error('[ScreenshotManager] Capture failed:', err);
      return { use_screenshot: false, image: null };
    }
  }

  return {
    process,
    shouldCapture
  };
})();

// Export logic handling for diverse loading environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScreenshotManager;
} else if (typeof window !== 'undefined') {
  window.ScreenshotManager = ScreenshotManager;
} else if (typeof self !== 'undefined') {
  // Available globally in the Service Worker
  self.ScreenshotManager = ScreenshotManager;
}
