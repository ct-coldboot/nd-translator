const SETTINGS_KEY = 'subtext.settings.v1';
const PROFILE_KEY = 'subtext.profile.v1';
const REFRAME_KEY = 'subtext.reframes.v1';

// On the family LLM box itself, the app is served from localhost and talks to the
// local Lemonade server directly (no Tailscale, no config needed). Anywhere else
// (e.g. GitHub Pages on the teen's phone) the server address is entered by hand in
// Settings, so the defaults there stay empty.
const ON_SERVER = ['localhost', '127.0.0.1'].includes(location.hostname);

const DEFAULT_SETTINGS = {
  baseUrl: ON_SERVER ? 'http://localhost:13305/api/v1' : '',
  model: ON_SERVER ? 'Qwen3.6-35B-A3B-MTP-GGUF' : '',
  apiKey: ''
};

const DEFAULT_PROFILE = {
  corrections: []
};

function safeGetJSON(key, defaultValue) {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return defaultValue;
    return JSON.parse(stored);
  } catch {
    return defaultValue;
  }
}

function safeSaveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable or quota exceeded
  }
}

export function getSettings() {
  const stored = safeGetJSON(SETTINGS_KEY, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(settings) {
  safeSaveJSON(SETTINGS_KEY, settings);
}

export function getProfile() {
  const stored = safeGetJSON(PROFILE_KEY, {});
  return { ...DEFAULT_PROFILE, ...stored };
}

export function addCorrection(entry) {
  const profile = getProfile();
  profile.corrections.push(entry);
  if (profile.corrections.length > 25) {
    profile.corrections = profile.corrections.slice(-25);
  }
  safeSaveJSON(PROFILE_KEY, profile);
}

export function getRecentCorrections(n = 8) {
  const profile = getProfile();
  return profile.corrections.slice(-n);
}

export function clearProfile() {
  safeSaveJSON(PROFILE_KEY, DEFAULT_PROFILE);
  safeSaveJSON(REFRAME_KEY, []);
}

// "That helps" / "Not this time" taps on the second-read card. Stays on-device,
// same as corrections; kept so a future prompt can learn which patterns land.
export function addReframeFeedback(entry) {
  const log = safeGetJSON(REFRAME_KEY, []);
  log.push(entry);
  safeSaveJSON(REFRAME_KEY, log.slice(-25));
}
