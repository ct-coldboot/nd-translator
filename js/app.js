import { getSettings, saveSettings, getProfile, addCorrection, getRecentCorrections, clearProfile } from './storage.js';
import { pingServer, chatJSON, normalizeBaseUrl } from './api.js';
import { buildMessages, buildCorrectionMessages, buildAlternativeMessages, INTENSITY_LABELS, AUDIENCES } from './prompt.js';
import { PHRASEBOOK, CATEGORIES } from '../data/phrasebook.js';

const $ = (id) => document.getElementById(id);

const state = {
  audience: 'friend',
  messages: null,      // messages that produced lastResult
  lastResult: null,
  modelIntensity: 3,   // intensity of the currently shown result
  online: false,
  pbCategory: 'all',
};

/* ---------- server status ---------- */
async function refreshStatus() {
  const settings = getSettings();
  if (!settings.baseUrl) return setOnline(false);
  const res = await pingServer(settings);
  setOnline(res.ok);
  if (res.ok) renderModelChips(res.models);
}

function setOnline(ok) {
  state.online = ok;
  $('status').classList.toggle('online', ok);
  $('statusText').textContent = ok ? 'live' : 'offline';
  $('offlineNote').classList.toggle('hidden', ok);
}

function renderModelChips(models) {
  const current = $('setModel').value.trim();
  $('modelChips').innerHTML = models.map(
    (m) => `<button type="button" class="chip${m === current ? ' active' : ''}" data-model="${m}">${m}</button>`
  ).join('');
}

/* ---------- translate flow ---------- */
function setBusy(busy, label = 'Translate') {
  $('translateBtn').disabled = busy;
  $('translateBtn').classList.toggle('busy', busy);
  $('ctaText').textContent = busy ? 'Translating…' : label;
  $('ctaOrb').innerHTML = busy ? '◌' : '&rarr;';
}

function showError(msg) {
  const box = $('errorBox');
  box.textContent = msg;
  box.classList.remove('hidden');
}

function friendlyError(err) {
  if (err.kind === 'network') return 'Could not reach the server. Check Tailscale is on, then try again — or use the phrasebook.';
  if (err.kind === 'parse') return 'The model answered in a weird format. Hit translate again — it usually sorts itself out.';
  return err.message || 'Something went wrong.';
}

async function requestAndRender(messages, { isCorrection = false, correctedIntensity = null } = {}) {
  const settings = getSettings();
  $('errorBox').classList.add('hidden');
  setBusy(true);
  try {
    const result = await chatJSON(settings, messages);
    if (!result?.reading || !result.translation) throw Object.assign(new Error('The model returned something unreadable'), { kind: 'parse' });

    if (isCorrection) {
      addCorrection({
        original: currentOriginal(messages),
        modelIntensity: state.modelIntensity,
        correctedIntensity,
        finalTranslation: result.translation,
        ts: Date.now(),
      });
      renderProfileCount();
    }
    state.messages = messages;
    state.lastResult = result;
    render(result);
    setOnline(true);
  } catch (err) {
    showError(friendlyError(err));
    if (err.kind === 'network') setOnline(false);
  } finally {
    setBusy(false);
  }
}

function currentOriginal(messages) {
  const first = messages.find((m) => m.role === 'user');
  const match = first?.content.match(/What I want to say: "([\s\S]*)"$/);
  return match ? match[1] : first?.content ?? '';
}

function translate() {
  const text = $('input').value.trim();
  if (!text) return;
  const settings = getSettings();
  if (!settings.baseUrl || !settings.model) {
    openSheet();
    $('testResult').textContent = 'Add the server address and model first.';
    $('testResult').className = 'test-result bad';
    return;
  }
  const messages = buildMessages({ text, audience: state.audience, corrections: getRecentCorrections() });
  requestAndRender(messages);
}

function render(result) {
  const intensity = clampIntensity(result.reading.intensity);
  state.modelIntensity = intensity;
  $('readingMeaning').textContent = result.reading.meaning ?? '';
  $('readingFeeling').textContent = result.reading.feeling ?? '';
  $('translationText').textContent = result.translation;
  $('ntHeard').textContent = result.explanation?.nt_heard ?? '';
  $('whatChanged').textContent = result.explanation?.what_changed ?? '';
  $('dial').value = intensity;
  updateDial();
  $('results').classList.remove('hidden');
  // retrigger the reveal animation
  document.querySelectorAll('#results .reveal').forEach((el) => {
    el.style.animation = 'none';
    void el.offsetHeight;
    el.style.animation = '';
  });
}

function clampIntensity(n) {
  return Math.min(5, Math.max(1, Math.round(Number(n) || 3)));
}

/* ---------- intensity dial ---------- */
function updateDial() {
  const value = Number($('dial').value);
  const { label, hint } = INTENSITY_LABELS.find((l) => l.value === value);
  $('dialLabel').textContent = `${value} · ${label}`;
  $('dialHint').textContent = hint;
  $('dial').style.setProperty('--fill', `${((value - 1) / 4) * 100}%`);
  $('retranslateBtn').classList.toggle('hidden', value === state.modelIntensity || !state.lastResult);
}

function retranslate() {
  const corrected = Number($('dial').value);
  const messages = buildCorrectionMessages(state.messages, state.lastResult, corrected);
  requestAndRender(messages, { isCorrection: true, correctedIntensity: corrected });
}

