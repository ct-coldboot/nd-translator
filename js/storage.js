const SETTINGS_KEY = 'subtext.settings.v1';
const PROFILE_KEY = 'subtext.profile.v1';

const DEFAULT_SETTINGS = {
  baseUrl: '',
  model: '',
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
}
