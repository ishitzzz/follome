# FolloMe — AI Browser Assistant 🧭✦

> An AI browser assistant that follows you across tabs and helps you complete tasks in real-time.

![Version](https://img.shields.io/badge/version-1.0.0-6366f1)
![Manifest](https://img.shields.io/badge/Manifest-V3-22c55e)
![License](https://img.shields.io/badge/license-MIT-f59e0b)

## 💡 What is FolloMe?

FolloMe removes the friction between AI tools and your real browsing tasks. Instead of copy-pasting content to ChatGPT, FolloMe:

1. **Reads context** from any webpage you're on
2. **Sends it to AI** automatically (ChatGPT, Gemini, or Claude)
3. **Receives instructions** and displays them as an on-screen overlay
4. **Guides you step-by-step** — right on the page

**One click → AI understands your page → You get guidance.**

## 🏗️ Architecture

```
follo-me/
├── manifest.json              # Chrome Extension Manifest V3
├── background/
│   └── service-worker.js      # Tab management & message routing
├── popup/
│   ├── popup.html             # Extension popup UI
│   ├── popup.css              # Popup styles
│   └── popup.js               # Popup interactions
├── content/
│   ├── content.js             # Main content script (all pages)
│   ├── ai-content.js          # AI platform content script
│   ├── overlay.js             # On-screen overlay UI
│   └── overlay.css            # Overlay styles
├── adapters/
│   ├── base-adapter.js        # Abstract AI adapter
│   ├── chatgpt-adapter.js     # ChatGPT web UI adapter
│   ├── gemini-adapter.js      # Google Gemini adapter
│   ├── claude-adapter.js      # Claude adapter
│   └── router.js              # URL-based adapter router
├── utils/
│   ├── storage.js             # Chrome storage abstraction
│   ├── analytics.js           # Event tracking system
│   └── context-extractor.js   # Page context extraction
└── icons/                     # Extension icons
```

### Key Design Principles

| Layer | Responsibility | Files |
|-------|---------------|-------|
| **Popup** | User interaction entry point | `popup/*` |
| **Background** | Tab management, message routing | `background/service-worker.js` |
| **Content** | DOM reading, overlay rendering | `content/*` |
| **Adapters** | AI platform-specific logic | `adapters/*` |
| **Utils** | Shared utilities | `utils/*` |

**Strict separation** — no logic mixing across layers. Each module is small and replaceable.

## 🚀 Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/ishitzzz/follome.git
   ```

2. Open Chrome and go to `chrome://extensions/`

3. Enable **Developer mode** (toggle in top right)

4. Click **Load unpacked**

5. Select the `follo-me` folder

6. Pin the FolloMe extension for easy access

## 📖 How to Use

1. **Navigate** to any webpage
2. **Click** the FolloMe extension icon
3. **Click** "Ask AI about this page" (or type a specific question)
4. FolloMe will:
   - Extract page context
   - Open/switch to your chosen AI (ChatGPT/Gemini/Claude)
   - Inject the prompt automatically
   - Wait for the AI response
   - Switch back and show you the guidance overlay

## 🔮 V1 Features

- ✅ Chrome Extension (Manifest V3)
- ✅ One-click page analysis
- ✅ Smart context extraction (visible text, metadata, interactive elements)
- ✅ AI adapter system (ChatGPT, Gemini, Claude)
- ✅ Auto prompt injection into AI web UI
- ✅ Response reading from AI DOM
- ✅ On-screen overlay with step-by-step guidance
- ✅ Follow-up questions
- ✅ Draggable, minimizable overlay
- ✅ Element highlighting  
- ✅ Event tracking system (local)
- ✅ Anonymous user identification
- ✅ Analytics-ready design

## 📊 Scalability Preparation

Even though V1 is local-only, the architecture is ready for 10,000+ users:

- **Event tracking** — structured as `{ user_id, timestamp, event_type, metadata }`
- **Anonymous user IDs** — generated per install
- **Clean analytics abstraction** — `FolloAnalytics.track(event)` — plug in Firebase/Supabase later
- **Performance-aware** — async operations, limited DOM scans, capped text extraction

## 🛠️ Development

### Adding a new AI adapter

1. Create `adapters/new-adapter.js` extending `BaseAIAdapter`
2. Implement `findInputElement()`, `findSendButton()`, `readLatestResponse()`
3. Add URL pattern to `AdapterRouter`
4. Add content script entry to `manifest.json`

### Event Types

| Event | When |
|-------|------|
| `button_clicked` | User clicks analyze button |
| `page_analyzed` | Page context extracted |
| `ai_response_received` | AI response captured |

## 📋 Non-Goals (V1)

- ❌ Full automation (no auto-clicking everything)
- ❌ Complex NLP parsing
- ❌ Backend server
- ❌ Authentication system
- ❌ Dashboards

## 📄 License

MIT © FolloMe
