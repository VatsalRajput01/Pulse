/* ==========================================================================
   Pulse Workspace — Authoritative Application Logic (app.js)
   Includes Phase 1, Phase 2 & Phase 3 Audit Implementations:
   - Async Promise-Based `loadState()` Boot Gate (Eliminates P0 Startup Race)
   - Operation-Specific Undo Callbacks (Zero Full-State Overwrites, Restores at Exact Index)
   - Milestone Deletion Protection with Operation-Specific Undo
   - Native HTML5 Notification API + Service Worker Notification Fallback for Timer
   - Strict Boolean Coercion (`sanitizeBoolean`) & Category Allow-Lists
   - Raw Text Storage (`sanitizeText`) & Entity Decoding Migration
   - Cached IndexedDB + Monotonic `rev` Multi-Tab Sync (`storage` event)
   - Dynamic 7-Day Rolling Labels, Uncapped `totalStreak`, & Midnight Timer
   - Persisted `Math.ceil` Focus Timer & Accessible ARIA/Escape Modals
   - Zero Personal / Demo Data in Production `defaultAppState`
   ========================================================================== */

(function () {
  "use strict";

  // --------------------------------------------------------------------------
  // 1. Static Same-Origin Service Worker Registration (`./sw.js`)
  // --------------------------------------------------------------------------
  if (
    "serviceWorker" in navigator &&
    (location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1")
  ) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./sw.js", { scope: "./" })
        .then((reg) => {
          const swBadge = document.getElementById("sw-badge");
          if (swBadge) swBadge.textContent = "Registered";
          if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
        })
        .catch((err) => {
          console.warn("Service worker registration skipped or failed:", err.message);
        });
    });
  }

  // --------------------------------------------------------------------------
  // 2. Synthesized Audio & Tactile Haptic Feedback
  // --------------------------------------------------------------------------
  let soundEnabled = true;
  let audioCtx = null;

  function triggerHaptic(duration = 8) {
    try {
      if (navigator.vibrate) navigator.vibrate(duration);
    } catch (e) {}
  }

  function playSound(type) {
    triggerHaptic(type === "success" ? 12 : 6);
    if (!soundEnabled) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      const now = audioCtx.currentTime;
      if (type === "tap") {
        osc.frequency.setValueAtTime(480, now);
        osc.frequency.exponentialRampToValueAtTime(720, now + 0.035);
        gain.gain.setValueAtTime(0.04, now);
        gain.gain.linearRampToValueAtTime(0.005, now + 0.035);
        osc.start(now);
        osc.stop(now + 0.035);
      } else if (type === "success") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.065);
        gain.gain.setValueAtTime(0.07, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.22);
      }
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // 3. Native HTML5 System Notifications for Focus Timer
  // --------------------------------------------------------------------------
  function requestTimerNotificationPermission() {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") {
      try {
        const permPromise = Notification.requestPermission();
        if (permPromise && typeof permPromise.catch === "function") {
          permPromise.catch(() => {});
        }
      } catch (e) {}
    }
  }

  function sendTimerCompletionNotification() {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;

    const title = "Pulse Focus";
    const options = {
      body: "Your focus session is complete!",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: "pulse-focus-timer",
      renotify: true
    };

    try {
      if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready
          .then((reg) => {
            if (reg && typeof reg.showNotification === "function") {
              return reg.showNotification(title, options);
            }
            new Notification(title, options);
          })
          .catch(() => {
            try {
              new Notification(title, options);
            } catch (err) {}
          });
      } else {
        new Notification(title, options);
      }
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // 4. Date Helpers, Dynamic 7-Day Rolling Labels & Uncapped Streak Logic
  // --------------------------------------------------------------------------
  function getLocalDateKey(d = new Date()) {
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${yr}-${mo}-${da}`;
  }

  function getTomorrowDateKey(baseDate = new Date()) {
    const tmrw = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1);
    return getLocalDateKey(tmrw);
  }

  function generateRollingDayLabels(referenceDate = new Date()) {
    const shortWeekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const labels = [];
    for (let offset = 6; offset >= 1; offset--) {
      const d = new Date(
        referenceDate.getFullYear(),
        referenceDate.getMonth(),
        referenceDate.getDate() - offset
      );
      labels.push(shortWeekdays[d.getDay()]);
    }
    labels.push("Today");
    return labels;
  }

  // --------------------------------------------------------------------------
  // 5. Strict Schema Validation, Explicit Boolean Coercion, Category Allow-Lists
  //    & Raw Text Storage (Escaped ONLY at DOM Render Boundary)
  // --------------------------------------------------------------------------
  const ENTITY_MIGRATION_VERSION = 3;

  const ALLOWED_PRIORITIES = new Set(["High", "Medium", "Low"]);
  const ALLOWED_HABIT_CATEGORIES = new Set(["Academic", "Routine", "Leadership", "Health"]);
  const ALLOWED_SKILL_CATEGORIES = new Set(["Science", "Leadership", "Technical", "General"]);
  const ALLOWED_NOTE_CATEGORIES = new Set(["Lab & study", "Leadership", "Personal", "Ideas"]);

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function decodeHtmlEntities(str) {
    if (str === null || str === undefined) return "";
    let current = String(str);
    let previous = "";
    let pass = 0;
    while (current !== previous && pass < 4) {
      previous = current;
      current = current
        .replace(/&#039;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&amp;/g, "&");
      pass++;
    }
    return current;
  }

  function sanitizeText(val, fallback = "", maxLength = 2000) {
    const cleanFallback = String(fallback ?? "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .trim()
      .slice(0, maxLength);
    if (val === null || val === undefined) return cleanFallback;
    const rawCleaned = String(val)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .trim()
      .slice(0, maxLength);
    return rawCleaned || cleanFallback;
  }

  function sanitizeBoolean(val, fallback = false) {
    if (typeof val === "boolean") return val;
    if (typeof val === "number") return val === 1 ? true : val === 0 ? false : fallback;
    if (typeof val === "string") {
      const norm = val.trim().toLowerCase();
      if (norm === "true" || norm === "1") return true;
      if (norm === "false" || norm === "0" || norm === "" || norm === "null" || norm === "undefined") return false;
    }
    return fallback;
  }

  function sanitizeCategory(val, allowedSet, defaultCategory, preserveLegacy = false) {
    const cleaned = sanitizeText(val, defaultCategory, 40);
    if (allowedSet.has(cleaned)) return cleaned;
    if (preserveLegacy && cleaned) {
      allowedSet.add(cleaned);
      return cleaned;
    }
    return defaultCategory;
  }

  function sanitizeNumber(val, fallback = 0, min = 0, max = 100000) {
    const num = Number(val);
    if (!Number.isFinite(num)) return fallback;
    const clamped = Math.min(max, Math.max(min, num));
    return Math.round(clamped * 100) / 100;
  }

  const MAX_SAFE_REV = Number.MAX_SAFE_INTEGER - 1000;

  function sanitizeRev(val) {
    if (!Number.isSafeInteger(val) || val < 0) return 0;
    return Math.min(val, MAX_SAFE_REV);
  }

  function generateUniqueId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  function isValidEntityId(idVal) {
    return (
      (typeof idVal === "string" && idVal.trim().length > 0) ||
      (Number.isSafeInteger(idVal) && idVal > 0)
    );
  }

  function sanitizeId(val, indexFallback, usedIdsSet = null) {
    let candidate = null;
    if (typeof val === "string" && val.trim().length > 0) {
      candidate = sanitizeText(val.trim(), "", 120);
    } else if (Number.isSafeInteger(val) && val > 0) {
      candidate = val;
    }
    if (!candidate) {
      candidate = generateUniqueId();
    }

    if (usedIdsSet instanceof Set) {
      while (usedIdsSet.has(candidate)) {
        candidate = generateUniqueId();
      }
      usedIdsSet.add(candidate);
    }
    return candidate;
  }

  // Phase 7: Identity Framing Milestones & Momentum Shield (Graceful Streaks)
  const IDENTITY_MILESTONE_TOASTS = {
    3: "3 days. You're building the rhythm of someone who follows through.",
    7: "7 days. You're someone who shows up.",
    10: "10 days. Double digits—consistency is your default.",
    14: "14 days. Two weeks in. You're someone who keeps showing up.",
    21: "21 days. This isn't an effort anymore—it's your identity.",
    30: "30 days. You're someone who keeps promises to yourself.",
    45: "45 days. Unhurried, steady discipline is who you are.",
    50: "50 days. Quiet discipline is your baseline.",
    60: "60 days. Deep consistency defines your standard.",
    75: "75 days. You don't negotiate with your standards.",
    90: "90 days. You've built a lasting identity.",
    100: "100 days. Mastery through daily presence.",
    180: "180 days. Half a year of unmistakable commitment.",
    365: "365 days. A full year of unwavering identity."
  };

  function getHabitCompletionToastMessage(habit) {
    const streak = habit && Number.isFinite(habit.totalStreak) ? habit.totalStreak : 0;
    if (IDENTITY_MILESTONE_TOASTS[streak]) {
      return IDENTITY_MILESTONE_TOASTS[streak];
    }
    return `${streak}d momentum. You're someone who shows up.`;
  }

  function ensureHabitFields(habit) {
    if (!Array.isArray(habit.history) || habit.history.length !== 7) {
      habit.history = [false, false, false, false, false, false, sanitizeBoolean(habit.doneToday, false)];
    } else {
      habit.history = habit.history.map((v) => sanitizeBoolean(v, false));
    }
    habit.doneToday = sanitizeBoolean(habit.history[6], false);
    const rawTotal = Number.isInteger(habit.totalStreak)
      ? habit.totalStreak
      : Number.isInteger(habit.streak)
        ? habit.streak
        : 0;
    habit.totalStreak = Math.max(0, rawTotal);
    habit.streak = habit.totalStreak;
    habit.category = sanitizeCategory(habit.category, ALLOWED_HABIT_CATEGORIES, "Routine");
  }

  // Analyzes the 7-day rolling window to detect a Grace Day (Momentum Shield) and compute
  // cumulative completion density for the 7-bar Momentum Strip.
  function analyzeHabitMomentum(habit) {
    ensureHabitFields(habit);
    const hist = habit.history;
    const slotStates = hist.map((done) => (done ? "done" : "missed"));

    // A single missed past day (idx 0..5) is shielded as a Grace Day if:
    // - No two consecutive past days are missed, AND
    // - The user has been consistent across the other 6 days (either all 5 other past days completed
    //   or 5+ of the 6 other days in the 7-day window completed, or totalStreak >= 6).
    const pastMissIndices = [];
    for (let i = 0; i < 6; i++) {
      if (!hist[i]) pastMissIndices.push(i);
    }

    let graceIndex = -1;
    if (pastMissIndices.length === 1) {
      const candidateIdx = pastMissIndices[0];
      const otherCompletedCount = hist.filter((v, idx) => idx !== candidateIdx && Boolean(v)).length;
      const pastCompletedCount = hist.slice(0, 6).filter(Boolean).length;
      if (pastCompletedCount >= 5 || otherCompletedCount >= 5 || habit.totalStreak >= 6) {
        graceIndex = candidateIdx;
        slotStates[graceIndex] = "grace";
      }
    }

    // Calculate cumulative density (1..7) and bar heights (38%..100%) across the 7 slots
    let runningDensity = 0;
    const densityRatios = [];
    for (let i = 0; i < 7; i++) {
      if (slotStates[i] === "done") {
        runningDensity += 1;
      } else if (slotStates[i] === "grace") {
        runningDensity = Math.max(1, runningDensity);
      } else {
        runningDensity = Math.max(0, runningDensity - 1);
      }
      const pct = Math.min(100, Math.round(38 + (runningDensity / 7) * 62));
      densityRatios.push(pct);
    }

    return {
      slotStates,
      graceIndex,
      hasGraceShield: graceIndex !== -1,
      densityRatios,
      completedCount: hist.filter(Boolean).length
    };
  }

  function calculateWindowMomentumStreak(habit) {
    const { slotStates } = analyzeHabitMomentum(habit);
    let streakCount = slotStates[6] === "done" ? 1 : 0;
    let consecutiveMissed = 0;
    for (let i = 5; i >= 0; i--) {
      if (slotStates[i] === "done") {
        streakCount += 1;
        consecutiveMissed = 0;
      } else if (slotStates[i] === "grace") {
        // Grace Day bridges the streak without resetting it
        consecutiveMissed = 0;
      } else {
        consecutiveMissed += 1;
        if (consecutiveMissed >= 1) break;
      }
    }
    return streakCount;
  }

  function toggleHabitToday(habit) {
    ensureHabitFields(habit);
    const nowDone = !habit.doneToday;
    habit.doneToday = nowDone;
    habit.history[6] = nowDone;
    if (nowDone) {
      habit.totalStreak += 1;
    } else {
      habit.totalStreak = Math.max(0, habit.totalStreak - 1);
    }
    habit.streak = habit.totalStreak;
    return habit.doneToday;
  }

  function toggleHabitHistorySlot(habit, slotIndex) {
    ensureHabitFields(habit);
    if (slotIndex < 0 || slotIndex > 6) return;
    if (slotIndex === 6) {
      toggleHabitToday(habit);
      return;
    }
    const nowDone = !habit.history[slotIndex];
    habit.history[slotIndex] = nowDone;
    const windowMomentum = calculateWindowMomentumStreak(habit);
    if (nowDone) {
      habit.totalStreak = Math.max(habit.totalStreak, windowMomentum);
    } else {
      habit.totalStreak = windowMomentum;
    }
    habit.streak = habit.totalStreak;
  }

  function checkDateRollover(appState) {
    if (!appState || typeof appState !== "object") return false;
    const todayKey = getLocalDateKey();
    if (!appState.lastActiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(appState.lastActiveDate)) {
      appState.lastActiveDate = todayKey;
      (appState.habits || []).forEach(ensureHabitFields);
      return false;
    }
    if (appState.lastActiveDate === todayKey) return false;

    const [pY, pM, pD] = appState.lastActiveDate.split("-").map(Number);
    const [cY, cM, cD] = todayKey.split("-").map(Number);
    const prevMidnight = new Date(pY, pM - 1, pD);
    const currMidnight = new Date(cY, cM - 1, cD);
    const diffDays = Math.round((currMidnight - prevMidnight) / 86400000);

    if (diffDays <= 0) {
      appState.lastActiveDate = todayKey;
      return false;
    }

    const shifts = Math.min(7, diffDays);
    (appState.habits || []).forEach((habit) => {
      ensureHabitFields(habit);
      const completedOnLastActiveDay = sanitizeBoolean(habit.doneToday || habit.history[6], false);
      const prevSixConsistent =
        habit.history.slice(0, 6).filter(Boolean).length >= 5 || habit.totalStreak >= 6;
      const dayBeforeLastCompleted = sanitizeBoolean(habit.history[5], false);

      // Phase 7 Grace Day (Momentum Shield) Rollover Rule:
      // Streak only resets to 0 if 2 consecutive days are missed, or if 1 day is missed without prior 6-day consistency.
      if (diffDays > 2) {
        habit.totalStreak = 0;
      } else if (diffDays === 2) {
        // 1 full day was skipped between lastActiveDate and today:
        // If lastActiveDate was completed AND user had 6-day consistency, the skipped day is absorbed by the Grace Shield.
        if (!completedOnLastActiveDay || !prevSixConsistent) {
          habit.totalStreak = 0;
        }
      } else if (diffDays === 1) {
        // Normal midnight rollover: if yesterday was missed, check whether it is protected by a Grace Shield
        if (!completedOnLastActiveDay) {
          if (!dayBeforeLastCompleted || !prevSixConsistent) {
            habit.totalStreak = 0;
          }
        }
      }

      for (let s = 0; s < shifts; s++) {
        habit.history.shift();
        habit.history.push(false);
      }
      habit.doneToday = false;
      habit.streak = habit.totalStreak;
    });

    (appState.tasks || []).forEach((task) => {
      if (task && task.deferredToDate && task.deferredToDate <= todayKey) {
        task.deferredToDate = null;
      }
    });

    appState.lastActiveDate = todayKey;
    return true;
  }

  function normalizeState(rawState) {
    const src = rawState && typeof rawState === "object" && !Array.isArray(rawState) ? rawState : {};
    const todayKey = getLocalDateKey();
    const usedIds = new Set();
    const isLegacySchema =
      !Number.isInteger(src.schemaVersion) || src.schemaVersion < ENTITY_MIGRATION_VERSION;

    const userName = sanitizeText(src.userName, "Workspace", 60);
    const soundEnabledVal = sanitizeBoolean(src.soundEnabled, true);
    const rev = sanitizeRev(src.rev);
    const savedAt = Number.isFinite(src.savedAt) && src.savedAt >= 0 ? src.savedAt : 0;
    const lastActiveDate =
      typeof src.lastActiveDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(src.lastActiveDate)
        ? src.lastActiveDate
        : todayKey;

    const rawHabits = Array.isArray(src.habits) ? src.habits : [];
    const habits = rawHabits.slice(0, 500).map((h, idx) => {
      const item = h && typeof h === "object" ? h : {};
      const rawHistory = Array.isArray(item.history) ? item.history : [];
      const history = [];
      for (let i = 0; i < 7; i++) {
        history.push(sanitizeBoolean(rawHistory[i], false));
      }
      const hasExplicitDoneToday = item.doneToday !== undefined && item.doneToday !== null;
      const doneToday = hasExplicitDoneToday ? sanitizeBoolean(item.doneToday, false) : history[6];
      history[6] = doneToday;

      const streakVal = Math.floor(sanitizeNumber(item.totalStreak ?? item.streak, 0, 0, 36500));
      return {
        id: sanitizeId(item.id, idx + 1, usedIds),
        name: sanitizeText(item.name, "Untitled habit", 140),
        category: sanitizeCategory(item.category, ALLOWED_HABIT_CATEGORIES, "Routine", isLegacySchema),
        streak: streakVal,
        totalStreak: streakVal,
        history,
        doneToday
      };
    });

    const rawTasks = Array.isArray(src.tasks) ? src.tasks : [];
    const tasks = rawTasks.slice(0, 2000).map((t, idx) => {
      const item = t && typeof t === "object" ? t : {};
      const deferredToDate =
        typeof item.deferredToDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.deferredToDate)
          ? item.deferredToDate
          : null;
      return {
        id: sanitizeId(item.id, idx + 1000, usedIds),
        title: sanitizeText(item.title, "Untitled task", 240),
        priority: sanitizeCategory(item.priority, ALLOWED_PRIORITIES, "Medium", false),
        completed: sanitizeBoolean(item.completed, false),
        deferredToDate
      };
    });

    const rawSkills = Array.isArray(src.skills) ? src.skills : [];
    const skills = rawSkills.slice(0, 200).map((s, idx) => {
      const item = s && typeof s === "object" ? s : {};
      const rawMilestones = Array.isArray(item.milestones) ? item.milestones : [];
      const milestones = rawMilestones.slice(0, 100).map((m) => {
        const mObj = m && typeof m === "object" ? m : {};
        return {
          title: sanitizeText(mObj.title, "Untitled milestone", 180),
          done: sanitizeBoolean(mObj.done, false)
        };
      });
      return {
        id: sanitizeId(item.id, idx + 3000, usedIds),
        name: sanitizeText(item.name, "Untitled skill", 140),
        category: sanitizeCategory(item.category, ALLOWED_SKILL_CATEGORIES, "General", isLegacySchema),
        currentHours: sanitizeNumber(item.currentHours, 0, 0, 50000),
        targetHours: sanitizeNumber(item.targetHours, 30, 1, 50000),
        milestones
      };
    });

    const rawNotes = Array.isArray(src.notes) ? src.notes : [];
    const notes = rawNotes.slice(0, 2000).map((n, idx) => {
      const item = n && typeof n === "object" ? n : {};
      return {
        id: sanitizeId(item.id, idx + 5000, usedIds),
        title: sanitizeText(item.title, "Untitled note", 160),
        category: sanitizeCategory(item.category, ALLOWED_NOTE_CATEGORIES, "Lab & study", isLegacySchema),
        body: sanitizeText(item.body, "", 10000),
        updatedAt: sanitizeText(item.updatedAt, todayKey, 40)
      };
    });

    const rawInbox = Array.isArray(src.inbox) ? src.inbox : [];
    const inbox = rawInbox.slice(0, 500).map((entry, idx) => {
      const item = entry && typeof entry === "object" ? entry : {};
      return {
        id: sanitizeId(item.id, idx + 8000, usedIds),
        text: sanitizeText(item.text ?? item.title, "Untitled thought", 240),
        createdAt: sanitizeText(item.createdAt, todayKey, 40)
      };
    });

    return {
      schemaVersion: ENTITY_MIGRATION_VERSION,
      userName,
      soundEnabled: soundEnabledVal,
      rev,
      baseRev: rev,
      savedAt,
      lastActiveDate,
      habits,
      tasks,
      skills,
      notes,
      inbox
    };
  }

  function migrateEncodedEntitiesInState(appState) {
    if (!appState || typeof appState !== "object") return normalizeState({});
    const needsEntityMigration =
      !Number.isInteger(appState.schemaVersion) || appState.schemaVersion < ENTITY_MIGRATION_VERSION;

    if (!needsEntityMigration) {
      return normalizeState(appState);
    }

    const migrated = Object.assign({}, appState);
    if (typeof migrated.userName === "string") {
      migrated.userName = decodeHtmlEntities(migrated.userName);
    }
    if (Array.isArray(migrated.habits)) {
      migrated.habits = migrated.habits.map((h) =>
        h && typeof h === "object"
          ? Object.assign({}, h, {
              name: typeof h.name === "string" ? decodeHtmlEntities(h.name) : h.name,
              category: typeof h.category === "string" ? decodeHtmlEntities(h.category) : h.category
            })
          : h
      );
    }
    if (Array.isArray(migrated.tasks)) {
      migrated.tasks = migrated.tasks.map((t) =>
        t && typeof t === "object"
          ? Object.assign({}, t, {
              title: typeof t.title === "string" ? decodeHtmlEntities(t.title) : t.title,
              priority: typeof t.priority === "string" ? decodeHtmlEntities(t.priority) : t.priority
            })
          : t
      );
    }
    if (Array.isArray(migrated.skills)) {
      migrated.skills = migrated.skills.map((s) => {
        if (!s || typeof s !== "object") return s;
        const milestones = Array.isArray(s.milestones)
          ? s.milestones.map((m) =>
              m && typeof m === "object"
                ? Object.assign({}, m, {
                    title: typeof m.title === "string" ? decodeHtmlEntities(m.title) : m.title
                  })
                : m
            )
          : s.milestones;
        return Object.assign({}, s, {
          name: typeof s.name === "string" ? decodeHtmlEntities(s.name) : s.name,
          category: typeof s.category === "string" ? decodeHtmlEntities(s.category) : s.category,
          milestones
        });
      });
    }
    if (Array.isArray(migrated.notes)) {
      migrated.notes = migrated.notes.map((n) =>
        n && typeof n === "object"
          ? Object.assign({}, n, {
              title: typeof n.title === "string" ? decodeHtmlEntities(n.title) : n.title,
              category: typeof n.category === "string" ? decodeHtmlEntities(n.category) : n.category,
              body: typeof n.body === "string" ? decodeHtmlEntities(n.body) : n.body
            })
          : n
      );
    }
    if (Array.isArray(migrated.inbox)) {
      migrated.inbox = migrated.inbox.map((item) =>
        item && typeof item === "object"
          ? Object.assign({}, item, {
              text: typeof item.text === "string" ? decodeHtmlEntities(item.text) : item.text
            })
          : item
      );
    }
    return normalizeState(migrated);
  }

  // Clean Production Default State (Zero Personal or Pre-Filled Demo Data)
  const defaultAppState = normalizeState({
    schemaVersion: ENTITY_MIGRATION_VERSION,
    userName: "Workspace",
    soundEnabled: true,
    lastActiveDate: getLocalDateKey(),
    habits: [],
    tasks: [],
    skills: [],
    notes: [],
    inbox: []
  });

  // --------------------------------------------------------------------------
  // 6. Cached IndexedDB Connection & Promise-Based `loadState()` (Fixes P0 Race)
  // --------------------------------------------------------------------------
  const LS_KEY = "pulse_minimal_v3";
  const IDB_NAME = "PulseWorkspaceDB";
  const IDB_VERSION = 1;
  const IDB_STORE = "app_state";

  let dbConnectionPromise = null;
  let isAppHydrated = false;
  let isReadOnlyMode = false;
  let persistenceBusy = false;
  let state = null;
  let lastCommittedStateSnapshot = null;
  const syncChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("pulse-sync") : null;

  function snapshotCommittedState(stateObj) {
    if (!isValidAppState(stateObj)) return;
    try {
      lastCommittedStateSnapshot = JSON.parse(JSON.stringify(stateObj));
    } catch (e) {}
  }

  function restoreFromCommittedSnapshot() {
    if (!lastCommittedStateSnapshot || !state) return;
    try {
      const restored = JSON.parse(JSON.stringify(lastCommittedStateSnapshot));
      state.userName = restored.userName;
      state.soundEnabled = restored.soundEnabled !== false;
      soundEnabled = state.soundEnabled;
      state.rev = sanitizeRev(restored.rev);
      state.baseRev = sanitizeRev(restored.baseRev ?? restored.rev);
      state.savedAt = restored.savedAt || 0;
      state.lastActiveDate = restored.lastActiveDate;
      state.habits = restored.habits || [];
      state.tasks = restored.tasks || [];
      state.skills = restored.skills || [];
      state.notes = restored.notes || [];
      state.inbox = restored.inbox || [];
    } catch (e) {}
  }

  function assertWorkspaceWritable() {
    if (!isAppHydrated) return false;
    if (isReadOnlyMode) {
      enforceReadOnlyModeUI();
      showToast("Workspace is read-only");
      return false;
    }
    if (persistenceBusy) {
      showToast("Saving previous change. Please wait.");
      return false;
    }
    return true;
  }

  function enforceReadOnlyModeUI() {
    if (!isReadOnlyMode || typeof document === "undefined" || !document.body) return;

    if (!document.getElementById("readonly-storage-banner")) {
      const banner = document.createElement("div");
      banner.id = "readonly-storage-banner";
      banner.setAttribute("role", "alert");
      banner.setAttribute("aria-live", "assertive");
      banner.className = "fixed top-0 left-0 right-0 z-50 bg-rose-600 text-white text-xs font-semibold px-4 py-2.5 text-center shadow-lg";
      banner.textContent = "Storage Error: Workspace is in Read-Only mode. Changes cannot be saved.";
      document.body.prepend(banner);
      document.body.style.paddingTop = "2.5rem";
    }

    const mutationSelectors = [
      "#btn-open-add-habit",
      "#btn-open-add-task",
      "#btn-open-add-skill",
      "#btn-open-add-note",
      "#btn-timer-start",
      "#btn-timer-reset",
      "#btn-enter-zen-focus",
      "#btn-dash-quick-capture",
      "#btn-tasks-quick-capture",
      "#dash-quick-capture-input",
      "#quick-capture-input",
      "#input-focus-session-name",
      "#input-custom-minutes",
      "#btn-save-username",
      "#input-user-name",
      "#toggle-sound-btn",
      "#btn-quick-sound",
      "#btn-clear-all-data",
      "#input-import-json",
      "#btn-reset-data",
      "#btn-save-habit-modal",
      "#btn-save-task-modal",
      "#btn-save-skill-modal",
      "#btn-save-milestone-modal",
      "#btn-save-note-modal",
      "#btn-accept-confirm-modal",
      "#btn-close-day",
      "#btn-dismiss-briefing",
      ".toggle-habit-btn",
      ".day-matrix-btn",
      ".edit-habit-btn",
      ".edit-habit-btn-desk",
      ".delete-habit-btn",
      ".delete-habit-btn-desk",
      ".task-check-btn",
      ".edit-task-btn",
      ".delete-task-btn",
      ".milestone-toggle",
      ".delete-milestone-btn",
      ".add-milestone-btn",
      ".dec-half-btn",
      ".log-half-btn",
      ".log-hour-btn",
      ".edit-skill-btn",
      ".delete-skill-btn",
      ".delete-note-btn",
      ".briefing-done-btn",
      ".briefing-focus-btn",
      ".closeout-finish-btn",
      ".closeout-tomorrow-btn",
      ".closeout-drop-btn",
      ".inbox-make-task-btn",
      ".inbox-make-habit-btn",
      ".inbox-make-skill-btn",
      ".inbox-make-note-btn",
      ".inbox-delete-btn"
    ];

    document.querySelectorAll(mutationSelectors.join(",")).forEach((el) => {
      el.disabled = true;
      el.setAttribute("aria-disabled", "true");
      el.classList.add("opacity-50", "cursor-not-allowed", "pointer-events-none");
    });
  }

  function openPulseDB() {
    if (dbConnectionPromise) return dbConnectionPromise;
    dbConnectionPromise = new Promise((resolve, reject) => {
      if (typeof window === "undefined" || !("indexedDB" in window)) {
        dbConnectionPromise = null;
        return reject(new Error("IndexedDB not supported"));
      }
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = (e) => {
        const db = e.target.result;
        db.onversionchange = () => {
          db.close();
          dbConnectionPromise = null;
        };
        db.onclose = () => {
          dbConnectionPromise = null;
        };
        resolve(db);
      };
      req.onerror = (e) => {
        dbConnectionPromise = null;
        reject(e.target.error || new Error("IndexedDB open failed"));
      };
      req.onblocked = () => {
        dbConnectionPromise = null;
        reject(new Error("IndexedDB blocked"));
      };
    });
    return dbConnectionPromise;
  }

  function isValidAppState(candidate) {
    return Boolean(
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      Array.isArray(candidate.habits) &&
      Array.isArray(candidate.tasks) &&
      Array.isArray(candidate.skills) &&
      Array.isArray(candidate.notes) &&
      Array.isArray(candidate.inbox)
    );
  }

  function isNewerState(challenger, baseline) {
    if (!isValidAppState(challenger)) return false;
    if (!isValidAppState(baseline)) return true;
    const cRev = sanitizeRev(challenger.rev);
    const bRev = sanitizeRev(baseline.rev);
    if (cRev !== bRev) return cRev > bRev;
    const cTime = Number.isFinite(challenger.savedAt) ? challenger.savedAt : 0;
    const bTime = Number.isFinite(baseline.savedAt) ? baseline.savedAt : 0;
    return cTime > bTime;
  }

  function loadFromIndexedDB() {
    return openPulseDB().then((db) => {
      return new Promise((resolve, reject) => {
        let tx;
        try {
          tx = db.transaction(IDB_STORE, "readonly");
        } catch (err) {
          dbConnectionPromise = null;
          return openPulseDB().then((freshDb) => {
            try {
              const retryTx = freshDb.transaction(IDB_STORE, "readonly");
              const retryReq = retryTx.objectStore(IDB_STORE).get("latest");
              retryReq.onsuccess = () => {
                const res = retryReq.result;
                resolve(isValidAppState(res) ? migrateEncodedEntitiesInState(res) : null);
              };
              retryReq.onerror = () => reject(retryReq.error || new Error("IndexedDB retry read failed"));
              retryTx.onabort = () => reject(retryTx.error || new Error("IndexedDB retry transaction aborted"));
            } catch (retryErr) {
              reject(retryErr);
            }
          }, reject);
        }
        const req = tx.objectStore(IDB_STORE).get("latest");
        req.onsuccess = () => {
          const result = req.result;
          resolve(isValidAppState(result) ? migrateEncodedEntitiesInState(result) : null);
        };
        req.onerror = () => reject(req.error || new Error("IndexedDB read failed"));
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
      });
    });
  }

  // P0 Optimistic Concurrency Control, Strict Init (!hasRecord && expectedBaseRev === 0),
  // Persistence Lock Management & Candidate Snapshotting:
  // Create a `candidate` clone, set its revs to `expectedBaseRev + 1`, and `put` the candidate.
  // ONLY inside `tx.oncomplete` update the live `stateObj` revisions, call `snapshotCommittedState(committedCandidate)`,
  // and post to BroadcastChannel. Resolves with `committedCandidate` (or `null` on failure).
  function saveToIndexedDB(stateObj, lockOwnedByCaller = false) {
    if (isReadOnlyMode || !isValidAppState(stateObj)) {
      return Promise.resolve(null);
    }
    if (!lockOwnedByCaller) {
      if (persistenceBusy) {
        return Promise.resolve(null);
      }
      persistenceBusy = true;
    }

    return openPulseDB()
      .then((db) => {
        return new Promise((resolve, reject) => {
          let tx;
          try {
            tx = db.transaction(IDB_STORE, "readwrite");
          } catch (err) {
            dbConnectionPromise = null;
            return reject(err);
          }

          let conflictError = null;
          let committedCandidate = null;
          const store = tx.objectStore(IDB_STORE);
          const getReq = store.get("latest");

          getReq.onsuccess = () => {
            const existing = getReq.result;
            const hasRecord = existing !== undefined && existing !== null && typeof existing === "object";
            const hasExistingRev = hasRecord && Number.isSafeInteger(existing.rev);
            const existingRev = hasExistingRev ? sanitizeRev(existing.rev) : 0;
            const expectedBaseRev =
              Number.isSafeInteger(stateObj.baseRev) && stateObj.baseRev >= 0
                ? sanitizeRev(stateObj.baseRev)
                : sanitizeRev(stateObj.rev);

            if ((!hasRecord && expectedBaseRev === 0) || (hasRecord && existingRev === expectedBaseRev)) {
              const nextRev = Math.min(expectedBaseRev + 1, MAX_SAFE_REV);
              const candidate = JSON.parse(JSON.stringify(stateObj));
              candidate.rev = nextRev;
              candidate.baseRev = nextRev;
              candidate.savedAt = Date.now();
              candidate.lastActiveDate = getLocalDateKey();
              candidate.schemaVersion = ENTITY_MIGRATION_VERSION;
              committedCandidate = candidate;
              store.put(candidate, "latest");
            } else {
              conflictError = new Error(
                "Optimistic concurrency conflict: hasRecord=" +
                  hasRecord +
                  ", existingRev (" +
                  existingRev +
                  ") !== expectedBaseRev (" +
                  expectedBaseRev +
                  "). Aborting transaction."
              );
              console.warn(conflictError.message);
              try {
                tx.abort();
              } catch (abortErr) {}
            }
          };

          getReq.onerror = () => {
            reject(getReq.error || new Error("IndexedDB atomic pre-read failed"));
          };

          tx.oncomplete = () => {
            if (committedCandidate) {
              stateObj.rev = committedCandidate.rev;
              stateObj.baseRev = committedCandidate.baseRev;
              stateObj.savedAt = committedCandidate.savedAt;
              stateObj.lastActiveDate = committedCandidate.lastActiveDate;
              stateObj.schemaVersion = committedCandidate.schemaVersion;
              snapshotCommittedState(committedCandidate);
              if (syncChannel) {
                try {
                  syncChannel.postMessage({
                    type: "IDB_STATE_COMMITTED",
                    rev: committedCandidate.rev,
                    savedAt: committedCandidate.savedAt
                  });
                } catch (bcErr) {}
              }
            }
            resolve(committedCandidate);
          };

          tx.onerror = () => {
            reject(conflictError || tx.error || new Error("IndexedDB write transaction error"));
          };

          tx.onabort = () => {
            reject(conflictError || tx.error || new Error("IndexedDB write transaction aborted"));
          };
        });
      })
      .catch((err) => {
        console.warn("saveToIndexedDB rejected:", err && err.message ? err.message : err);
        return null;
      })
      .finally(() => {
        if (!lockOwnedByCaller) {
          persistenceBusy = false;
        }
      });
  }

  // P0 IDB Boot Recovery (No Overwrite): If loadFromIndexedDB() rejects or throws during loadState(),
  // enter Degraded Read-Only Mode (isReadOnlyMode = true) so saveState() aborts all writes and UI alerts the user.
  function loadState() {
    let lsState = null;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (isValidAppState(parsed)) {
          lsState = migrateEncodedEntitiesInState(parsed);
        }
      }
    } catch (e) {
      lsState = null;
    }

    let idbErrored = false;
    let idbReadPromise;
    try {
      idbReadPromise = loadFromIndexedDB().catch((err) => {
        idbErrored = true;
        isReadOnlyMode = true;
        console.error("IndexedDB failed during startup; entering Degraded Read-Only Mode:", err);
        return null;
      });
    } catch (err) {
      idbErrored = true;
      isReadOnlyMode = true;
      console.error("IndexedDB threw synchronously during startup; entering Degraded Read-Only Mode:", err);
      idbReadPromise = Promise.resolve(null);
    }

    return idbReadPromise.then((idbState) => {
      let winningState = null;
      let winnerSource = "default";

      if (idbErrored) {
        isReadOnlyMode = true;
        winningState = isValidAppState(lsState) ? lsState : normalizeState(defaultAppState);
        checkDateRollover(winningState);
        winningState.baseRev = sanitizeRev(winningState.rev);
        snapshotCommittedState(winningState);
        enforceReadOnlyModeUI();
        return winningState;
      }

      if (isValidAppState(lsState) && isValidAppState(idbState)) {
        if (isNewerState(idbState, lsState)) {
          winningState = idbState;
          winnerSource = "idb";
        } else {
          winningState = lsState;
          winnerSource = "ls";
        }
      } else if (isValidAppState(idbState)) {
        winningState = idbState;
        winnerSource = "idb";
      } else if (isValidAppState(lsState)) {
        winningState = lsState;
        winnerSource = "ls";
      } else {
        winningState = normalizeState(defaultAppState);
        winnerSource = "default";
      }

      winningState.baseRev = sanitizeRev(winningState.rev);
      const rolledOver = checkDateRollover(winningState);
      snapshotCommittedState(winningState);

      // Heal whichever storage layer was behind or if midnight rollover advanced the date
      if (!isReadOnlyMode) {
        if (winnerSource === "ls" || rolledOver) {
          winningState.baseRev =
            idbState && Number.isSafeInteger(idbState.rev) ? sanitizeRev(idbState.rev) : 0;
          return saveToIndexedDB(winningState).then((committedState) => {
            if (committedState && typeof committedState === "object") {
              try {
                localStorage.setItem(LS_KEY, JSON.stringify(committedState));
              } catch (e) {}
            }
            snapshotCommittedState(winningState);
            return winningState;
          });
        }
        if (winnerSource === "idb") {
          try {
            localStorage.setItem(LS_KEY, JSON.stringify(winningState));
          } catch (e) {}
        }
      }

      return winningState;
    });
  }

  function saveState(s) {
    if (isReadOnlyMode) {
      enforceReadOnlyModeUI();
      console.warn("saveState aborted: Application is in Degraded Read-Only Mode to protect IndexedDB backup.");
      return Promise.resolve({ lsSuccess: false, idbSuccess: false, rev: s ? s.rev : 0, savedAt: 0, committedState: null });
    }
    if (!isAppHydrated || !isValidAppState(s)) {
      return Promise.resolve({ lsSuccess: false, idbSuccess: false, rev: 0, savedAt: 0, committedState: null });
    }
    if (persistenceBusy) {
      showToast("Saving previous change. Please wait.");
      return Promise.resolve({ lsSuccess: false, idbSuccess: false, rev: s.rev || 0, savedAt: s.savedAt || 0, committedState: null });
    }

    persistenceBusy = true;
    clearUndoCallback();
    checkDateRollover(s);

    const expectedBaseRev =
      Number.isSafeInteger(s.baseRev) && s.baseRev >= 0 ? sanitizeRev(s.baseRev) : sanitizeRev(s.rev);
    try {
      const existingRaw = localStorage.getItem(LS_KEY) || localStorage.getItem("pulse_state_v1");
      if (existingRaw) {
        const existingParsed = JSON.parse(existingRaw);
        if (existingParsed && Number.isSafeInteger(existingParsed.rev)) {
          const storedRev = sanitizeRev(existingParsed.rev);
          if (storedRev !== expectedBaseRev && storedRev > expectedBaseRev) {
            console.warn(
              "saveState aborted: Stored revision (rev " +
                storedRev +
                ") does not match expected baseRev (rev " +
                expectedBaseRev +
                "). Aborting stale write."
            );
            persistenceBusy = false;
            return Promise.resolve({
              lsSuccess: false,
              idbSuccess: false,
              rev: expectedBaseRev,
              savedAt: s.savedAt || 0,
              committedState: null
            });
          }
        }
      }
    } catch (e) {
      console.warn("saveState concurrency check error:", e);
    }

    // Do NOT mutate s.rev or s.baseRev before saveToIndexedDB commits inside tx.oncomplete.
    // Mirror the exact immutable `committedState` returned by saveToIndexedDB to LocalStorage, NOT the mutable `s`.
    return saveToIndexedDB(s, true)
      .then((committedState) => {
        const idbSuccess = Boolean(committedState && typeof committedState === "object");
        let lsSuccess = false;
        if (idbSuccess) {
          try {
            const serialized = JSON.stringify(committedState);
            localStorage.setItem(LS_KEY, serialized);
            lsSuccess = true;
          } catch (e) {
            lsSuccess = false;
          }
        } else {
          console.warn(
            "saveState: saveToIndexedDB did not succeed; skipping localStorage write to maintain IDB as single authority."
          );
        }
        return {
          lsSuccess,
          idbSuccess,
          rev: idbSuccess ? committedState.rev : s.rev,
          savedAt: idbSuccess ? committedState.savedAt : s.savedAt,
          committedState: idbSuccess ? committedState : null
        };
      })
      .finally(() => {
        persistenceBusy = false;
      });
  }

  // --------------------------------------------------------------------------
  // 7. Operation-Specific Undo System (Zero Full-State Overwrites)
  // --------------------------------------------------------------------------
  let currentUndoCallback = null;
  let toastTimeout = null;

  function hideUndoButtonElement(undoBtn) {
    if (!undoBtn) return;
    undoBtn.classList.add("hidden", "pointer-events-none");
    undoBtn.style.visibility = "hidden";
    undoBtn.setAttribute("tabindex", "-1");
    undoBtn.disabled = true;
  }

  function showUndoButtonElement(undoBtn) {
    if (!undoBtn) return;
    undoBtn.classList.remove("hidden", "pointer-events-none");
    undoBtn.style.visibility = "visible";
    undoBtn.removeAttribute("tabindex");
    undoBtn.disabled = false;
  }

  function clearUndoCallback() {
    currentUndoCallback = null;
    const undoBtn = document.getElementById("toast-undo-btn");
    const toast = document.getElementById("toast");
    if (undoBtn) {
      undoBtn.classList.add("hidden", "pointer-events-none");
      undoBtn.style.visibility = "hidden";
      undoBtn.setAttribute("tabindex", "-1");
      undoBtn.disabled = true;
    }
    if (toast) {
      toast.classList.remove("pointer-events-auto");
      toast.classList.add("pointer-events-none");
      toast.style.pointerEvents = "none";
    }
  }

  function showToast(text, undoCallback = null) {
    const toast = document.getElementById("toast");
    const undoBtn = document.getElementById("toast-undo-btn");
    const textEl = document.getElementById("toast-text");
    if (!toast || !textEl) return;

    textEl.textContent = text;
    currentUndoCallback = typeof undoCallback === "function" ? undoCallback : null;

    if (currentUndoCallback) {
      if (undoBtn) {
        undoBtn.classList.remove("hidden", "pointer-events-none");
        undoBtn.style.visibility = "visible";
        undoBtn.removeAttribute("tabindex");
        undoBtn.disabled = false;
      }
      toast.classList.remove("pointer-events-none");
      toast.classList.add("pointer-events-auto");
      toast.style.pointerEvents = "auto";
    } else {
      if (undoBtn) {
        undoBtn.classList.add("hidden", "pointer-events-none");
        undoBtn.style.visibility = "hidden";
        undoBtn.setAttribute("tabindex", "-1");
        undoBtn.disabled = true;
      }
      toast.classList.remove("pointer-events-auto");
      toast.classList.add("pointer-events-none");
      toast.style.pointerEvents = "none";
    }

    toast.classList.add("toast-visible");
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.remove("toast-visible", "pointer-events-auto");
      toast.classList.add("pointer-events-none");
      toast.style.pointerEvents = "none";
      currentUndoCallback = null;
      if (undoBtn) {
        undoBtn.classList.add("hidden", "pointer-events-none");
        undoBtn.style.visibility = "hidden";
        undoBtn.setAttribute("tabindex", "-1");
        undoBtn.disabled = true;
      }
    }, 4500);
  }

  function performRollbackAndRender(rollbackFn) {
    if (typeof rollbackFn === "function") {
      try {
        rollbackFn();
      } catch (e) {
        restoreFromCommittedSnapshot();
      }
    } else {
      restoreFromCommittedSnapshot();
    }
    updateProfileUi();
    updateSoundUi();
    renderAll();
  }

  function saveStateWithUndo(s, toastMessage, undoCallback) {
    return saveState(s)
      .then((res) => {
        if (res && res.idbSuccess) {
          showToast(toastMessage, undoCallback);
        } else {
          performRollbackAndRender(undoCallback);
          showToast("Save failed. Changes rolled back.");
        }
        return res;
      })
      .catch(() => {
        performRollbackAndRender(undoCallback);
        showToast("Save failed. Changes rolled back.");
        return { lsSuccess: false, idbSuccess: false };
      });
  }

  function saveStateWithToast(s, successToastMessage = null, rollbackCallback = null) {
    return saveState(s)
      .then((res) => {
        if (res && res.idbSuccess) {
          if (successToastMessage) {
            showToast(successToastMessage);
          }
        } else {
          performRollbackAndRender(rollbackCallback);
          showToast("Save failed. Changes rolled back.");
        }
        return res;
      })
      .catch(() => {
        performRollbackAndRender(rollbackCallback);
        showToast("Save failed. Changes rolled back.");
        return { lsSuccess: false, idbSuccess: false };
      });
  }

  // --------------------------------------------------------------------------
  // 8. Task-Linked Motivational Focus Engine with Auto-Logging & Notifications
  // --------------------------------------------------------------------------
  const TIMER_STORAGE_KEY = "pulse_timer_state_v1";
  const MOTIVATION_QUOTES = [
    "Deep work is your superpower.",
    "Focus on the process, not the outcome.",
    "Clarity comes from single-tasking without interruption.",
    "Small, deliberate sessions compound into mastery.",
    "Protect your attention; it shapes your craft.",
    "One priority finished is worth ten half-started.",
    "Calm execution beats frantic multitasking.",
    "Let the clock hold the time so your mind holds the work.",
    "Consistency in quiet hours builds lasting momentum.",
    "Eliminate the unnecessary so the essential can speak.",
    "Depth requires patience before it yields breakthroughs.",
    "Stay with the problem a little longer than feels comfortable.",
    "Simplicity is about subtracting the obvious and adding the meaningful.",
    "Where your attention goes, your life follows.",
    "Quiet, uninterrupted blocks turn hard problems into clear steps.",
    "Mastery is built in the minutes nobody else sees.",
    "Do less, with fuller presence.",
    "Attention is the rarest and purest form of generosity to your craft.",
    "Begin before you feel ready; momentum creates clarity.",
    "Resist the urge to switch. Breakthroughs live just past boredom.",
    "Slow down your breathing; sharpen your intent.",
    "Every focused session is a vote for the person you are becoming.",
    "Distraction costs more than the time it takes—it costs depth.",
    "Treat this block as an appointment with your highest work.",
    "Progress is quiet. Let the work speak when the timer ends.",
    "One clear line of thought outperforms a dozen open tabs.",
    "Discipline is choosing what matters now over what is merely loud.",
    "Precision comes from unhurried concentration.",
    "Leave the outcome for later; inhabit the next five minutes.",
    "Stillness of mind is the launchpad for high-leverage work.",
    "Finish the step in front of you before measuring the mountain.",
    "Great craft is the accumulation of calm, deliberate hours.",
    "Guard your mornings and your focus blocks with equal care.",
    "When you remove noise, the next move becomes obvious.",
    "Patience in the small details builds effortless excellence.",
    "Your best thinking happens when you give it room to breathe."
  ];

  function pickRandomQuoteIndex(excludeIdx = -1) {
    if (MOTIVATION_QUOTES.length <= 1) return 0;
    let nextIdx = Math.floor(Math.random() * MOTIVATION_QUOTES.length);
    while (nextIdx === excludeIdx) {
      nextIdx = Math.floor(Math.random() * MOTIVATION_QUOTES.length);
    }
    return nextIdx;
  }

  let timerSeconds = 25 * 60;
  let timerTargetTimestamp = null;
  let timerInterval = null;
  let timerRunning = false;
  let isFocusSessionActive = false;
  let focusLinkedType = "none"; // "none" | "task" | "skill" | "habit"
  let focusLinkedId = null;
  let focusCustomSessionName = "";
  let activeSuggestionIndex = -1;
  let currentSuggestionMatches = [];
  let autocompleteDebounceTimer = null;
  let motivationQuoteIndex = 0;
  let motivationCycleInterval = null;
  let motivationFadeTimeout = null;

  const mainTimerDisplay = document.getElementById("main-timer-display");
  const deskTimerDisplay = document.getElementById("desk-timer-display");
  const headerTimerDisplay = document.getElementById("header-timer-display");
  const btnTimerStart = document.getElementById("btn-timer-start");
  const btnTimerReset = document.getElementById("btn-timer-reset");
  const selectTimerPreset = document.getElementById("select-timer-preset");
  const btnTimerDropdown = document.getElementById("btn-timer-dropdown");
  const menuTimerPreset = document.getElementById("menu-timer-preset");
  const labelTimerPreset = document.getElementById("label-timer-preset");
  const chevronTimerPreset = document.getElementById("chevron-timer-preset");
  const inputCustomMinutes = document.getElementById("input-custom-minutes");
  const btnImmersivePause = document.getElementById("btn-immersive-pause");
  const btnImmersiveStop = document.getElementById("btn-immersive-stop");
  const btnMinimizeFocus = document.getElementById("btn-minimize-focus");
  const btnEnterZenFocus = document.getElementById("btn-enter-zen-focus");
  const btnTimerMinus5 = document.getElementById("btn-timer-minus-5");
  const btnTimerPlus5 = document.getElementById("btn-timer-plus-5");
  const floatingMiniTimer = document.getElementById("floating-mini-timer");
  const miniTimerClock = document.getElementById("mini-timer-clock");
  const miniTimerTarget = document.getElementById("mini-timer-target");
  const btnMiniTimerToggle = document.getElementById("btn-mini-timer-toggle");
  const btnMiniTimerOpen = document.getElementById("btn-mini-timer-open");
  const btnMiniTimerZen = document.getElementById("btn-mini-timer-zen");
  let isFocusMinimized = true;

  const selectFocusTarget = document.getElementById("select-focus-target");
  const labelFocusTarget = document.getElementById("label-focus-target");
  const inputFocusSessionName = document.getElementById("input-focus-session-name");
  const focusAutocompleteMenu = document.getElementById("focus-autocomplete-menu");
  const btnUnlinkFocusTarget = document.getElementById("btn-unlink-focus-target");
  const focusTimerCard = document.getElementById("focus-timer-card");
  const focusTimerSubtitle = document.getElementById("focus-timer-subtitle");
  const focusLinkSelectorRow = document.getElementById("focus-link-selector-row");
  const focusModeStage = document.getElementById("focus-mode-stage");
  const focusStageTypeBadge = document.getElementById("focus-stage-type-badge");
  const focusStageContextLabel = document.getElementById("focus-stage-context-label");
  const focusStageTargetTitle = document.getElementById("focus-stage-target-title");
  const focusStageClock = document.getElementById("focus-stage-clock");
  const focusStageProgress = document.getElementById("focus-stage-progress");
  const focusMotivationQuote = document.getElementById("focus-motivation-quote");
  const dashboardMetricsGrid = document.getElementById("dashboard-metrics-grid");
  const dashboardSnapshotsWrap = document.getElementById("dashboard-snapshots-wrap");

  function formatTime(sec) {
    const m = Math.floor(sec / 60).toString().padStart(2, "0");
    const s = (sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function getSessionElapsedHours(presetMinutes) {
    const mins = Number.isFinite(presetMinutes) && presetMinutes > 0 ? presetMinutes : 25;
    return Math.round((mins / 60) * 100) / 100;
  }

  function resolveLinkedFocusTarget() {
    if (!state || focusLinkedType === "none" || !isValidEntityId(focusLinkedId)) {
      return null;
    }
    const targetIdStr = String(focusLinkedId);
    if (focusLinkedType === "task") {
      const task = (state.tasks || []).find((t) => String(t.id) === targetIdStr && !t.completed);
      if (task) return { type: "task", item: task, label: `Task: ${task.title}`, title: task.title };
    } else if (focusLinkedType === "skill") {
      const skill = (state.skills || []).find((s) => String(s.id) === targetIdStr);
      if (skill) return { type: "skill", item: skill, label: `Skill: ${skill.name}`, title: skill.name };
    } else if (focusLinkedType === "habit") {
      const habit = (state.habits || []).find((h) => String(h.id) === targetIdStr && !h.doneToday);
      if (habit) return { type: "habit", item: habit, label: `Habit: ${habit.name}`, title: habit.name };
    }
    focusLinkedType = "none";
    focusLinkedId = null;
    if (selectFocusTarget) selectFocusTarget.value = "none";
    return null;
  }

  let transientHintTimeout = null;
  function showTransientFocusHint() {
    const hintEl = document.getElementById("focus-shortcut-hint");
    if (!hintEl) return;
    if (transientHintTimeout) clearTimeout(transientHintTimeout);
    hintEl.classList.remove("hint-visible");
    requestAnimationFrame(() => {
      hintEl.classList.add("hint-visible");
      transientHintTimeout = setTimeout(() => {
        hintEl.classList.remove("hint-visible");
      }, 4000);
    });
  }

  function getEffectiveSessionTitle() {
    const resolved = resolveLinkedFocusTarget();
    if (resolved) return resolved.title;
    const custom = sanitizeText(focusCustomSessionName, "", 140);
    return custom || "Deep work";
  }

  function populateFocusTargetDropdown() {
    if (!state) return;
    const resolved = resolveLinkedFocusTarget();

    if (resolved) {
      if (labelFocusTarget) labelFocusTarget.textContent = resolved.label;
      if (selectFocusTarget) selectFocusTarget.value = `${resolved.type}:${resolved.item.id}`;
      if (inputFocusSessionName && document.activeElement !== inputFocusSessionName) {
        inputFocusSessionName.value = resolved.title;
      }
      if (btnUnlinkFocusTarget) btnUnlinkFocusTarget.classList.remove("hidden");
      if (focusTimerSubtitle) {
        focusTimerSubtitle.textContent = "";
      }
    } else {
      if (labelFocusTarget) labelFocusTarget.textContent = "General focus (unlinked)";
      if (selectFocusTarget) selectFocusTarget.value = "none";
      if (inputFocusSessionName && document.activeElement !== inputFocusSessionName) {
        inputFocusSessionName.value = focusCustomSessionName || "";
      }
      if (btnUnlinkFocusTarget) btnUnlinkFocusTarget.classList.add("hidden");
      if (focusTimerSubtitle) {
        focusTimerSubtitle.textContent = "";
      }
    }
  }

  function buildAutocompleteSuggestions(queryText = "") {
    if (!state) return [];
    const q = String(queryText || "").toLowerCase().trim();
    const suggestions = [];

    (state.tasks || [])
      .filter((t) => !t.completed)
      .forEach((t) => {
        if (!q || t.title.toLowerCase().includes(q)) {
          suggestions.push({
            type: "task",
            id: t.id,
            title: t.title,
            badge: `Task · ${t.priority}`
          });
        }
      });

    (state.skills || []).forEach((s) => {
      if (!q || s.name.toLowerCase().includes(q)) {
        const presetMins = parseInt(selectTimerPreset.value, 10) || 25;
        const hrs = getSessionElapsedHours(presetMins);
        suggestions.push({
          type: "skill",
          id: s.id,
          title: s.name,
          badge: `Skill · +${hrs}h`
        });
      }
    });

    (state.habits || [])
      .filter((h) => !h.doneToday)
      .forEach((h) => {
        if (!q || h.name.toLowerCase().includes(q)) {
          suggestions.push({
            type: "habit",
            id: h.id,
            title: h.name,
            badge: `Habit · ${h.totalStreak || 0}d`
          });
        }
      });

    return suggestions.slice(0, 8);
  }

  function closeFocusAutocompleteMenu() {
    if (autocompleteDebounceTimer) {
      clearTimeout(autocompleteDebounceTimer);
      autocompleteDebounceTimer = null;
    }
    if (focusAutocompleteMenu) {
      focusAutocompleteMenu.classList.add("hidden");
      focusAutocompleteMenu.innerHTML = "";
    }
    if (inputFocusSessionName) {
      inputFocusSessionName.setAttribute("aria-expanded", "false");
      inputFocusSessionName.removeAttribute("aria-activedescendant");
    }
    currentSuggestionMatches = [];
    activeSuggestionIndex = -1;
  }

  function highlightAutocompleteItem(index) {
    if (!focusAutocompleteMenu) return;
    const items = focusAutocompleteMenu.querySelectorAll('[role="option"].focus-ac-item');
    items.forEach((item, idx) => {
      if (idx === index) {
        item.classList.add("ac-active", "bg-slate-100");
        item.setAttribute("aria-selected", "true");
        if (inputFocusSessionName) inputFocusSessionName.setAttribute("aria-activedescendant", item.id);
        if (typeof item.scrollIntoView === "function") {
          item.scrollIntoView({ block: "nearest" });
        }
      } else {
        item.classList.remove("ac-active", "bg-slate-100");
        item.setAttribute("aria-selected", "false");
      }
    });
    if (index === -1 && inputFocusSessionName) {
      inputFocusSessionName.removeAttribute("aria-activedescendant");
    }
  }

  function renderFocusAutocompleteMenu(queryText = "", forceOpen = false) {
    if (!focusAutocompleteMenu || !state) return;
    const cleanedQuery = String(queryText || "").trim();

    // v2.1 Patch: Enforce 2-character minimum during typing unless explicitly opened via ArrowDown
    if (!forceOpen && (!cleanedQuery || cleanedQuery.length < 2)) {
      closeFocusAutocompleteMenu();
      return;
    }

    currentSuggestionMatches = buildAutocompleteSuggestions(cleanedQuery);
    activeSuggestionIndex = -1;

    if (currentSuggestionMatches.length === 0) {
      closeFocusAutocompleteMenu();
      return;
    }

    let html = `<div class="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500" role="presentation">Link existing item</div>`;
    currentSuggestionMatches.forEach((m, idx) => {
      const isLinked = focusLinkedType === m.type && String(focusLinkedId) === String(m.id);
      html += `
        <div
          id="focus-ac-opt-${idx}"
          role="option"
          aria-selected="false"
          data-ac-idx="${idx}"
          data-ac-type="${m.type}"
          data-ac-id="${escapeHtml(String(m.id))}"
          data-ac-title="${escapeHtml(m.title)}"
          class="focus-ac-item ${isLinked ? "font-semibold" : "font-medium"}"
        >
          <span class="truncate">${escapeHtml(m.title)}</span>
          <span class="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 shrink-0">${escapeHtml(m.badge)}</span>
        </div>
      `;
    });

    focusAutocompleteMenu.innerHTML = html;
    focusAutocompleteMenu.classList.remove("hidden");
    if (inputFocusSessionName) {
      inputFocusSessionName.setAttribute("aria-expanded", "true");
      inputFocusSessionName.removeAttribute("aria-activedescendant");
    }

    focusAutocompleteMenu.querySelectorAll('[role="option"].focus-ac-item').forEach((optEl) => {
      optEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        playSound("tap");
        const lType = optEl.getAttribute("data-ac-type") || "none";
        const lId = (optEl.getAttribute("data-ac-id") || "").trim();
        const lTitle = optEl.getAttribute("data-ac-title") || "";
        if ((lType === "task" || lType === "skill" || lType === "habit") && lId) {
          focusLinkedType = lType;
          focusLinkedId = lId;
          focusCustomSessionName = lTitle;
          if (inputFocusSessionName) inputFocusSessionName.value = lTitle;
        }
        closeFocusAutocompleteMenu();
        populateFocusTargetDropdown();
        syncFocusModeUI();
        persistTimerState();
      });
    });
  }

  function startMotivationEngine() {
    stopMotivationEngine();
    if (!focusMotivationQuote) return;

    const studioQuoteEl = document.getElementById("focus-studio-quote");
    motivationQuoteIndex = pickRandomQuoteIndex(motivationQuoteIndex);
    const initialQuote = `“${MOTIVATION_QUOTES[motivationQuoteIndex]}”`;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion) {
      focusMotivationQuote.classList.remove("quote-fading");
      focusMotivationQuote.textContent = initialQuote;
      if (studioQuoteEl) {
        studioQuoteEl.classList.remove("quote-fading");
        studioQuoteEl.textContent = initialQuote;
      }
      return;
    }

    focusMotivationQuote.classList.add("quote-fading");
    focusMotivationQuote.textContent = initialQuote;
    if (studioQuoteEl) {
      studioQuoteEl.classList.add("quote-fading");
      studioQuoteEl.textContent = initialQuote;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (focusMotivationQuote) focusMotivationQuote.classList.remove("quote-fading");
        if (studioQuoteEl) studioQuoteEl.classList.remove("quote-fading");
      });
    });

    motivationCycleInterval = setInterval(() => {
      if (!timerRunning || !focusMotivationQuote) return;
      const liveStudioQuote = document.getElementById("focus-studio-quote");
      focusMotivationQuote.classList.add("quote-fading");
      if (liveStudioQuote) liveStudioQuote.classList.add("quote-fading");
      if (motivationFadeTimeout) clearTimeout(motivationFadeTimeout);
      motivationFadeTimeout = setTimeout(() => {
        motivationQuoteIndex = pickRandomQuoteIndex(motivationQuoteIndex);
        const nextText = `“${MOTIVATION_QUOTES[motivationQuoteIndex]}”`;
        if (focusMotivationQuote) {
          focusMotivationQuote.textContent = nextText;
          requestAnimationFrame(() => {
            if (focusMotivationQuote) focusMotivationQuote.classList.remove("quote-fading");
          });
        }
        if (liveStudioQuote) {
          liveStudioQuote.textContent = nextText;
          requestAnimationFrame(() => {
            if (liveStudioQuote) liveStudioQuote.classList.remove("quote-fading");
          });
        }
      }, 1250);
    }, 14000);
  }

  function stopMotivationEngine() {
    if (motivationCycleInterval) {
      clearInterval(motivationCycleInterval);
      motivationCycleInterval = null;
    }
    if (motivationFadeTimeout) {
      clearTimeout(motivationFadeTimeout);
      motivationFadeTimeout = null;
    }
    if (focusMotivationQuote) {
      focusMotivationQuote.classList.remove("quote-fading");
    }
  }

  let focusStageTriggerEl = null;

  function setFocusStageBackgroundInert(isInert) {
    if (!isAppHydrated) return;
    ["header", "nav", "main"].forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        if (focusModeStage && el.contains(focusModeStage)) return;
        if (isInert) {
          el.setAttribute("inert", "");
          el.inert = true;
          el.setAttribute("aria-hidden", "true");
        } else {
          el.removeAttribute("inert");
          el.inert = false;
          el.removeAttribute("aria-hidden");
        }
      });
    });
  }

  function restoreFocusStageTriggerFocus() {
    const candidate =
      focusStageTriggerEl &&
      document.body.contains(focusStageTriggerEl) &&
      !focusStageTriggerEl.disabled &&
      focusStageTriggerEl.offsetParent !== null
        ? focusStageTriggerEl
        : currentActiveView === "focus" && btnTimerStart && !btnTimerStart.disabled
          ? btnTimerStart
          : btnMiniTimerOpen && floatingMiniTimer && !floatingMiniTimer.classList.contains("hidden")
            ? btnMiniTimerOpen
            : btnTimerStart;

    if (candidate && typeof candidate.focus === "function") {
      candidate.focus();
    }
  }

  function minimizeFocusStage() {
    isFocusMinimized = true;
    syncFocusModeUI();
    restoreFocusStageTriggerFocus();
  }

  function syncFocusModeUI() {
    const resolved = resolveLinkedFocusTarget();
    const presetMins = parseInt(selectTimerPreset.value, 10) || 25;
    const elapsedHrs = getSessionElapsedHours(presetMins);

    const effectiveTitle = getEffectiveSessionTitle();
    if (miniTimerTarget) {
      miniTimerTarget.textContent = effectiveTitle;
    }
    if (btnMiniTimerToggle) {
      btnMiniTimerToggle.textContent = timerRunning ? "Pause" : "Resume";
    }

    if (btnImmersivePause) {
      btnImmersivePause.textContent = timerRunning ? "Pause" : "Resume";
    }
    if (btnTimerStart) {
      btnTimerStart.textContent = timerRunning ? "Pause" : isFocusSessionActive ? "Resume" : "Start session";
    }

    syncDurationControlsState();

    if (isFocusSessionActive) {
      if (resolved && resolved.type === "task") {
        if (focusStageTypeBadge) focusStageTypeBadge.textContent = "Linked task session";
        if (focusStageContextLabel) focusStageContextLabel.textContent = "Task";
        if (focusStageTargetTitle) focusStageTargetTitle.textContent = resolved.title;
      } else if (resolved && resolved.type === "skill") {
        if (focusStageTypeBadge) focusStageTypeBadge.textContent = "Linked skill session";
        if (focusStageContextLabel) focusStageContextLabel.textContent = `Skill · +${elapsedHrs}h`;
        if (focusStageTargetTitle) focusStageTargetTitle.textContent = resolved.title;
      } else if (resolved && resolved.type === "habit") {
        if (focusStageTypeBadge) focusStageTypeBadge.textContent = "Linked habit session";
        if (focusStageContextLabel) focusStageContextLabel.textContent = "Daily habit";
        if (focusStageTargetTitle) focusStageTargetTitle.textContent = resolved.title;
      } else {
        if (focusStageTypeBadge) focusStageTypeBadge.textContent = "Active focus session";
        if (focusStageContextLabel) focusStageContextLabel.textContent = "Focus session";
        if (focusStageTargetTitle) focusStageTargetTitle.textContent = effectiveTitle;
      }

      const studioQuoteWrap = document.getElementById("focus-studio-quote-wrap");
      if (studioQuoteWrap) studioQuoteWrap.classList.remove("hidden");
      if (!motivationCycleInterval) {
        startMotivationEngine();
      }

      if (!isFocusMinimized) {
        const wasStageHidden = !focusModeStage || focusModeStage.classList.contains("hidden");
        if (
          wasStageHidden &&
          document.activeElement &&
          document.activeElement !== document.body &&
          (!focusModeStage || !focusModeStage.contains(document.activeElement))
        ) {
          focusStageTriggerEl = document.activeElement;
        } else if (!focusStageTriggerEl) {
          focusStageTriggerEl = btnTimerStart;
        }

        if (document.body) document.body.classList.add("focus-immersive-active");
        setFocusStageBackgroundInert(true);

        if (focusModeStage) {
          focusModeStage.classList.remove("hidden");
          focusModeStage.setAttribute("aria-hidden", "false");
          if (document.activeElement && !focusModeStage.contains(document.activeElement) && btnImmersivePause) {
            btnImmersivePause.focus();
          }
        }
        if (floatingMiniTimer) floatingMiniTimer.classList.add("hidden");
      } else {
        if (document.body) document.body.classList.remove("focus-immersive-active");
        setFocusStageBackgroundInert(false);
        if (focusModeStage) {
          focusModeStage.classList.add("hidden");
          focusModeStage.setAttribute("aria-hidden", "true");
        }
        if (floatingMiniTimer) {
          floatingMiniTimer.classList.remove("hidden");
        }
      }
    } else {
      const wasStageOpen = focusModeStage && !focusModeStage.classList.contains("hidden");
      isFocusMinimized = false;
      const studioQuoteWrap = document.getElementById("focus-studio-quote-wrap");
      if (studioQuoteWrap) studioQuoteWrap.classList.add("hidden");
      if (document.body) document.body.classList.remove("focus-immersive-active");
      setFocusStageBackgroundInert(false);
      if (focusModeStage) {
        focusModeStage.classList.add("hidden");
        focusModeStage.setAttribute("aria-hidden", "true");
      }
      if (floatingMiniTimer) floatingMiniTimer.classList.add("hidden");
      if (wasStageOpen) {
        restoreFocusStageTriggerFocus();
      }
      stopMotivationEngine();
      renderDailyBriefing();
      renderEveningCloseout();
    }
  }

  function persistTimerState() {
    try {
      localStorage.setItem(
        TIMER_STORAGE_KEY,
        JSON.stringify({
          timerSeconds,
          timerTargetTimestamp,
          timerRunning,
          presetMinutes: parseInt(selectTimerPreset.value, 10) || 25,
          focusLinkedType,
          focusLinkedId,
          focusCustomSessionName
        })
      );
    } catch (e) {}
  }

  function syncDurationControlsState() {
    const isLocked = timerRunning || (isFocusSessionActive && timerSeconds > 0);
    document.querySelectorAll(".timer-opt-btn").forEach((btn) => {
      btn.disabled = isLocked;
      if (isLocked) {
        btn.classList.add("opacity-50", "cursor-not-allowed");
      } else {
        btn.classList.remove("opacity-50", "cursor-not-allowed");
      }
    });

    if (inputCustomMinutes) {
      inputCustomMinutes.disabled = isLocked;
      if (isLocked) inputCustomMinutes.classList.add("opacity-50", "cursor-not-allowed");
      else inputCustomMinutes.classList.remove("opacity-50", "cursor-not-allowed");
    }
    if (btnTimerMinus5) {
      btnTimerMinus5.disabled = isLocked;
      if (isLocked) btnTimerMinus5.classList.add("opacity-50", "cursor-not-allowed");
      else btnTimerMinus5.classList.remove("opacity-50", "cursor-not-allowed");
    }
    if (btnTimerPlus5) {
      btnTimerPlus5.disabled = isLocked;
      if (isLocked) btnTimerPlus5.classList.add("opacity-50", "cursor-not-allowed");
      else btnTimerPlus5.classList.remove("opacity-50", "cursor-not-allowed");
    }
  }

  function syncDurationSelectionUI(minutes) {
    const actualMinutesFromSeconds =
      timerSeconds > 0 && timerSeconds % 60 === 0
        ? timerSeconds / 60
        : Math.max(1, Math.round(timerSeconds / 60));
    const targetMinutes =
      minutes !== undefined && Number.isFinite(Number(minutes)) && Number(minutes) > 0
        ? Number(minutes)
        : actualMinutesFromSeconds;

    if (selectTimerPreset) {
      selectTimerPreset.value = String(targetMinutes);
    }
    if (labelTimerPreset) {
      labelTimerPreset.textContent = `${targetMinutes}m`;
    }
    if (inputCustomMinutes && document.activeElement !== inputCustomMinutes) {
      inputCustomMinutes.value = String(targetMinutes);
    }

    document.querySelectorAll(".timer-opt-btn").forEach((btn) => {
      const btnVal = parseInt(btn.dataset.val, 10);
      const isPressed =
        btnVal === targetMinutes &&
        (timerRunning || isFocusSessionActive ? true : timerSeconds === btnVal * 60);
      btn.setAttribute("aria-pressed", isPressed ? "true" : "false");
      if (isPressed) {
        btn.className =
          "timer-opt-btn tap-target h-10 px-5 py-2 rounded-full border border-slate-900 bg-slate-900 text-white text-xs font-semibold transition-colors";
      } else {
        btn.className =
          "timer-opt-btn tap-target h-10 px-5 py-2 rounded-full border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 transition-colors";
      }
    });

    syncDurationControlsState();
  }

  function syncStartButtonState() {
    syncDurationControlsState();
    if (timerSeconds <= 0 && !timerRunning) {
      btnTimerStart.disabled = true;
      btnTimerStart.setAttribute("aria-disabled", "true");
      btnTimerStart.className =
        "tap-target h-11 bg-slate-300 text-slate-500 text-xs sm:text-sm font-semibold px-7 rounded-full cursor-not-allowed";
    } else {
      btnTimerStart.disabled = false;
      btnTimerStart.removeAttribute("aria-disabled");
      btnTimerStart.className =
        "tap-target h-11 bg-slate-900 hover:bg-slate-800 text-white text-xs sm:text-sm font-semibold px-7 rounded-full shadow-xs transition-colors";
    }
  }

  function updateTimerDisplays() {
    const formatted = formatTime(timerSeconds);
    mainTimerDisplay.textContent = formatted;
    if (deskTimerDisplay) deskTimerDisplay.textContent = formatted;
    headerTimerDisplay.textContent = formatted;
    if (focusStageClock) focusStageClock.textContent = formatted;
    if (miniTimerClock) miniTimerClock.textContent = formatted;

    if (focusStageProgress) {
      const totalSeconds = Math.max(1, (parseInt(selectTimerPreset.value, 10) || 25) * 60);
      const elapsedPct = Math.min(100, Math.max(0, Math.round(((totalSeconds - timerSeconds) / totalSeconds) * 100)));
      focusStageProgress.style.width = `${elapsedPct}%`;
    }
    syncStartButtonState();
  }

  function handleFocusSessionCompleted() {
    const resolved = resolveLinkedFocusTarget();
    const presetMins = parseInt(selectTimerPreset.value, 10) || 25;
    const elapsedHrs = getSessionElapsedHours(presetMins);

    if (resolved && resolved.type === "skill") {
      const targetSkill = state.skills.find((s) => s.id === resolved.item.id);
      if (targetSkill) {
        const previousHours = sanitizeNumber(targetSkill.currentHours, 0, 0, 50000);
        targetSkill.currentHours = Math.min(50000, Math.round((previousHours + elapsedHrs) * 100) / 100);
        saveStateWithUndo(state, `Focus complete: +${elapsedHrs}h logged to ${targetSkill.name}`, () => {
          const revertSkill = state.skills.find((s) => s.id === targetSkill.id);
          if (revertSkill) revertSkill.currentHours = previousHours;
        });
        renderAll();
        return;
      }
    } else if (resolved && resolved.type === "task") {
      const targetTask = state.tasks.find((t) => t.id === resolved.item.id);
      if (targetTask && !targetTask.completed) {
        showToast("Focus session completed");
        askConfirmation(
          "Complete linked task?",
          `Your ${presetMins}-minute focus session finished. Mark "${targetTask.title}" as completed?`,
          () => {
            const liveTask = state.tasks.find((t) => t.id === targetTask.id);
            if (!liveTask) return;
            liveTask.completed = true;
            playSound("success");
            saveStateWithUndo(state, `Task "${liveTask.title}" completed`, () => {
              const revertTask = state.tasks.find((t) => t.id === targetTask.id);
              if (revertTask) revertTask.completed = false;
            });
            renderAll();
          }
        );
        return;
      }
    } else if (resolved && resolved.type === "habit") {
      const targetHabit = state.habits.find((h) => h.id === resolved.item.id);
      if (targetHabit && !targetHabit.doneToday) {
        showToast("Focus session completed");
        askConfirmation(
          "Complete linked habit?",
          `Your ${presetMins}-minute focus session finished. Mark "${targetHabit.name}" done for today?`,
          () => {
            if (!assertWorkspaceWritable()) return;
            const liveHabit = state.habits.find((h) => h.id === targetHabit.id);
            if (!liveHabit || liveHabit.doneToday) return;
            ensureHabitFields(liveHabit);
            const prevHistory = liveHabit.history.slice();
            const prevStreak = liveHabit.totalStreak;
            const prevDone = liveHabit.doneToday;
            toggleHabitToday(liveHabit);
            playSound("success");
            renderAll();
            saveStateWithToast(state, getHabitCompletionToastMessage(liveHabit), () => {
              liveHabit.history = prevHistory;
              liveHabit.totalStreak = prevStreak;
              liveHabit.streak = prevStreak;
              liveHabit.doneToday = prevDone;
            });
          }
        );
        return;
      }
    }
    showToast("Focus session completed. Tap Reset to start again.");
  }

  function tickTimer() {
    if (!timerRunning || !timerTargetTimestamp) return;
    const remaining = Math.max(0, Math.ceil((timerTargetTimestamp - Date.now()) / 1000));
    timerSeconds = remaining;
    updateTimerDisplays();
    if (remaining <= 0) {
      clearInterval(timerInterval);
      timerRunning = false;
      isFocusSessionActive = false;
      timerTargetTimestamp = null;
      btnTimerStart.textContent = "Start session";
      syncStartButtonState();
      syncFocusModeUI();
      persistTimerState();
      playSound("success");
      sendTimerCompletionNotification();
      handleFocusSessionCompleted();
    }
  }

  function toggleTimer() {
    if (!isAppHydrated) return;
    if (timerSeconds <= 0 && !timerRunning) return;
    playSound("tap");
    if (timerRunning) {
      tickTimer();
      clearInterval(timerInterval);
      timerRunning = false;
      timerTargetTimestamp = null;
      // Note: isFocusSessionActive remains TRUE so session is paused, not destroyed!
    } else {
      requestTimerNotificationPermission();
      timerRunning = true;
      isFocusSessionActive = true;
      isFocusMinimized = false;
      timerTargetTimestamp = Date.now() + timerSeconds * 1000;
      if (timerInterval) clearInterval(timerInterval);
      timerInterval = setInterval(tickTimer, 250);
      showTransientFocusHint();
    }
    syncStartButtonState();
    syncFocusModeUI();
    persistTimerState();
  }

  function resetTimer() {
    if (!isAppHydrated) return;
    playSound("tap");
    if (timerInterval) clearInterval(timerInterval);
    timerRunning = false;
    isFocusSessionActive = false;
    isFocusMinimized = false;
    timerTargetTimestamp = null;
    const mins = parseInt(selectTimerPreset.value, 10) || 25;
    timerSeconds = mins * 60;
    btnTimerStart.textContent = "Start session";
    syncDurationSelectionUI(mins);
    updateTimerDisplays();
    syncFocusModeUI();
    persistTimerState();
  }

  // Issue 2 Fix: Prevent Accidental Session Wipe with askConfirmation
  function requestStopSession() {
    if (!isAppHydrated) return;
    const totalDuration = (parseInt(selectTimerPreset.value, 10) || 25) * 60;
    const isSessionDirty = timerRunning || (isFocusSessionActive && timerSeconds < totalDuration);

    if (isSessionDirty) {
      askConfirmation(
        "Stop focus session?",
        "Are you sure you want to stop this session? Your current progress will be reset.",
        () => {
          resetTimer();
        }
      );
    } else {
      resetTimer();
    }
  }

  function restorePersistedTimer() {
    let syncedMinutes = Math.max(1, Math.round(timerSeconds / 60));
    try {
      const raw = localStorage.getItem(TIMER_STORAGE_KEY);
      if (!raw) {
        syncDurationSelectionUI(syncedMinutes);
        populateFocusTargetDropdown();
        updateTimerDisplays();
        syncFocusModeUI();
        return;
      }
      const saved = JSON.parse(raw);
      const preset = Number.isInteger(saved.presetMinutes) && saved.presetMinutes >= 1 && saved.presetMinutes <= 240 ? saved.presetMinutes : 25;
      syncedMinutes = preset;
      selectTimerPreset.value = String(preset);
      if (labelTimerPreset) labelTimerPreset.textContent = `${preset}m`;
      if (inputCustomMinutes) inputCustomMinutes.value = String(preset);

      focusCustomSessionName = sanitizeText(saved.focusCustomSessionName, "", 140);
      if (
        (saved.focusLinkedType === "task" || saved.focusLinkedType === "skill" || saved.focusLinkedType === "habit") &&
        isValidEntityId(saved.focusLinkedId)
      ) {
        focusLinkedType = saved.focusLinkedType;
        focusLinkedId = saved.focusLinkedId;
      } else {
        focusLinkedType = "none";
        focusLinkedId = null;
      }
      populateFocusTargetDropdown();

      if (sanitizeBoolean(saved.timerRunning, false) && Number.isFinite(saved.timerTargetTimestamp)) {
        const remaining = Math.max(0, Math.ceil((saved.timerTargetTimestamp - Date.now()) / 1000));
        timerSeconds = remaining;
        if (remaining > 0) {
          timerRunning = true;
          isFocusSessionActive = true;
          timerTargetTimestamp = saved.timerTargetTimestamp;
          btnTimerStart.textContent = "Pause";
          if (timerInterval) clearInterval(timerInterval);
          timerInterval = setInterval(tickTimer, 250);
        } else {
          timerRunning = false;
          isFocusSessionActive = false;
          timerTargetTimestamp = null;
          timerSeconds = preset * 60;
          btnTimerStart.textContent = "Start session";
          persistTimerState();
          handleFocusSessionCompleted();
        }
      } else if (Number.isFinite(saved.timerSeconds)) {
        timerSeconds = Math.max(0, Math.floor(saved.timerSeconds));
        timerRunning = false;
        timerTargetTimestamp = null;
        const isPausedMidway = timerSeconds > 0 && timerSeconds < preset * 60 && timerSeconds % 60 !== 0;
        isFocusSessionActive = isPausedMidway;
        if (!isPausedMidway && timerSeconds > 0) {
          syncedMinutes = Math.min(240, Math.max(1, Math.round(timerSeconds / 60)));
          timerSeconds = syncedMinutes * 60;
        }
        btnTimerStart.textContent = isPausedMidway ? "Resume" : "Start session";
      }
    } catch (e) {}
    syncDurationSelectionUI(syncedMinutes);
    updateTimerDisplays();
    syncFocusModeUI();
  }

  // --------------------------------------------------------------------------
  // 9. UI State & Controllers (Bound After Async `loadState()` Resolves)
  // --------------------------------------------------------------------------
  let currentTaskFilter = "all";
  let targetSkillForMilestone = null;
  let editingNoteId = null;
  let editingHabitId = null;
  let editingTaskId = null;
  let editingSkillId = null;
  let sortTasksByPriority = false;
  let lastFocusedTrigger = null;
  let pendingConfirmAction = null;

  const habitModal = document.getElementById("modal-habit");
  const taskModal = document.getElementById("modal-task");
  const skillModal = document.getElementById("modal-skill");
  const milestoneModal = document.getElementById("modal-milestone");
  const noteModal = document.getElementById("modal-note");
  const confirmModal = document.getElementById("modal-confirm");
  const pwaInstallModal = document.getElementById("modal-pwa-install");

  const userNameInput = document.getElementById("input-user-name");
  const userGreeting = document.getElementById("header-user-greeting");
  const greetingTitle = document.getElementById("greeting-title");
  const profileAvatar = document.getElementById("profile-avatar");
  const taskSearch = document.getElementById("task-search-input");
  const noteSearch = document.getElementById("note-search-input");

  function updateSoundUi() {
    const iconOn = document.getElementById("icon-sound-on");
    const iconOff = document.getElementById("icon-sound-off");
    const toggleBtn = document.getElementById("toggle-sound-btn");

    if (soundEnabled) {
      iconOn.classList.remove("hidden");
      iconOff.classList.add("hidden");
      toggleBtn.className = "tap-target w-11 h-6 bg-slate-900 rounded-full p-0.5 flex items-center justify-end";
    } else {
      iconOn.classList.add("hidden");
      iconOff.classList.remove("hidden");
      toggleBtn.className = "tap-target w-11 h-6 bg-slate-300 rounded-full p-0.5 flex items-center justify-start";
    }
  }

  function updateProfileUi() {
    if (!state) return;
    const name = state.userName || "Workspace";
    userNameInput.value = name;
    userGreeting.textContent = name;
    greetingTitle.textContent = name === "Workspace" ? "Overview" : `${name}'s overview`;
    profileAvatar.textContent = name.charAt(0).toUpperCase();
  }

  const tabList = ["dashboard", "focus", "habits", "tasks", "skills", "notes", "settings"];
  let currentActiveView = "dashboard";
  let modalHistoryPushed = false;
  let isProgrammaticModalPop = false;

  function openAccessibleModal(modalEl, initialFocusEl = null) {
    if (!modalEl) return;
    modalEl.classList.remove("hidden");
    modalEl.setAttribute("aria-hidden", "false");
    if (isAppHydrated && !modalHistoryPushed) {
      try {
        history.pushState({ view: currentActiveView, modal: modalEl.id || "modal" }, "", getCleanUrlForView(currentActiveView));
        modalHistoryPushed = true;
      } catch (e) {}
    }
    requestAnimationFrame(() => {
      if (initialFocusEl && typeof initialFocusEl.focus === "function") {
        initialFocusEl.focus();
      } else {
        const firstFocusable = modalEl.querySelector(
          'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), button:not([disabled])'
        );
        if (firstFocusable) firstFocusable.focus();
      }
    });
  }

  function closeAccessibleModal(modalEl, fromPopState = false) {
    if (!modalEl) return;
    modalEl.classList.add("hidden");
    modalEl.setAttribute("aria-hidden", "true");
    const anyModalStillOpen = [habitModal, taskModal, skillModal, milestoneModal, noteModal, confirmModal, pwaInstallModal].some(
      (m) => m && !m.classList.contains("hidden")
    );
    if (!anyModalStillOpen) {
      if (fromPopState) {
        modalHistoryPushed = false;
      } else if (modalHistoryPushed) {
        modalHistoryPushed = false;
        isProgrammaticModalPop = true;
        try {
          history.back();
        } catch (e) {
          isProgrammaticModalPop = false;
        }
      }
    }
    if (lastFocusedTrigger && typeof lastFocusedTrigger.focus === "function") {
      lastFocusedTrigger.focus();
      lastFocusedTrigger = null;
    }
  }

  function askConfirmation(headingText, descText, onConfirm, triggerEl = null) {
    lastFocusedTrigger = triggerEl || document.activeElement;
    document.getElementById("modal-confirm-heading").textContent = headingText;
    document.getElementById("modal-confirm-desc").textContent = descText;
    pendingConfirmAction = onConfirm;
    openAccessibleModal(confirmModal, document.getElementById("btn-accept-confirm-modal"));
    playSound("tap");
  }

  function setupSegmentedPills(buttonSelector, hiddenInputId) {
    const buttons = document.querySelectorAll(buttonSelector);
    const hiddenInput = document.getElementById(hiddenInputId);
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        playSound("tap");
        const val = btn.dataset.val;
        hiddenInput.value = val;
        buttons.forEach((b) => {
          if (b.dataset.val === val) {
            b.className = `${buttonSelector.slice(1)} tap-target h-10 rounded-xl border border-slate-900 bg-slate-900 text-white text-xs font-semibold px-3 flex items-center justify-center`;
          } else {
            b.className = `${buttonSelector.slice(1)} tap-target h-10 rounded-xl border border-slate-200 bg-slate-50 text-slate-700 text-xs font-medium px-3 flex items-center justify-center`;
          }
        });
      });
    });
  }

  function setActivePillValue(buttonSelector, hiddenInputId, targetVal) {
    const buttons = document.querySelectorAll(buttonSelector);
    const hiddenInput = document.getElementById(hiddenInputId);
    hiddenInput.value = targetVal;
    buttons.forEach((b) => {
      if (b.dataset.val === targetVal) {
        b.className = `${buttonSelector.slice(1)} tap-target h-10 rounded-xl border border-slate-900 bg-slate-900 text-white text-xs font-semibold px-3 flex items-center justify-center`;
      } else {
        b.className = `${buttonSelector.slice(1)} tap-target h-10 rounded-xl border border-slate-200 bg-slate-50 text-slate-700 text-xs font-medium px-3 flex items-center justify-center`;
      }
    });
  }

  function openHabitModal(habitToEdit = null, triggerEl = null) {
    if (!assertWorkspaceWritable()) return;
    lastFocusedTrigger = triggerEl || document.activeElement;
    const heading = document.getElementById("modal-habit-heading");
    const nameInput = document.getElementById("modal-habit-name");
    const saveBtn = document.getElementById("btn-save-habit-modal");

    if (habitToEdit) {
      editingHabitId = habitToEdit.id;
      heading.textContent = "Edit habit";
      saveBtn.textContent = "Update habit";
      nameInput.value = habitToEdit.name || "";
      setActivePillValue(
        ".habit-cat-btn",
        "modal-habit-cat",
        sanitizeCategory(habitToEdit.category, ALLOWED_HABIT_CATEGORIES, "Academic")
      );
    } else {
      editingHabitId = null;
      heading.textContent = "New daily habit";
      saveBtn.textContent = "Save habit";
      nameInput.value = "";
      setActivePillValue(".habit-cat-btn", "modal-habit-cat", "Academic");
    }
    openAccessibleModal(habitModal, nameInput);
    playSound("tap");
  }

  function openTaskModal(taskToEdit = null, triggerEl = null) {
    if (!assertWorkspaceWritable()) return;
    lastFocusedTrigger = triggerEl || document.activeElement;
    const heading = document.getElementById("modal-task-heading");
    const titleInput = document.getElementById("modal-task-title");
    const saveBtn = document.getElementById("btn-save-task-modal");

    if (taskToEdit) {
      editingTaskId = taskToEdit.id;
      heading.textContent = "Edit task";
      saveBtn.textContent = "Update task";
      titleInput.value = taskToEdit.title || "";
      setActivePillValue(
        ".task-prio-btn",
        "modal-task-prio",
        sanitizeCategory(taskToEdit.priority, ALLOWED_PRIORITIES, "Medium")
      );
    } else {
      editingTaskId = null;
      heading.textContent = "New task";
      saveBtn.textContent = "Save task";
      titleInput.value = "";
      setActivePillValue(".task-prio-btn", "modal-task-prio", "Medium");
    }
    openAccessibleModal(taskModal, titleInput);
    playSound("tap");
  }

  function openSkillModal(skillToEdit = null, triggerEl = null) {
    if (!assertWorkspaceWritable()) return;
    lastFocusedTrigger = triggerEl || document.activeElement;
    const heading = document.getElementById("modal-skill-heading");
    const nameInput = document.getElementById("modal-skill-name");
    const targetInput = document.getElementById("modal-skill-target");
    const saveBtn = document.getElementById("btn-save-skill-modal");

    if (skillToEdit) {
      editingSkillId = skillToEdit.id;
      heading.textContent = "Edit skill target";
      saveBtn.textContent = "Update skill";
      nameInput.value = skillToEdit.name || "";
      targetInput.value = skillToEdit.targetHours || 40;
      setActivePillValue(
        ".skill-cat-btn",
        "modal-skill-category",
        sanitizeCategory(skillToEdit.category, ALLOWED_SKILL_CATEGORIES, "Science")
      );
    } else {
      editingSkillId = null;
      heading.textContent = "New skill target";
      saveBtn.textContent = "Save skill";
      nameInput.value = "";
      targetInput.value = 40;
      setActivePillValue(".skill-cat-btn", "modal-skill-category", "Science");
    }
    openAccessibleModal(skillModal, nameInput);
    playSound("tap");
  }

  // Protected Past-Day Habit Click with Operation-Specific Undo & Rollback Callback
  function handleHabitMatrixDayClick(habit, slotIndex, dayLabel, triggerEl = null) {
    if (!assertWorkspaceWritable() || !state) return;
    ensureHabitFields(habit);
    if (slotIndex < 0 || slotIndex > 6) return;

    const previousHistory = habit.history.slice();
    const previousTotalStreak = habit.totalStreak;
    const previousDoneToday = habit.doneToday;
    const rollbackHabit = () => {
      habit.history = previousHistory.slice();
      habit.totalStreak = previousTotalStreak;
      habit.streak = previousTotalStreak;
      habit.doneToday = previousDoneToday;
    };

    if (slotIndex === 6) {
      const isNowDone = toggleHabitToday(habit);
      playSound(isNowDone ? "success" : "tap");
      renderAll();
      saveStateWithToast(state, isNowDone ? getHabitCompletionToastMessage(habit) : null, rollbackHabit);
      return;
    }

    const isCurrentlyCompleted = sanitizeBoolean(habit.history[slotIndex], false);
    if (isCurrentlyCompleted) {
      const targetHabitId = habit.id;

      askConfirmation(
        "Uncheck past habit entry?",
        `Unchecking "${habit.name}" for ${dayLabel} will recalculate and reduce your historical streak. Do you want to continue?`,
        () => {
          if (!assertWorkspaceWritable()) return;
          const liveHabit = state.habits.find((h) => h.id === targetHabitId);
          if (!liveHabit) return;
          toggleHabitHistorySlot(liveHabit, slotIndex);
          playSound("tap");
          saveStateWithUndo(state, `Unchecked ${dayLabel} for ${liveHabit.name}`, () => {
            const hToRestore = state.habits.find((h) => h.id === targetHabitId);
            if (hToRestore) {
              hToRestore.history = previousHistory.slice();
              hToRestore.totalStreak = previousTotalStreak;
              hToRestore.streak = previousTotalStreak;
              hToRestore.doneToday = previousDoneToday;
            }
          });
          renderAll();
        },
        triggerEl
      );
      return;
    }

    toggleHabitHistorySlot(habit, slotIndex);
    playSound("success");
    renderAll();
    saveStateWithToast(state, null, rollbackHabit);
  }

  // --------------------------------------------------------------------------
  // 10. Renderers with Operation-Specific Undo Callbacks (Including Milestones)
  // --------------------------------------------------------------------------
  const PRIORITY_WEIGHT = { High: 3, Medium: 2, Low: 1 };

  function renderHabits() {
    if (!state) return;
    const container = document.getElementById("habits-list");
    container.innerHTML = "";

    if (state.habits.length === 0) {
      container.innerHTML = `<div class="card-surface p-8 text-center text-slate-500 text-xs">No habits configured. Tap "Add habit" to create your first routine.</div>`;
      return;
    }

    const days = generateRollingDayLabels();

    state.habits.forEach((habit) => {
      ensureHabitFields(habit);
      const momentum = analyzeHabitMomentum(habit);
      const card = document.createElement("div");
      card.className = "card-surface p-4 sm:p-5 lg:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4";

      let matrixHtml = `<div class="grid grid-cols-7 gap-1.5 w-full sm:w-auto" role="group" aria-label="7-day momentum strip for ${escapeHtml(habit.name)}">`;
      habit.history.forEach((completed, idx) => {
        const slotState = momentum.slotStates[idx];
        const barHeightPct = momentum.densityRatios[idx];
        let capsuleClass = "momentum-capsule";
        let fillHtml = `<div class="momentum-bar-fill momentum-fill-empty"></div>`;
        let slotTitle = `${days[idx]}: Not completed`;

        if (slotState === "done") {
          capsuleClass += " momentum-capsule-done";
          const shadeClass =
            barHeightPct >= 80
              ? "momentum-fill-high"
              : barHeightPct >= 58
                ? "momentum-fill-mid"
                : "momentum-fill-low";
          fillHtml = `
            <div class="momentum-bar-fill ${shadeClass}" style="height: ${barHeightPct}%">
              <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
          `;
          slotTitle = `${days[idx]}: Completed (${barHeightPct}% momentum density)`;
        } else if (slotState === "grace") {
          capsuleClass += " momentum-capsule-grace";
          fillHtml = `
            <div class="momentum-bar-fill momentum-fill-grace" style="height: 76%">
              <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </div>
          `;
          slotTitle = `${days[idx]}: Grace day (Momentum Shield active)`;
        }

        matrixHtml += `
          <button type="button" data-day-idx="${idx}" title="${escapeHtml(slotTitle)}" aria-label="Toggle ${escapeHtml(days[idx])} for ${escapeHtml(habit.name)}" aria-pressed="${completed ? "true" : "false"}" class="day-matrix-btn tap-target flex flex-col items-center">
            <span class="text-[10px] ${slotState === "grace" ? "text-amber-700 font-semibold" : "text-slate-500 font-medium"} mb-1">${escapeHtml(days[idx])}</span>
            <div class="${capsuleClass}">
              ${fillHtml}
            </div>
          </button>
        `;
      });
      matrixHtml += `</div>`;

      const shieldBadgeHtml = momentum.hasGraceShield
        ? `<span class="bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-md text-[10px] font-medium inline-flex items-center gap-1" title="Single missed day protected by 6-day consistency"><svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span>Shield active</span></span>`
        : "";

      card.innerHTML = `
        <div class="flex items-start sm:items-center justify-between gap-3 flex-1">
          <div class="flex items-center space-x-3.5 flex-1 cursor-pointer habit-row-tap">
            <button type="button" aria-label="Mark ${escapeHtml(habit.name)} done today" aria-pressed="${habit.doneToday ? "true" : "false"}" class="toggle-habit-btn tap-target w-7 h-7 sm:w-6 sm:h-6 rounded-lg border flex items-center justify-center shrink-0 ${
              habit.doneToday ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 hover:border-slate-500 bg-white"
            }">
              ${habit.doneToday ? '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ""}
            </button>
            <div>
              <div class="font-semibold text-xs sm:text-sm lg:text-base text-slate-900 leading-snug ${habit.doneToday ? "line-through text-slate-500" : ""}">
                ${escapeHtml(habit.name)}
              </div>
              <div class="text-[11px] text-slate-500 flex flex-wrap items-center gap-2 mt-1">
                <span class="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md text-[10px] font-medium">${escapeHtml(habit.category)}</span>
                <span>${escapeHtml(habit.totalStreak)} day streak</span>
                ${shieldBadgeHtml}
              </div>
            </div>
          </div>
          <div class="flex items-center space-x-1 sm:hidden shrink-0">
            <button type="button" class="edit-habit-btn tap-target w-8 h-8 rounded-lg text-slate-500 hover:text-slate-700 flex items-center justify-center" aria-label="Edit ${escapeHtml(habit.name)}" title="Edit habit">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
            <button type="button" class="delete-habit-btn tap-target w-8 h-8 rounded-lg text-slate-300 hover:text-rose-600 flex items-center justify-center" aria-label="Delete ${escapeHtml(habit.name)}" title="Delete habit">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        <div class="flex items-center justify-between sm:justify-end space-x-2 border-t sm:border-t-0 pt-3 sm:pt-0 border-slate-100">
          ${matrixHtml}
          <div class="hidden sm:flex items-center space-x-1 shrink-0 pl-1">
            <button type="button" class="edit-habit-btn-desk tap-target w-8 h-8 rounded-lg text-slate-500 hover:text-slate-700 flex items-center justify-center" aria-label="Edit ${escapeHtml(habit.name)}" title="Edit habit">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
            <button type="button" class="delete-habit-btn-desk tap-target w-8 h-8 rounded-lg text-slate-300 hover:text-rose-600 flex items-center justify-center" aria-label="Delete ${escapeHtml(habit.name)}" title="Delete habit">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
      `;

      card.querySelector(".habit-row-tap").addEventListener("click", () => {
        if (!assertWorkspaceWritable()) return;
        ensureHabitFields(habit);
        const prevHistory = habit.history.slice();
        const prevStreak = habit.totalStreak;
        const prevDone = habit.doneToday;
        const isNowDone = toggleHabitToday(habit);
        playSound(isNowDone ? "success" : "tap");
        renderAll();
        saveStateWithToast(state, isNowDone ? getHabitCompletionToastMessage(habit) : null, () => {
          habit.history = prevHistory;
          habit.totalStreak = prevStreak;
          habit.streak = prevStreak;
          habit.doneToday = prevDone;
        });
      });

      card.querySelectorAll(".day-matrix-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          if (!assertWorkspaceWritable()) return;
          const idx = parseInt(btn.dataset.dayIdx, 10);
          handleHabitMatrixDayClick(habit, idx, days[idx], e.currentTarget);
        });
      });

      card.querySelector(".edit-habit-btn").addEventListener("click", (e) => openHabitModal(habit, e.currentTarget));
      card.querySelector(".edit-habit-btn-desk").addEventListener("click", (e) => openHabitModal(habit, e.currentTarget));

      const deleteHabit = () => {
        if (!assertWorkspaceWritable()) return;
        const originalIndex = state.habits.findIndex((h) => h.id === habit.id);
        if (originalIndex === -1) return;
        const deletedHabitClone = JSON.parse(JSON.stringify(state.habits[originalIndex]));
        state.habits.splice(originalIndex, 1);
        playSound("tap");
        saveStateWithUndo(state, "Habit removed", () => {
          if (!state.habits.some((h) => h.id === deletedHabitClone.id)) {
            const insertIdx = Math.min(originalIndex, state.habits.length);
            state.habits.splice(insertIdx, 0, deletedHabitClone);
          }
        });
        renderAll();
      };

      card.querySelector(".delete-habit-btn").addEventListener("click", deleteHabit);
      card.querySelector(".delete-habit-btn-desk").addEventListener("click", deleteHabit);

      container.appendChild(card);
    });
  }

  function renderTasks() {
    if (!state) return;
    const container = document.getElementById("tasks-list");
    container.innerHTML = "";

    const query = (taskSearch.value || "").toLowerCase().trim();
    let filtered = state.tasks.slice();

    if (currentTaskFilter === "active") filtered = filtered.filter((t) => !t.completed);
    if (currentTaskFilter === "completed") filtered = filtered.filter((t) => t.completed);
    if (query) filtered = filtered.filter((t) => t.title.toLowerCase().includes(query));

    if (sortTasksByPriority) {
      filtered.sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        return (PRIORITY_WEIGHT[b.priority] || 0) - (PRIORITY_WEIGHT[a.priority] || 0);
      });
    }

    if (filtered.length === 0) {
      container.innerHTML = `<div class="card-surface p-8 text-center text-slate-500 text-xs">No tasks to display.</div>`;
      return;
    }

    filtered.forEach((task) => {
      const item = document.createElement("div");
      item.className = "card-surface p-4 sm:p-5 lg:p-5 flex items-center justify-between gap-3.5";

      let badgeStyle = "bg-slate-100 text-slate-600";
      if (task.priority === "High") badgeStyle = "bg-rose-50 text-rose-700 border border-rose-200";
      if (task.priority === "Medium") badgeStyle = "bg-amber-50 text-amber-700 border border-amber-200";

      item.innerHTML = `
        <div class="flex items-center space-x-3.5 flex-1 cursor-pointer task-row-tap">
          <button type="button" aria-label="Mark ${escapeHtml(task.title)} completed" aria-pressed="${task.completed ? "true" : "false"}" class="task-check-btn tap-target w-7 h-7 sm:w-6 sm:h-6 rounded-lg border flex items-center justify-center shrink-0 ${
            task.completed ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 hover:border-slate-500 bg-white"
          }">
            ${task.completed ? '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ""}
          </button>
          <div class="flex-1">
            <div class="text-xs sm:text-sm lg:text-base font-semibold text-slate-900 leading-snug ${task.completed ? "line-through text-slate-500" : ""}">
              ${escapeHtml(task.title)}
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-1.5">
              <span class="${badgeStyle} text-[10px] font-medium px-2 py-0.5 rounded-md">${escapeHtml(task.priority)}</span>
              ${
                !task.completed && task.deferredToDate && task.deferredToDate > getLocalDateKey()
                  ? '<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-medium px-2 py-0.5 rounded-md">Deferred to tomorrow</span>'
                  : ""
              }
            </div>
          </div>
        </div>
        <div class="flex items-center space-x-1 shrink-0">
          <button type="button" class="edit-task-btn tap-target w-8 h-8 rounded-lg text-slate-500 hover:text-slate-700 flex items-center justify-center" aria-label="Edit ${escapeHtml(task.title)}" title="Edit task">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button type="button" class="delete-task-btn tap-target w-8 h-8 rounded-lg text-slate-300 hover:text-rose-600 flex items-center justify-center" aria-label="Delete ${escapeHtml(task.title)}" title="Delete task">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      `;

      item.querySelector(".task-row-tap").addEventListener("click", () => {
        if (!assertWorkspaceWritable()) return;
        const prevCompleted = task.completed;
        task.completed = !task.completed;
        playSound(task.completed ? "success" : "tap");
        renderAll();
        saveStateWithToast(state, task.completed ? "Task completed" : null, () => {
          task.completed = prevCompleted;
        });
      });

      item.querySelector(".edit-task-btn").addEventListener("click", (e) => openTaskModal(task, e.currentTarget));

      item.querySelector(".delete-task-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable()) return;
        const originalIndex = state.tasks.findIndex((t) => t.id === task.id);
        if (originalIndex === -1) return;
        const deletedTaskClone = JSON.parse(JSON.stringify(state.tasks[originalIndex]));
        state.tasks.splice(originalIndex, 1);
        playSound("tap");
        saveStateWithUndo(state, "Task removed", () => {
          if (!state.tasks.some((t) => t.id === deletedTaskClone.id)) {
            const insertIdx = Math.min(originalIndex, state.tasks.length);
            state.tasks.splice(insertIdx, 0, deletedTaskClone);
          }
        });
        renderAll();
      });

      container.appendChild(item);
    });
  }

  function renderSkills() {
    if (!state) return;
    const container = document.getElementById("skills-list");
    container.innerHTML = "";

    if (state.skills.length === 0) {
      container.innerHTML = `<div class="card-surface p-8 text-center text-slate-500 text-xs">No active skills tracked. Tap "Add skill" to begin.</div>`;
      return;
    }

    state.skills.forEach((skill) => {
      const card = document.createElement("div");
      card.className = "card-surface p-4 sm:p-5 lg:p-6 space-y-4";
      const safeTarget = Math.max(1, sanitizeNumber(skill.targetHours, 30, 1, 50000));
      const safeCurrent = sanitizeNumber(skill.currentHours, 0, 0, 50000);
      const progressPct = Math.min(100, Math.round((safeCurrent / safeTarget) * 100));

      let milestonesHtml = "";
      (skill.milestones || []).forEach((m, mIdx) => {
        milestonesHtml += `
          <div class="flex items-center justify-between text-xs py-2 border-b border-slate-100 last:border-0 gap-2">
            <button type="button" class="milestone-toggle tap-target flex items-center space-x-3 text-left flex-1 py-0.5" data-m-idx="${mIdx}" aria-pressed="${m.done ? "true" : "false"}">
              <div class="w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${
                m.done ? "bg-slate-900 border-slate-900 text-white" : "border-slate-300 bg-white"
              }">
                ${m.done ? '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ""}
              </div>
              <span class="leading-snug ${m.done ? "line-through text-slate-500" : "text-slate-700 font-medium"}">${escapeHtml(m.title)}</span>
            </button>
            <button type="button" class="delete-milestone-btn tap-target w-7 h-7 rounded-lg text-slate-300 hover:text-rose-600 flex items-center justify-center shrink-0" data-m-idx="${mIdx}" aria-label="Remove milestone ${escapeHtml(m.title)}" title="Remove milestone">
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        `;
      });

      card.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <h4 class="font-bold text-slate-900 text-sm lg:text-base">${escapeHtml(skill.name)}</h4>
              <span class="text-[10px] bg-slate-100 text-slate-700 font-medium px-2 py-0.5 rounded-md">${escapeHtml(skill.category)}</span>
            </div>
            <p class="text-xs text-slate-500 mt-1">${escapeHtml(safeCurrent)} / ${escapeHtml(safeTarget)} hours logged</p>
          </div>
          <div class="flex items-center space-x-1 shrink-0">
            <button type="button" class="edit-skill-btn tap-target w-8 h-8 rounded-lg text-slate-500 hover:text-slate-700 flex items-center justify-center" aria-label="Edit ${escapeHtml(skill.name)}" title="Edit skill">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
            <button type="button" class="delete-skill-btn tap-target w-8 h-8 rounded-lg text-slate-300 hover:text-rose-600 flex items-center justify-center" aria-label="Delete ${escapeHtml(skill.name)}" title="Delete skill">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        <div class="space-y-1.5">
          <div class="flex justify-between text-xs font-medium text-slate-600">
            <span>Progress</span>
            <span>${escapeHtml(progressPct)}%</span>
          </div>
          <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
            <div class="bg-slate-900 h-2 rounded-full transition-all duration-500 ease-out" style="width: ${progressPct}%"></div>
          </div>
        </div>

        <div class="bg-slate-50 rounded-xl p-3.5 border border-slate-100">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold text-slate-600">Milestones</span>
            <button type="button" class="add-milestone-btn tap-target text-xs font-semibold text-indigo-600 hover:text-indigo-700 py-1 px-2 -mr-2 rounded-lg">+ Add milestone</button>
          </div>
          <div class="divide-y divide-slate-100">
            ${milestonesHtml || '<div class="text-xs text-slate-500 py-1.5">No milestones added yet.</div>'}
          </div>
        </div>

        <div class="flex items-center justify-between pt-1">
          <span class="text-xs text-slate-500 font-medium">Record session</span>
          <div class="flex items-center space-x-1.5">
            <button type="button" class="dec-half-btn tap-target h-9 border border-slate-200 hover:bg-slate-50 text-slate-600 font-semibold text-xs px-3 rounded-xl" ${safeCurrent <= 0 ? "disabled" : ""} aria-label="Subtract 0.5 hours from ${escapeHtml(skill.name)}">-0.5h</button>
            <button type="button" class="log-half-btn tap-target h-9 border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold text-xs px-3 rounded-xl" aria-label="Add 0.5 hours to ${escapeHtml(skill.name)}">+0.5h</button>
            <button type="button" class="log-hour-btn tap-target h-9 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs px-3.5 rounded-xl" aria-label="Add 1 hour to ${escapeHtml(skill.name)}">+1h</button>
          </div>
        </div>
      `;

      card.querySelectorAll(".milestone-toggle").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (!assertWorkspaceWritable()) return;
          const mIndex = parseInt(btn.dataset.mIdx, 10);
          if (!skill.milestones || !skill.milestones[mIndex]) return;
          const prevDone = skill.milestones[mIndex].done;
          skill.milestones[mIndex].done = !prevDone;
          playSound(skill.milestones[mIndex].done ? "success" : "tap");
          renderAll();
          saveStateWithToast(state, null, () => {
            if (skill.milestones && skill.milestones[mIndex]) {
              skill.milestones[mIndex].done = prevDone;
            }
          });
        });
      });

      // Phase 3 P1 Fix + Audit Fix 5: Milestone deletion wrapped in askConfirmation with operation-specific Undo
      card.querySelectorAll(".delete-milestone-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          if (!assertWorkspaceWritable()) return;
          const mIndex = parseInt(btn.dataset.mIdx, 10);
          if (!Array.isArray(skill.milestones) || mIndex < 0 || mIndex >= skill.milestones.length) return;
          const targetMilestone = skill.milestones[mIndex];
          askConfirmation(
            "Remove milestone?",
            `Remove "${targetMilestone.title}" from "${skill.name}"? You can undo this action immediately after.`,
            () => {
              if (!assertWorkspaceWritable()) return;
              if (!Array.isArray(skill.milestones) || mIndex < 0 || mIndex >= skill.milestones.length) return;
              const parentSkillId = skill.id;
              const deletedMilestoneClone = JSON.parse(JSON.stringify(skill.milestones[mIndex]));
              skill.milestones.splice(mIndex, 1);
              playSound("tap");
              saveStateWithUndo(state, "Milestone removed", () => {
                const targetSkill = state.skills.find((s) => s.id === parentSkillId);
                if (targetSkill) {
                  if (!Array.isArray(targetSkill.milestones)) targetSkill.milestones = [];
                  const insertIdx = Math.min(mIndex, targetSkill.milestones.length);
                  targetSkill.milestones.splice(insertIdx, 0, deletedMilestoneClone);
                }
              });
              renderAll();
            },
            e.currentTarget
          );
        });
      });

      card.querySelector(".add-milestone-btn").addEventListener("click", (e) => {
        if (!assertWorkspaceWritable()) return;
        lastFocusedTrigger = e.currentTarget;
        targetSkillForMilestone = skill;
        const input = document.getElementById("input-milestone-title");
        input.value = "";
        openAccessibleModal(milestoneModal, input);
        playSound("tap");
      });

      card.querySelector(".dec-half-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable()) return;
        if (safeCurrent <= 0) return;
        const prevHours = skill.currentHours;
        skill.currentHours = Math.max(0, Math.round((safeCurrent - 0.5) * 100) / 100);
        playSound("tap");
        renderAll();
        saveStateWithToast(state, `-0.5h adjusted in ${skill.name}`, () => {
          skill.currentHours = prevHours;
        });
      });

      card.querySelector(".log-half-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable()) return;
        const prevHours = skill.currentHours;
        skill.currentHours = Math.round((safeCurrent + 0.5) * 100) / 100;
        playSound("success");
        renderAll();
        saveStateWithToast(state, `+0.5h logged in ${skill.name}`, () => {
          skill.currentHours = prevHours;
        });
      });

      card.querySelector(".log-hour-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable()) return;
        const prevHours = skill.currentHours;
        skill.currentHours = Math.round((safeCurrent + 1) * 100) / 100;
        playSound("success");
        renderAll();
        saveStateWithToast(state, `+1h logged in ${skill.name}`, () => {
          skill.currentHours = prevHours;
        });
      });

      card.querySelector(".edit-skill-btn").addEventListener("click", (e) => openSkillModal(skill, e.currentTarget));

      card.querySelector(".delete-skill-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable()) return;
        const originalIndex = state.skills.findIndex((s) => s.id === skill.id);
        if (originalIndex === -1) return;
        const deletedSkillClone = JSON.parse(JSON.stringify(state.skills[originalIndex]));
        state.skills.splice(originalIndex, 1);
        playSound("tap");
        saveStateWithUndo(state, "Skill removed", () => {
          if (!state.skills.some((s) => s.id === deletedSkillClone.id)) {
            const insertIdx = Math.min(originalIndex, state.skills.length);
            state.skills.splice(insertIdx, 0, deletedSkillClone);
          }
        });
        renderAll();
      });

      container.appendChild(card);
    });
  }

  function renderNotes() {
    if (!state) return;
    const container = document.getElementById("notes-list");
    container.innerHTML = "";

    const notes = state.notes || [];
    const query = (noteSearch.value || "").toLowerCase().trim();
    const filtered = query
      ? notes.filter(
          (n) =>
            (n.title || "").toLowerCase().includes(query) ||
            (n.body || "").toLowerCase().includes(query)
        )
      : notes;

    if (filtered.length === 0) {
      container.innerHTML = `<div class="col-span-full card-surface p-8 text-center text-slate-500 text-xs">No notes saved yet. Tap "New note" to record observations or study notes.</div>`;
      return;
    }

    filtered.forEach((note) => {
      const card = document.createElement("div");
      card.className = "card-surface p-4 sm:p-5 lg:p-6 flex flex-col justify-between space-y-3.5 hover:border-slate-300 select-text";

      card.innerHTML = `
        <div class="space-y-1.5">
          <div class="flex items-start justify-between gap-2">
            <h4 class="font-bold text-slate-900 text-xs sm:text-sm lg:text-base leading-snug cursor-pointer edit-note-trigger flex-1 select-text">${escapeHtml(note.title)}</h4>
            <button type="button" class="delete-note-btn tap-target w-7 h-7 rounded-lg text-slate-300 hover:text-rose-600 flex items-center justify-center shrink-0" aria-label="Delete note ${escapeHtml(note.title)}" title="Delete note">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <p class="text-xs text-slate-600 leading-relaxed whitespace-pre-line cursor-pointer edit-note-body select-text">${escapeHtml(note.body)}</p>
        </div>
        <div class="flex items-center justify-between pt-2.5 border-t border-slate-100 text-[10px] text-slate-500">
          <span class="bg-slate-100 text-slate-600 font-medium px-2 py-0.5 rounded-md">${escapeHtml(note.category || "Lab & study")}</span>
          <span>${escapeHtml(note.updatedAt || "Saved")}</span>
        </div>
      `;

      const openEdit = (e) => {
        const selection = window.getSelection && window.getSelection().toString();
        if (selection && selection.length > 0) return;
        if (!assertWorkspaceWritable()) return;

        lastFocusedTrigger = e.currentTarget;
        editingNoteId = note.id;
        document.getElementById("modal-note-heading").textContent = "Edit note";
        const titleInput = document.getElementById("modal-note-title");
        titleInput.value = note.title || "";
        setActivePillValue(
          ".note-cat-btn",
          "modal-note-cat",
          sanitizeCategory(note.category, ALLOWED_NOTE_CATEGORIES, "Lab & study")
        );
        document.getElementById("modal-note-body").value = note.body || "";
        openAccessibleModal(noteModal, titleInput);
        playSound("tap");
      };

      card.querySelector(".edit-note-trigger").addEventListener("click", openEdit);
      card.querySelector(".edit-note-body").addEventListener("click", openEdit);

      card.querySelector(".delete-note-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable()) return;
        const originalIndex = state.notes.findIndex((n) => n.id === note.id);
        if (originalIndex === -1) return;
        const deletedNoteClone = JSON.parse(JSON.stringify(state.notes[originalIndex]));
        state.notes.splice(originalIndex, 1);
        playSound("tap");
        saveStateWithUndo(state, "Note removed", () => {
          if (!state.notes.some((n) => n.id === deletedNoteClone.id)) {
            const insertIdx = Math.min(originalIndex, state.notes.length);
            state.notes.splice(insertIdx, 0, deletedNoteClone);
          }
        });
        renderAll();
      });

      container.appendChild(card);
    });
  }

  // --------------------------------------------------------------------------
  // Phase 5: The Daily Briefing Launchpad (Morning / Evening Ritual)
  // --------------------------------------------------------------------------
  const BRIEFING_DISMISSED_KEY = "pulse_briefing_dismissed_date_v1";
  let isBriefingCollapsing = false;
  let hasBriefingEnteredOnce = false;

  function isBriefingDismissedToday() {
    try {
      return localStorage.getItem(BRIEFING_DISMISSED_KEY) === getLocalDateKey();
    } catch (e) {
      return false;
    }
  }

  function markBriefingDismissedToday() {
    try {
      localStorage.setItem(BRIEFING_DISMISSED_KEY, getLocalDateKey());
    } catch (e) {}
  }

  function getBriefingGreetingText() {
    const hr = new Date().getHours();
    if (hr < 12) return "Good morning. What matters today?";
    if (hr < 17) return "Good afternoon. What matters today?";
    return "Good evening. What matters today?";
  }

  function curateDailyBriefingItems() {
    if (!state) return [];
    const pendingTasks = (state.tasks || [])
      .filter((t) => !t.completed)
      .slice()
      .sort((a, b) => (PRIORITY_WEIGHT[b.priority] || 0) - (PRIORITY_WEIGHT[a.priority] || 0))
      .map((t) => ({
        kind: "task",
        id: t.id,
        title: t.title,
        meta: `${t.priority} priority`
      }));

    const pendingHabits = (state.habits || [])
      .filter((h) => !h.doneToday)
      .slice()
      .sort((a, b) => (b.totalStreak || 0) - (a.totalStreak || 0))
      .map((h) => ({
        kind: "habit",
        id: h.id,
        title: h.name,
        meta: `${h.totalStreak || 0}d streak · ${h.category || "Routine"}`
      }));

    // Curate up to 3 top items combining high-priority incomplete tasks and uncompleted habits
    const combined = [];
    let tIdx = 0;
    let hIdx = 0;
    while (combined.length < 3 && (tIdx < pendingTasks.length || hIdx < pendingHabits.length)) {
      if (tIdx < pendingTasks.length && (combined.length < 2 || hIdx >= pendingHabits.length)) {
        combined.push(pendingTasks[tIdx++]);
      } else if (hIdx < pendingHabits.length) {
        combined.push(pendingHabits[hIdx++]);
      }
    }
    return combined;
  }

  function collapseBriefingCardForToday() {
    const card = document.getElementById("daily-briefing-card");
    markBriefingDismissedToday();
    if (!card || card.classList.contains("hidden")) return;
    isBriefingCollapsing = true;
    card.classList.add("briefing-collapsing");
    setTimeout(() => {
      card.classList.add("hidden");
      card.classList.remove("briefing-collapsing");
      isBriefingCollapsing = false;
    }, 360);
  }

  function startFocusFromBriefingItem(kind, itemId) {
    if (!isAppHydrated || !state) return;
    focusLinkedType = kind;
    focusLinkedId = itemId;
    isFocusMinimized = false;
    populateFocusTargetDropdown();
    switchView("focus");

    const presetMins = parseInt(selectTimerPreset.value, 10) || 25;
    if (timerSeconds <= 0) {
      timerSeconds = presetMins * 60;
    }
    if (!timerRunning) {
      toggleTimer();
    } else {
      syncFocusModeUI();
      persistTimerState();
    }
  }

  function renderDailyBriefing() {
    const card = document.getElementById("daily-briefing-card");
    const listEl = document.getElementById("daily-briefing-list");
    const headingEl = document.getElementById("briefing-heading");
    if (!card || !listEl || !state) return;
    if (isBriefingCollapsing) return;

    const currentHour = new Date().getHours();
    const isMorningWindow = currentHour < 12;

    if (headingEl) {
      headingEl.textContent = "Good morning. What matters today?";
    }

    // Phase 8 Requirement 1: Strictly hide Daily Briefing if local time is 12:00 PM (Noon) or later
    if (timerRunning || !isMorningWindow || isBriefingDismissedToday()) {
      card.classList.add("hidden");
      return;
    }

    const curated = curateDailyBriefingItems();
    if (curated.length === 0) {
      card.classList.add("hidden");
      return;
    }

    const wasHidden = card.classList.contains("hidden");
    card.classList.remove("hidden", "briefing-collapsing");
    if (wasHidden && !hasBriefingEnteredOnce) {
      hasBriefingEnteredOnce = true;
      card.classList.remove("briefing-gentle-enter");
      void card.offsetWidth;
      card.classList.add("briefing-gentle-enter");
    }
    listEl.innerHTML = "";

    curated.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "py-2.5 flex items-center justify-between gap-3";

      const badgeLabel = entry.kind === "task" ? "Task" : "Habit";
      row.innerHTML = `
        <div class="flex items-center space-x-3 min-w-0 flex-1">
          <button type="button" class="briefing-done-btn tap-target w-6 h-6 rounded-lg border border-slate-300 hover:border-slate-900 bg-white flex items-center justify-center shrink-0 transition-colors" aria-label="Mark ${escapeHtml(entry.title)} done" title="Mark done">
            <svg class="w-3.5 h-3.5 text-slate-300 hover:text-slate-900" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
          <div class="min-w-0 flex-1">
            <div class="text-xs sm:text-sm font-semibold text-slate-900 truncate">${escapeHtml(entry.title)}</div>
            <div class="flex items-center gap-1.5 mt-0.5">
              <span class="text-[10px] font-semibold bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded">${badgeLabel}</span>
              <span class="text-[11px] text-slate-500 truncate">${escapeHtml(entry.meta)}</span>
            </div>
          </div>
        </div>
        <button type="button" class="briefing-focus-btn tap-target h-8 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-semibold flex items-center gap-1.5 shrink-0">
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span>Start focus</span>
        </button>
      `;

      row.querySelector(".briefing-done-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable()) return;
        if (entry.kind === "task") {
          const targetTask = state.tasks.find((t) => t.id === entry.id);
          if (!targetTask) return;
          targetTask.completed = true;
          playSound("success");
          saveStateWithUndo(state, `Task "${targetTask.title}" completed`, () => {
            const revertTask = state.tasks.find((t) => t.id === entry.id);
            if (revertTask) revertTask.completed = false;
          });
        } else {
          const targetHabit = state.habits.find((h) => h.id === entry.id);
          if (!targetHabit) return;
          ensureHabitFields(targetHabit);
          const prevHistory = targetHabit.history.slice();
          const prevStreak = targetHabit.totalStreak;
          const prevDone = targetHabit.doneToday;
          toggleHabitToday(targetHabit);
          playSound("success");
          saveStateWithToast(state, getHabitCompletionToastMessage(targetHabit), () => {
            targetHabit.history = prevHistory;
            targetHabit.totalStreak = prevStreak;
            targetHabit.streak = prevStreak;
            targetHabit.doneToday = prevDone;
          });
        }

        const remainingItems = curateDailyBriefingItems();
        if (remainingItems.length === 0) {
          collapseBriefingCardForToday();
        }
        renderAll();
      });

      row.querySelector(".briefing-focus-btn").addEventListener("click", () => {
        startFocusFromBriefingItem(entry.kind, entry.id);
      });

      listEl.appendChild(row);
    });
  }

  // --------------------------------------------------------------------------
  // Phase 6: The Evening Close-out & Carry Forward (Night Ritual)
  // --------------------------------------------------------------------------
  const CLOSEOUT_STORAGE_KEY = "pulse_evening_closeout_v1";
  let isCloseoutCollapsing = false;

  function getEveningCloseoutTasks() {
    if (!state || !Array.isArray(state.tasks)) return [];
    const todayKey = getLocalDateKey();
    return state.tasks
      .filter((t) => !t.completed && (!t.deferredToDate || t.deferredToDate <= todayKey))
      .slice()
      .sort((a, b) => (PRIORITY_WEIGHT[b.priority] || 0) - (PRIORITY_WEIGHT[a.priority] || 0));
  }

  function isEveningCloseoutDismissedForCurrentTasks(remainingTasks) {
    try {
      const raw = localStorage.getItem(CLOSEOUT_STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.date !== getLocalDateKey()) return false;
      if (Array.isArray(parsed.taskIds)) {
        const dismissedIds = new Set(parsed.taskIds.map(String));
        return remainingTasks.every((t) => dismissedIds.has(String(t.id)));
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function persistEveningCloseoutDismissed() {
    try {
      const remaining = getEveningCloseoutTasks();
      localStorage.setItem(
        CLOSEOUT_STORAGE_KEY,
        JSON.stringify({
          date: getLocalDateKey(),
          taskIds: remaining.map((t) => String(t.id))
        })
      );
    } catch (e) {}
  }

  function collapseEveningCloseoutCard() {
    const card = document.getElementById("evening-closeout-card");
    persistEveningCloseoutDismissed();
    if (!card || card.classList.contains("hidden")) return;
    isCloseoutCollapsing = true;
    card.classList.add("briefing-collapsing");
    setTimeout(() => {
      card.classList.add("hidden");
      card.classList.remove("briefing-collapsing");
      isCloseoutCollapsing = false;
    }, 360);
  }

  function renderEveningCloseout() {
    const card = document.getElementById("evening-closeout-card");
    const listEl = document.getElementById("evening-closeout-list");
    const headingEl = document.getElementById("closeout-heading");
    if (!card || !listEl || !state) return;
    if (isCloseoutCollapsing) return;

    const currentHour = new Date().getHours();
    const isEveningWindow = currentHour >= 18;
    const remainingTasks = getEveningCloseoutTasks();

    if (
      timerRunning ||
      !isEveningWindow ||
      remainingTasks.length === 0 ||
      isEveningCloseoutDismissedForCurrentTasks(remainingTasks)
    ) {
      card.classList.add("hidden");
      return;
    }

    const count = remainingTasks.length;
    if (headingEl) {
      headingEl.textContent = `Let's close today. You have ${count} ${count === 1 ? "task" : "tasks"} remaining.`;
    }

    card.classList.remove("hidden", "briefing-collapsing");
    listEl.innerHTML = "";

    remainingTasks.forEach((task) => {
      const row = document.createElement("div");
      row.className = "py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5";

      let prioBadge = "bg-slate-100 text-slate-600";
      if (task.priority === "High") prioBadge = "bg-rose-50 text-rose-700 border border-rose-200";
      if (task.priority === "Medium") prioBadge = "bg-amber-50 text-amber-700 border border-amber-200";

      row.innerHTML = `
        <div class="min-w-0 flex-1">
          <div class="text-xs sm:text-sm font-semibold text-slate-900 truncate">${escapeHtml(task.title)}</div>
          <div class="mt-1 flex items-center gap-1.5">
            <span class="${prioBadge} text-[10px] font-medium px-2 py-0.5 rounded-md">${escapeHtml(task.priority)}</span>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" class="closeout-finish-btn tap-target h-8 px-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-semibold transition-colors" aria-label="Finish ${escapeHtml(task.title)} now">
            Finish now
          </button>
          <button type="button" class="closeout-tomorrow-btn tap-target h-8 px-2.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-[11px] font-semibold transition-colors" aria-label="Carry ${escapeHtml(task.title)} forward to tomorrow">
            Tomorrow
          </button>
          <button type="button" class="closeout-drop-btn tap-target h-8 px-2.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-[11px] font-semibold transition-colors" aria-label="Drop ${escapeHtml(task.title)}">
            Drop
          </button>
        </div>
      `;

      row.querySelector(".closeout-finish-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable()) return;
        const liveTask = state.tasks.find((t) => t.id === task.id);
        if (!liveTask) return;
        const prevDeferred = liveTask.deferredToDate || null;
        liveTask.completed = true;
        liveTask.deferredToDate = null;
        playSound("success");
        saveStateWithUndo(state, `Task "${liveTask.title}" completed`, () => {
          const revertTask = state.tasks.find((t) => t.id === task.id);
          if (revertTask) {
            revertTask.completed = false;
            revertTask.deferredToDate = prevDeferred;
          }
        });
        if (getEveningCloseoutTasks().length === 0) {
          collapseEveningCloseoutCard();
        }
        renderAll();
      });

      row.querySelector(".closeout-tomorrow-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable()) return;
        const liveTask = state.tasks.find((t) => t.id === task.id);
        if (!liveTask) return;
        const prevDeferred = liveTask.deferredToDate || null;
        liveTask.deferredToDate = getTomorrowDateKey();
        playSound("tap");
        saveStateWithUndo(state, `"${liveTask.title}" deferred to tomorrow`, () => {
          const revertTask = state.tasks.find((t) => t.id === task.id);
          if (revertTask) {
            revertTask.deferredToDate = prevDeferred;
          }
        });
        if (getEveningCloseoutTasks().length === 0) {
          collapseEveningCloseoutCard();
        }
        renderAll();
      });

      row.querySelector(".closeout-drop-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable()) return;
        const originalIndex = state.tasks.findIndex((t) => t.id === task.id);
        if (originalIndex === -1) return;
        const deletedTaskClone = JSON.parse(JSON.stringify(state.tasks[originalIndex]));
        state.tasks.splice(originalIndex, 1);
        playSound("tap");
        saveStateWithUndo(state, `Task "${deletedTaskClone.title}" dropped`, () => {
          if (!state.tasks.some((t) => t.id === deletedTaskClone.id)) {
            const insertIdx = Math.min(originalIndex, state.tasks.length);
            state.tasks.splice(insertIdx, 0, deletedTaskClone);
          }
        });
        if (getEveningCloseoutTasks().length === 0) {
          collapseEveningCloseoutCard();
        }
        renderAll();
      });

      listEl.appendChild(row);
    });
  }

  function renderDashboard() {
    if (!state) return;
    populateFocusTargetDropdown();
    syncFocusModeUI();
    renderDailyBriefing();
    renderEveningCloseout();
    const habitsDone = state.habits.filter((h) => h.doneToday).length;
    document.getElementById("stat-habits").textContent = `${habitsDone}/${state.habits.length}`;

    const openTasks = state.tasks.filter((t) => !t.completed).length;
    document.getElementById("stat-tasks").textContent = openTasks;

    const totalHours =
      Math.round(state.skills.reduce((acc, s) => acc + sanitizeNumber(s.currentHours, 0), 0) * 100) / 100;
    document.getElementById("stat-hours").textContent = `${totalHours}h`;

    const totalNotes = (state.notes || []).length;
    document.getElementById("stat-notes").textContent = totalNotes;

    const dHabits = document.getElementById("dash-habits-container");
    dHabits.innerHTML = "";
    if (state.habits.length === 0) {
      dHabits.innerHTML = `<div class="text-xs text-slate-500 py-2">No habits added yet.</div>`;
    } else {
      state.habits.slice(0, 3).forEach((h) => {
        ensureHabitFields(h);
        const momentum = analyzeHabitMomentum(h);
        let miniStripHtml = `<div class="mini-momentum-strip" aria-hidden="true">`;
        momentum.slotStates.forEach((st, idx) => {
          const hPx = st === "done" ? Math.max(6, Math.round((momentum.densityRatios[idx] / 100) * 14)) : st === "grace" ? 11 : 4;
          const colorCls =
            st === "done"
              ? momentum.densityRatios[idx] >= 75
                ? "bg-slate-900"
                : "bg-slate-600"
              : st === "grace"
                ? "bg-amber-500"
                : "bg-slate-200";
          miniStripHtml += `<span class="mini-momentum-bar ${colorCls}" style="height: ${hPx}px"></span>`;
        });
        miniStripHtml += `</div>`;

        const row = document.createElement("button");
        row.type = "button";
        row.className = "tap-target w-full flex items-center justify-between text-xs py-2.5 text-left gap-3";
        row.innerHTML = `
          <div class="flex items-center space-x-3 min-w-0">
            <div class="w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${
              h.doneToday ? "bg-slate-900 border-slate-900 text-white" : "border-slate-300 bg-white"
            }">
              ${h.doneToday ? '<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ""}
            </div>
            <span class="truncate ${h.doneToday ? "line-through text-slate-500" : "text-slate-800 font-medium"}">${escapeHtml(h.name)}</span>
          </div>
          <div class="flex items-center space-x-2 shrink-0">
            ${miniStripHtml}
            <span class="text-[11px] ${h.doneToday ? "text-slate-900 font-semibold" : "text-slate-500"}">${escapeHtml(h.totalStreak)}d</span>
          </div>
        `;
        row.addEventListener("click", () => {
          if (!assertWorkspaceWritable()) return;
          ensureHabitFields(h);
          const prevHistory = h.history.slice();
          const prevStreak = h.totalStreak;
          const prevDone = h.doneToday;
          const isNowDone = toggleHabitToday(h);
          playSound(isNowDone ? "success" : "tap");
          renderAll();
          saveStateWithToast(state, isNowDone ? getHabitCompletionToastMessage(h) : null, () => {
            h.history = prevHistory;
            h.totalStreak = prevStreak;
            h.streak = prevStreak;
            h.doneToday = prevDone;
          });
        });
        dHabits.appendChild(row);
      });
    }

    const dTasks = document.getElementById("dash-tasks-container");
    dTasks.innerHTML = "";
    const pendingTasks = state.tasks.filter((t) => !t.completed).slice(0, 3);
    if (pendingTasks.length === 0) {
      dTasks.innerHTML = `<div class="text-xs text-slate-500 py-2">No pending tasks.</div>`;
    } else {
      pendingTasks.forEach((t) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tap-target w-full flex items-center justify-between text-xs py-2.5 text-left gap-3";
        row.innerHTML = `
          <div class="flex items-center space-x-3 min-w-0">
            <div class="w-5 h-5 rounded-md border border-slate-300 bg-white flex items-center justify-center shrink-0"></div>
            <span class="text-slate-800 font-medium truncate">${escapeHtml(t.title)}</span>
          </div>
          <span class="text-[10px] font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md shrink-0">${escapeHtml(t.priority)}</span>
        `;
        row.addEventListener("click", () => {
          if (!assertWorkspaceWritable()) return;
          const prevCompleted = t.completed;
          t.completed = true;
          playSound("success");
          renderAll();
          saveStateWithToast(state, "Task completed", () => {
            t.completed = prevCompleted;
          });
        });
        dTasks.appendChild(row);
      });
    }

    const dSkills = document.getElementById("dash-skills-container");
    dSkills.innerHTML = "";
    if (state.skills.length === 0) {
      dSkills.innerHTML = `<div class="text-xs text-slate-500 py-1">No skills tracked yet.</div>`;
    } else {
      state.skills.slice(0, 3).forEach((s) => {
        const safeTarget = Math.max(1, sanitizeNumber(s.targetHours, 30, 1, 50000));
        const safeCurrent = sanitizeNumber(s.currentHours, 0, 0, 50000);
        const pct = Math.min(100, Math.round((safeCurrent / safeTarget) * 100));
        const row = document.createElement("div");
        row.className = "space-y-1.5";
        row.innerHTML = `
          <div class="flex justify-between text-xs gap-2">
            <span class="font-medium text-slate-800 truncate">${escapeHtml(s.name)}</span>
            <span class="text-slate-500 text-[11px] shrink-0">${escapeHtml(safeCurrent)}/${escapeHtml(safeTarget)}h (${escapeHtml(pct)}%)</span>
          </div>
          <div class="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
            <div class="bg-slate-900 h-1.5 rounded-full transition-all duration-500 ease-out" style="width: ${pct}%"></div>
          </div>
        `;
        dSkills.appendChild(row);
      });
    }

    const dNotes = document.getElementById("dash-notes-container");
    dNotes.innerHTML = "";
    const recentNotes = (state.notes || []).slice(0, 2);
    if (recentNotes.length === 0) {
      dNotes.innerHTML = `<div class="text-xs text-slate-500 py-2">No notes saved yet.</div>`;
    } else {
      recentNotes.forEach((n) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tap-target w-full text-left py-2 block";
        row.innerHTML = `
          <div class="text-xs font-semibold text-slate-800 truncate">${escapeHtml(n.title)}</div>
          <div class="text-[11px] text-slate-500 truncate mt-0.5">${escapeHtml(n.body)}</div>
        `;
        row.addEventListener("click", () => switchView("notes"));
        dNotes.appendChild(row);
      });
    }
  }

  // --------------------------------------------------------------------------
  // Phase 8: Quick Capture Inbox & Frictionless Triage with Operation-Specific Undo
  // --------------------------------------------------------------------------
  function captureQuickThought(rawText) {
    if (!assertWorkspaceWritable() || !state) return false;
    const cleanedText = sanitizeText(rawText, "", 240);
    if (!cleanedText) return false;
    if (!Array.isArray(state.inbox)) state.inbox = [];

    const newItem = {
      id: generateUniqueId(),
      text: cleanedText,
      createdAt: getLocalDateKey()
    };
    state.inbox.unshift(newItem);
    playSound("tap");
    saveStateWithUndo(state, "Captured to Inbox", () => {
      if (Array.isArray(state.inbox)) {
        const idx = state.inbox.findIndex((i) => i.id === newItem.id);
        if (idx !== -1) state.inbox.splice(idx, 1);
      }
    });
    renderAll();
    return true;
  }

  function renderInboxTargetList(containerEl, listEl, countEl) {
    if (!containerEl || !listEl || !state) return;
    const inboxItems = Array.isArray(state.inbox) ? state.inbox : [];

    if (inboxItems.length === 0) {
      containerEl.classList.add("hidden");
      listEl.innerHTML = "";
      if (countEl) countEl.textContent = "0";
      return;
    }

    containerEl.classList.remove("hidden");
    if (countEl) countEl.textContent = String(inboxItems.length);
    listEl.innerHTML = "";

    inboxItems.forEach((item) => {
      const row = document.createElement("div");
      row.className = "py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2";

      row.innerHTML = `
        <div class="text-xs sm:text-sm font-medium text-slate-800 truncate flex-1">${escapeHtml(item.text)}</div>
        <div class="flex flex-wrap items-center gap-1.5 shrink-0">
          <button type="button" class="inbox-make-task-btn tap-target h-7 px-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-semibold transition-colors" aria-label="Convert ${escapeHtml(item.text)} to task">
            Make task
          </button>
          <button type="button" class="inbox-make-habit-btn tap-target h-7 px-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[11px] font-semibold transition-colors" aria-label="Convert ${escapeHtml(item.text)} to habit">
            Make habit
          </button>
          <button type="button" class="inbox-make-skill-btn tap-target h-7 px-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[11px] font-semibold transition-colors" aria-label="Convert ${escapeHtml(item.text)} to new skill">
            New skill
          </button>
          <button type="button" class="inbox-make-note-btn tap-target h-7 px-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[11px] font-semibold transition-colors" aria-label="Convert ${escapeHtml(item.text)} to note">
            Make note
          </button>
          <button type="button" class="inbox-delete-btn tap-target w-7 h-7 rounded-lg text-slate-300 hover:text-rose-600 flex items-center justify-center transition-colors" aria-label="Delete inbox item ${escapeHtml(item.text)}" title="Remove">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      `;

      // 1-Tap "Make task" -> moves item to state.tasks with Medium priority + Operation-Specific Undo
      row.querySelector(".inbox-make-task-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable() || !Array.isArray(state.inbox)) return;
        const originalIndex = state.inbox.findIndex((i) => i.id === item.id);
        if (originalIndex === -1) return;
        const removedInboxClone = JSON.parse(JSON.stringify(state.inbox[originalIndex]));
        state.inbox.splice(originalIndex, 1);

        const createdTask = {
          id: generateUniqueId(),
          title: removedInboxClone.text,
          priority: "Medium",
          completed: false,
          deferredToDate: null
        };
        state.tasks.push(createdTask);
        playSound("success");

        saveStateWithUndo(state, `Moved "${createdTask.title}" to Tasks`, () => {
          const tIdx = state.tasks.findIndex((t) => t.id === createdTask.id);
          if (tIdx !== -1) state.tasks.splice(tIdx, 1);
          if (!Array.isArray(state.inbox)) state.inbox = [];
          if (!state.inbox.some((i) => i.id === removedInboxClone.id)) {
            const insertIdx = Math.min(originalIndex, state.inbox.length);
            state.inbox.splice(insertIdx, 0, removedInboxClone);
          }
        });
        renderAll();
      });

      // 1-Tap "Make habit" -> moves item to state.habits + Operation-Specific Undo
      row.querySelector(".inbox-make-habit-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable() || !Array.isArray(state.inbox)) return;
        const originalIndex = state.inbox.findIndex((i) => i.id === item.id);
        if (originalIndex === -1) return;
        const removedInboxClone = JSON.parse(JSON.stringify(state.inbox[originalIndex]));
        state.inbox.splice(originalIndex, 1);

        const createdHabit = {
          id: generateUniqueId(),
          name: removedInboxClone.text.slice(0, 140) || "Untitled habit",
          category: "Routine",
          streak: 0,
          totalStreak: 0,
          history: [false, false, false, false, false, false, false],
          doneToday: false
        };
        state.habits.push(createdHabit);
        playSound("success");

        saveStateWithUndo(state, `Moved "${createdHabit.name}" to Habits`, () => {
          const hIdx = state.habits.findIndex((h) => h.id === createdHabit.id);
          if (hIdx !== -1) state.habits.splice(hIdx, 1);
          if (!Array.isArray(state.inbox)) state.inbox = [];
          if (!state.inbox.some((i) => i.id === removedInboxClone.id)) {
            const insertIdx = Math.min(originalIndex, state.inbox.length);
            state.inbox.splice(insertIdx, 0, removedInboxClone);
          }
        });
        renderAll();
      });

      // 1-Tap "New skill" -> moves item to state.skills + Operation-Specific Undo
      row.querySelector(".inbox-make-skill-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable() || !Array.isArray(state.inbox)) return;
        const originalIndex = state.inbox.findIndex((i) => i.id === item.id);
        if (originalIndex === -1) return;
        const removedInboxClone = JSON.parse(JSON.stringify(state.inbox[originalIndex]));
        state.inbox.splice(originalIndex, 1);

        const createdSkill = {
          id: generateUniqueId(),
          name: removedInboxClone.text.slice(0, 140) || "Untitled skill",
          category: "General",
          currentHours: 0,
          targetHours: 30,
          milestones: []
        };
        state.skills.push(createdSkill);
        playSound("success");

        saveStateWithUndo(state, `Created skill "${createdSkill.name}"`, () => {
          const sIdx = state.skills.findIndex((s) => s.id === createdSkill.id);
          if (sIdx !== -1) state.skills.splice(sIdx, 1);
          if (!Array.isArray(state.inbox)) state.inbox = [];
          if (!state.inbox.some((i) => i.id === removedInboxClone.id)) {
            const insertIdx = Math.min(originalIndex, state.inbox.length);
            state.inbox.splice(insertIdx, 0, removedInboxClone);
          }
        });
        renderAll();
      });

      // 1-Tap "Make note" -> moves item to state.notes + Operation-Specific Undo
      row.querySelector(".inbox-make-note-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable() || !Array.isArray(state.inbox)) return;
        const originalIndex = state.inbox.findIndex((i) => i.id === item.id);
        if (originalIndex === -1) return;
        const removedInboxClone = JSON.parse(JSON.stringify(state.inbox[originalIndex]));
        state.inbox.splice(originalIndex, 1);

        if (!Array.isArray(state.notes)) state.notes = [];
        const createdNote = {
          id: generateUniqueId(),
          title: removedInboxClone.text.slice(0, 80) || "Quick note",
          category: "Ideas",
          body: removedInboxClone.text,
          updatedAt: getLocalDateKey()
        };
        state.notes.unshift(createdNote);
        playSound("success");

        saveStateWithUndo(state, `Moved "${createdNote.title}" to Notes`, () => {
          const nIdx = state.notes.findIndex((n) => n.id === createdNote.id);
          if (nIdx !== -1) state.notes.splice(nIdx, 1);
          if (!Array.isArray(state.inbox)) state.inbox = [];
          if (!state.inbox.some((i) => i.id === removedInboxClone.id)) {
            const insertIdx = Math.min(originalIndex, state.inbox.length);
            state.inbox.splice(insertIdx, 0, removedInboxClone);
          }
        });
        renderAll();
      });

      // 1-Tap Delete -> removes item from state.inbox + Operation-Specific Undo
      row.querySelector(".inbox-delete-btn").addEventListener("click", () => {
        if (!assertWorkspaceWritable() || !Array.isArray(state.inbox)) return;
        const originalIndex = state.inbox.findIndex((i) => i.id === item.id);
        if (originalIndex === -1) return;
        const removedInboxClone = JSON.parse(JSON.stringify(state.inbox[originalIndex]));
        state.inbox.splice(originalIndex, 1);
        playSound("tap");

        saveStateWithUndo(state, "Inbox item removed", () => {
          if (!Array.isArray(state.inbox)) state.inbox = [];
          if (!state.inbox.some((i) => i.id === removedInboxClone.id)) {
            const insertIdx = Math.min(originalIndex, state.inbox.length);
            state.inbox.splice(insertIdx, 0, removedInboxClone);
          }
        });
        renderAll();
      });

      listEl.appendChild(row);
    });
  }

  function renderQuickCaptureInbox() {
    renderInboxTargetList(
      document.getElementById("dash-inbox-container"),
      document.getElementById("dash-inbox-list"),
      document.getElementById("dash-inbox-count")
    );
    renderInboxTargetList(
      document.getElementById("tasks-inbox-container"),
      document.getElementById("tasks-inbox-list"),
      document.getElementById("tasks-inbox-count")
    );
  }

  function renderAll() {
    if (!isAppHydrated || !state) return;
    renderQuickCaptureInbox();
    renderDashboard();
    renderHabits();
    renderTasks();
    renderSkills();
    renderNotes();
    if (isReadOnlyMode) {
      enforceReadOnlyModeUI();
    }
  }

  function getCleanUrlForView(viewName) {
    const target = tabList.includes(viewName) ? viewName : "dashboard";
    if (typeof window === "undefined" || !window.location) return `/${target}`;
    if (window.location.protocol === "file:") return window.location.pathname;

    try {
      const rawPath = (window.location.pathname || "/").replace(/\/index\.html$/i, "/");
      const tabRegex = new RegExp(`/(${tabList.join("|")})/?$`);
      const basePath = rawPath.replace(tabRegex, "").replace(/\/$/, "");
      return `${basePath}/${target}`;
    } catch (e) {
      return `/${target}`;
    }
  }

  function parseViewFromLocation() {
    if (typeof window === "undefined" || !window.location) return "dashboard";

    if (window.history && window.history.state && tabList.includes(window.history.state.view)) {
      return window.history.state.view;
    }

    try {
      const pathSegments = (window.location.pathname || "").split("/").filter(Boolean);
      const lastSegment = pathSegments[pathSegments.length - 1];
      if (tabList.includes(lastSegment)) {
        return lastSegment;
      }
    } catch (e) {}

    try {
      const hashView = (window.location.hash || "").replace(/^#/, "");
      if (tabList.includes(hashView)) {
        return hashView;
      }
    } catch (e) {}

    return "dashboard";
  }

  // View Navigation with Clean History API Paths (No Hash Fragments)

  function switchView(target, options = { pushHistory: true, silent: false }) {
    if (!isAppHydrated) return;
    const validTarget = tabList.includes(target) ? target : "dashboard";
    const pushHistory = !options || options.pushHistory !== false;
    const silent = Boolean(options && options.silent);

    if (!silent) {
      playSound("tap");
    }

    if (pushHistory && validTarget !== currentActiveView) {
      try {
        const cleanUrl = getCleanUrlForView(validTarget);
        if (currentActiveView === "dashboard") {
          history.pushState({ view: validTarget }, "", cleanUrl);
        } else if (validTarget === "dashboard") {
          history.pushState({ view: "dashboard" }, "", cleanUrl);
        } else {
          history.replaceState({ view: validTarget }, "", cleanUrl);
        }
      } catch (e) {}
    }

    currentActiveView = validTarget;
    if (document.body) {
      document.body.classList.toggle("focus-view-active", validTarget === "focus");
    }

    tabList.forEach((t) => {
      const view = document.getElementById(`view-${t}`);
      const deskBtn = document.getElementById(`desk-tab-${t}`);
      const mobBtn = document.getElementById(`mob-tab-${t}`);
      const mobPill = document.getElementById(`mob-pill-${t}`);

      if (t === validTarget) {
        view.classList.remove("hidden");
        view.classList.remove("view-animate");
        void view.offsetWidth;
        view.classList.add("view-animate");

        if (deskBtn) {
          deskBtn.className = "tap-target py-3 border-b-2 border-slate-900 text-slate-900 font-semibold flex items-center gap-1.5";
          deskBtn.setAttribute("aria-current", "page");
        }
        if (mobBtn) {
          mobBtn.className = "tap-target flex flex-col items-center justify-center py-1 text-slate-900 font-semibold";
          mobBtn.setAttribute("aria-current", "page");
        }
        if (mobPill) mobPill.className = "w-9 h-7 rounded-full bg-slate-900 text-white flex items-center justify-center transition-colors";
      } else {
        view.classList.add("hidden");
        if (deskBtn) {
          deskBtn.className = "tap-target py-3 border-b-2 border-transparent text-slate-500 hover:text-slate-800 flex items-center gap-1.5 font-medium";
          deskBtn.removeAttribute("aria-current");
        }
        if (mobBtn) {
          mobBtn.className = "tap-target flex flex-col items-center justify-center py-1 text-slate-500 font-medium";
          mobBtn.removeAttribute("aria-current");
        }
        if (mobPill) mobPill.className = "w-9 h-7 rounded-full bg-transparent text-slate-500 flex items-center justify-center transition-colors";
      }
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
    renderAll();
  }

  function runStorageDiagnostics(showNotification) {
    if (!isAppHydrated || !state) return;
    const lsEl = document.getElementById("status-ls");
    const idbEl = document.getElementById("status-idb");
    const cacheEl = document.getElementById("status-cache");
    const summaryEl = document.getElementById("sw-status-text");

    let lsOk = false;
    try {
      if (typeof window !== "undefined" && "localStorage" in window && window.localStorage !== null) {
        void localStorage.getItem(LS_KEY);
        lsOk = true;
      }
    } catch (e) {
      lsOk = false;
    }

    if (lsEl) {
      lsEl.textContent = lsOk ? "Active" : "Blocked";
      lsEl.className = lsOk ? "text-emerald-700 font-semibold" : "text-amber-600 font-semibold";
    }

    // 100% read-only IndexedDB verification (never writes to the database)
    const idbPromise = openPulseDB()
      .then((db) => {
        return new Promise((resolve) => {
          try {
            const tx = db.transaction(IDB_STORE, "readonly");
            const req = tx.objectStore(IDB_STORE).count();
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
          } catch (e) {
            resolve(false);
          }
        });
      })
      .catch(() => false);

    const cachePromise =
      "caches" in window && typeof caches.has === "function"
        ? caches.has("pulse-static-v8").then((hasCache) => Boolean(hasCache)).catch(() => false)
        : Promise.resolve(false);

    Promise.all([idbPromise, cachePromise]).then(([idbOk, cacheOk]) => {
      if (idbEl) {
        idbEl.textContent = isReadOnlyMode ? "Read-Only" : idbOk ? "Active" : "Standby";
        idbEl.className = !isReadOnlyMode && idbOk ? "text-emerald-700 font-semibold" : "text-amber-600 font-semibold";
      }
      if (cacheEl) {
        cacheEl.textContent = cacheOk ? "Active" : "Inactive";
        cacheEl.className = cacheOk ? "text-emerald-700 font-semibold" : "text-amber-600 font-semibold";
      }
      const totalItems =
        state.habits.length +
        state.tasks.length +
        state.skills.length +
        (state.notes ? state.notes.length : 0) +
        (state.inbox ? state.inbox.length : 0);
      if (summaryEl) {
        summaryEl.textContent = `Rev #${state.rev || 0}: ${totalItems} records synced across LocalStorage and IndexedDB.`;
      }
      if (showNotification) {
        playSound("success");
        showToast(`Storage verified (Rev #${state.rev || 0})`);
      }
    });
  }

  // --------------------------------------------------------------------------
  // 11. Bind Static Listeners & Gate Application Startup on `loadState()` Promise
  // --------------------------------------------------------------------------
  function bindStaticEventListeners() {
    document.getElementById("toast-undo-btn").addEventListener("click", () => {
      if (!assertWorkspaceWritable()) return;
      if (typeof currentUndoCallback !== "function") return;
      const callback = currentUndoCallback;
      const preUndoSnapshot = JSON.parse(JSON.stringify(state));
      clearUndoCallback();
      try {
        callback();
        playSound("success");
        updateProfileUi();
        updateSoundUi();
        renderAll();
        saveStateWithToast(state, "Action undone", () => {
          state.userName = preUndoSnapshot.userName;
          state.soundEnabled = preUndoSnapshot.soundEnabled;
          soundEnabled = preUndoSnapshot.soundEnabled !== false;
          state.habits = preUndoSnapshot.habits;
          state.tasks = preUndoSnapshot.tasks;
          state.skills = preUndoSnapshot.skills;
          state.notes = preUndoSnapshot.notes;
          state.inbox = preUndoSnapshot.inbox;
        });
      } catch (err) {
        clearUndoCallback();
      }
    });

    tabList.forEach((t) => {
      const dBtn = document.getElementById(`desk-tab-${t}`);
      if (dBtn) dBtn.addEventListener("click", () => switchView(t));
      const mBtn = document.getElementById(`mob-tab-${t}`);
      if (mBtn) mBtn.addEventListener("click", () => switchView(t));
    });

    document.getElementById("quick-view-habits").addEventListener("click", () => switchView("habits"));
    document.getElementById("quick-view-tasks").addEventListener("click", () => switchView("tasks"));
    document.getElementById("quick-view-skills").addEventListener("click", () => switchView("skills"));
    document.getElementById("quick-view-notes").addEventListener("click", () => switchView("notes"));

    const btnDismissBriefing = document.getElementById("btn-dismiss-briefing");
    if (btnDismissBriefing) {
      btnDismissBriefing.addEventListener("click", () => {
        playSound("tap");
        collapseBriefingCardForToday();
      });
    }

    const btnCloseDay = document.getElementById("btn-close-day");
    if (btnCloseDay) {
      btnCloseDay.addEventListener("click", () => {
        playSound("success");
        collapseEveningCloseoutCard();
        showToast("Day closed. Rest well tonight.");
      });
    }

    btnTimerStart.addEventListener("click", toggleTimer);
    btnTimerReset.addEventListener("click", requestStopSession);
    if (btnImmersivePause) {
      btnImmersivePause.addEventListener("click", toggleTimer);
    }
    if (btnImmersiveStop) {
      btnImmersiveStop.addEventListener("click", requestStopSession);
    }
    if (inputCustomMinutes) {
      const applyCustomDuration = () => {
        if (timerRunning || isFocusSessionActive) return;
        const rawVal = parseInt(inputCustomMinutes.value, 10);
        if (!Number.isFinite(rawVal)) return;
        const clampedMins = Math.min(240, Math.max(1, rawVal));
        if (!timerRunning) {
          timerSeconds = clampedMins * 60;
          btnTimerStart.textContent = "Start session";
          updateTimerDisplays();
        }
        syncDurationSelectionUI(clampedMins);
        populateFocusTargetDropdown();
        persistTimerState();
      };
      inputCustomMinutes.addEventListener("input", applyCustomDuration);
      inputCustomMinutes.addEventListener("change", () => {
        const rawVal = parseInt(inputCustomMinutes.value, 10);
        const clampedMins = Number.isFinite(rawVal) ? Math.min(240, Math.max(1, rawVal)) : 25;
        inputCustomMinutes.value = String(clampedMins);
        applyCustomDuration();
      });
    }
    document.getElementById("btn-header-timer").addEventListener("click", () => switchView("focus"));

    if (inputFocusSessionName) {
      inputFocusSessionName.setAttribute("role", "combobox");
      inputFocusSessionName.setAttribute("aria-autocomplete", "list");
      inputFocusSessionName.setAttribute("aria-expanded", "false");
      inputFocusSessionName.setAttribute("aria-controls", "focus-autocomplete-menu");
    }
    if (focusAutocompleteMenu) {
      focusAutocompleteMenu.setAttribute("role", "listbox");
    }
    [mainTimerDisplay, deskTimerDisplay, focusStageClock, miniTimerClock].forEach((clockEl) => {
      if (clockEl) {
        clockEl.setAttribute("role", "timer");
        clockEl.setAttribute("aria-live", "off");
      }
    });
    if (focusModeStage) {
      focusModeStage.setAttribute("role", "dialog");
      focusModeStage.setAttribute("aria-modal", "true");
      focusModeStage.setAttribute("aria-labelledby", "focus-stage-target-title");
      focusModeStage.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const focusables = Array.from(
          focusModeStage.querySelectorAll(
            'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });
    }

    if (btnMinimizeFocus) {
      btnMinimizeFocus.addEventListener("click", () => {
        playSound("tap");
        minimizeFocusStage();
      });
    }
    if (btnEnterZenFocus) {
      btnEnterZenFocus.addEventListener("click", (e) => {
        playSound("tap");
        focusStageTriggerEl = e.currentTarget || btnEnterZenFocus;
        isFocusMinimized = false;
        if (!timerRunning) {
          toggleTimer();
        } else {
          syncFocusModeUI();
        }
      });
    }
    function expandMiniTimerToFullScreen(e) {
      if (e) e.stopPropagation();
      playSound("tap");
      focusStageTriggerEl = (e && e.currentTarget) || btnTimerStart;
      isFocusMinimized = false;
      isFocusSessionActive = true;
      switchView("focus");
      syncFocusModeUI();
    }

    if (btnMiniTimerOpen) {
      btnMiniTimerOpen.addEventListener("click", expandMiniTimerToFullScreen);
    }
    if (btnMiniTimerToggle) {
      btnMiniTimerToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleTimer();
      });
    }
    if (btnMiniTimerZen) {
      btnMiniTimerZen.addEventListener("click", expandMiniTimerToFullScreen);
    }
    if (btnTimerMinus5 && inputCustomMinutes) {
      btnTimerMinus5.addEventListener("click", () => {
        playSound("tap");
        const currentMins = parseInt(inputCustomMinutes.value, 10) || 25;
        const nextMins = Math.max(1, currentMins - 5);
        inputCustomMinutes.value = String(nextMins);
        inputCustomMinutes.dispatchEvent(new Event("change"));
      });
    }
    if (btnTimerPlus5 && inputCustomMinutes) {
      btnTimerPlus5.addEventListener("click", () => {
        playSound("tap");
        const currentMins = parseInt(inputCustomMinutes.value, 10) || 25;
        const nextMins = Math.min(240, currentMins + 5);
        inputCustomMinutes.value = String(nextMins);
        inputCustomMinutes.dispatchEvent(new Event("change"));
      });
    }

    if (inputFocusSessionName) {
      inputFocusSessionName.addEventListener("focus", () => {
        if (inputFocusSessionName.value.trim().length >= 2) {
          renderFocusAutocompleteMenu(inputFocusSessionName.value);
        }
      });

      inputFocusSessionName.addEventListener("input", () => {
        if (autocompleteDebounceTimer) {
          clearTimeout(autocompleteDebounceTimer);
          autocompleteDebounceTimer = null;
        }
        activeSuggestionIndex = -1;

        const val = inputFocusSessionName.value;
        focusCustomSessionName = sanitizeText(val, "", 140);
        const resolved = resolveLinkedFocusTarget();
        if (resolved && val.trim() !== resolved.title) {
          focusLinkedType = "none";
          focusLinkedId = null;
        }
        populateFocusTargetDropdown();

        if (val.trim().length >= 2) {
          autocompleteDebounceTimer = setTimeout(() => {
            autocompleteDebounceTimer = null;
            if (document.activeElement === inputFocusSessionName) {
              renderFocusAutocompleteMenu(inputFocusSessionName.value);
            }
          }, 180);
        } else if (focusAutocompleteMenu) {
          focusAutocompleteMenu.classList.add("hidden");
          focusAutocompleteMenu.innerHTML = "";
          currentSuggestionMatches = [];
          inputFocusSessionName.setAttribute("aria-expanded", "false");
          inputFocusSessionName.removeAttribute("aria-activedescendant");
        }
        syncFocusModeUI();
        persistTimerState();
      });

      inputFocusSessionName.addEventListener("keydown", (e) => {
        const isMenuOpen = focusAutocompleteMenu && !focusAutocompleteMenu.classList.contains("hidden");

        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (autocompleteDebounceTimer) {
            clearTimeout(autocompleteDebounceTimer);
            autocompleteDebounceTimer = null;
          }
          if (!isMenuOpen) {
            renderFocusAutocompleteMenu(inputFocusSessionName.value, true);
            if (currentSuggestionMatches.length > 0) {
              activeSuggestionIndex = 0;
              highlightAutocompleteItem(0);
            }
          } else if (currentSuggestionMatches.length > 0) {
            activeSuggestionIndex = (activeSuggestionIndex + 1) % currentSuggestionMatches.length;
            highlightAutocompleteItem(activeSuggestionIndex);
          }
          return;
        }

        if (e.key === "ArrowUp") {
          if (isMenuOpen && currentSuggestionMatches.length > 0) {
            e.preventDefault();
            activeSuggestionIndex =
              activeSuggestionIndex <= 0
                ? currentSuggestionMatches.length - 1
                : activeSuggestionIndex - 1;
            highlightAutocompleteItem(activeSuggestionIndex);
          }
          return;
        }

        if (e.key === "Enter") {
          e.preventDefault();
          if (autocompleteDebounceTimer) {
            clearTimeout(autocompleteDebounceTimer);
            autocompleteDebounceTimer = null;
          }

          if (isMenuOpen && activeSuggestionIndex >= 0 && activeSuggestionIndex < currentSuggestionMatches.length) {
            const chosen = currentSuggestionMatches[activeSuggestionIndex];
            focusLinkedType = chosen.type;
            focusLinkedId = String(chosen.id);
            focusCustomSessionName = chosen.title;
            inputFocusSessionName.value = chosen.title;
            playSound("tap");
          } else {
            focusCustomSessionName = sanitizeText(inputFocusSessionName.value, "", 140);
            const resolved = resolveLinkedFocusTarget();
            if (!resolved || inputFocusSessionName.value.trim() !== resolved.title) {
              focusLinkedType = "none";
              focusLinkedId = null;
            }
          }

          closeFocusAutocompleteMenu();
          inputFocusSessionName.blur();

          populateFocusTargetDropdown();
          syncFocusModeUI();
          persistTimerState();
          return;
        }

        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeFocusAutocompleteMenu();
          inputFocusSessionName.blur();
          return;
        }
      });

      inputFocusSessionName.addEventListener("blur", () => {
        closeFocusAutocompleteMenu();
      });
    }

    if (btnUnlinkFocusTarget) {
      btnUnlinkFocusTarget.addEventListener("click", () => {
        playSound("tap");
        focusLinkedType = "none";
        focusLinkedId = null;
        focusCustomSessionName = "";
        if (inputFocusSessionName) {
          inputFocusSessionName.value = "";
          inputFocusSessionName.focus();
        }
        populateFocusTargetDropdown();
        syncFocusModeUI();
        persistTimerState();
      });
    }

    document.querySelectorAll(".timer-opt-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (timerRunning || isFocusSessionActive) return;
        const val = parseInt(btn.dataset.val, 10) || 25;
        selectTimerPreset.value = String(val);
        if (labelTimerPreset) labelTimerPreset.textContent = `${val}m`;
        if (inputCustomMinutes) inputCustomMinutes.value = String(val);
        populateFocusTargetDropdown();
        syncDurationSelectionUI(val);
        resetTimer();
      });
    });

    document.addEventListener("click", (e) => {
      if (focusAutocompleteMenu && !focusAutocompleteMenu.classList.contains("hidden")) {
        const wrap = document.getElementById("focus-autocomplete-wrap");
        if (!wrap || !wrap.contains(e.target)) {
          closeFocusAutocompleteMenu();
        }
      }
    });

    setupSegmentedPills(".habit-cat-btn", "modal-habit-cat");
    setupSegmentedPills(".task-prio-btn", "modal-task-prio");
    setupSegmentedPills(".skill-cat-btn", "modal-skill-category");
    setupSegmentedPills(".note-cat-btn", "modal-note-cat");

    function toggleSound() {
      if (!assertWorkspaceWritable()) return;
      const prevSound = soundEnabled;
      soundEnabled = !soundEnabled;
      state.soundEnabled = soundEnabled;
      updateSoundUi();
      if (soundEnabled) playSound("success");
      saveStateWithToast(state, soundEnabled ? "Audio feedback enabled" : "Audio feedback muted", () => {
        soundEnabled = prevSound;
        state.soundEnabled = prevSound;
      });
    }

    document.getElementById("btn-quick-sound").addEventListener("click", toggleSound);
    document.getElementById("toggle-sound-btn").addEventListener("click", toggleSound);

    document.getElementById("btn-save-username").addEventListener("click", () => {
      if (!assertWorkspaceWritable()) return;
      const prevName = state.userName;
      const newName = sanitizeText(userNameInput.value, "Workspace", 60);
      state.userName = newName;
      updateProfileUi();
      playSound("success");
      saveStateWithToast(state, "Profile updated", () => {
        state.userName = prevName;
      });
    });

    document.getElementById("btn-cancel-confirm-modal").addEventListener("click", () => {
      pendingConfirmAction = null;
      closeAccessibleModal(confirmModal);
    });

    document.getElementById("btn-accept-confirm-modal").addEventListener("click", () => {
      const fn = pendingConfirmAction;
      pendingConfirmAction = null;
      closeAccessibleModal(confirmModal);
      if (typeof fn === "function") fn();
    });

    const modalConfigs = [
      { el: habitModal, labelId: "modal-habit-heading" },
      { el: taskModal, labelId: "modal-task-heading" },
      { el: skillModal, labelId: "modal-skill-heading" },
      { el: milestoneModal, labelId: "modal-milestone-heading" },
      { el: noteModal, labelId: "modal-note-heading" },
      { el: confirmModal, labelId: "modal-confirm-heading" },
      { el: pwaInstallModal, labelId: "modal-pwa-install-heading" }
    ];

    modalConfigs.forEach(({ el, labelId }) => {
      if (!el) return;
      if (!el.getAttribute("role")) el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      el.setAttribute("aria-labelledby", labelId);
      el.setAttribute("aria-hidden", el.classList.contains("hidden") ? "true" : "false");

      el.addEventListener("click", (e) => {
        if (e.target === el) closeAccessibleModal(el);
      });

      el.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const focusables = Array.from(
          el.querySelectorAll(
            'button:not([disabled]), input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });
    });

    document.addEventListener("keydown", (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : "";
      const isTypingInField =
        activeTag === "INPUT" ||
        activeTag === "TEXTAREA" ||
        activeTag === "SELECT" ||
        (document.activeElement && document.activeElement.isContentEditable);

      const anyModalOpen = modalConfigs.some(({ el }) => el && !el.classList.contains("hidden"));

      // Spacebar toggles Pause/Resume when focus timer is active (or on Focus tab) and not typing in an input
      if ((e.code === "Space" || e.key === " ") && !isTypingInField && !anyModalOpen) {
        const isInFullScreenStage = focusModeStage && !focusModeStage.classList.contains("hidden");
        if (timerRunning || currentActiveView === "focus" || isInFullScreenStage) {
          if (activeTag !== "BUTTON") {
            e.preventDefault();
            toggleTimer();
            return;
          }
        }
      }

      if (e.key !== "Escape") return;

      if (focusAutocompleteMenu && !focusAutocompleteMenu.classList.contains("hidden")) {
        closeFocusAutocompleteMenu();
        return;
      }

      for (const { el } of modalConfigs) {
        if (el && !el.classList.contains("hidden")) {
          closeAccessibleModal(el);
          playSound("tap");
          return;
        }
      }

      // Escape minimizes the full-screen focus stage into the floating Mini Timer and restores trigger focus
      if (isFocusSessionActive) {
        if (!isFocusMinimized) {
          playSound("tap");
          minimizeFocusStage();
          return;
        } else if (currentActiveView === "focus") {
          switchView("dashboard");
          return;
        }
      }
    });

    document.getElementById("btn-open-add-habit").addEventListener("click", (e) => openHabitModal(null, e.currentTarget));
    document.getElementById("btn-close-habit-modal").addEventListener("click", () => closeAccessibleModal(habitModal));
    document.getElementById("btn-cancel-habit-modal").addEventListener("click", () => closeAccessibleModal(habitModal));

    document.getElementById("btn-open-add-task").addEventListener("click", (e) => openTaskModal(null, e.currentTarget));
    document.getElementById("btn-close-task-modal").addEventListener("click", () => closeAccessibleModal(taskModal));
    document.getElementById("btn-cancel-task-modal").addEventListener("click", () => closeAccessibleModal(taskModal));

    document.getElementById("btn-open-add-skill").addEventListener("click", (e) => openSkillModal(null, e.currentTarget));
    document.getElementById("btn-close-skill-modal").addEventListener("click", () => closeAccessibleModal(skillModal));
    document.getElementById("btn-cancel-skill-modal").addEventListener("click", () => closeAccessibleModal(skillModal));

    document.getElementById("btn-close-milestone-modal").addEventListener("click", () => closeAccessibleModal(milestoneModal));
    document.getElementById("btn-cancel-milestone-modal").addEventListener("click", () => closeAccessibleModal(milestoneModal));

    document.getElementById("btn-open-add-note").addEventListener("click", (e) => {
      if (!assertWorkspaceWritable()) return;
      lastFocusedTrigger = e.currentTarget;
      editingNoteId = null;
      document.getElementById("modal-note-heading").textContent = "New note";
      const titleInput = document.getElementById("modal-note-title");
      titleInput.value = "";
      setActivePillValue(".note-cat-btn", "modal-note-cat", "Lab & study");
      document.getElementById("modal-note-body").value = "";
      openAccessibleModal(noteModal, titleInput);
      playSound("tap");
    });
    document.getElementById("btn-close-note-modal").addEventListener("click", () => closeAccessibleModal(noteModal));
    document.getElementById("btn-cancel-note-modal").addEventListener("click", () => closeAccessibleModal(noteModal));

    document.getElementById("btn-save-milestone-modal").addEventListener("click", () => {
      if (!assertWorkspaceWritable()) return;
      const input = document.getElementById("input-milestone-title");
      const title = sanitizeText(input.value, "", 180);
      if (!title || !targetSkillForMilestone) return;
      const liveSkill = state.skills.find((s) => s.id === targetSkillForMilestone.id);
      if (!liveSkill) return;
      if (!Array.isArray(liveSkill.milestones)) liveSkill.milestones = [];
      const prevMilestones = JSON.parse(JSON.stringify(liveSkill.milestones));
      liveSkill.milestones.push({ title, done: false });
      input.value = "";
      closeAccessibleModal(milestoneModal);
      playSound("success");
      renderAll();
      saveStateWithToast(state, "Milestone added", () => {
        liveSkill.milestones = prevMilestones;
      });
    });

    document.getElementById("btn-save-habit-modal").addEventListener("click", () => {
      if (!assertWorkspaceWritable()) return;
      const nameInput = document.getElementById("modal-habit-name");
      const catInput = document.getElementById("modal-habit-cat");
      const name = sanitizeText(nameInput.value, "", 140);
      if (!name) return;
      const category = sanitizeCategory(catInput.value, ALLOWED_HABIT_CATEGORIES, "Routine");

      const prevHabits = JSON.parse(JSON.stringify(state.habits));
      let toastMsg = "Habit added";
      if (editingHabitId !== null) {
        const existing = state.habits.find((h) => h.id === editingHabitId);
        if (existing) {
          existing.name = name;
          existing.category = category;
        }
        toastMsg = "Habit updated";
      } else {
        state.habits.push({
          id: generateUniqueId(),
          name,
          category,
          streak: 0,
          totalStreak: 0,
          history: [false, false, false, false, false, false, false],
          doneToday: false
        });
      }
      editingHabitId = null;
      nameInput.value = "";
      closeAccessibleModal(habitModal);
      playSound("success");
      renderAll();
      saveStateWithToast(state, toastMsg, () => {
        state.habits = prevHabits;
      });
    });

    document.getElementById("btn-save-task-modal").addEventListener("click", () => {
      if (!assertWorkspaceWritable()) return;
      const titleInput = document.getElementById("modal-task-title");
      const prioInput = document.getElementById("modal-task-prio");
      const title = sanitizeText(titleInput.value, "", 240);
      if (!title) return;
      const priority = sanitizeCategory(prioInput.value, ALLOWED_PRIORITIES, "Medium");

      const prevTasks = JSON.parse(JSON.stringify(state.tasks));
      let toastMsg = "Task added";
      if (editingTaskId !== null) {
        const existing = state.tasks.find((t) => t.id === editingTaskId);
        if (existing) {
          existing.title = title;
          existing.priority = priority;
        }
        toastMsg = "Task updated";
      } else {
        state.tasks.push({
          id: generateUniqueId(),
          title,
          priority,
          completed: false
        });
      }
      editingTaskId = null;
      titleInput.value = "";
      closeAccessibleModal(taskModal);
      playSound("success");
      renderAll();
      saveStateWithToast(state, toastMsg, () => {
        state.tasks = prevTasks;
      });
    });

    document.getElementById("btn-save-skill-modal").addEventListener("click", () => {
      if (!assertWorkspaceWritable()) return;
      const nameInput = document.getElementById("modal-skill-name");
      const targetInput = document.getElementById("modal-skill-target");
      const catInput = document.getElementById("modal-skill-category");
      const name = sanitizeText(nameInput.value, "", 140);
      const target = sanitizeNumber(targetInput.value, 30, 1, 50000);
      const category = sanitizeCategory(catInput.value, ALLOWED_SKILL_CATEGORIES, "General");
      if (!name) return;

      const prevSkills = JSON.parse(JSON.stringify(state.skills));
      let toastMsg = "Skill added";
      if (editingSkillId !== null) {
        const existing = state.skills.find((s) => s.id === editingSkillId);
        if (existing) {
          existing.name = name;
          existing.targetHours = target;
          existing.category = category;
        }
        toastMsg = "Skill updated";
      } else {
        state.skills.push({
          id: generateUniqueId(),
          name,
          category,
          currentHours: 0,
          targetHours: target,
          milestones: []
        });
      }
      editingSkillId = null;
      nameInput.value = "";
      closeAccessibleModal(skillModal);
      playSound("success");
      renderAll();
      saveStateWithToast(state, toastMsg, () => {
        state.skills = prevSkills;
      });
    });

    document.getElementById("btn-save-note-modal").addEventListener("click", () => {
      if (!assertWorkspaceWritable()) return;
      const titleInput = document.getElementById("modal-note-title");
      const catInput = document.getElementById("modal-note-cat");
      const bodyInput = document.getElementById("modal-note-body");
      const title = sanitizeText(titleInput.value, "", 160);
      const body = sanitizeText(bodyInput.value, "", 10000);
      if (!title && !body) return;

      if (!state.notes) state.notes = [];
      const prevNotes = JSON.parse(JSON.stringify(state.notes));
      const nowStamp = getLocalDateKey();
      const category = sanitizeCategory(catInput.value, ALLOWED_NOTE_CATEGORIES, "Lab & study");

      let toastMsg = "Note saved";
      if (editingNoteId) {
        const existing = state.notes.find((n) => n.id === editingNoteId);
        if (existing) {
          existing.title = title || "Untitled note";
          existing.category = category;
          existing.body = body;
          existing.updatedAt = nowStamp;
        }
        toastMsg = "Note updated";
      } else {
        state.notes.unshift({
          id: generateUniqueId(),
          title: title || "Untitled note",
          category,
          body,
          updatedAt: nowStamp
        });
      }
      editingNoteId = null;
      closeAccessibleModal(noteModal);
      playSound("success");
      renderAll();
      saveStateWithToast(state, toastMsg, () => {
        state.notes = prevNotes;
      });
    });

    taskSearch.addEventListener("input", renderTasks);
    noteSearch.addEventListener("input", renderNotes);

    [
      { inputId: "quick-capture-input", btnId: "btn-tasks-quick-capture" },
      { inputId: "dash-quick-capture-input", btnId: "btn-dash-quick-capture" }
    ].forEach(({ inputId, btnId }) => {
      const capInput = document.getElementById(inputId);
      const capBtn = document.getElementById(btnId);
      if (capInput) {
        capInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (captureQuickThought(capInput.value)) {
              capInput.value = "";
            }
          }
        });
      }
      if (capBtn && capInput) {
        capBtn.addEventListener("click", () => {
          if (captureQuickThought(capInput.value)) {
            capInput.value = "";
            capInput.focus();
          }
        });
      }
    });

    const filterBtns = {
      all: document.getElementById("filter-all"),
      active: document.getElementById("filter-active"),
      completed: document.getElementById("filter-completed")
    };

    function setTaskFilter(f) {
      if (!isAppHydrated) return;
      playSound("tap");
      currentTaskFilter = f;
      Object.keys(filterBtns).forEach((k) => {
        if (k === f) {
          filterBtns[k].className = "tap-target h-9 text-xs font-semibold px-3 rounded-lg bg-slate-900 text-white";
        } else {
          filterBtns[k].className = "tap-target h-9 text-xs font-medium px-3 rounded-lg text-slate-600 hover:text-slate-900";
        }
      });
      renderTasks();
    }

    filterBtns.all.addEventListener("click", () => setTaskFilter("all"));
    filterBtns.active.addEventListener("click", () => setTaskFilter("active"));
    filterBtns.completed.addEventListener("click", () => setTaskFilter("completed"));

    document.getElementById("btn-sort-priority").addEventListener("click", (e) => {
      if (!isAppHydrated) return;
      playSound("tap");
      sortTasksByPriority = !sortTasksByPriority;
      const btn = e.currentTarget;
      const label = document.getElementById("label-sort-priority");
      btn.setAttribute("aria-pressed", sortTasksByPriority ? "true" : "false");

      if (sortTasksByPriority) {
        btn.className =
          "tap-target h-11 sm:h-11 text-xs font-semibold px-3.5 rounded-xl border border-slate-900 bg-slate-900 text-white flex items-center justify-center gap-1.5 shrink-0";
        if (label) label.textContent = "Sort: Priority";
      } else {
        btn.className =
          "tap-target h-11 sm:h-11 text-xs font-medium px-3.5 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 flex items-center justify-center gap-1.5 shrink-0";
        if (label) label.textContent = "Sort: Default";
      }
      renderTasks();
    });

    // Clear All Workspace Data (Operation-Specific Collection Restoration)
    document.getElementById("btn-clear-all-data").addEventListener("click", (e) => {
      if (!assertWorkspaceWritable()) return;
      askConfirmation(
        "Clear workspace data?",
        "This will remove all current habits, tasks, skills, and notes. You can still undo immediately from the notification banner.",
        () => {
          const removedHabits = JSON.parse(JSON.stringify(state.habits));
          const removedTasks = JSON.parse(JSON.stringify(state.tasks));
          const removedSkills = JSON.parse(JSON.stringify(state.skills));
          const removedNotes = JSON.parse(JSON.stringify(state.notes || []));
          const removedInbox = JSON.parse(JSON.stringify(state.inbox || []));

          targetSkillForMilestone = null;
          editingNoteId = null;
          editingHabitId = null;
          editingTaskId = null;
          editingSkillId = null;

          state.habits = [];
          state.tasks = [];
          state.skills = [];
          state.notes = [];
          state.inbox = [];
          playSound("tap");
          saveStateWithUndo(state, "Workspace cleared", () => {
            removedHabits.forEach((h) => {
              if (!state.habits.some((existing) => existing.id === h.id)) state.habits.push(h);
            });
            removedTasks.forEach((t) => {
              if (!state.tasks.some((existing) => existing.id === t.id)) state.tasks.push(t);
            });
            removedSkills.forEach((s) => {
              if (!state.skills.some((existing) => existing.id === s.id)) state.skills.push(s);
            });
            removedNotes.forEach((n) => {
              if (!state.notes.some((existing) => existing.id === n.id)) state.notes.push(n);
            });
            if (!Array.isArray(state.inbox)) state.inbox = [];
            removedInbox.forEach((item) => {
              if (!state.inbox.some((existing) => existing.id === item.id)) state.inbox.push(item);
            });
          });
          renderAll();
        },
        e.currentTarget
      );
    });

    // Blob-based Export JSON Backup
    document.getElementById("btn-export-data").addEventListener("click", () => {
      if (!isAppHydrated) return;
      playSound("tap");
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const blobUrl = URL.createObjectURL(blob);
      const downloadAnchor = document.createElement("a");
      downloadAnchor.href = blobUrl;
      downloadAnchor.download = `pulse_workspace_${Date.now()}.json`;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      showToast("JSON backup exported");
    });

    // Hardened Import JSON Backup
    document.getElementById("input-import-json").addEventListener("change", (e) => {
      if (!assertWorkspaceWritable()) return;
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        showToast("Backup file exceeds 5 MB limit");
        e.target.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const rawParsed = JSON.parse(String(event.target.result || ""));
          if (!isValidAppState(rawParsed) || !Array.isArray(rawParsed.inbox)) {
            showToast("Invalid backup file: all five collections (including inbox) are required");
            e.target.value = "";
            return;
          }

          askConfirmation(
            "Import backup file?",
            `Replace current workspace items with "${file.name}"? You can undo this import immediately from the banner.`,
            () => {
              const prevHabits = JSON.parse(JSON.stringify(state.habits));
              const prevTasks = JSON.parse(JSON.stringify(state.tasks));
              const prevSkills = JSON.parse(JSON.stringify(state.skills));
              const prevNotes = JSON.parse(JSON.stringify(state.notes || []));
              const prevInbox = JSON.parse(JSON.stringify(state.inbox || []));
              const prevUserName = state.userName;
              const prevSoundEnabled = state.soundEnabled !== false;

              targetSkillForMilestone = null;
              editingNoteId = null;
              editingHabitId = null;
              editingTaskId = null;
              editingSkillId = null;

              const sanitizedState = migrateEncodedEntitiesInState(rawParsed);
              sanitizedState.rev = sanitizeRev(state.rev);
              sanitizedState.baseRev = sanitizeRev(state.rev);
              checkDateRollover(sanitizedState);

              state = sanitizedState;
              soundEnabled = state.soundEnabled !== false;
              saveStateWithUndo(state, "Backup imported and verified", () => {
                state.userName = prevUserName;
                state.soundEnabled = prevSoundEnabled;
                soundEnabled = prevSoundEnabled;
                state.habits = prevHabits;
                state.tasks = prevTasks;
                state.skills = prevSkills;
                state.notes = prevNotes;
                state.inbox = prevInbox;
              });
              updateProfileUi();
              updateSoundUi();
              renderAll();
              playSound("success");
            }
          );
        } catch (err) {
          showToast("Could not parse backup file");
        } finally {
          e.target.value = "";
        }
      };
      reader.readAsText(file);
    });

    // Reset to Clean Default State
    document.getElementById("btn-reset-data").addEventListener("click", (e) => {
      if (!assertWorkspaceWritable()) return;
      askConfirmation(
        "Reset workspace to defaults?",
        "This will reset your profile and clear all workspace items back to a fresh default state. You can still undo immediately after.",
        () => {
          const prevHabits = JSON.parse(JSON.stringify(state.habits));
          const prevTasks = JSON.parse(JSON.stringify(state.tasks));
          const prevSkills = JSON.parse(JSON.stringify(state.skills));
          const prevNotes = JSON.parse(JSON.stringify(state.notes || []));
          const prevInbox = JSON.parse(JSON.stringify(state.inbox || []));
          const prevUserName = state.userName;
          const prevSoundEnabled = state.soundEnabled !== false;

          targetSkillForMilestone = null;
          editingNoteId = null;
          editingHabitId = null;
          editingTaskId = null;
          editingSkillId = null;

          const restored = normalizeState(defaultAppState);
          restored.rev = sanitizeRev(state.rev);
          restored.baseRev = sanitizeRev(state.rev);
          state = restored;
          soundEnabled = true;
          saveStateWithUndo(state, "Workspace reset to default", () => {
            state.userName = prevUserName;
            state.soundEnabled = prevSoundEnabled;
            soundEnabled = prevSoundEnabled;
            state.habits = prevHabits;
            state.tasks = prevTasks;
            state.skills = prevSkills;
            state.notes = prevNotes;
            state.inbox = prevInbox;
          });
          updateSoundUi();
          updateProfileUi();
          renderAll();
          playSound("success");
        },
        e.currentTarget
      );
    });

    document.getElementById("btn-verify-storage").addEventListener("click", () => {
      runStorageDiagnostics(true);
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && isAppHydrated && state) {
        if (timerRunning) tickTimer();
        if (checkDateRollover(state)) {
          saveState(state);
        }
        renderAll();
      }
    });

    function applyCrossTabSyncedState(incomingState) {
      if (!incomingState || !isValidAppState(incomingState)) return;
      const currentRev = sanitizeRev(state && state.rev);
      if (!isNewerState(incomingState, state) && sanitizeRev(incomingState.rev) <= currentRev) return;

      [habitModal, taskModal, skillModal, milestoneModal, noteModal, confirmModal, pwaInstallModal].forEach((modalEl) => {
        if (modalEl && !modalEl.classList.contains("hidden")) {
          closeAccessibleModal(modalEl);
        }
      });
      pendingConfirmAction = null;

      checkDateRollover(incomingState);
      incomingState.baseRev = sanitizeRev(incomingState.rev);
      state = incomingState;
      snapshotCommittedState(state);
      soundEnabled = state.soundEnabled !== false;

      clearUndoCallback();
      targetSkillForMilestone = null;
      editingNoteId = null;
      editingHabitId = null;
      editingTaskId = null;
      editingSkillId = null;

      updateProfileUi();
      updateSoundUi();
      renderAll();
    }

    window.addEventListener("storage", (event) => {
      if (!isAppHydrated || isReadOnlyMode || event.key !== LS_KEY || !event.newValue) return;
      try {
        const incomingRaw = JSON.parse(event.newValue);
        if (!isValidAppState(incomingRaw)) return;
        const incomingState = migrateEncodedEntitiesInState(incomingRaw);
        applyCrossTabSyncedState(incomingState);
      } catch (err) {
        console.warn("Multi-tab storage sync error:", err);
      }
    });

    if (syncChannel) {
      syncChannel.addEventListener("message", (event) => {
        if (!isAppHydrated || isReadOnlyMode) return;
        const msg = event && event.data;
        if (!msg || msg.type !== "IDB_STATE_COMMITTED") return;
        const currentRev = sanitizeRev(state && state.rev);
        if (Number.isSafeInteger(msg.rev) && msg.rev <= currentRev) return;

        loadFromIndexedDB()
          .then((freshIdbState) => {
            if (freshIdbState && isValidAppState(freshIdbState)) {
              applyCrossTabSyncedState(freshIdbState);
            }
          })
          .catch((err) => {
            console.warn("BroadcastChannel IDB re-read error:", err);
          });
      });
    }

    bindPwaInstallButton();
    updatePwaInstallUI();
  }

  // --------------------------------------------------------------------------
  // Manual PWA Install Trigger (Settings View)
  // --------------------------------------------------------------------------
  let deferredInstallPrompt = null;
  const btnInstallPwa = document.getElementById("btn-install-pwa");
  const labelInstallPwa = document.getElementById("label-install-pwa");
  const pwaInstallDesc = document.getElementById("pwa-install-desc");

  function updatePwaInstallUI() {
    const isStandalone =
      (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      (typeof navigator !== "undefined" && navigator.standalone);

    if (isStandalone) {
      if (labelInstallPwa) labelInstallPwa.textContent = "Install guide";
      if (pwaInstallDesc) pwaInstallDesc.textContent = "Running as an installed standalone application.";
    } else if (deferredInstallPrompt) {
      if (labelInstallPwa) labelInstallPwa.textContent = "Install app";
      if (pwaInstallDesc) pwaInstallDesc.textContent = "Install as a standalone application for fast, offline access.";
    } else {
      if (labelInstallPwa) labelInstallPwa.textContent = "Install app";
      if (pwaInstallDesc) pwaInstallDesc.textContent = "Install as a standalone application on your device.";
    }
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updatePwaInstallUI();
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    showToast("Pulse Workspace installed successfully");
    updatePwaInstallUI();
  });

  function openManualPwaInstallModal(triggerEl = null) {
    if (!pwaInstallModal) return;
    lastFocusedTrigger = triggerEl || document.activeElement;
    const statusTextEl = document.getElementById("modal-pwa-install-status");
    const isStandalone =
      (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      (typeof navigator !== "undefined" && navigator.standalone);

    if (statusTextEl) {
      statusTextEl.textContent = isStandalone
        ? "Pulse Workspace is currently running in standalone mode. To install on another device, follow the steps below:"
        : "Add Pulse Workspace to your home screen or desktop for instant launch and full offline capability:";
    }
    openAccessibleModal(pwaInstallModal, document.getElementById("btn-got-it-pwa-install"));
  }

  function bindPwaInstallButton() {
    const closeBtn = document.getElementById("btn-close-pwa-install-modal");
    const gotItBtn = document.getElementById("btn-got-it-pwa-install");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => closeAccessibleModal(pwaInstallModal));
    }
    if (gotItBtn) {
      gotItBtn.addEventListener("click", () => closeAccessibleModal(pwaInstallModal));
    }

    if (!btnInstallPwa) return;
    btnInstallPwa.addEventListener("click", (e) => {
      playSound("tap");
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice
          .then((choiceResult) => {
            if (choiceResult && choiceResult.outcome === "accepted") {
              showToast("Installing Pulse Workspace...");
            }
            deferredInstallPrompt = null;
            updatePwaInstallUI();
          })
          .catch(() => {
            deferredInstallPrompt = null;
            updatePwaInstallUI();
          });
      } else {
        openManualPwaInstallModal(e.currentTarget);
      }
    });
  }

  // Background Midnight Rollover Timer
  let midnightTimerId = null;
  function setupMidnightTimer() {
    if (midnightTimerId) clearTimeout(midnightTimerId);
    const now = new Date();
    const nextMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0, 0, 0, 50
    );
    const msUntilMidnight = Math.max(1000, nextMidnight.getTime() - now.getTime());
    midnightTimerId = setTimeout(() => {
      if (isAppHydrated && state && checkDateRollover(state)) {
        saveState(state);
        renderAll();
      }
      const newFormatted = new Date().toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric"
      });
      document.getElementById("desktop-date").textContent = newFormatted;
      document.getElementById("dashboard-date-badge").textContent = newFormatted;
      setupMidnightTimer();
    }, msUntilMidnight);
  }

  // Background Ritual Boundary Scheduler (P1: Checks every 60s for 12:00 PM and 18:00 boundaries)
  let ritualSchedulerInterval = null;
  let lastRitualCheckHour = new Date().getHours();

  function setupRitualScheduler() {
    if (ritualSchedulerInterval) clearInterval(ritualSchedulerInterval);
    lastRitualCheckHour = new Date().getHours();
    ritualSchedulerInterval = setInterval(() => {
      if (!isAppHydrated || !state || timerRunning) return;
      const currentHour = new Date().getHours();
      lastRitualCheckHour = currentHour;
      renderDailyBriefing();
      renderEveningCloseout();
    }, 60000);
  }

  // --------------------------------------------------------------------------
  // 12. Async Application Boot Sequence (Blocks Input & Render Until Resolved)
  // --------------------------------------------------------------------------
  if (document.body) {
    document.body.setAttribute("inert", "");
    document.body.inert = true;
  }
  const mainEl = document.querySelector("main");
  if (mainEl) {
    mainEl.setAttribute("inert", "");
    mainEl.inert = true;
    mainEl.classList.add("pointer-events-none", "opacity-0");
  }

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  const today = new Date();
  const dateFormatted = today.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
  document.getElementById("desktop-date").textContent = dateFormatted;
  document.getElementById("dashboard-date-badge").textContent = dateFormatted;

  loadState().then((hydratedState) => {
    state = hydratedState;
    soundEnabled = state.soundEnabled !== false;
    isAppHydrated = true;

    bindStaticEventListeners();
    setupMidnightTimer();
    setupRitualScheduler();
    updateProfileUi();
    updateSoundUi();
    restorePersistedTimer();

    // Seed initial History API state with clean paths (no hashes) and handle Android / OS hardware Back button
    const startView = parseViewFromLocation();
    try {
      const dashUrl = getCleanUrlForView("dashboard");
      const startUrl = getCleanUrlForView(startView);
      if (startView !== "dashboard") {
        history.replaceState({ view: "dashboard" }, "", dashUrl);
        history.pushState({ view: startView }, "", startUrl);
      } else {
        history.replaceState({ view: "dashboard" }, "", dashUrl);
      }
    } catch (e) {}

    window.addEventListener("popstate", (event) => {
      if (!isAppHydrated) return;

      if (isProgrammaticModalPop) {
        isProgrammaticModalPop = false;
        return;
      }

      // If any modal dialog is open when hardware Back is pressed, close the modal first
      const openModal = [habitModal, taskModal, skillModal, milestoneModal, noteModal, confirmModal, pwaInstallModal].find(
        (m) => m && !m.classList.contains("hidden")
      );
      if (openModal) {
        closeAccessibleModal(openModal, true);
        playSound("tap");
        return;
      }

      const targetFromState = event.state && event.state.view;
      const parsedPathView = parseViewFromLocation();
      const destination = tabList.includes(targetFromState)
        ? targetFromState
        : tabList.includes(parsedPathView)
          ? parsedPathView
          : "dashboard";

      switchView(destination, { pushHistory: false, silent: false });
    });

    switchView(startView, { pushHistory: false, silent: true });

    if (document.body) {
      document.body.removeAttribute("inert");
      document.body.inert = false;
    }
    if (mainEl) {
      mainEl.removeAttribute("inert");
      mainEl.inert = false;
      mainEl.classList.remove("pointer-events-none", "opacity-0");
    }

    runStorageDiagnostics(false);
  }).catch((bootErr) => {
    console.error("Critical boot hydration error:", bootErr);
    if (document.body) {
      document.body.removeAttribute("inert");
      document.body.inert = false;
    }
    if (mainEl) {
      mainEl.removeAttribute("inert");
      mainEl.inert = false;
      mainEl.classList.remove("pointer-events-none", "opacity-0");
      mainEl.innerHTML = `
        <div class="max-w-md mx-auto my-12 p-6 bg-white border border-slate-200 rounded-2xl shadow-sm text-center space-y-3">
          <h2 class="text-base font-bold text-slate-900">Workspace Recovery</h2>
          <p class="text-xs text-slate-500 leading-relaxed">
            We encountered an issue during startup storage hydration. Your saved data remains preserved.
          </p>
          <button id="btn-reload-workspace" type="button" class="tap-target h-10 px-4 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 transition-colors">
            Reload workspace
          </button>
        </div>
      `;
      const reloadBtn = document.getElementById("btn-reload-workspace");
      if (reloadBtn) {
        reloadBtn.addEventListener("click", () => {
          window.location.reload();
        });
      }
    }
  });
})();