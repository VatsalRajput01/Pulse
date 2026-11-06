# Pulse | Daily Workspace ⚡

Pulse is a premium, local-first minimalist personal operating system and Progressive Web App engineered for high-agency individuals who value focus, privacy, and speed. Built with zero external dependencies, it pairs daily habit and task tracking with a strict zero-scroll, `100dvh` **Focus Studio** for distraction-free deep work sessions.

## ✨ Key Features

- **True Local-First Architecture (IndexedDB)**: State is cached in-memory and committed asynchronously to IndexedDB (`PulseWorkspaceDB`) with local fallback, delivering instantaneous sub-millisecond UI updates with zero cloud latency.
- **Offline-Ready PWA (Service Worker v8)**: Fully installable as a standalone native app on desktop and mobile platforms with resilient cache-first offline support.
- **Immersive Focus Studio**: A dedicated, zero-scroll `100dvh` deep work environment featuring customizable Pomodoro/Zen focus timers, synthesized Web Audio haptics, and native HTML5 notifications.
- **Optimistic Concurrency Control (OCC)**: Monotonic revision tracking (`rev` / `baseRev`) and multi-tab synchronization via `BroadcastChannel` proactively eliminate stale overwrites and race conditions.
- **The Momentum System**: Dynamic 7-day rolling habit matrix with streak tracking, task prioritization, and deliberate skill practice hour logging with milestone roadmaps.
- **Quick Capture Inbox**: Frictionless, keyboard-accessible quick-capture bar designed for capturing thoughts on the fly, with one-click triage into tasks, habits, skills, or scratchpad notes.

## 🛠️ Tech Stack

- **Pure HTML5**: Semantic, accessible markup structured for screen readers with comprehensive ARIA attributes.
- **Custom CSS**: Compiled Tailwind CSS v3.4 utilities and custom spring physics curves (`--ease-spring`), completely offline with **zero external CDN dependencies**.
- **Vanilla JavaScript (ES6+)**: Authoritative, frameworkless application architecture structured for pure execution speed and zero runtime overhead.
- **Persistence Layer**: IndexedDB (`PulseWorkspaceDB`) + LocalStorage dual-persistence with transactional atomic safety and automatic schema migration.

## 🚀 Getting Started

Pulse is completely self-contained—no `npm install`, dependencies, or build tools are required. Simply clone the repository and serve it locally:

### Option 1: Live Server Extension
1. Open the workspace folder in VS Code.
2. Click **Go Live** on the bottom status bar (or right-click [`index.html`](./index.html) → **Open with Live Server**).
3. The workspace will open at:
```text
http://127.0.0.1:5500/index.html
```

### Option 2: Python Simple HTTP Server
Open a terminal in the root workspace directory and run:

```bash
python -m http.server 5500
```

Then visit [`http://localhost:5500`](http://localhost:5500) in any modern web browser.

## 🔒 Privacy & Data Security

Pulse is built on an uncompromising privacy-first principle:
- **Zero External Telemetry**: No third-party trackers, analytics, external databases, or remote tracking APIs are used.
- **100% Client-Side**: All data (habits, tasks, skills, notes, and session logs) resides strictly inside your browser profile.
- **Full Data Portability**: Complete, human-readable JSON export and import capabilities are available under Settings, guaranteeing permanent ownership of your personal data.

---

*Designed & Developed by [Vatsal Rajput](https://github.com/VatsalRajput01)*
