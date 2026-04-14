/**
 * FolloMe - Speech Recognition Module
 * Handles voice interaction, converts speech to text, and sends it to AI backend.
 */
const FolloSpeech = (() => {
  let recognition = null;
  let isListening = false;

  function init() {
    // Check if Web Speech API is supported
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.error('[FolloMe] SpeechRecognition is not supported in this browser.');
      return false;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    // You can set it to the user's language later, stick to en-US for now
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isListening = true;
      if (typeof FolloOverlay !== 'undefined') {
        FolloOverlay.showLoading("Listening... 🎤");
      }
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      if (typeof FolloOverlay !== 'undefined') {
        FolloOverlay.showLoading(`Recognized: "${transcript}"`);
      }
      
      // Briefly show transcript then trigger analysis
      setTimeout(() => {
        if (typeof FolloOverlay !== 'undefined') {
          FolloOverlay.showLoading("Processing...");
        }
        handleSpeechInput(transcript);
      }, 1500);
    };

    recognition.onerror = (event) => {
      isListening = false;
      console.error('[FolloMe] Speech recognition error', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        if (typeof FolloOverlay !== 'undefined') {
          FolloOverlay.showError("Microphone permission denied. Please allow microphone access for this site to use voice commands.");
        }
      } else {
        if (typeof FolloOverlay !== 'undefined') {
          FolloOverlay.showError("Couldn't hear properly, try again. (" + event.error + ")");
        }
      }
    };

    recognition.onend = () => {
      isListening = false;
    };

    return true;
  }

  function toggle() {
    if (!recognition && !init()) {
      if (typeof FolloOverlay !== 'undefined') {
        FolloOverlay.showError("Voice input is not supported in this browser.");
      }
      return;
    }

    if (isListening) {
      recognition.stop();
    } else {
      try {
        recognition.start();
      } catch (err) {
        console.error('[FolloMe] Failed to start speech recognition', err);
      }
    }
  }

  async function handleSpeechInput(text) {
     if (typeof FolloAnalytics !== 'undefined') {
       await FolloAnalytics.track('speech_input', { textLength: text.length });
     }

     const context = typeof ContextExtractor !== 'undefined' ? ContextExtractor.extract() : "";
     
     // Construct learning mode prompt but rely on ContextExtractor for the cursor JSON instructions.
     let prompt = "";
     if (typeof ContextExtractor !== 'undefined') {
       const specialInstruction = `[LEARNING MODE ACTIVE]\nHelp me step-by-step like a tutorial. Keep it simple: no long paragraphs, clear actionable steps only. Explain what each major section does and what I should try next regarding this query: "${text}"`;
       prompt = ContextExtractor.buildPrompt(context, specialInstruction);
     } else {
       prompt = `User is on a webpage. Help them step-by-step like a tutorial. Keep it simple. User question: ${text}`;
     }
     
     chrome.runtime.sendMessage({
       type: 'SEND_TO_AI',
       prompt: prompt,
       sourceTabUrl: window.location.href
     });
  }

  return {
    toggle
  };
})();

if (typeof window !== 'undefined') {
  window.FolloSpeech = FolloSpeech;
}