function anotherWay() {
  if (!state.lastResult) return;
  requestAndRender(buildAlternativeMessages(state.messages, state.lastResult));
}

async function copyTranslation() {
  try {
    await navigator.clipboard.writeText($('translationText').textContent);
    $('copyBtn').textContent = 'Copied';
    setTimeout(() => { $('copyBtn').textContent = 'Copy'; }, 1600);
  } catch {
    showError('Could not copy — long-press the text instead.');
  }
}

/* ---------- audience chips ---------- */
function renderAudienceChips() {
  $('audienceChips').innerHTML = AUDIENCES.map(
    (a) => `<button class="chip${a.id === state.audience ? ' active' : ''}" role="radio" aria-checked="${a.id === state.audience}" data-audience="${a.id}">${a.label}</button>`
  ).join('');
}

/* ---------- phrasebook ---------- */
function renderPbChips() {
  const cats = [{ id: 'all', label: 'All' }, ...CATEGORIES];
  $('pbChips').innerHTML = cats.map(
    (c) => `<button class="chip${c.id === state.pbCategory ? ' active' : ''}" data-category="${c.id}">${c.label}</button>`
  ).join('');
}

function renderPhrasebook() {
  const q = $('pbSearch').value.trim().toLowerCase();
  const entries = PHRASEBOOK.filter((e) => {
    if (state.pbCategory !== 'all' && e.category !== state.pbCategory) return false;
    if (!q) return true;
    return [e.situation, e.direct, e.rendered, e.note].join(' ').toLowerCase().includes(q);
  });
  $('pbList').innerHTML = entries.length
    ? entries.map((e) => `
      <section class="shell card pb-entry">
        <div class="core">
          <p class="situation">${e.situation}</p>
          <p class="direct">“${e.direct}”</p>
          <p class="rendered">“${e.rendered}”</p>
          <p class="note">${e.note}</p>
        </div>
      </section>`).join('')
    : '<p class="pb-empty">Nothing matches — try fewer words.</p>';
}

/* ---------- views ---------- */
function switchView(view) {
  $('viewTranslate').classList.toggle('hidden', view !== 'translate');
  $('viewPhrasebook').classList.toggle('hidden', view !== 'phrasebook');
  document.querySelectorAll('.dock-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  window.scrollTo({ top: 0 });
}

/* ---------- settings sheet ---------- */
function openSheet() {
  const s = getSettings();
  $('setBaseUrl').value = s.baseUrl;
  $('setModel').value = s.model;
  $('setApiKey').value = s.apiKey;
  renderProfileCount();
  document.body.classList.add('sheet-open');
}

function closeSheet() {
  document.body.classList.remove('sheet-open');
  refreshStatus();
}

function persistSettings() {
  saveSettings({
    baseUrl: normalizeBaseUrl($('setBaseUrl').value),
    model: $('setModel').value.trim(),
    apiKey: $('setApiKey').value.trim(),
  });
}

async function testConnection() {
  persistSettings();
  const out = $('testResult');
  out.textContent = 'Checking…';
  out.className = 'test-result';
  const res = await pingServer(getSettings());
  if (res.ok) {
    renderModelChips(res.models);
    out.textContent = res.models.length
      ? `Connected — ${res.models.length} model${res.models.length > 1 ? 's' : ''} available below.`
      : 'Connected, but no models are loaded on the server.';
    out.className = 'test-result ok';
  } else {
    out.textContent = res.error;
    out.className = 'test-result bad';
  }
  setOnline(res.ok);
}

function renderProfileCount() {
  const n = getProfile().corrections.length;
  $('profileCount').textContent = n === 0 ? 'No corrections saved yet.' : `${n} correction${n > 1 ? 's' : ''} saved on this phone.`;
}

/* ---------- wiring ---------- */
function init() {
  renderAudienceChips();
  renderPbChips();
  renderPhrasebook();
  updateDial();
  refreshStatus();

  $('translateBtn').addEventListener('click', translate);
  $('retranslateBtn').addEventListener('click', retranslate);
  $('againBtn').addEventListener('click', anotherWay);
  $('copyBtn').addEventListener('click', copyTranslation);
  $('dial').addEventListener('input', updateDial);

  $('audienceChips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-audience]');
    if (!btn) return;
    state.audience = btn.dataset.audience;
    renderAudienceChips();
  });

  $('pbChips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-category]');
    if (!btn) return;
    state.pbCategory = btn.dataset.category;
    renderPbChips();
    renderPhrasebook();
  });
  $('pbSearch').addEventListener('input', renderPhrasebook);

  $('modelChips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-model]');
    if (!btn) return;
    $('setModel').value = btn.dataset.model;
    persistSettings();
    $('modelChips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === btn));
  });

  document.querySelector('.dock').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) switchView(btn.dataset.view);
  });
  $('gotoPhrasebook').addEventListener('click', () => switchView('phrasebook'));

  $('settingsBtn').addEventListener('click', openSheet);
  $('sheetBackdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  ['setBaseUrl', 'setModel', 'setApiKey'].forEach((id) => $(id).addEventListener('change', persistSettings));
  $('testBtn').addEventListener('click', testConnection);
  $('clearProfileBtn').addEventListener('click', () => { clearProfile(); renderProfileCount(); });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
