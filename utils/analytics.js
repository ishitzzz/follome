/**
 * FolloMe — Analytics Module
 * Lightweight event tracking system.
 * Stores events locally now, designed for future backend integration.
 * 
 * Event structure:
 * {
 *   user_id: string,
 *   timestamp: ISO string,
 *   event_type: string,
 *   metadata: object
 * }
 */

const FolloAnalytics = (() => {
  let _userId = null;

  /**
   * Initialize analytics — fetches or creates user ID
   */
  async function init() {
    _userId = await FolloStorage.getUserId();
    return _userId;
  }

  /**
   * Track an event
   * @param {string} eventType - e.g. "button_clicked", "page_analyzed"
   * @param {object} metadata - additional context
   */
  async function track(eventType, metadata = {}) {
    if (!_userId) {
      await init();
    }

    const event = {
      user_id: _userId,
      timestamp: new Date().toISOString(),
      event_type: eventType,
      metadata
    };

    // Store locally
    await FolloStorage.appendEvent(event);

    // Future: send to backend
    // await sendToBackend(event);

    return event;
  }

  /**
   * Placeholder for future backend integration
   */
  // async function sendToBackend(event) {
  //   try {
  //     await fetch('https://api.follome.app/events', {
  //       method: 'POST',
  //       headers: { 'Content-Type': 'application/json' },
  //       body: JSON.stringify(event)
  //     });
  //   } catch (err) {
  //     console.warn('[FolloMe] Analytics send failed:', err);
  //   }
  // }

  return { init, track };
})();

if (typeof window !== 'undefined') {
  window.FolloAnalytics = FolloAnalytics;
}
