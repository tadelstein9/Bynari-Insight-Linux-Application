// === In-flight record store ===
// localStorage holds the queue of items + which one is currently active.
// Persistence is metadata only; uploaded photo File objects live in
// in-memory _objectUrls because file:// across origins doesn't fly in
// webviews. Photo paths persist; thumbnails re-bind when the user
// resumes via the file picker.

const STORAGE_KEY = 'bynari.items';
const ACTIVE_KEY  = 'bynari.activeItemId';
const STEP_ORDER  = ['photos','identify','comps','category','title','datasheet','measureup'];
// Human labels for the queue card — must match the sidebar nav labels.
// Never show the raw route token (e.g. "comps") to the seller.
const STEP_LABELS = {
  photos:    'Your item',
  identify:  'Identify',
  comps:     'Items like yours',
  category:  'Category',
  title:     'Title & Description',
  datasheet: 'Datasheet',
  measureup: 'Analyzer',
};

// === Tier ===
// Free tier is unlimited — no counter, no wall, no registration
// (memory bynari-free-tier-five-listings-policy). Metering code removed;
// only the free-vs-paid chrome distinction remains.
const TIER_OVERRIDE_KEY = 'bynari.tier';

function tierMode() {
  // URL param override (?tier=free|paid) — operator/testing toggle, lets us
  // preview either tier on localhost without changing host. Stays in the URL
  // through hash navigation, so the whole walkthrough renders in that tier.
  const param = new URLSearchParams(location.search).get('tier');
  if (param === 'free' || param === 'paid') return param;
  // localStorage override next (operator/testing toggle).
  const override = localStorage.getItem(TIER_OVERRIDE_KEY);
  if (override === 'free' || override === 'paid') return override;
  // Default: localhost (Pywebview http_server) = paid desktop. Any other
  // hostname (bynari-insight.com etc.) = free tier.
  const host = location.hostname;
  return (host === 'localhost' || host === '127.0.0.1') ? 'paid' : 'free';
}

const _dataUrls = new Map();  // photo.path → data URL (session-only, in-memory)

// Free public web → sessionStorage: the in-flight queue clears when the browser
// closes, so each visitor gets a clean walkthrough and no one inherits the last
// person's work. It still survives a refresh within the same visit. Paid desktop
// → localStorage/SQLite: persistence is the seller's own inventory brain
// (save-and-resume), cleared only by hand via File → Clear all data.
function stateStore() {
  return tierMode() === 'free' ? window.sessionStorage : window.localStorage;
}
// One-time purge of any queue previously persisted to localStorage on the free
// web tier (written before this switch) — otherwise a stale item lingers there.
if (typeof window !== 'undefined' && tierMode() === 'free') {
  try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(ACTIVE_KEY); } catch (e) {}
}

function loadItems() {
  try { return JSON.parse(stateStore().getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}
function saveItems(items) {
  stateStore().setItem(STORAGE_KEY, JSON.stringify(items));
}
function getActiveId() { return stateStore().getItem(ACTIVE_KEY); }
function setActive(id) {
  if (id) stateStore().setItem(ACTIVE_KEY, id);
  else stateStore().removeItem(ACTIVE_KEY);
}
function getActive() {
  const id = getActiveId();
  if (!id) return null;
  return loadItems().find(i => i.id === id) || null;
}

function newItem() {
  const id = `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const item = {
    id,
    createdAt: new Date().toISOString(),
    status: 'photos',
    photos: [],
    identify: { brand: '', model: '', year: '', size: '', userDescription: '' },
    comps: [],
    category: null,
    title: '',
    description: '',
    conditionChoice: '',
    specifics: {},
  };
  const items = loadItems();
  items.unshift(item);
  saveItems(items);
  setActive(id);
  return item;
}

function updateActive(patch) {
  const items = loadItems();
  const id = getActiveId();
  const idx = items.findIndex(i => i.id === id);
  if (idx < 0) return null;
  const next = { ...items[idx], ...(typeof patch === 'function' ? patch(items[idx]) : patch) };
  items[idx] = next;
  saveItems(items);
  return next;
}

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

function itemLabel(item) {
  const id = item.identify || {};
  if (id.brand && id.model) return `${id.brand} ${id.model}`;
  if (id.brand) return id.brand;
  if ((item.photos || []).length) return `${item.photos.length} photo${item.photos.length === 1 ? '' : 's'}`;
  if (item.batchId) return `${item.batchTemplateName || 'Batch'} — item ${item.batchSeq} of ${item.batchTotal}`;
  return 'Untitled item';
}

// An "Untitled item" draft the seller opened but never put anything into.
// Clicking "create a listing" spawns a blank stub; if they back out without
// adding a photo, a brand/model, or any text, there's nothing to resume — so it
// shouldn't linger in My listings. Anything WITH content (or a saved datasheet,
// or a planned batch member) is kept. Batch stubs are intentional and exempt.
function isEmptyDraft(item) {
  if (!item || item.savedAt || item.batchId) return false;
  const id = item.identify || {};
  const hasIdentify = !!(id.brand || id.model || id.year || id.size || id.userDescription);
  const hasPhotos = (item.photos || []).length > 0;
  const hasComps = (item.comps || []).length > 0;
  const hasCategory = !!item.category;
  const hasText = !!(item.title || item.description || item.conditionChoice);
  const hasSpecifics = item.specifics && Object.keys(item.specifics).length > 0;
  return !(hasIdentify || hasPhotos || hasComps || hasCategory || hasText || hasSpecifics);
}

// Drop abandoned blank stubs. Called when My listings renders — reaching that
// screen means the seller has left whatever draft they had open, so an empty one
// is abandoned. Returns true if anything was removed.
function pruneEmptyDrafts() {
  const items = loadItems();
  const kept = items.filter(it => !isEmptyDraft(it));
  if (kept.length === items.length) return false;
  saveItems(kept);
  if (!kept.some(it => it.id === getActiveId())) setActive(null);
  return true;
}

// === Routing ===
const navItems = document.querySelectorAll('.nav-item, [data-route]');
const screens  = document.querySelectorAll('.screen');

// === In-app dialogs ===
// Native confirm()/alert() in the desktop shell render an ugly title bar that
// leaks the localhost URL ("JavaScript Confirm — http://127.0.0.1…"). Route
// every popup through a styled modal that matches the rest of the app.
function showDialog({ message, okLabel = 'OK', cancelLabel = null, danger = false }) {
  return new Promise(resolve => {
    let backdrop = document.getElementById('appDialog');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'appDialog';
      backdrop.className = 'modal-backdrop hidden';
      backdrop.innerHTML = '<div class="modal" role="dialog" aria-modal="true">'
        + '<p class="modal-body" id="appDialogBody"></p>'
        + '<div class="modal-actions" id="appDialogActions"></div></div>';
      document.body.appendChild(backdrop);
    }
    backdrop.querySelector('#appDialogBody').textContent = message || '';
    const actions = backdrop.querySelector('#appDialogActions');
    actions.innerHTML = '';
    const done = val => { backdrop.classList.add('hidden'); resolve(val); };
    if (cancelLabel !== null) {
      const c = document.createElement('button');
      c.className = 'button secondary';
      c.textContent = cancelLabel;
      c.addEventListener('click', () => done(false));
      actions.appendChild(c);
    }
    const ok = document.createElement('button');
    ok.className = 'button ' + (danger ? 'danger' : 'primary');
    ok.textContent = okLabel;
    ok.addEventListener('click', () => done(cancelLabel !== null ? true : undefined));
    actions.appendChild(ok);
    backdrop.classList.remove('hidden');
    ok.focus();
  });
}
function showConfirm(message, opts = {}) {
  return showDialog({ message, okLabel: opts.okLabel || 'Yes', cancelLabel: opts.cancelLabel || 'Cancel', danger: opts.danger !== false });
}
function showAlert(message) {
  return showDialog({ message, okLabel: 'OK' });
}
// alert() callers never read a return value, so a fire-and-forget styled modal
// is a drop-in replacement everywhere.
window.alert = msg => { showAlert(String(msg)); };

// Safeguard: never let an in-app link navigate the embedded webview away from
// the app — that blanks the whole UI and strips the navigation (no way back).
// Any external (http/https) link, or any target=_blank, opens in the system
// browser via the bridge instead. Capture phase so it wins over the link's own
// handlers. Covers every current and future external link in one place.
document.addEventListener('click', e => {
  const a = e.target.closest ? e.target.closest('a[href]') : null;
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (!/^https?:\/\//i.test(href) && a.target !== '_blank') return;  // leave #routes alone
  e.preventDefault();
  if (!href || href === '#') return;
  const api = window.pywebview && window.pywebview.api;
  if (api && api.open_url) api.open_url(href);
  else window.open(href, '_blank');   // web build: a real new tab is fine
}, true);

function routeTo(name) {
  // Block walkthrough routes if no active item
  const isWalkStep = STEP_ORDER.includes(name);
  if (isWalkStep && !getActive()) {
    name = 'home';
  }
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.route === name);
  });
  screens.forEach(s => s.classList.toggle('hidden', s.dataset.screen !== name));
  if (location.hash !== '#' + name) location.hash = '#' + name;
  refreshSidebarState();
  refreshScreenNav(name);

  // Re-render the screen if it has a render hook
  if (name === 'home')     renderHome();
  if (name === 'photos')   renderPhotos();
  if (name === 'identify') renderIdentify();
  if (name === 'comps')    renderComps();
  if (name === 'category') renderCategory();
  if (name === 'title')    renderTitleDescription();
  if (name === 'datasheet') renderDatasheet();
  if (name === 'measureup') renderMeasureUp();
  if (name === 'batch') renderBatchSetup();
  if (name === 'rewrite-result') renderRewriteResult();
  if (name === 'worklist') renderWorklist();
}

navItems.forEach(item => {
  if (!item.dataset.route) return;
  item.addEventListener('click', e => {
    e.preventDefault();
    switchTab('listing');   // every walkthrough route lives in the Listings tab
    routeTo(item.dataset.route);
  });
});

document.querySelectorAll('[data-next]').forEach(btn => {
  btn.addEventListener('click', () => {
    const active = getActive();
    if (active) updateActive({ status: btn.dataset.next });
    routeTo(btn.dataset.next);
  });
});

// === Sidebar walkthrough enable/disable ===
function refreshSidebarState() {
  const hasActive = !!getActive();
  document.querySelectorAll('.walk-step').forEach(el => {
    el.classList.toggle('disabled', !hasActive);
  });
  // "Start over" only makes sense when there's an item to abandon.
  document.getElementById('startOverLink')?.classList.toggle('hidden', !hasActive);
}

// === Global navigation history (Back / Forward across the whole app) ===
// The top Back/Forward arrows live in the tab bar and work everywhere —
// walkthrough steps, the Analyzer and Inventory tabs, and the splash — by
// replaying where the user has actually been (no one-off "get back" links).
let _navHist = ['splash'];   // the app always opens on the splash
let _navIdx = 0;
let _navRestoring = false;
let _navRecordPending = false;

function currentLocation() {
  const debut = document.getElementById('debut');
  if (debut && !debut.classList.contains('hidden')) return 'splash';
  const tab = document.querySelector('.tab-bar-btn.active[data-tab]')?.dataset.tab || 'listing';
  return tab === 'listing' ? 'listing:' + getCurrentRoute() : tab;
}

function applyLocation(loc) {
  const debut = document.getElementById('debut');
  if (loc === 'splash') { debut?.classList.remove('hidden'); renderLauncherResume(); return; }
  debut?.classList.add('hidden');
  if (loc.startsWith('listing:')) { switchTab('listing'); routeTo(loc.slice(8) || 'home'); }
  else switchTab(loc);   // 'analyze' | 'inventory'
}

// Record the resting location once per user action (microtask-coalesced so a
// switchTab()+routeTo() pair collapses to one history entry). Skipped while
// replaying history.
function recordLocation() {
  if (_navRestoring || _navRecordPending) return;
  _navRecordPending = true;
  Promise.resolve().then(() => {
    _navRecordPending = false;
    const loc = currentLocation();
    if (_navHist[_navIdx] !== loc) {
      _navHist = _navHist.slice(0, _navIdx + 1);
      _navHist.push(loc);
      _navIdx = _navHist.length - 1;
    }
    updateGlobalNav();
  });
}

function updateGlobalNav() {
  const back = document.getElementById('navBack');
  const fwd  = document.getElementById('navForward');
  if (back) back.disabled = _navIdx <= 0;
  if (fwd)  fwd.disabled  = _navIdx >= _navHist.length - 1;
  updateBottomNav();
}

// The walkthrough steps already carry their own Back/Next footer (the flow
// buttons that advance the listing). Every OTHER page gets the global bottom
// Back/Next bar, which steps through the app's sections in tab order —
// Listings → Analyzer → My Inventory — so Next always moves you to the next
// page (the same destination as the tab above), Back to the previous one.
const _flowSteps = new Set(['photos', 'identify', 'comps', 'category', 'title', 'datasheet', 'measureup']);
const _bottomTabSeq = ['listing', 'analyze', 'inventory'];

function currentTabName() {
  const loc = currentLocation();
  return loc.startsWith('listing:') ? 'listing' : loc;  // analyze | inventory | settings | splash
}

function bottomNavStep(dir) {
  const i = _bottomTabSeq.indexOf(currentTabName());
  const j = i + dir;
  if (i < 0 || j < 0 || j >= _bottomTabSeq.length) return;
  switchTab(_bottomTabSeq[j]);
}

function updateBottomNav() {
  const bar = document.getElementById('bottomNav');
  if (!bar) return;
  const loc = currentLocation();
  const isFlowStep = loc.startsWith('listing:') && _flowSteps.has(loc.slice(8));
  const i = _bottomTabSeq.indexOf(currentTabName());
  const show = tierMode() === 'paid' && i >= 0 && !isFlowStep;
  bar.classList.toggle('hidden', !show);
  document.body.classList.toggle('has-bottom-nav', show);
  // No dead buttons: at the first section "Back" becomes a Home button, and at
  // the last section "Next" becomes one — so a first-time user always has a
  // labelled, clickable way out instead of a greyed-out stub.
  const back = document.getElementById('bottomNavBack');
  const next = document.getElementById('bottomNavNext');
  const atFirst = i === 0;
  const atLast  = i === _bottomTabSeq.length - 1;
  if (back) {
    back.textContent = atFirst ? '⌂ Home' : 'Back';
    back.classList.toggle('bottom-nav-home', atFirst);
    back.disabled = false;   // ends are clickable Home buttons — never dead
  }
  if (next) {
    next.textContent = atLast ? '⌂ Home' : 'Next';
    next.classList.toggle('bottom-nav-home', atLast);
    next.disabled = false;
  }
}

function navGoBack() {
  if (_navIdx <= 0) return;
  _navRestoring = true;
  _navIdx--;
  applyLocation(_navHist[_navIdx]);
  _navRestoring = false;
  updateGlobalNav();
}
function navGoForward() {
  if (_navIdx >= _navHist.length - 1) return;
  _navRestoring = true;
  _navIdx++;
  applyLocation(_navHist[_navIdx]);
  _navRestoring = false;
  updateGlobalNav();
}

document.getElementById('navBack')?.addEventListener('click', navGoBack);
document.getElementById('navForward')?.addEventListener('click', navGoForward);
// Refresh — reload the page so the current view re-reads your data (and any update).
document.getElementById('navRefresh')?.addEventListener('click', () => location.reload());
document.getElementById('bottomNavBack')?.addEventListener('click', () => {
  if (_bottomTabSeq.indexOf(currentTabName()) <= 0) goHome();
  else bottomNavStep(-1);
});
document.getElementById('bottomNavNext')?.addEventListener('click', () => {
  if (_bottomTabSeq.indexOf(currentTabName()) >= _bottomTabSeq.length - 1) goHome();
  else bottomNavStep(1);
});

// routeTo() calls this on every screen change; it's the record hook now.
function refreshScreenNav() {
  recordLocation();
}

function getCurrentRoute() {
  return (location.hash || '#home').slice(1);
}

// === Home screen ===
// Batch groups that are expanded in the queue (persists across re-renders).
const _expandedBatches = new Set();

function queueCardHtml(item) {
  const isSaved = !!item.savedAt;
  const stepLabel = STEP_LABELS[item.status] || item.status;
  const stepIdx = STEP_ORDER.indexOf(item.status) + 1;
  const meta = isSaved
    ? `Saved ${timeAgo(item.savedAt)}`
    : `Step ${stepIdx} of ${STEP_ORDER.length} · ${stepLabel}`;
  const action = isSaved ? 'Open' : 'Resume';
  return `<div class="queue-card${isSaved ? ' saved' : ''}">
      <div class="queue-card-main">
        <div class="queue-card-title">${itemLabel(item)}</div>
        <div class="queue-card-meta">${meta}</div>
      </div>
      <button class="button secondary queue-card-resume" data-item-id="${item.id}">${action}</button>
      <button class="queue-card-discard" data-item-id="${item.id}" title="Discard this item" aria-label="Discard">✕</button>
    </div>`;
}

function renderHome() {
  refreshSidebarState();
  pruneEmptyDrafts();  // drop abandoned blank "Untitled item" stubs
  const items = loadItems();
  const empty = document.getElementById('homeEmpty');
  const queue = document.getElementById('homeQueue');
  const list  = document.getElementById('queueList');

  if (items.length === 0) {
    empty.classList.remove('hidden');
    queue.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  queue.classList.remove('hidden');

  // Partition into batch groups + single items, preserving first-seen order, so
  // a spawned batch reads as one unit instead of N loose cards.
  const blocks = [];
  const batchAt = {};
  for (const item of items) {
    if (item.batchId) {
      if (!(item.batchId in batchAt)) {
        batchAt[item.batchId] = blocks.length;
        blocks.push({ type: 'batch', batchId: item.batchId, members: [] });
      }
      blocks[batchAt[item.batchId]].members.push(item);
    } else {
      blocks.push({ type: 'single', item });
    }
  }

  list.innerHTML = blocks.map(b => {
    if (b.type === 'single') return queueCardHtml(b.item);
    const members = b.members.slice().sort((x, y) => (x.batchSeq || 0) - (y.batchSeq || 0));
    const n = members.length;
    const done = members.filter(m => m.savedAt).length;
    const name = members[0]?.batchTemplateName || 'Batch';
    const expanded = _expandedBatches.has(b.batchId);
    const hasNext = members.some(m => !m.savedAt);
    return `<div class="batch-group">
      <div class="batch-group-head">
        <button class="batch-group-toggle" data-batch-toggle="${b.batchId}" aria-expanded="${expanded}">${expanded ? '▾' : '▸'}</button>
        <div class="batch-group-info">
          <div class="batch-group-title">${escapeHtml(name)} — batch of ${n}</div>
          <div class="batch-group-meta">${done} of ${n} done${_batchExported[b.batchId] ? ' · exported' : ''}</div>
        </div>
        ${hasNext ? `<button class="button secondary batch-group-continue" data-batch-continue="${b.batchId}">Continue →</button>` : ''}
        <button class="button secondary batch-group-export" data-batch-export="${b.batchId}">Export →</button>
        <button class="batch-group-discard" data-batch-discard="${b.batchId}" title="Discard this batch" aria-label="Discard batch">✕</button>
      </div>
      <div class="batch-group-members${expanded ? '' : ' hidden'}">
        ${members.map(queueCardHtml).join('')}
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.queue-card-resume').forEach(btn => {
    btn.addEventListener('click', () => {
      setActive(btn.dataset.itemId);
      const item = getActive();
      routeTo(item?.status || 'photos');
    });
  });

  list.querySelectorAll('.queue-card-discard[data-item-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.itemId;
      const item = loadItems().find(i => i.id === id);
      const label = item ? itemLabel(item) : 'this item';
      if (!(await showConfirm(`Discard "${label}"? This can't be undone.`))) return;
      saveItems(loadItems().filter(i => i.id !== id));
      if (getActiveId() === id) setActive(null);
      renderHome();
    });
  });

  list.querySelectorAll('[data-batch-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.batchToggle;
      if (_expandedBatches.has(id)) _expandedBatches.delete(id); else _expandedBatches.add(id);
      renderHome();
    });
  });

  list.querySelectorAll('[data-batch-continue]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.batchContinue;
      const members = loadItems().filter(i => i.batchId === id)
        .sort((x, y) => (x.batchSeq || 0) - (y.batchSeq || 0));
      const next = members.find(m => !m.savedAt) || members[0];
      if (next) { setActive(next.id); routeTo(next.status || 'photos'); }
    });
  });

  list.querySelectorAll('[data-batch-export]').forEach(btn => {
    btn.addEventListener('click', () => exportBatch(btn.dataset.batchExport));
  });

  list.querySelectorAll('[data-batch-discard]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.batchDiscard;
      const count = loadItems().filter(i => i.batchId === id).length;
      if (!(await showConfirm(`Discard this whole batch of ${count}? This can't be undone.`))) return;
      saveItems(loadItems().filter(i => i.batchId !== id));
      if (getActive()?.batchId === id) setActive(null);
      renderHome();
    });
  });
}

// === Photos screen ===
// Per-category photo roles eBay prescribes in its Sell flow (Front, Dial,
// Measurement, …). eBay doesn't expose these via API, so Bynari ships its own
// taxonomy in photo_roles.json (canonical copy seeded into cassini.db). Loaded
// once and matched to the item's category; categories with no prescribed roles
// (e.g. computer keyboards) show no guidance.
let _photoRoles = null;
async function loadPhotoRoles() {
  if (_photoRoles) return _photoRoles;
  try {
    const res = await fetch('photo_roles.json', { cache: 'no-store' });
    _photoRoles = res.ok ? await res.json() : { families: [] };
  } catch (e) { _photoRoles = { families: [] }; }
  return _photoRoles;
}

// Return {family, label, roles[]} for a category {name, path}, or empty roles
// when nothing is prescribed.
function photoRolesForCategory(spec, category) {
  const empty = { family: null, label: null, roles: [] };
  if (!category) return empty;
  const name = `${category.name || category.categoryName || ''}`;
  const path = `${category.path || category.full_path || category.category_path || ''}`;
  for (const fam of (spec.families || [])) {
    const m = fam.match || {};
    const pathHit = (m.pathAny || []).some(s => s && path.includes(s));
    const nameHit = (m.nameAny || []).some(t => t && (name === t || name.includes(t)));
    if (pathHit || nameHit) return { family: fam.family, label: fam.label, roles: fam.roles || [] };
  }
  return empty;
}

// Show, when the category is known, the shots buyers look for in this kind of
// listing. Renders only when roles exist (no empty container otherwise).
async function renderPhotoRoleGuidance() {
  const box = document.getElementById('photoRolesGuide');
  if (!box) return;
  const item = getActive();
  const spec = await loadPhotoRoles();
  const match = photoRolesForCategory(spec, item && item.category);
  if (!match.roles.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const chips = match.roles
    .map(r => `<span class="photo-role-chip" title="${escapeHtml(r.hint || '')}">${escapeHtml(r.name)}</span>`)
    .join('');
  box.innerHTML = '<div class="photo-roles-head">Shots buyers look for</div>'
    + `<div class="photo-roles-chips">${chips}</div>`;
  box.classList.remove('hidden');
}

function renderPhotos() {
  const grid = document.getElementById('photoGrid');
  if (!grid) return;
  const item = getActive();
  if (!item) { grid.innerHTML = ''; return; }
  renderPhotoRoleGuidance();

  // "Tell us about it" now lives on the Photos screen — keep it in sync.
  const desc = document.getElementById('identifyUserDesc');
  if (desc) desc.value = item.identify.userDescription || '';

  // Optional per-photo role labels, drawn from the category's role set when one
  // is known (cached; load then re-render). Bynari's own short list — the seller
  // labels what they have; we map it to eBay's slots under the covers. No
  // pressure to fill every slot, and nothing shows when no roles are prescribed.
  const roleMatch = _photoRoles ? photoRolesForCategory(_photoRoles, item.category) : null;
  if (!_photoRoles) loadPhotoRoles().then(() => renderPhotos());
  const roleOptions = roleMatch ? roleMatch.roles : [];

  grid.innerHTML = '';
  item.photos.forEach((p, idx) => {
    const card = document.createElement('div');
    card.className = 'photo-card' + (idx === 0 ? ' cover' : '');
    card.draggable = true;
    const src = _dataUrls.get(p.path) || '';
    const placeholder = src ? '' : '<div class="photo-placeholder">' + (p.name || 'photo') + '</div>';
    const roleSel = roleOptions.length
      ? `<select class="photo-role-select" data-path="${p.path}" draggable="false" title="Label this shot (optional)">`
        + '<option value="">— role —</option>'
        + roleOptions.map(r => `<option value="${escapeHtml(r.name)}"${p.role === r.name ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('')
        + '</select>'
      : '';
    card.innerHTML = `
      ${src ? `<img src="${src}" alt="${p.name || 'photo'}">` : placeholder}
      <div class="photo-remove" data-path="${p.path}" title="Remove">×</div>
      ${roleSel}
    `;
    grid.appendChild(card);
  });

  // Tag a photo with its role; updateActive persists it (no re-render needed).
  grid.querySelectorAll('.photo-role-select').forEach(sel => {
    sel.addEventListener('mousedown', e => e.stopPropagation());  // don't start a card drag
    sel.addEventListener('change', () => {
      const path = sel.dataset.path;
      const role = sel.value || null;
      updateActive(curr => ({ photos: curr.photos.map(ph => ph.path === path ? { ...ph, role } : ph) }));
    });
  });

  const addCard = document.createElement('div');
  addCard.className = 'photo-card add';
  addCard.id = 'photoAddCard';
  addCard.innerHTML = `<div class="add-icon">+</div><div>Add photos</div>`;
  grid.appendChild(addCard);

  addCard.addEventListener('click', addPhotos);

  grid.querySelectorAll('.photo-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const path = btn.dataset.path;
      updateActive(curr => ({ photos: curr.photos.filter(ph => ph.path !== path) }));
      _dataUrls.delete(path);
      renderPhotos();
    });
  });
}

async function addPhotos() {
  // Pywebview path: native picker, returns paths + data URLs from Python.
  if (window.pywebview?.api?.pick_photos) {
    let files;
    try {
      files = await window.pywebview.api.pick_photos();
    } catch (err) {
      console.error('pick_photos failed', err);
      return;
    }
    if (!files || !files.length) return;
    const newPhotos = files.map(f => {
      _dataUrls.set(f.path, f.data_url);
      return { path: f.path, name: f.name };
    });
    updateActive(curr => ({ photos: [...curr.photos, ...newPhotos] }));
    renderPhotos();
    return;
  }
  // Browser fallback: HTML file input. Triggers the standard OS picker.
  const input = document.getElementById('photoInput');
  if (input) input.click();
}

// Browser-mode file input change handler. No-op in Pywebview (input is unused
// there because pick_photos returns directly).
document.getElementById('photoInput')?.addEventListener('change', e => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const newPhotos = files.map(f => {
    const path = `${f.name}#${f.size}#${f.lastModified || 0}`;
    _dataUrls.set(path, URL.createObjectURL(f));
    return { path, name: f.name };
  });
  updateActive(curr => ({ photos: [...curr.photos, ...newPhotos] }));
  renderPhotos();
  e.target.value = '';  // allow re-selecting the same files
});

// === Identify screen ===
function renderIdentify() {
  const item = getActive();
  if (!item) return;
  document.getElementById('identifyBrand').value = item.identify.brand || '';
  document.getElementById('identifyModel').value = item.identify.model || '';
  document.getElementById('identifyYear').value = item.identify.year || '';
  document.getElementById('identifySize').value = item.identify.size || '';
  refreshIdentifyNext();
}

// All four Identify fields are optional now — many items have no brand, model,
// year, or size. Next is always available; the harvester does its best with
// whatever the seller can give. (Closes the brand-required gate.)
function refreshIdentifyNext() {
  const nextBtn = document.getElementById('identifyNextBtn');
  if (nextBtn) nextBtn.disabled = false;
}

// Structured fields live on the Identify screen. Merge them into identify
// without disturbing userDescription (captured on the Photos screen).
function persistIdentify() {
  const brand = document.getElementById('identifyBrand').value.trim();
  const model = document.getElementById('identifyModel').value.trim();
  const year  = document.getElementById('identifyYear').value.trim();
  const size  = document.getElementById('identifySize').value.trim();
  updateActive(curr => ({ identify: { ...curr.identify, brand, model, year, size } }));
  refreshIdentifyNext();
}

// "Tell us about it" lives on the Photos screen; it feeds the harvester's
// category cue and description fallback, so persist it on its own.
function persistUserDesc() {
  const userDescription = document.getElementById('identifyUserDesc').value.trim();
  updateActive(curr => ({ identify: { ...curr.identify, userDescription } }));
}

['identifyBrand', 'identifyModel', 'identifyYear', 'identifySize'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', persistIdentify);
});
document.getElementById('identifyUserDesc')?.addEventListener('input', persistUserDesc);

// === Items-like-yours screen (code-internal: "comps") ===
const SEARCH_ENDPOINT = 'https://api.tadelstein.com/item_summary_search.php';

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s || '';
  return div.innerHTML;
}

// Category cues distinguish what KIND of thing an item is, so a brand-noisy
// search can be steered back to the right category. Example: brand "Arnex"
// alone returns 50 pocket watches; appending the cue "wristwatch" (pulled from
// the seller's own words) pins the search to the right shelf.
//
// Order matters: multi-word cues come before their single-word substrings so
// "pocket watch" wins over "watch" and "sewing machine" wins over nothing.
// First match in this order is returned.
const CATEGORY_CUES = [
  'pocket watch', 'wrist watch', 'sewing machine',
  'wristwatch', 'watch',
  'car', 'truck', 'motorcycle', 'bicycle', 'bike',
  'dress', 'shirt', 'jeans', 'jacket', 'coat', 'boots', 'shoes', 'sneakers',
  'guitar', 'bass', 'amplifier', 'amp',
  'camera', 'lens', 'tripod',
  'book', 'record', 'vinyl', 'cd', 'dvd',
  'vacuum', 'blender', 'mixer', 'lamp',
  'ring', 'necklace', 'bracelet', 'earrings', 'brooch', 'pendant',
];

// Pull the first category cue that appears in the seller's free-text
// description, as a whole word. Returns '' when none match.
function extractCategoryCue(description) {
  if (!description) return '';
  const text = description.toLowerCase();
  for (const cue of CATEGORY_CUES) {
    // Word-boundary match so "watchband" doesn't register as "watch" and
    // "scar" doesn't register as "car".
    const re = new RegExp('\\b' + cue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    if (re.test(text)) return cue;
  }
  return '';
}

// Watch-part cues → eBay category to FILTER the comp search to, so an obscure
// part (a dial) finds part listings, not complete watches that mention "dial".
// Requires a part-INTENT signal too so a watch saying "black dial" isn't filtered.
const PART_WORD_CATEGORY = [
  ['dial', '57723'], ['crystal', '57715'], ['hands', '57721'], ['hand set', '57721'],
  ['movement', '57720'],
  ['bezel', '173696'], ['caseback', '173696'], ['case back', '173696'],
  ['mainspring', '173696'], ['hairspring', '173696'], ['balance wheel', '173696'],
  ['balance staff', '173696'], ['escape wheel', '173696'], ['setting lever', '173696'],
  ['train wheel bridge', '173696'], ['main plate', '173696'], ['pallet fork', '173696'],
  ['pusher', '173696'], ['crown', '173696'], ['stem', '173696'],
];
const PART_INTENT_RE = /(for parts|for repair|replacement|spare|new old stock|\bnos\b|\bpart\b|\bparts\b)/i;
function partCategoryForItem(item) {
  const desc = (item.identify?.userDescription || '').toLowerCase();
  if (!desc || !PART_INTENT_RE.test(desc)) return '';
  for (const [word, cat] of PART_WORD_CATEGORY) {
    const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    if (re.test(desc)) return cat;
  }
  return '';
}
(function injectCompsMismatchStyle() {
  const css = `.comps-mismatch { background:#fff7ed; border:1px solid #fed7aa; color:#9a3412;
    border-radius:8px; padding:10px 14px; margin:0 0 12px; font-size:13px; line-height:1.45; }`;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
})();

function buildSearchQuery(item, opts = {}) {
  // _compsOverrideQuery is set when the user pivots from a dead-end with a
  // fresh search angle (e.g. movement caliber after the brand search failed).
  // It replaces the composed brand+model+description query — but narrowing
  // terms typed afterward (compsRefinement) still append, so "A Schild 1187/94"
  // can be narrowed to "A Schild 1187/94 wristwatch" without losing the pivot.
  if (item._compsOverrideQuery) {
    const parts = [item._compsOverrideQuery];
    if (item.compsRefinement) parts.push(item.compsRefinement);
    return parts.join(' ').slice(0, 200);
  }

  const { mode = 'primary' } = opts;
  const parts = [];
  const hasBrand = !!item.identify.brand;
  const hasModel = !!item.identify.model;
  // The category cue (e.g. "wristwatch") steers brand-noisy searches back to
  // the right shelf. Pulled from the seller's own words; '' when none found.
  const cue = extractCategoryCue(item.identify.userDescription);

  if (mode === 'primary') {
    // brand + model + cue. eBay's Browse API does AND-style keyword matching,
    // so we keep this tight and let the ladder loosen it on a dry result.
    if (hasBrand) parts.push(item.identify.brand);
    if (hasModel) parts.push(item.identify.model);
    if (cue) parts.push(cue);
    // When no labels were provided at all, the description IS the query.
    if (!hasBrand && !hasModel && item.identify.userDescription) {
      parts.push(item.identify.userDescription);
    }
  } else if (mode === 'model-cue') {
    // Drop the brand, keep the model/caliber + category. For the Arnex case
    // this is "A Schild 1187/94 wristwatch" — the movement on a whole watch.
    if (hasModel) parts.push(item.identify.model);
    if (cue) parts.push(cue);
  } else if (mode === 'brand-cue') {
    // Drop the model, keep brand + category. This is the fix that turns
    // "Arnex" (50 pocket watches) into "Arnex wristwatch".
    if (hasBrand) parts.push(item.identify.brand);
    if (cue) parts.push(cue);
  } else if (mode === 'description') {
    if (item.identify.userDescription) parts.push(item.identify.userDescription);
  } else if (mode === 'brand-only') {
    // Last resort — accept the category noise rather than a dead end.
    if (hasBrand) parts.push(item.identify.brand);
  }

  if (item.compsRefinement) parts.push(item.compsRefinement);
  return parts.join(' ').slice(0, 200);
}

async function searchComps(q, opts) {
  // opts.filter / opts.sort are forwarded to the broker (Browse pass-through),
  // used by Buy mode. Existing comp callers pass no opts — behavior unchanged.
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String((opts && opts.limit) || COMPS_FETCH_MAX));
  if (opts && opts.categoryId) url.searchParams.set('category_id', opts.categoryId);
  if (opts && opts.filter) url.searchParams.set('filter', opts.filter);
  if (opts && opts.sort)   url.searchParams.set('sort', opts.sort);
  const resp = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  return data.itemSummaries || [];
}

// The refine block is always visible on Items-like-yours now.
// extractEbayItemId returns a string item id if the input looks like an
// eBay URL (or a raw long numeric id); else null.
function extractEbayItemId(text) {
  if (!text) return null;
  const cleaned = text.trim().replace(/^v1\|/, '');
  // Common eBay URL shapes: .../itm/<id>, .../itm/<slug>/<id>, ?item=<id>
  const patterns = [
    /[?&]item=(\d{8,})/i,
    /\/itm\/[^?#\s]*?(\d{10,})(?:[/?#]|$)/i,
    /^\s*(\d{10,15})\s*$/,
  ];
  for (const p of patterns) {
    const m = cleaned.match(p);
    if (m) return m[1];
  }
  return null;
}

const ITEM_ENDPOINT = 'https://api.tadelstein.com/item.php';
const ITEM_ASPECTS_ENDPOINT = 'https://api.tadelstein.com/item_aspects.php';
const HARVEST_MAX_COMPS = 8;

// === Aggregator (port of bynari-desktop/engine/aggregator.py) ===
const ASPECT_SYNONYMS = {
  'MPN': ['Part Number', 'Manufacturer Part Number'],
};

function _aliasToCanonical() {
  const out = {};
  for (const [canonical, aliases] of Object.entries(ASPECT_SYNONYMS)) {
    for (const alias of aliases) out[alias] = canonical;
  }
  return out;
}

function normalizeSpecKeys(specs) {
  const mapping = _aliasToCanonical();
  const out = {};
  for (const [k, v] of Object.entries(specs || {})) {
    const canonical = mapping[k] || k;
    if (!(canonical in out)) out[canonical] = v;
  }
  return out;
}

// Aspect names that are seller/listing metadata, not item attributes — some
// sellers add these as custom item specifics (e.g. "Sold By: Kings Watch
// House"). Filter them so they never reach the title, description, or specifics.
const NON_ITEM_ASPECTS = new Set([
  'seller', 'sold by', 'soldby', 'store', 'store name', 'shop',
  'ships from', 'ship from', 'shipping', 'shipping from', 'handling time',
  'location', 'item location', 'returns', 'return policy', 'payment',
  'business seller', 'feedback', 'listing type', 'price',
]);
function isItemAspect(name) {
  return !!name && !NON_ITEM_ASPECTS.has(name.trim().toLowerCase());
}
// eBay's aspect schema bolts compliance/logistics fields onto nearly every
// category (a pocket watch AND a watchmaker's tool both get "California Prop 65
// Warning" + "Personalization Instructions"). These are valid aspects but NEVER
// a buyer-search facet anywhere, so we don't recommend filling them. Distinct
// from NON_ITEM_ASPECTS (metadata leaks) — these are real, just not searched on.
// Category-INappropriate real facets (e.g. Band Type on a pocket watch) are NOT
// listed here; those are handled by comp fill-rate, since Band Type is a genuine
// facet in wristwatches. Extend conservatively — only add never-searched fields.
const NON_FACET_ASPECTS = new Set([
  'california prop 65 warning', 'personalization instructions',
  'unit type', 'unit quantity',
]);
function isBuyerFacet(name) {
  return !!name && !NON_FACET_ASPECTS.has(name.trim().toLowerCase());
}
function aspectsToSpecs(localizedAspects) {
  const specs = {};
  for (const a of localizedAspects || []) {
    if (a && a.name && isItemAspect(a.name)) specs[a.name] = a.value || '';
  }
  return specs;
}

function buildConsensus(comps, schemaAspects) {
  // Union complete-fill (NOT consensus-collapse). The harvest pool is the
  // user's survey selection. We build a row for EVERY cassini.db aspect for the
  // category (so blanks are visible and fillable — fill-until-full) AND for any
  // aspect a comp carries that the schema doesn't list (so nothing a "sell one
  // like this" draft would keep is silently dropped). Per field the value shown
  // is the most-common across the pool; the alternatives ride along in `values`.
  // Cassini now expects all aspects filled — every field on eBay's form has real
  // search demand — so we keep them all. See memory cassini-fill-all-aspects.
  const normalized = comps.map(c => normalizeSpecKeys(c.specs || {}));
  const total = comps.length;

  const rowFor = (name, aspect) => {
    const counter = new Map();
    for (const nspecs of normalized) {
      const v = (nspecs[name] || '').toString().trim();
      if (v) counter.set(v, (counter.get(v) || 0) + 1);
    }
    const coverage = [...counter.values()].reduce((a, b) => a + b, 0);
    const valuesSorted = [...counter.entries()].sort((a, b) => b[1] - a[1]);
    const consensus = valuesSorted.length ? valuesSorted[0][0] : '';
    let agreement;
    if (coverage === 0) agreement = 'none';
    else if (counter.size === 1) agreement = 'unanimous';
    else if (valuesSorted[0][1] > coverage / 2) agreement = 'majority';
    else agreement = 'split';
    const allowed = (aspect && aspect.allowedValues) || [];
    return {
      name,
      required: !!(aspect && aspect.required),
      inSchema: !!aspect,
      mode: (aspect && aspect.mode) || '',
      allowedValues: allowed,
      allowedValueCount: (aspect && aspect.allowedValueCount) || allowed.length,
      values: valuesSorted,
      coverage,
      compsTotal: total,
      consensus,
      agreement,
    };
  };

  const rows = [];
  const seen = new Set();
  // 1. Every cassini.db aspect for the category — required + recommended, in the
  //    schema's natural (priority) order.
  for (const aspect of schemaAspects || []) {
    const name = (aspect.name || '').trim();
    if (!name || seen.has(name) || !isBuyerFacet(name)) continue;
    seen.add(name);
    rows.push(rowFor(name, aspect));
  }
  // 2. Extra aspects the comps carry that the schema doesn't list — keep them
  //    (a "sell one like this" draft would). Preserve first-seen order.
  for (const nspecs of normalized) {
    for (const key of Object.keys(nspecs)) {
      const name = (key || '').trim();
      if (!name || seen.has(name) || !isBuyerFacet(name)) continue;
      seen.add(name);
      rows.push(rowFor(name, null));
    }
  }
  return rows;
}

function requiredGaps(rows) {
  return rows.filter(r => r.required && r.coverage === 0);
}

// === Harvest ===
function stripItemIdEnvelope(itemId) {
  // eBay summary search returns 'v1|<legacy>|<variant>' — strip to legacy id.
  if (!itemId) return '';
  const parts = ('' + itemId).split('|');
  return parts.length >= 2 ? parts[1] : ('' + itemId);
}

function compIdsForHarvest(item) {
  // Primary: the user's survey selections from the Items-like-yours checkboxes.
  // That curated set IS the harvest pool — no auto-padding with cache items.
  const ids = [];
  const survey = item.surveySelections || [];
  for (const c of survey) {
    const id = stripItemIdEnvelope(c.itemId);
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= HARVEST_MAX_COMPS) break;
  }

  // Backstop for legacy paths (Rewrite-a-listing currently sets a single
  // selectedComp directly without going through the survey screen).
  if (!ids.length && item.selectedComp?.itemId) {
    const sid = stripItemIdEnvelope(item.selectedComp.itemId);
    if (sid) ids.push(sid);
  }

  return ids;
}

async function fetchItemAspects(categoryId) {
  const url = new URL(ITEM_ASPECTS_ENDPOINT);
  url.searchParams.set('category_id', categoryId);
  const resp = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  if (data && data.error) throw new Error(data.error);
  return data.aspects || [];
}

// Collapse comps that are the SAME product — variation-reps or relistings whose
// titles are near-identical (raw-token Jaccard ≥ 0.7). Two reps of one product
// are NOT independent evidence; counting them separately fabricates consensus
// (e.g. two B*B Glass variation reps made the product code "MX 2297 197" in
// their Size field look agreed-upon). Uses raw titleTokens — unlike the
// discriminative clustering, here shared words SHOULD count toward sameness.
// Keeps the first of each product. (titleTokens is hoisted from below.)
function dedupeSameProduct(items) {
  const SAME_PRODUCT = 0.7;
  const kept = [], keptTokens = [];
  for (const it of items) {
    const toks = titleTokens(it.title || '');
    const isDup = keptTokens.some(kt => {
      if (!toks.size || !kt.size) return false;
      let inter = 0; for (const t of toks) if (kt.has(t)) inter++;
      return inter / (toks.size + kt.size - inter) >= SAME_PRODUCT;
    });
    if (!isDup) { kept.push(it); keptTokens.push(toks); }
  }
  return kept;
}

async function harvestForActiveItem() {
  const item = getActive();
  if (!item || !item.category?.id) return null;
  const ids = compIdsForHarvest(item);
  if (!ids.length) return null;

  // Fetch schema + a BROAD category fill-rate sample + each curated comp's full
  // item.php, all in parallel. The broad sample decides the FIELD SET; the
  // curated comps decide the VALUES.
  const [schemaResult, broadResult, ...itemResults] = await Promise.allSettled([
    fetchItemAspects(item.category.id),
    peerFillRatesForActiveItem(item),
    ...ids.map(id => fetchItemAsReference(id)),
  ]);

  const schema = schemaResult.status === 'fulfilled' ? schemaResult.value : [];
  const broad = broadResult.status === 'fulfilled' ? broadResult.value : null;
  const items = dedupeSameProduct(itemResults
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value));

  if (!items.length || !schema.length) return null;

  const comps = items.map(it => ({
    itemId: it.itemId || '',
    title: it.title || '',
    specs: aspectsToSpecs(it.localizedAspects),
  }));

  let consensus = buildConsensus(comps, schema);
  // Field-set gate: drop a schema field only when it is non-required, no curated
  // comp fills it, AND it's broadly leaf-DEAD in the category — almost no peer
  // carries it (Band Type ≈ 13% on pocket watches). The bar to DROP is low (0.2)
  // on purpose: this removes category-inappropriate fields, not merely
  // low-demand ones — the fill-all thesis keeps every field that's actually
  // part of the category's reality. (Distinct from Sell's 0.4 bar to RECOMMEND.)
  if (broad && broad.rates) {
    const FIELD_DEAD_THRESHOLD = 0.2;
    consensus = consensus.filter(r =>
      r.required || r.coverage > 0 ||
      (broad.rates.get((r.name || '').toLowerCase()) || 0) >= FIELD_DEAD_THRESHOLD);
  }

  updateActive({
    _consensusMatrix: consensus,
    _harvestedComps: items.map(it => ({
      itemId: it.itemId,
      title: it.title,
      shortDescription: it.shortDescription || '',
      condition: it.condition || '',
      conditionDescription: it.conditionDescription || '',
    })),
  });
  return consensus;
}

function consensusValue(item, aspectName) {
  const matrix = item._consensusMatrix || [];
  const row = matrix.find(r => r.name === aspectName);
  return row?.consensus || '';
}

// Product match (eBay catalog ePID). The identifier rides on the Browse search
// summaries — cached on the item in _compsCache.items — but NOT on item.php, so
// the harvest (which re-fetches each chosen comp via item.php) drops it. We
// bridge back to the cached summaries by the chosen comps' legacy ids. ePID is
// PRODUCT-granular: two comps carrying one epid genuinely ARE the same catalog
// product, so — unlike spec-value consensus, where same-product reps fake
// agreement — same-epid agreement is real. The rule mirrors the title packer:
// surface only on >=2-comp agreement, blank otherwise (no guessed identifier).
// Degrades to blank on uncataloged / new-old-stock inventory, which is the
// correct behavior (most one-off stock is not in eBay's catalog — the live
// Arnex is the fixture). See memory bynari-epid-product-match + BYN-SPEC-008 §6.5.
function productMatchEpid(item) {
  if (!item) return null;
  const summaries = (item._compsCache && item._compsCache.items) || [];
  if (!summaries.length) return null;
  const epidByLegacy = new Map();
  for (const s of summaries) {
    const epid = (s.epid || '').toString().trim();
    if (!epid) continue;
    const legacy = stripItemIdEnvelope(s.legacyItemId || s.itemId);
    if (legacy) epidByLegacy.set(legacy, epid);
  }
  if (!epidByLegacy.size) return null;
  // The chosen comps (survey selections) are the same-product cluster the user
  // curated; count the epids they carry.
  const ids = compIdsForHarvest(item);
  const counter = new Map();
  for (const id of ids) {
    const epid = epidByLegacy.get(id);
    if (epid) counter.set(epid, (counter.get(epid) || 0) + 1);
  }
  if (!counter.size) return null;
  const [topEpid, topCount] = [...counter.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topCount < 2) return null;  // a singleton epid is not consensus
  return { epid: topEpid, count: topCount, of: ids.length };
}

async function fetchItemAsReference(itemId) {
  const url = new URL(ITEM_ENDPOINT);
  url.searchParams.set('item', itemId);
  const resp = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

function updateRefineButtonLabel() {
  const input = document.getElementById('compsRefineInput');
  const btn = document.getElementById('compsRefineBtn');
  if (!input || !btn) return;
  const text = input.value.trim();
  btn.textContent = extractEbayItemId(text) ? 'Use this listing' : 'Search';
}
document.getElementById('compsRefineInput')?.addEventListener('input', updateRefineButtonLabel);

const COMPS_PAGE_SIZE = 10;
const COMPS_FETCH_MAX = 50;

function dedupeComps(items) {
  // Same-title relistings come back as different itemIds; collapse them.
  const seen = new Set();
  return items.filter(it => {
    const key = (it.title || '').trim().toLowerCase();
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function renderComps() {
  const item = getActive();
  if (!item) return;
  // Always start the comps screen in list-mode; the survey card resets to
  // hidden when the user navigates away and returns.
  if (typeof hideSurvey === 'function') hideSurvey();
  const list = document.getElementById('compsList');
  const status = document.getElementById('compsStatus');
  list.innerHTML = '';
  status.className = 'comps-status';

  const primaryQ = buildSearchQuery(item, { mode: 'primary' });
  // Part intent (a dial/movement "for parts") filters the search to that parts
  // category so we find the PART, not complete watches that mention it.
  const partCat = partCategoryForItem(item);
  if (!primaryQ.trim()) {
    showDeadEnd(item, [], 'Add a brand, model, or description on the previous step first.');
    return;
  }

  // Cache hit: same final query already fetched. Repaint at the cached offset.
  if (item._compsCache && item._compsCache.q === primaryQ) {
    paintComps(item._compsCache.items, item._compsCache.offset || 0);
    return;
  }

  status.textContent = 'Looking for items like yours…';

  try {
    const attempts = [];
    let items = [];
    let finalQ = primaryQ;
    let strategy = 'primary';

    // Tier 1: brand + model + category-cue (+ parts-category filter if a part).
    let raw = await searchComps(primaryQ, { categoryId: partCat });
    attempts.push({ q: primaryQ, count: raw.length, strategy: 'primary' });
    items = dedupeComps(raw);

    // Loosening ladder. Each tier drops a constraint and runs only if the
    // previous tiers came back dry. The cue stays attached through tiers 2-3
    // so dropping brand/model never costs us the category. Brand-only is last
    // because category-noisy brands (Arnex → pocket watches) flood it.
    //   2. model + cue   — drop brand, keep movement/caliber + category
    //   3. brand + cue   — drop model, keep brand + category  (the Arnex fix)
    //   4. description   — the seller's full words
    //   5. brand-only    — accept category noise over a dead end
    const ladder = [
      { mode: 'model-cue',  strategy: 'model-cue',  cat: partCat },
      { mode: 'brand-cue',  strategy: 'brand-cue',  cat: partCat },
      // Last-resort tiers drop the parts filter — better to surface complete
      // items (and warn) than dead-end.
      { mode: 'description', strategy: 'description', cat: '' },
      { mode: 'brand-only', strategy: 'brand-only',  cat: '' },
    ];

    for (const tier of ladder) {
      if (items.length > 0) break;
      const q = buildSearchQuery(item, { mode: tier.mode });
      // Skip empty queries and any query a prior tier already ran.
      if (!q.trim() || attempts.some(a => a.q === q)) continue;
      raw = await searchComps(q, { categoryId: tier.cat });
      attempts.push({ q, count: raw.length, strategy: tier.strategy });
      if (raw.length > 0) {
        items = dedupeComps(raw);
        finalQ = q;
        strategy = tier.strategy;
      }
    }

    if (items.length === 0) {
      // Cache the empty result so refine-button handler can detect dead-end state.
      updateActive({ _compsCache: { q: primaryQ, items: [], offset: 0, attempts, strategy: 'dead-end' } });
      showDeadEnd(item, attempts);
      return;
    }

    const partMismatch = !!partCat && (strategy === 'description' || strategy === 'brand-only');
    updateActive({ _compsCache: { q: finalQ, items, offset: 0, attempts, strategy, partMismatch } });
    paintComps(items, 0);
  } catch (err) {
    status.textContent = 'Could not load items right now. ' + err.message;
    status.classList.add('error');
  }
}

function showDeadEnd(item, attempts, customMsg) {
  const status = document.getElementById('compsStatus');
  const list = document.getElementById('compsList');
  const noMatchBtn = document.getElementById('compsShowMoreBtn');
  list.innerHTML = '';
  status.className = 'comps-status dead-end';

  let msg;
  if (customMsg) {
    msg = customMsg;
  } else {
    const lastTried = attempts[attempts.length - 1]?.q;
    msg = lastTried
      ? `We tried searching for "${lastTried}" and didn't find a match.`
      : `We didn't find a match for what you've described.`;
  }

  status.innerHTML = `
    <p class="dead-end-msg">${escapeHtml(msg)}</p>
    <p class="dead-end-hint">Try a different angle in the search box below. <strong>Include what the item is</strong> — searching only the movement name surfaces loose parts, not whole watches. For vintage watches, try the movement name plus the kind of watch (e.g. "AS 1187 wristwatch" or "A Schild Swiss wristwatch"). For tools, the part number plus the tool category. For clothing, the style plus the garment type.</p>
  `;

  if (noMatchBtn) noMatchBtn.style.display = 'none';
}

function paintComps(items, offset) {
  const list = document.getElementById('compsList');
  const status = document.getElementById('compsStatus');
  const noMatchBtn = document.getElementById('compsShowMoreBtn');
  const item = getActive();
  list.innerHTML = '';
  status.classList.remove('error');

  if (!items.length) {
    status.textContent = 'No items found.';
    if (noMatchBtn) noMatchBtn.style.display = 'none';
    return;
  }

  const pageStart = offset;
  const pageEnd   = Math.min(offset + COMPS_PAGE_SIZE, items.length);
  const toShow    = items.slice(pageStart, pageEnd);

  // Status line — position + contextual hints
  let statusText = `Showing ${pageStart + 1}–${pageEnd} of ${items.length}`;
  if (
    items.length >= COMPS_FETCH_MAX &&
    item && !item.identify.model && !item.identify.userDescription
  ) {
    statusText += ' — add a model number on Identify for closer matches.';
  } else if (items.length < 5 && item && item.identify.model) {
    statusText += ' — try removing the model number on Identify to see more options.';
  }
  status.textContent = statusText;

  if (item && item._compsCache && item._compsCache.partMismatch) {
    const warn = document.createElement('div');
    warn.className = 'comps-mismatch';
    warn.innerHTML = 'These look like <strong>complete items</strong>, not the part you described — we couldn\'t find that part. Add &ldquo;for parts&rdquo; or refine your search below.';
    list.appendChild(warn);
  }

  toShow.forEach(it => {
    const row = document.createElement('label');
    row.className = 'comp-row comp-row-check';
    const title = it.title || '';
    const cond  = it.condition || '';
    const href  = it.itemWebUrl || '#';
    row.innerHTML = `
      <input type="checkbox" class="comp-check-input" data-item-id="${escapeHtml(it.itemId)}">
      <span class="comp-check-box"></span>
      <div class="comp-info">
        <span class="comp-title">${escapeHtml(title)}</span>
        ${cond ? `<span class="comp-cond">${escapeHtml(cond)}</span>` : ''}
        ${href !== '#' ? `<a class="comp-link" href="${escapeHtml(href)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">View on eBay</a>` : ''}
      </div>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('.comp-check-input').forEach(cb => {
    cb.addEventListener('change', updateSurveyControls);
  });
  const matchBtn = document.getElementById('compsMatchBtn');
  if (matchBtn) matchBtn.classList.toggle('hidden', list.querySelectorAll('.comp-check-input').length < 3);
  updateSurveyControls();

  // Show More button is always visible when we have any items.
  if (noMatchBtn) noMatchBtn.style.display = '';
}

function updateSurveyControls() {
  const checked = document.querySelectorAll('.comp-check-input:checked');
  const count = checked.length;
  const countEl = document.getElementById('surveyCount');
  const btn = document.getElementById('surveyDetailsBtn');
  const bar = document.getElementById('compsSurveyBar');
  if (countEl) countEl.textContent = count === 0
    ? 'Tell us which ones look closest.'
    : `${count} ${count === 1 ? 'looks' : 'look'} like mine`;
  if (btn) btn.disabled = count === 0;
  if (bar) bar.classList.remove('hidden');
}

// === Survey view (multi-comp aggregate) ===
// User checks N comps on the list, clicks "Pull details" — we fetch each one,
// aggregate item specifics across them, and show the consensus (top value
// per aspect + coverage indicator). "Use these" stores the survey selection
// as the harvest pool and advances to Category, where the schema-validated
// harvest runs over the same pool. Single-comp pattern is gone: Cassini
// compliance comes from multi-comp coverage, not from one cherry-picked
// listing per [[cassini-compliant-outputs]].

let _currentSurveyItems = null;

function aggregateAspects(items) {
  // Walk every comp's localizedAspects; preserve first-seen aspect order.
  const counts = new Map();   // name -> Map<value, count>
  const order = [];           // aspect name appearance order
  for (const it of items) {
    const aspects = it.localizedAspects || [];
    for (const a of aspects) {
      if (!a || !a.name || !isItemAspect(a.name)) continue;
      const name = a.name.trim();
      const value = (a.value || '').toString().trim();
      if (!value) continue;
      if (!counts.has(name)) {
        counts.set(name, new Map());
        order.push(name);
      }
      const vmap = counts.get(name);
      vmap.set(value, (vmap.get(value) || 0) + 1);
    }
  }
  const total = items.length;
  return order.map(name => {
    const vmap = counts.get(name);
    const sorted = [...vmap.entries()].sort((a, b) => b[1] - a[1]);
    const [topValue, topCount] = sorted[0];
    return {
      name,
      value: topValue,
      count: topCount,
      total,
      alternatives: sorted.slice(1),
    };
  });
}

function showSurvey(items) {
  _currentSurveyItems = items;

  const n = items.length;
  document.getElementById('analyzeTitle').textContent =
    n === 1
      ? "Here's what this listing shows"
      : `Here's what these ${n} listings have in common`;
  document.getElementById('analyzeMeta').innerHTML = '';
  document.getElementById('analyzeDesc').textContent = 'Does that look right?';

  const rows = aggregateAspects(items);
  const specsTable = document.getElementById('analyzeSpecs');
  if (rows.length) {
    specsTable.innerHTML = rows.map(r => {
      const allAgree = r.count === r.total && r.alternatives.length === 0;
      const coverage = n === 1
        ? ''
        : (allAgree
            ? `<span class="agree-pip strong">all ${r.total}</span>`
            : `<span class="agree-pip">${r.count} of ${r.total}</span>`);
      return `<tr>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.value)}</td>
        <td class="coverage">${coverage}</td>
      </tr>`;
    }).join('');
  } else {
    specsTable.innerHTML = '<tr><td colspan="3" style="color:#8a92a8;font-style:italic;">No item specifics on the selected listings.</td></tr>';
  }

  document.getElementById('compsAnalyze').classList.remove('hidden');
  document.getElementById('compsStatus').classList.add('hidden');
  document.getElementById('compsList').classList.add('hidden');
  document.getElementById('compsSurveyBar')?.classList.add('hidden');
  document.getElementById('compsRefine').classList.add('hidden');
  document.getElementById('compsMatchBtn')?.classList.add('hidden');
  document.querySelector('[data-screen="comps"] .action-row').classList.add('hidden');
}

function hideSurvey() {
  _currentSurveyItems = null;
  document.getElementById('compsAnalyze').classList.add('hidden');
  document.getElementById('compsStatus').classList.remove('hidden');
  document.getElementById('compsList').classList.remove('hidden');
  document.getElementById('compsRefine').classList.remove('hidden');
  document.querySelector('[data-screen="comps"] .action-row').classList.remove('hidden');
  // Reveal the survey bar only when there are comp results to act on.
  const hasComps = !!document.querySelectorAll('.comp-check-input').length;
  if (hasComps) document.getElementById('compsSurveyBar')?.classList.remove('hidden');
  document.getElementById('compsMatchBtn')?.classList.toggle('hidden', !hasComps);
  const status = document.getElementById('compsStatus');
  if (status && status.textContent.startsWith('Loading') ||
      status && status.textContent.startsWith('Pulling')) {
    status.textContent = '';
  }
}

// "Match these for me" — auto-select the comps that cluster together, so the
// seller isn't hand-picking. Category-agnostic: tokenize titles, down-weight
// terms common to most results (the shared search words don't discriminate),
// pick the most-central comp as anchor, and check the comps sharing >=2
// distinctive tokens with it. The union is only as good as the comps picked
// (the clothing walk showed mixed garments -> contradictions), so this nudges
// toward a coherent set the seller can still adjust.
function titleTokens(title) {
  const STOP = new Set(['the','for','with','and','men','mens','man','women','womens','woman',
    'size','new','nwt','nip','used','vtg','vintage','lot','your','this','from',
    'xs','sm','med','lg','xl','xxl','2xl','3xl','4xl','5xl']);
  return new Set((title || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)));
}
function autoSelectMatches() {
  const rows = [...document.querySelectorAll('.comp-row')];
  if (rows.length < 2) return;
  const comps = rows.map((row, i) => ({
    i,
    cb: row.querySelector('.comp-check-input'),
    tokens: titleTokens(row.querySelector('.comp-title')?.textContent || ''),
  }));
  const n = comps.length;
  // Remove only NEAR-UNIVERSAL tokens (the brand/search words shared by ~all
  // results); keep the mid-frequency tokens that actually distinguish the
  // cluster (crew/short vs quarter/long). Then score pairs by Jaccard overlap —
  // it separates real matches (~0.5) from outliers (a long-sleeve vs a tee
  // ~0.07) regardless of category, and is INCLUSIVE of valid variants.
  const df = new Map();
  comps.forEach(c => c.tokens.forEach(t => df.set(t, (df.get(t) || 0) + 1)));
  const universal = Math.max(2, Math.ceil(n * 0.9));
  const disc = comps.map(c => new Set([...c.tokens].filter(t => df.get(t) < universal)));
  const jac = (a, b) => {
    const A = disc[a], B = disc[b];
    if (!A.size || !B.size) return 0;
    let inter = 0; for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
  };
  // Seed = most-central comp (highest average overlap with the rest).
  let seed = 0, best = -1;
  for (let a = 0; a < n; a++) {
    let tot = 0; for (let b = 0; b < n; b++) if (b !== a) tot += jac(a, b);
    if (tot > best) { best = tot; seed = a; }
  }
  const THRESH = 0.24;  // inclusive: catches valid variants, drops outliers
  let picks = [];
  for (let b = 0; b < n; b++) if (b === seed || jac(seed, b) >= THRESH) picks.push(b);
  if (picks.length < 2) {
    const scored = comps.filter(c => c.i !== seed)
      .map(c => ({ i: c.i, s: jac(seed, c.i) })).sort((x, y) => y.s - x.s);
    picks = [seed, ...scored.slice(0, 3).map(x => x.i)];
  }
  const set = new Set(picks);
  comps.forEach(c => {
    if (!c.cb) return;
    c.cb.checked = set.has(c.i);
    c.cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
document.getElementById('compsMatchBtn')?.addEventListener('click', autoSelectMatches);
(function injectMatchBtnStyle() {
  const css = `
  .comps-match-btn { background:#eef3fb; color:#2d6cdf; border:1px solid #cfe0fb; border-radius:7px;
    padding:7px 14px; font-size:13px; font-weight:600; cursor:pointer; margin:2px 0 14px; }
  .comps-match-btn:hover { background:#e2ecfb; }
  .comps-match-btn.hidden { display:none; }
  `;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
})();

// Pick the most common eBay category across the selected comps. They're the
// matched items, so their category is a more reliable signal than a brand/query
// suggestion — which mis-files obscure parts (an A. Schild movement part) as
// Wristwatches. Stamp it with the current search query so renderCategory's
// cache uses it instead of re-fetching a wrong suggestion.
function majorityCategoryFromItems(items, q) {
  const counts = new Map();
  for (const it of items || []) {
    const id = it.categoryId || (it.categoryIdPath || '').split('|').pop() || '';
    if (!id) continue;
    const rec = counts.get(id) || { n: 0, item: it };
    rec.n++; counts.set(id, rec);
  }
  let best = null;
  for (const rec of counts.values()) if (!best || rec.n > best.n) best = rec;
  if (!best) return null;
  const cat = deriveCategoryFromItem(best.item);
  if (cat) cat.q = q;
  return cat;
}

function commitSurvey() {
  if (!_currentSurveyItems || !_currentSurveyItems.length) return;
  const items = _currentSurveyItems;
  const surveySelections = items.map(it => ({
    itemId: it.itemId,
    title: it.title || '',
    condition: it.condition || '',
    itemWebUrl: it.itemWebUrl || '',
  }));
  const active = getActive();
  const compCategory = majorityCategoryFromItems(items, active ? buildSearchQuery(active) : '');
  updateActive({
    surveySelections,
    // Keep selectedComp for downstream compatibility (description prefill,
    // title composition fall-throughs). First in the survey is the
    // representative reference.
    selectedComp: surveySelections[0],
    referenceItem: items[0],
    // Category from the matched comps beats the query suggestion (parts case).
    category: compCategory || active?.category || null,
    status: 'category',
    _consensusMatrix: null,
    _harvestedComps: null,
  });
  hideSurvey();
  routeTo('category');
}

async function pullDetailsFromChecked() {
  const checked = document.querySelectorAll('.comp-check-input:checked');
  if (!checked.length) return;
  const status = document.getElementById('compsStatus');
  status.classList.remove('error');
  status.textContent = `Pulling details from ${checked.length} listing${checked.length === 1 ? '' : 's'}…`;
  try {
    const ids = Array.from(checked).map(cb => stripItemIdEnvelope(cb.dataset.itemId));
    const settled = await Promise.allSettled(ids.map(id => fetchItemAsReference(id)));
    const items = settled
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
    if (!items.length) throw new Error('none of the listings could be fetched');
    showSurvey(items);
  } catch (err) {
    status.textContent = 'Could not pull details: ' + err.message;
    status.classList.add('error');
  }
}

document.getElementById('analyzeBackBtn')?.addEventListener('click', hideSurvey);
document.getElementById('analyzeUseBtn')?.addEventListener('click', commitSurvey);
document.getElementById('surveyDetailsBtn')?.addEventListener('click', pullDetailsFromChecked);

// Sold-on-eBay off-ramp. Until Marketplace Insights lands, we can't fetch
// sold listings programmatically — but eBay's UI shows them to anyone with
// a browser. This link sends the user to the sold-filter results for their
// current search; once they find a match they can paste its URL/ID back
// into the refine box, which fetches the item and surveys it.
function openSoldOnEbay(e) {
  if (e) e.preventDefault();
  const item = getActive();
  if (!item) return;
  let q = buildSearchQuery(item, { mode: 'primary' });
  if (!q.trim() && item._compsOverrideQuery) q = item._compsOverrideQuery;
  if (!q.trim()) return;
  const url = 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(q.trim()) +
    '&LH_Sold=1&LH_Complete=1&_ipg=50&_sop=12';
  if (window.pywebview?.api?.open_url) {
    window.pywebview.api.open_url(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
document.getElementById('soldOnEbayLink')?.addEventListener('click', openSoldOnEbay);

document.getElementById('compsShowMoreBtn')?.addEventListener('click', () => {
  const item = getActive();
  if (!item) return;
  const cache = item._compsCache;
  if (!cache) return;  // nothing to paginate
  const items = cache.items;
  const nextOffset = (cache.offset || 0) + COMPS_PAGE_SIZE;
  if (nextOffset >= items.length) {
    // Exhausted — button hides via paintComps; forward arrow / refine box
    // become the user's only paths forward. Just hide the button here too.
    document.getElementById('compsShowMoreBtn').style.display = 'none';
    return;
  }
  updateActive(curr => ({ _compsCache: { ...curr._compsCache, offset: nextOffset } }));
  paintComps(items, nextOffset);
});

document.getElementById('compsRefineBtn')?.addEventListener('click', async () => {
  const input = document.getElementById('compsRefineInput');
  const text = (input?.value || '').trim();
  if (!text) return;
  const item = getActive();
  if (!item) return;

  // Branch 1: an eBay URL or raw item id → fetch and show as a single-item
  // survey. Same surface as the multi-comp checkbox flow, just with N=1.
  const itemId = extractEbayItemId(text);
  if (itemId) {
    const status = document.getElementById('compsStatus');
    status.textContent = 'Loading the listing you pasted…';
    status.classList.remove('error');
    try {
      const ref = await fetchItemAsReference(itemId);
      ref.itemId = ref.itemId || itemId;
      if (input) input.value = '';
      showSurvey([ref]);
    } catch (err) {
      status.textContent = 'Could not load that listing: ' + err.message;
      status.classList.add('error');
    }
    return;
  }

  // Branch 2: dead-end pivot. If the current cache is empty (the fallback
  // ladder produced no matches), treat the typed text as a fresh search
  // angle that REPLACES the composed query — not a refinement on top of
  // a query that already returned nothing.
  const cache = item._compsCache;
  const inDeadEnd = !cache || cache.strategy === 'dead-end' || cache.items.length === 0;
  if (inDeadEnd) {
    updateActive({
      _compsOverrideQuery: text,
      compsRefinement: '',
      _compsCache: null,
    });
    if (input) input.value = '';
    updateRefineButtonLabel();
    renderComps();
    return;
  }

  // Branch 3: narrowing on results. Append to compsRefinement, invalidate
  // cache, re-fetch. Used when Susan already has comps showing and wants
  // to filter them down.
  const combined = item.compsRefinement
    ? `${item.compsRefinement} ${text}`.trim()
    : text;
  updateActive({ compsRefinement: combined, _compsCache: null });
  if (input) input.value = '';
  updateRefineButtonLabel();
  renderComps();
});

// === Category screen ===
const CATEGORY_ENDPOINT = 'https://api.tadelstein.com/category_suggestions.php';

function renderCategoryDisplay(category) {
  const nameEl = document.querySelector('[data-screen="category"] .category-name');
  const pathEl = document.querySelector('[data-screen="category"] .category-path');
  nameEl.textContent = category.name;
  pathEl.innerHTML = category.path
    .map(p => escapeHtml(p))
    .join('<span class="sep">›</span>');
}

// Fetch eBay Taxonomy suggestions for a free-text query.
async function fetchCategorySuggestions(q) {
  const url = new URL(CATEGORY_ENDPOINT);
  url.searchParams.set('q', q);
  const resp = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  return data.categorySuggestions || [];
}

// Turn one Taxonomy suggestion into our stored category shape.
// categoryTreeNodeAncestors is leaf-first; reverse for root→leaf, then append leaf.
function suggestionToCategory(s, q) {
  const leafName = s.category.categoryName;
  const leafId = s.category.categoryId;
  const ancestors = s.categoryTreeNodeAncestors || [];
  const path = [...ancestors].reverse().map(a => a.categoryName).concat([leafName]);
  return { q, id: leafId, name: leafName, path };
}

async function renderCategory() {
  const item = getActive();
  if (!item) return;
  const nameEl = document.querySelector('[data-screen="category"] .category-name');
  const pathEl = document.querySelector('[data-screen="category"] .category-path');

  const q = buildSearchQuery(item);

  // Cache hit only if the query that produced the cached category still matches.
  // Stale cache (different brand/description) is invalidated by re-fetching.
  if (item.category && item.category.q === q) {
    renderCategoryDisplay(item.category);
    return;
  }

  nameEl.textContent = 'Looking up category…';
  pathEl.textContent = '';

  if (!q.trim()) {
    nameEl.textContent = '—';
    pathEl.textContent = 'Add a brand on the previous step first.';
    return;
  }

  try {
    const suggestions = await fetchCategorySuggestions(q);
    if (!suggestions.length) {
      nameEl.textContent = '—';
      pathEl.textContent = 'No category found. Use Change category to pick one.';
      return;
    }
    const category = suggestionToCategory(suggestions[0], q);
    updateActive({ category });
    renderCategoryDisplay(category);
  } catch (err) {
    nameEl.textContent = '—';
    pathEl.textContent = 'Could not load category: ' + err.message;
  }
}

// === Title & Description screen ===
// Negative phrases stripped from comp-derived prefill text per
// [[feedback-prefilled-copy-leans-neutral]] — seller adds these themselves.
const STOPWORDS = new Set([
  'a','an','the','and','or','of','for','with','in','on','to','by','at','as',
  'is','it','this','that','from','&','-','/','|','+','vs','via','if','but',
]);
const NEG_TOKENS = new Set([
  'parts','repair','repairs','broken','damaged','damage','worn','asis',
  'untested','scratched','dented','tarnished','cracked','rust','rusty',
  'pitted','restoration','donor','flaws','flaw','missing','torn','stained',
  'discolored','faded','chipped','peeling','as-is',
]);


function compConsensusRanking(item) {
  const comps = item._compsCache?.items || [];
  if (!comps.length) return [];
  const counts = new Map();
  const cases  = new Map();
  comps.forEach(c => {
    const title = c.title || '';
    const tokens = title.match(/[A-Za-z0-9][A-Za-z0-9.'-]*/g) || [];
    const seen = new Set();
    tokens.forEach(t => {
      const lower = t.toLowerCase();
      if (lower.length < 2) return;
      if (STOPWORDS.has(lower)) return;
      if (NEG_TOKENS.has(lower)) return;
      if (seen.has(lower)) return;
      seen.add(lower);
      counts.set(lower, (counts.get(lower) || 0) + 1);
      if (!cases.has(lower)) cases.set(lower, t);
    });
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lower]) => cases.get(lower));
}

function generateTitlePrefill(item) {
  // Brand/MPN in the title come ONLY from the seller's own Identify input —
  // never borrowed from the comp pool. A no-brand pile must not inherit
  // "Bulova"/"BB Glass" from whichever matched comp happened to carry it; the
  // most Cassini-weighted surface must not assert a brand the seller didn't.
  // (Type + the specifics packed below are neutral and still come from consensus;
  // the packer already skips the Brand/MPN/Model rows.)
  const brand = item.identify.brand || '';
  const mpn   = item.identify.model || '';
  const type  = consensusValue(item, 'Type') || consensusValue(item, 'Item Type') || '';
  const matrix = item._consensusMatrix || [];

  // Rewrite: the seller's OWN listing title is an accurate base — keep it.
  // (Packing raw aspect values misfires for vehicles / Make-Model items.)
  if (item.mode === 'rewrite' && item.referenceItem?.title) {
    return item.referenceItem.title.slice(0, 80);
  }
  // No harvest/seed yet — use a pasted reference's title if we have one.
  if (!matrix.length) {
    if (item.referenceItem?.title) return item.referenceItem.title.slice(0, 80);
    return [brand, mpn, type].filter(Boolean).join(' ');
  }

  // Lead with Brand → Model → Type, then PACK the highest-search item specifics
  // (the matrix is already in cassini search-volume order) up to 80 chars.
  // Cassini weights the title heaviest, so we front-load the terms buyers
  // actually search — NOT a single comp's short title. See cassini-fill-all-
  // aspects + cassini-compliant-outputs.
  let title = [brand, mpn, type].filter(Boolean).join(' ');
  const used = new Set(title.toLowerCase().split(/\s+/).filter(Boolean));
  const SKIP_TITLE = new Set(['Brand', 'MPN', 'Manufacturer Part Number', 'Part Number',
    'Type', 'Item Type', 'Model', 'Reference Number', 'Customized', 'Country of Origin',
    'With Original Box/Packaging', 'With Papers', 'With Service Records', 'Vintage',
    'Handmade', 'Unit Type', 'Unit Quantity', 'California Prop 65 Warning']);
  for (const row of matrix) {
    if (SKIP_TITLE.has(row.name)) continue;
    // Only pack CONSENSUS values (≥2 comps agree). A coverage-1 value is one
    // comp's claim — that's how a lone part number ("MX 2297"), a comma-garbage
    // "Acrylic, Timex", or a stray compatible-brand list leaks into the title of
    // a thin/mismatched pool. The title is the most Cassini-weighted surface, so
    // it carries only what the pool actually agrees on. See multi-comp-consensus.
    if ((row.coverage || 0) < 2) continue;
    const val = (resolveSpecValue(row, item).value || '').toString().trim();
    if (!val || val.length > 22) continue;
    if (/^(yes|no|n\/a|none|unbranded|does not apply)$/i.test(val)) continue;
    const lower = val.toLowerCase();
    if (used.has(lower)) continue;
    const words = lower.split(/\s+/).filter(Boolean);
    if (words.length && words.every(w => used.has(w))) continue;  // all words already present
    const next = `${title} ${val}`.trim();
    if (next.length > 80) continue;  // skip and try the next (shorter) term
    title = next;
    used.add(lower);
    words.forEach(w => used.add(w));
  }
  return title;
}

function generateDescriptionPrefill(item) {
  // The seller's OWN listing (rewrite) is a legitimate base — keep its text.
  // For a multi-comp List harvest, referenceItem is someone ELSE's comp, so we
  // do NOT copy their prose (and their typos / unearned condition claims) —
  // we compose a neutral description from the consensus below. See
  // [[feedback-prefilled-copy-leans-neutral]] + [[feedback-trust-and-safety-discipline]].
  const ref = item.referenceItem;
  if (item.mode === 'rewrite' && ref?.shortDescription && ref.shortDescription.length > 20) {
    return ref.shortDescription;
  }

  // Build from consensus values when we've harvested. No throttle-filler per
  // [[feedback-no-throttle-filler-phrases]].
  // User-typed Brand and Model win over consensus. If Susan typed "Arnex" but
  // her chosen comp is a Hamilton with the same A. Schild movement, the title
  // must still say Arnex — the comp's brand reflects ITS brand, not hers.
  const brand = item.identify.brand || consensusValue(item, 'Brand') || '';
  const mpn   = item.identify.model || consensusValue(item, 'MPN')   || '';
  const type  = consensusValue(item, 'Type')  || consensusValue(item, 'Item Type') || '';

  // Pick a small number of high-coverage, non-required, non-name aspects to
  // describe — Color, Material, Connectivity, etc. Skip aspects already in
  // the head sentence.
  const headParts = [brand, mpn, type].filter(Boolean);
  const headSentence = headParts.length ? `${headParts.join(' ')}.` : '';

  const matrix = item._consensusMatrix || [];
  // Skip identity + low-descriptive-value aspects so the sentence highlights
  // real features (Movement, Dial Color, Material…), not "Department: Men;
  // Customized: No".
  const SKIP = new Set(['Brand', 'MPN', 'Manufacturer Part Number', 'Part Number',
    'Type', 'Item Type', 'Model', 'Department', 'Customized', 'Country of Origin',
    'Vintage', 'Handmade', 'With Original Box/Packaging', 'With Papers',
    'With Service Records', 'Unit Type', 'Unit Quantity', 'Reference Number',
    'California Prop 65 Warning']);
  const features = [];
  for (const row of matrix) {
    if (SKIP.has(row.name)) continue;
    if (!row.consensus) continue;
    if (row.agreement === 'split' || row.agreement === 'none') continue;
    features.push(`${row.name}: ${row.consensus}`);
    if (features.length >= 4) break;
  }

  if (headSentence && features.length) {
    return `${headSentence} ${features.join('; ')}.`;
  }
  if (headSentence) return headSentence;

  // Fallback when no harvest yet — brand/model/category from identify only.
  const head = [item.identify.brand, item.identify.model].filter(Boolean).join(' ');
  const catSuffix = item.category?.name ? `, ${item.category.name.toLowerCase()}` : '';
  if (head) return `${head}${catSuffix}.`;
  if (item.category?.name) return `${item.category.name}.`;
  return '';
}

// Condition picker. Default set shown to every seller; category-specific
// conditions (from eBay's condition policies) are a later rung, same pattern
// as the catalog value rung. Each option carries a NEUTRAL prefill statement
// per [[feedback-prefilled-copy-leans-neutral]] — no flaw catalogs, no filler.
// The empty key is the "no pick yet" placeholder; 'other' leaves the statement
// blank for the seller to write.
const CONDITION_OPTIONS = [
  { key: '',         label: 'Choose condition…',     statement: '' },
  { key: 'new',      label: 'New',                   statement: 'New, unused.' },
  { key: 'new-open', label: 'New — open box',        statement: 'New, open box. Never used.' },
  { key: 'nos',      label: 'New old stock',         statement: 'New old stock. Unused, from original stock.' },
  { key: 'pre-exc',  label: 'Pre-owned — excellent', statement: 'Pre-owned, in excellent condition.' },
  { key: 'pre-good', label: 'Pre-owned — good',      statement: 'Pre-owned, in good condition.' },
  { key: 'parts',    label: 'For parts / repair',    statement: 'Sold for parts or repair.' },
  { key: 'other',    label: 'Other…',                statement: '' },
];

function conditionStatementFor(choiceKey) {
  const opt = CONDITION_OPTIONS.find(o => o.key === choiceKey);
  return opt ? opt.statement : '';
}

function populateConditionPicker() {
  const sel = document.getElementById('conditionChoice');
  if (!sel || sel.options.length) return;
  for (const opt of CONDITION_OPTIONS) {
    const o = document.createElement('option');
    o.value = opt.key;
    o.textContent = opt.label;
    sel.appendChild(o);
  }
}

function generateConditionPrefill(item) {
  // No guessing the condition — only the seller knows it. Their explicit pick
  // wins; a pasted reference listing's own text is the next-best start; else
  // blank (the picker flags it, the seller chooses).
  const fromChoice = conditionStatementFor(item.conditionChoice);
  if (fromChoice) return fromChoice;
  const refCond = item.referenceItem?.conditionDescription;
  if (refCond && refCond.length > 5) return refCond;
  return '';
}

function setTdcStatus(text, kind) {
  const el = document.getElementById('tdcStatus');
  if (!el) return;
  if (!text) { el.textContent = ''; el.classList.remove('error'); return; }
  el.textContent = text;
  el.classList.toggle('error', kind === 'error');
}

function applyPrefills(item) {
  // Prefill rules:
  //  - empty field            → fill, mark as autoprefill
  //  - field matches its last
  //    auto-marker             → re-fill, mark again (data improved)
  //  - field edited by user   → leave alone (their text is the commit)
  let title = item.title;
  let description = item.description;
  let conditionStatement = item.conditionStatement;
  let changed = false;

  const proposedTitle = generateTitlePrefill(item);
  if (proposedTitle && (!title || title === item._autoTitle)) {
    title = proposedTitle;
    changed = true;
  }
  const proposedDesc = generateDescriptionPrefill(item);
  if (proposedDesc && (!description || description === item._autoDescription)) {
    description = proposedDesc;
    changed = true;
  }
  const proposedCond = generateConditionPrefill(item);
  if (proposedCond && (!conditionStatement || conditionStatement === item._autoCondition)) {
    conditionStatement = proposedCond;
    changed = true;
  }
  if (changed) {
    updateActive({
      title,
      description,
      conditionStatement,
      _autoTitle: proposedTitle,
      _autoDescription: proposedDesc,
      _autoCondition: proposedCond,
    });
  }

  document.getElementById('titleInput').value = title || '';
  document.getElementById('descriptionInput').value = description || '';
  document.getElementById('conditionInput').value = conditionStatement || '';
  populateConditionPicker();
  const cc = document.getElementById('conditionChoice');
  if (cc) cc.value = item.conditionChoice || '';
  updateTitleCounter();
}

function harvestSummaryText(item) {
  // Per [[feedback-sparse-harvest-prompts-user-effort]] surface the count and
  // a "add your own details" nudge when the harvest is thin. For NOS items
  // (see [[ebay-nos-inventory-reality]]) sparse is the expected case.
  const harvested = (item._harvestedComps || []).length;
  if (harvested === 0) {
    return 'No comparable listings found. Type the listing in yourself — Bynari Insight will save it.';
  }
  const noun = harvested === 1 ? 'listing' : 'listings';
  if (harvested < 5) {
    return `Pulled from ${harvested} similar ${noun}. You'll want to add your own details to make this listing stand out.`;
  }
  return `Pulled from ${harvested} similar ${noun}.`;
}

async function renderTitleDescription() {
  const item = getActive();
  if (!item) return;
  applyPrefills(item);

  if (item._consensusMatrix) {
    setTdcStatus(harvestSummaryText(item));
    return;
  }
  if (!item.category?.id) return;

  setTdcStatus('Harvesting details from comparable listings…');
  try {
    const consensus = await harvestForActiveItem();
    if (consensus) {
      const updated = getActive();
      applyPrefills(updated);
      setTdcStatus(harvestSummaryText(updated));
    } else {
      setTdcStatus(
        'No comparable listings found. Type the listing in yourself — Bynari Insight will save it.'
      );
    }
  } catch (err) {
    setTdcStatus('Could not gather extra details: ' + err.message, 'error');
  }
}

function updateTitleCounter() {
  const t = document.getElementById('titleInput');
  const c = document.getElementById('titleCounter');
  if (!t || !c) return;
  const len = t.value.length;
  c.textContent = `${len} / 80`;
  c.classList.remove('low', 'good');
  if (len === 0) {
    // neutral
  } else if (len < 62) {
    c.classList.add('low');
  } else if (len <= 80) {
    c.classList.add('good');
  }
}

['titleInput', 'descriptionInput', 'conditionInput'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => {
    const title = document.getElementById('titleInput').value;
    const description = document.getElementById('descriptionInput').value;
    const conditionStatement = document.getElementById('conditionInput').value;
    updateActive({ title, description, conditionStatement });
    if (id === 'titleInput') updateTitleCounter();
  });
});

// Condition picker — an explicit pick prefills the matching neutral statement
// (the seller can then edit it). 'Other…' and the placeholder leave the
// statement alone so the seller writes their own.
document.getElementById('conditionChoice')?.addEventListener('change', (e) => {
  const choice = e.target.value;
  if (choice && choice !== 'other') {
    const statement = conditionStatementFor(choice);
    const ci = document.getElementById('conditionInput');
    if (ci) ci.value = statement;
    updateActive({ conditionChoice: choice, conditionStatement: statement, _autoCondition: statement });
  } else {
    updateActive({ conditionChoice: choice });
  }
});

// "Change category" — opens a real picker (type a term → choose from eBay's
// taxonomy). The old behavior just re-ran the auto-lookup, a dead end whenever
// that query came back empty.
function categoryPickerEls() {
  const root = document.querySelector('[data-screen="category"] .category-picker');
  return {
    root,
    input:   root?.querySelector('.cat-picker-input'),
    results: root?.querySelector('.cat-picker-results'),
    status:  root?.querySelector('.cat-picker-status'),
  };
}

function openCategoryPicker() {
  const { root, input, results, status } = categoryPickerEls();
  if (!root) return;
  root.classList.remove('hidden');
  results.innerHTML = '';
  if (status) status.textContent = '';
  // Seed the box with the current auto query so the seller can tweak it.
  const item = getActive();
  if (input && !input.value) input.value = item ? buildSearchQuery(item) : '';
  input?.focus();
}

async function runCategoryPickerSearch() {
  const { input, results, status } = categoryPickerEls();
  const q = (input?.value || '').trim();
  if (!q) { if (status) status.textContent = 'Type what the item is first.'; return; }
  results.innerHTML = '';
  if (status) status.textContent = 'Searching categories…';
  try {
    const suggestions = await fetchCategorySuggestions(q);
    if (!suggestions.length) {
      status.textContent = 'No categories matched. Try different words.';
      return;
    }
    status.textContent = '';
    suggestions.slice(0, 8).forEach(s => {
      const cat = suggestionToCategory(s, q);
      const li = document.createElement('li');
      const leaf = document.createElement('div');
      leaf.className = 'cat-leaf';
      leaf.textContent = cat.name;
      const path = document.createElement('div');
      path.className = 'cat-path';
      path.textContent = cat.path.join(' › ');
      li.append(leaf, path);
      li.addEventListener('click', () => {
        updateActive({ category: cat });
        renderCategoryDisplay(cat);
        categoryPickerEls().root.classList.add('hidden');
      });
      results.appendChild(li);
    });
  } catch (err) {
    if (status) status.textContent = 'Could not search: ' + err.message;
  }
}

document.querySelector('[data-screen="category"] .change-link')?.addEventListener('click', e => {
  e.preventDefault();
  openCategoryPicker();
});
document.querySelector('[data-screen="category"] .cat-picker-btn')?.addEventListener('click', runCategoryPickerSearch);
document.querySelector('[data-screen="category"] .cat-picker-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); runCategoryPickerSearch(); }
});

// === Datasheet screen ===
// === Spec-fill ladder ===
// Resolve one aspect's value by trying sources in priority order and returning
// the first hit. Sources stay INTERNAL — never surfaced in the UI (sourcing is
// opaque). New rungs (eBay catalog, manufacturer, Amazon, Google) slot into
// this list; today the live rungs are the seller's own edit and eBay comp
// consensus. The field NAMES themselves come from the cassini.db aspect schema
// (item_aspects.php) — that rung is already wired upstream in buildConsensus.
function resolveSpecValue(row, item) {
  const overrides = item.specificsOverrides || {};
  // 1. Seller override — the seller's edit always wins.
  if (overrides[row.name] !== undefined && overrides[row.name] !== null) {
    return { value: overrides[row.name], source: 'user' };
  }
  // 1b. User-typed Brand (from Identify) seeds the Brand specific so it agrees
  //     with the title, which also leads with identify.brand — the seller's
  //     brand reflects THEIR item, not a comp's casing/value (the Arnex rule).
  //     Brand only: identify.model isn't reliably an MPN (e.g. "Dri-FIT").
  if (item.identify?.brand && row.name.trim().toLowerCase() === 'brand') {
    return { value: item.identify.brand, source: 'user' };
  }
  // 2. eBay catalog (getProduct) — the next rung. Returns null until the
  //    broker wraps the Commerce Catalog API. See catalogValue() stub.
  const fromCatalog = catalogValue(item, row.name);
  if (fromCatalog) return { value: fromCatalog, source: 'catalog' };
  // 3. eBay comp consensus — the working value rung today.
  if (row.consensus) return { value: row.consensus, source: 'comps' };
  // 4. Off-eBay web enrichment — fills what comps didn't have. Stub until a
  //    broker-side fetcher lands (browsers can't scrape cross-origin). SPECS
  //    ONLY, never pricing. See webEnrichValue().
  const fromWeb = webEnrichValue(item, row.name);
  if (fromWeb) return { value: fromWeb, source: 'web' };
  return { value: '', source: null };
}

// eBay catalog rung — stub. Returns null until the broker wraps the eBay
// Commerce Catalog API (getProduct), which is scope-gated and not live yet.
// When catalog.php lands, fetch the product's aspects and return the value
// for aspectName here. This is the clean insertion point for that rung.
function catalogValue(item, aspectName) {
  return null;
}

// Off-eBay enrichment rung — stub. The clean insertion point for an automated
// source (Google Custom Search API / manufacturer / Amazon) once a server-side
// fetcher lands on the broker (browsers can't scrape cross-origin). Until then,
// the seller fills blanks via the "search the web" assist in beginEditSpec —
// their edit becomes the value. SPECS ONLY — pricing never comes from off-eBay.
function webEnrichValue(item, aspectName) {
  return null;
}

function specificsForRender(item) {
  // Union complete-fill: surface EVERY aspect (required + recommended + any
  // extra a comp carried), each valued via the spec-fill ladder. Blanks are
  // shown, not hidden — the target is zero blanks (fill-until-full). Cassini
  // expects all aspects filled and every field on eBay's form carries real
  // search demand, so none is "obscure" enough to drop. The fill is under the
  // covers, so showing all fields burdens the machine, not the seller. Required
  // and recommended come back in the schema's natural (priority) order. See
  // memory cassini-fill-all-aspects.
  const matrix = item._consensusMatrix || [];
  const required = [];
  const optional = [];
  for (const row of matrix) {
    const { value } = resolveSpecValue(row, item);
    const entry = { name: row.name, value, required: !!row.required };
    if (row.required) required.push(entry);
    else optional.push(entry);
  }
  return { required, optional };
}

function renderDatasheet() {
  const item = getActive();
  if (!item) return;
  const el = document.getElementById('datasheetContent');
  if (!el) return;

  const specs = specificsForRender(item);
  const catPath = item.category?.path?.join('  ›  ') || '—';

  el.innerHTML = `
    <section class="ds-section">
      <h2 class="ds-heading">Title</h2>
      <div class="ds-title">${escapeHtml(item.title || '—')}</div>
    </section>

    <section class="ds-section">
      <h2 class="ds-heading">Category</h2>
      <div class="ds-line">${escapeHtml(catPath)}</div>
    </section>
    ${(() => {
      const pm = productMatchEpid(item);
      if (!pm) return '';
      return `
    <section class="ds-section">
      <h2 class="ds-heading">Product match</h2>
      <div class="ds-line">This item looks like eBay catalog product <strong>${escapeHtml(pm.epid)}</strong>, agreed across ${pm.count} of the listings you chose. If eBay's form offers a matching product, choose it &mdash; it fills core details buyers filter on.</div>
    </section>`;
    })()}

    <section class="ds-section">
      <h2 class="ds-heading">Condition</h2>
      <div class="ds-line">${escapeHtml(item.conditionStatement || '—')}</div>
    </section>

    <section class="ds-section">
      <h2 class="ds-heading">Item Description</h2>
      <div class="ds-body">${escapeHtml(item.description || '—')}</div>
    </section>

    <section class="ds-section">
      <h2 class="ds-heading">Item Specifics</h2>
      ${renderSpecificsTable('Required', specs.required, true)}
      ${renderSpecificsTable('Optional', specs.optional, false)}
      ${(!specs.required.length && !specs.optional.length)
        ? '<div class="ds-empty">No item specifics yet. Walk back to Items like yours and refine, or paste a listing URL there.</div>'
        : ''}
    </section>

    <section class="ds-section">
      <h2 class="ds-heading">Shipping &amp; Returns</h2>
      <div class="ds-body">Set up a <strong>shipping policy</strong> and a <strong>return policy</strong> in eBay Business Policies before publishing this listing. (Seller Hub → Account Settings → Business Policies.)</div>
    </section>
  `;

  // Wire inline editing on every specifics value cell
  el.querySelectorAll('.ds-spec-value').forEach(cell => {
    cell.addEventListener('click', () => beginEditSpec(cell));
  });
}

// "How it measures up" — the verdict step. Counts how many of the details
// buyers search for in this category the listing actually fills, and names the
// blanks worth filling. Built entirely from the consensus matrix (the union of
// required + recommended + comp-carried aspects); no new fetch. Save lives here,
// at the end of the analysis, so the flow checks the work instead of just
// stopping at the datasheet. See cassini-fill-all-aspects.
function renderMeasureUp() {
  const item = getActive();
  if (!item) return;
  const el = document.getElementById('measureUpContent');
  if (!el) return;

  const specs = specificsForRender(item);
  const all = [...specs.required, ...specs.optional];
  const total = all.length;
  const filled = all.filter(r => r.value).length;
  const blanks = all.filter(r => !r.value);

  let html;
  if (!total) {
    // No basis to compare — comps were skipped or no category schema resolved.
    html = `<div class="mu-card">
      <p class="mu-verdict">There's nothing to measure this against yet — no similar listings were pulled.
      Go back to <a href="#comps" data-route="comps">Items like yours</a> to add a few, or save it as is and refine later.</p>
    </div>`;
  } else {
    const pct = Math.round((filled / total) * 100);
    const complete = blanks.length === 0;
    // Blanks worth filling — required ("needed") first, capped so it nudges
    // rather than overwhelms.
    const ranked = [...blanks].sort((a, b) => (b.required === true) - (a.required === true));
    const nudge = ranked.slice(0, 6);
    html = `<div class="mu-card">
      <div class="mu-score">
        <span class="mu-score-num">${filled} of ${total}</span>
        <span class="mu-score-label">details buyers search for in this category are filled in</span>
      </div>
      <div class="mu-bar"><div class="mu-bar-fill" style="width:${pct}%"></div></div>
      ${complete
        ? `<p class="mu-verdict mu-verdict-good">Every detail buyers look for is filled. This listing is as complete as it can be — the strongest version you can give it.</p>`
        : `<p class="mu-verdict">A few details buyers search for are still blank. Filling them gives buyers more ways to find this listing:</p>
           <ul class="mu-blanks">${nudge.map(r =>
             `<li>${escapeHtml(r.name)}${r.required ? ' <span class="mu-needed">needed</span>' : ''}</li>`
           ).join('')}</ul>
           <p class="mu-hint">Go <a href="#datasheet" data-route="datasheet">back to your datasheet</a> to add any you can — or save it now and come back to it.</p>`
      }
    </div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('[data-route]').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); routeTo(a.dataset.route); });
  });
}

function renderSpecificsTable(label, rows, required) {
  if (!rows.length) return '';
  // Fields the active template marks as per-item (Layer 2) — flag the blanks so
  // the seller knows these are theirs to fill for THIS item, not carried over.
  const deltaSet = new Set((getActive() || {})._templateDeltaFields || []);
  const trs = rows.map(r => {
    const blank = !r.value;
    const valueCls = 'ds-spec-value' + (blank ? ' ds-spec-empty' : '');
    const shown = blank ? 'Add a value' : escapeHtml(r.value);
    const flag = (blank && deltaSet.has(r.name))
      ? ' <span class="ds-spec-flag ds-spec-delta">for this item</span>'
      : ((r.required && blank) ? ' <span class="ds-spec-flag">needed</span>' : '');
    return `
    <tr>
      <td class="ds-spec-name">${escapeHtml(r.name)}${flag}</td>
      <td class="${valueCls}" data-aspect="${escapeHtml(r.name)}" data-value="${escapeHtml(r.value)}" title="Click to edit">${shown}</td>
    </tr>`;
  }).join('');
  return `
    <h3 class="ds-subheading">${label}</h3>
    <table class="ds-specs">
      <tbody>${trs}</tbody>
    </table>
  `;
}

function openExternalSearch(query) {
  const url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
  if (window.pywebview?.api?.open_url) window.pywebview.api.open_url(url);
  else window.open(url, '_blank', 'noopener');
}
(function injectSpecSearchStyles() {
  const css = `
  .ds-spec-edit { display:flex; align-items:center; gap:8px; }
  .ds-spec-edit .ds-spec-input { flex:1; }
  .ds-spec-search { font-size:11px; color:#2d6cdf; text-decoration:none; white-space:nowrap; }
  .ds-spec-search:hover { text-decoration:underline; }
  `;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
})();

function beginEditSpec(cell) {
  if (cell.querySelector('input')) return;  // already editing
  const aspect = cell.dataset.aspect;
  const current = cell.dataset.value || '';
  cell.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'ds-spec-edit';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'ds-spec-input';
  wrap.appendChild(input);

  // Off-eBay fill assist: a targeted web search for this exact field. The
  // seller's edit is the commit (webEnrichValue is the automated future rung).
  const it = getActive();
  const q = [it?.identify?.brand, it?.identify?.model, aspect].filter(Boolean).join(' ').trim()
    || [it?.title, aspect].filter(Boolean).join(' ').trim();
  if (q) {
    const link = document.createElement('a');
    link.className = 'ds-spec-search';
    link.href = '#';
    link.textContent = 'search the web ↗';
    link.title = `Look up "${aspect}" for this item`;
    link.addEventListener('mousedown', ev => ev.preventDefault());  // don't blur-commit the input
    link.addEventListener('click', ev => { ev.preventDefault(); openExternalSearch(q); });
    wrap.appendChild(link);
  }

  cell.appendChild(wrap);
  input.focus();
  input.select();

  const commit = () => {
    const v = input.value.trim();
    const item = getActive();
    const overrides = { ...(item.specificsOverrides || {}) };
    if (v) overrides[aspect] = v;
    else delete overrides[aspect];
    updateActive({ specificsOverrides: overrides });
    renderDatasheet();
  };
  const cancel = () => renderDatasheet();

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
}

function buildDatasheetMarkdown(item) {
  const lines = [];
  const head = [item.identify.brand, item.identify.model].filter(Boolean).join(' ');
  lines.push(`# ${head || 'Item'} — eBay Datasheet`);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## Title');
  lines.push('');
  lines.push('```');
  lines.push(item.title || '');
  lines.push('```');
  lines.push('');

  lines.push('## Category');
  lines.push('');
  lines.push(item.category?.path?.join(' › ') || '—');
  lines.push('');

  const pm = productMatchEpid(item);
  if (pm) {
    lines.push('## Product match');
    lines.push('');
    lines.push(`This item looks like eBay catalog product **${pm.epid}**, agreed across ${pm.count} of the listings you chose. If eBay's form offers a matching product, choose it — it fills core details buyers filter on.`);
    lines.push('');
  }

  lines.push('## Condition');
  lines.push('');
  lines.push(`> ${item.conditionStatement || '—'}`);
  lines.push('');

  lines.push('## Item Description');
  lines.push('');
  lines.push(item.description || '—');
  lines.push('');

  const specs = specificsForRender(item);
  const reqFilled = specs.required.filter(r => r.value);
  const optFilled = specs.optional.filter(r => r.value);
  const stillBlank = [...specs.required, ...specs.optional]
    .filter(r => !r.value)
    .map(r => r.name);
  lines.push('## Item Specifics');
  lines.push('');
  if (reqFilled.length) {
    lines.push('### Required');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    reqFilled.forEach(r => lines.push(`| ${r.name} | ${r.value} |`));
    lines.push('');
  }
  if (optFilled.length) {
    lines.push('### Optional');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    optFilled.forEach(r => lines.push(`| ${r.name} | ${r.value} |`));
    lines.push('');
  }
  if (stillBlank.length) {
    // Fill-until-full checklist: every aspect still empty. Cassini expects all
    // filled; this is the seller's worklist toward zero blanks.
    lines.push(`### Still to fill (${stillBlank.length})`);
    lines.push('');
    lines.push(stillBlank.map(n => `- ${n}`).join('\n'));
    lines.push('');
  }

  lines.push('## Shipping & Returns');
  lines.push('');
  lines.push('Set up a **shipping policy** and a **return policy** in eBay Business Policies before publishing this listing.');
  lines.push('');
  lines.push('- **Where:** Seller Hub → Account Settings → Business Policies');
  lines.push('- Business Policies are reusable across all your listings.');

  return lines.join('\n');
}

function saveBrowserDownload(content, filename) {
  // Browser fallback for save_datasheet. Triggers the standard download
  // dialog. The browser then handles location/filename — same UX role as
  // the Pywebview SAVE_DIALOG, just rendered by the browser.
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { saved: true, path: filename };
}

async function saveDatasheetClicked() {
  const item = getActive();
  if (!item) return;
  const content = buildDatasheetMarkdown(item);
  const safe = s => (s || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const parts = [safe(item.identify.brand), safe(item.identify.model), 'datasheet']
    .filter(Boolean);
  const defaultName = (parts.join('-') || 'datasheet') + '.md';
  try {
    const result = window.pywebview?.api?.save_datasheet
      ? await window.pywebview.api.save_datasheet(content, defaultName)
      : saveBrowserDownload(content, defaultName);
    if (result && result.saved) {
      updateActive({ savedAt: new Date().toISOString(), savedPath: result.path });
      showThankYou();
    }
  } catch (err) {
    console.error('save failed', err);
  }
}
document.getElementById('datasheetSaveBtn')?.addEventListener('click', saveDatasheetClicked);
// Save now lives at the end of "How it measures up", not the datasheet.
document.getElementById('measureUpSaveBtn')?.addEventListener('click', saveDatasheetClicked);
// "Next" carries the seller into the full Analyzer — the other door of the same
// idea — so the last step is never a dead end, even with nothing filled in.
document.getElementById('measureUpNextBtn')?.addEventListener('click', () => switchTab('analyze'));

// === Thank-you modal ===
// Free tier is unlimited (no counter, no wall, no upgrade pitch). Both tiers
// show the same Saved confirmation. The atWall parameter is kept for backward
// compatibility with showThankYouAtWall() callers but is now a no-op.
function paintThankYou({ atWall = false } = {}) {
  const counterEl = document.getElementById('thankYouCounter');
  const linkRow   = document.getElementById('thankYouLinkRow');
  const startBtn  = document.getElementById('thankYouStartAnother');
  const titleEl   = document.getElementById('thankYouTitle');
  const bodyEl    = document.getElementById('thankYouBody');

  counterEl?.classList.add('hidden');
  linkRow?.classList.add('hidden');
  if (titleEl) titleEl.textContent = 'Saved.';
  if (bodyEl)  bodyEl.textContent  = 'Thanks for using Bynari Insight.';
  if (startBtn) {
    startBtn.textContent = 'Start another listing';
    startBtn.dataset.action = 'new';
    startBtn.disabled = false;
  }
}

function showThankYou() {
  paintThankYou({ atWall: false });
  document.getElementById('thankYouBackdrop')?.classList.remove('hidden');
}
function showThankYouAtWall() {
  paintThankYou({ atWall: true });
  document.getElementById('thankYouBackdrop')?.classList.remove('hidden');
}
function hideThankYou() {
  document.getElementById('thankYouBackdrop')?.classList.add('hidden');
}

// Close on the thank-you modal returns to Home — the saved item rests in the
// queue with its savedAt timestamp, the active-item highlight clears, the
// walkthrough sidebar de-activates.
document.getElementById('thankYouClose')?.addEventListener('click', () => {
  hideThankYou();
  setActive(null);
  routeTo('home');
});

document.getElementById('thankYouStartAnother')?.addEventListener('click', e => {
  const action = e.currentTarget.dataset.action || 'new';
  if (action === 'upgrade') {
    // Route to landing page for desktop-app purchase
    if (window.pywebview?.api?.open_url) {
      window.pywebview.api.open_url('https://www.bynari-insight.com');
    } else {
      window.open('https://www.bynari-insight.com', '_blank');
    }
    return;
  }
  hideThankYou();
  startNewItem();
});

document.getElementById('thankYouLink')?.addEventListener('click', e => {
  e.preventDefault();
  const url = e.currentTarget.dataset.url;
  if (window.pywebview?.api?.open_url) {
    window.pywebview.api.open_url(url);
  } else {
    window.open(url, '_blank');
  }
});

document.getElementById('thankYouTipLink')?.addEventListener('click', e => {
  e.preventDefault();
  const url = e.currentTarget.dataset.url;
  if (window.pywebview?.api?.open_url) {
    window.pywebview.api.open_url(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
});

// Backdrop click behaves like Close — return to Home.
document.getElementById('thankYouBackdrop')?.addEventListener('click', e => {
  if (e.target.id === 'thankYouBackdrop') {
    hideThankYou();
    setActive(null);
    routeTo('home');
  }
});

// === New Item wiring ===
function startNewItem() {
  newItem();
  routeTo('photos');
}
document.getElementById('cmdNewItem')?.addEventListener('click', startNewItem);
document.getElementById('homeNewItemBtn')?.addEventListener('click', startNewItem);
document.getElementById('homeNewItemBtnQueue')?.addEventListener('click', startNewItem);

// === Rewrite entry wiring ===
function goToRewrite() {
  routeTo('rewrite');
}

// === Start over (discard current in-flight, fresh listing) ===
async function startOver() {
  if (!(await showConfirm('Discard this item and start over? Your work won\'t be saved.'))) return;
  const currentId = getActiveId();
  if (currentId) {
    const items = loadItems().filter(i => i.id !== currentId);
    saveItems(items);
  }
  newItem();
  routeTo('photos');
}

// "Start over" lives in the quiet sidebar foot (beside "How this works"), not
// in each step's action row — it's an escape hatch, not part of the forward
// path. refreshSidebarState() shows it only while an item is in flight.
document.getElementById('startOverLink')?.addEventListener('click', e => {
  e.preventDefault();
  startOver();
});
document.getElementById('homeRewriteBtn')?.addEventListener('click', goToRewrite);
document.getElementById('homeRewriteBtnQueue')?.addEventListener('click', goToRewrite);

// === Batch spawn wiring ===
document.getElementById('batchCreateBtn')?.addEventListener('click', async () => {
  const sel = document.getElementById('batchTemplate');
  const countEl = document.getElementById('batchCount');
  const status = document.getElementById('batchStatus');
  const btn = document.getElementById('batchCreateBtn');
  if (!sel || !sel.value) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  try {
    const n = await spawnBatch(sel.value, countEl ? countEl.value : 10);
    routeTo('home');
    if (status) status.textContent = '';
  } catch (e) {
    console.error('spawnBatch', e);
    if (status) { status.classList.add('error'); status.textContent = 'Could not create the batch.'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Create drafts'; }
  }
});

function setRewriteStatus(text, kind) {
  const el = document.getElementById('rewriteStatus');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('error', kind === 'error');
}

function deriveCategoryFromItem(itemData) {
  // item.php returns categoryId + categoryPath (pipe-separated names) +
  // optional categoryIdPath. We construct the same shape renderCategory uses.
  const id = itemData.categoryId || '';
  const pathStr = itemData.categoryPath || '';
  const parts = pathStr ? pathStr.split('|').filter(Boolean) : [];
  const name = parts.length ? parts[parts.length - 1] : '';
  if (!id || !name) return null;
  return { id, name, path: parts, q: '' };
}

async function rewriteSubmit() {
  const input = document.getElementById('rewriteInput');
  const text = (input?.value || '').trim();
  if (!text) {
    setRewriteStatus('Paste a URL or item number first.', 'error');
    return;
  }
  const itemId = extractEbayItemId(text);
  if (!itemId) {
    setRewriteStatus('That doesn\'t look like a valid eBay URL or item number.', 'error');
    return;
  }
  setRewriteStatus('Pulling the listing…');
  try {
    // Seed + diagnose in one pass (freshness + quality + Sell-Similar framing,
    // stored on _rewriteAnalysis). The comp rebuild is the interactive walk that
    // follows, so harvest stays off here.
    await analyzeListingForRewrite(itemId, { harvest: false });
  } catch (err) {
    setRewriteStatus('Could not pull that listing: ' + err.message, 'error');
    return;
  }
  if (input) input.value = '';
  setRewriteStatus('');
  routeTo('rewrite-result');
}

// Shared Buy/Rewrite handoff: pull an existing eBay listing as the reference
// and seed a fresh in-flight listing from it. Used by Rewrite (paste a URL)
// and by Buy (pick a sourcing candidate). Returns the reference data; throws
// on fetch failure so the caller can show its own status.
async function startListingFromEbayItem(itemId, mode) {
  const data = await fetchItemAsReference(itemId);
  newItem();   // creates + sets active
  const category = deriveCategoryFromItem(data);
  const ref = {
    itemId: data.itemId || itemId,
    title: data.title || '',
    condition: data.condition || '',
    itemWebUrl: data.itemWebUrl || '',
  };
  // Seed the datasheet from the item's OWN specifics so they show even before
  // (or without) a comp harvest — the listing you're rewriting (or sourcing) is
  // its own first reference. Treat the item as a comp; keep it in the harvest
  // pool (surveySelections) so walking to "Items like yours" unions more on top.
  let seedMatrix;
  try {
    const schema = category?.id ? await fetchItemAspects(category.id) : [];
    seedMatrix = buildConsensus([{ ...ref, specs: aspectsToSpecs(data.localizedAspects) }], schema);
  } catch (e) {
    console.error('rewrite seed', e);
    seedMatrix = buildConsensus([{ ...ref, specs: aspectsToSpecs(data.localizedAspects) }], []);
  }
  updateActive({
    mode,
    sourceItemId: itemId,
    status: 'title',
    identify: {
      brand: data.brand || '',
      model: data.mpn || '',
      year: '',
      size: '',
      userDescription: '',
    },
    category,
    selectedComp: ref,
    surveySelections: [ref],
    referenceItem: data,
    // Clear any prefill markers so the next render generates fresh text
    // from the new reference / consensus pair.
    title: '',
    description: '',
    conditionStatement: '',
    _autoTitle: '',
    _autoDescription: '',
    _autoCondition: '',
    _consensusMatrix: seedMatrix,
    _harvestedComps: null,
  });
  return data;
}
// === Rewrite-from-31-day core (BYN-desktop-architecture §3B) ===
// Two scoring axes over a pasted listing — FRESHNESS (age vs the GTC mark, from
// item.php's itemCreationDate) and QUALITY (title/photos/specifics vs target) —
// plus a priority and the End-and-Sell-Similar action. The scoring primitives are
// pure (the ranked worklist calls them per item without touching active state);
// analyzeListingForRewrite is the single-paste orchestration that seeds + scores
// and (optionally) rebuilds the datasheet from comps.
const GTC_CLIFF_DAYS = 31;

// User-facing copy stays NEUTRAL: state the listing's age as a fact and frame the
// relist as a fresh start. No claims about eBay (no "visibility"/"throttle"); the
// 31-day rationale lives in the spec, not the shipped string. See memory
// feedback-no-accusing-ebay.
function scoreFreshness(itemCreationDate, nowMs) {
  if (!itemCreationDate) return { ageDays: null, bucket: 'unknown', label: 'Listing age not available.' };
  const created = Date.parse(itemCreationDate);
  if (isNaN(created)) return { ageDays: null, bucket: 'unknown', label: 'Listing age not available.' };
  const now = (nowMs != null) ? nowMs : Date.now();
  const ageDays = Math.max(0, Math.floor((now - created) / 86400000));
  let bucket, label;
  if (ageDays < GTC_CLIFF_DAYS) { bucket = 'fresh'; label = `Listed ${ageDays} day${ageDays === 1 ? '' : 's'} ago.`; }
  else if (ageDays <= 60) { bucket = 'eroding'; label = `Listed ${ageDays} days ago — a fresh relist is worth considering.`; }
  else { bucket = 'stale'; label = `Listed ${ageDays} days ago — a fresh relist is likely overdue.`; }
  return { ageDays, bucket, label };
}

// Quality of the listing AS IT STANDS (the "before"): title length vs the 70–80
// target, photo count vs 6–8, and how many category fields it fills. Operates on
// the seeded active item (its _consensusMatrix carries the listing's own specs).
function inferRewriteQuality(item) {
  const ref = item.referenceItem || {};
  const title = item.title || ref.title || '';
  const titleLen = title.length;
  const photoCount = (ref.image ? 1 : 0) + ((ref.additionalImages && ref.additionalImages.length) || 0);
  const matrix = item._consensusMatrix || [];
  const requiredGaps = matrix.filter(r => r.required && !resolveSpecValue(r, item).value).map(r => r.name);
  const filled = matrix.filter(r => resolveSpecValue(r, item).value).length;
  const fillRate = matrix.length ? filled / matrix.length : 0;
  const titleScore = titleLen >= 70 ? 1 : titleLen / 70;
  const photoScore = Math.min(photoCount, 8) / 8;
  const score = 0.4 * fillRate + 0.3 * titleScore + 0.3 * photoScore;
  const gaps = [];
  if (titleLen < 70) gaps.push(`Title is ${titleLen} characters (aim 70–80)`);
  if (photoCount < 6) gaps.push(`${photoCount} photo${photoCount === 1 ? '' : 's'} (aim 6–8)`);
  if (requiredGaps.length) gaps.push(`${requiredGaps.length} required field${requiredGaps.length === 1 ? '' : 's'} still blank`);
  return { titleLen, photoCount, fillRate, requiredGaps, score, gaps };
}

// Rewrite priority — higher = sooner. Past the cliff AND low quality is the top
// candidate (a fresh item number alone won't save a thin listing). Tunable.
function rewritePriority(freshness, quality) {
  const ageFactor = { stale: 1, eroding: 0.6, unknown: 0.3, fresh: 0.1 }[freshness.bucket] ?? 0.3;
  const qualGap = 1 - (quality.score || 0);
  return Math.round((0.5 * ageFactor + 0.5 * qualGap) * 100);
}

function buildSellSimilarInstruction(freshness) {
  const age = (freshness && freshness.ageDays != null) ? `This listing is ${freshness.ageDays} days old. ` : '';
  return `${age}End the current listing and use eBay's "Sell similar" to relist from this refreshed datasheet — a new item number, a fresh start. Don't just revise the existing one.`;
}

// Single-paste orchestration. opts.harvest=true rebuilds the datasheet from comps
// (the worklist path); default false = diagnose the listing as-is (the interactive
// path, where the seller then walks the comp rebuild). opts.nowMs for testing.
async function analyzeListingForRewrite(idOrText, opts = {}) {
  const itemId = extractEbayItemId(idOrText) || (/^\s*\d{8,}\s*$/.test('' + idOrText) ? ('' + idOrText).trim() : null);
  if (!itemId) throw new Error('not a valid eBay URL or item number');
  const data = await startListingFromEbayItem(itemId, 'rewrite');   // seeds active item
  const freshness = scoreFreshness(data.itemCreationDate, opts.nowMs);

  if (opts.harvest) {
    try {
      const active = getActive();
      const q = buildSearchQuery(active);
      if (q && active.category?.id) {
        const summaries = dedupeComps(await searchComps(q, { categoryId: active.category.id, limit: COMPS_FETCH_MAX }));
        const ownRef = { itemId: data.itemId || itemId, title: data.title || '', condition: data.condition || '', itemWebUrl: data.itemWebUrl || '' };
        const picks = summaries.slice(0, HARVEST_MAX_COMPS).map(s => ({ itemId: s.itemId, title: s.title || '', condition: s.condition || '', itemWebUrl: s.itemWebUrl || '' }));
        updateActive({ surveySelections: [ownRef, ...picks], _compsCache: { q, items: summaries, offset: 0 } });
        await harvestForActiveItem();
      }
    } catch (e) { console.error('rewrite harvest', e); }
  }

  const item = getActive();
  const quality = inferRewriteQuality(item);
  const priority = rewritePriority(freshness, quality);
  const analysis = {
    itemId,
    ageDays: freshness.ageDays,
    freshness,
    quality,
    gaps: quality.gaps,
    priority,
    sellSimilar: buildSellSimilarInstruction(freshness),
    refreshedDatasheet: opts.harvest ? buildDatasheetMarkdown(item) : null,
  };
  updateActive({ _rewriteAnalysis: analysis });
  return analysis;
}

// The rewrite-result summary — renders _rewriteAnalysis (set by the core). Copy
// stays neutral/plain: the verdict frames it as the seller's opportunity, never a
// claim about eBay (no "throttle"/"visibility"/jargon). Empty state when no
// analysis. See feedback-no-accusing-ebay, feedback-no-industry-jargon-in-ui.
function renderRewriteResult() {
  const item = getActive();
  const el = document.getElementById('rewriteResultContent');
  if (!el) return;
  const a = item && item._rewriteAnalysis;
  if (!a) {
    el.innerHTML = '<div class="rr-empty">Paste a listing on the previous step to see its review.</div>';
    return;
  }
  const verdict = rewriteVerdict(a.priority);
  const gapsHtml = (a.gaps && a.gaps.length)
    ? `<ul class="rr-gaps">${a.gaps.map(g => `<li>${escapeHtml(g)}</li>`).join('')}</ul>`
    : '<p class="rr-nogap">Nothing major stands out — title, photos, and details look complete.</p>';
  el.innerHTML = `
    <div class="rr-verdict ${verdict.cls}">${escapeHtml(verdict.text)}</div>
    <div class="rr-age">${escapeHtml(a.freshness.label)}</div>
    <div class="rr-block">
      <h3 class="rr-h">What could be stronger</h3>
      ${gapsHtml}
    </div>
    <div class="rr-block rr-action">
      <h3 class="rr-h">How to refresh it</h3>
      <p class="rr-instruction">${escapeHtml(a.sellSimilar)}</p>
    </div>`;
}
(function injectRewriteResultStyles() {
  const css = `
  .rewrite-result { max-width:640px; }
  .rr-empty { color:#9ca3af; font-style:italic; padding:12px 0; }
  .rr-verdict { display:inline-block; font-size:13px; font-weight:600; padding:5px 12px;
    border-radius:14px; margin-bottom:10px; }
  .rr-high { background:#fef2f2; color:#b91c1c; }
  .rr-med  { background:#fffbeb; color:#b45309; }
  .rr-low  { background:#ecfdf5; color:#047857; }
  .rr-age { font-size:14px; color:#374151; margin-bottom:18px; }
  .rr-block { margin-bottom:18px; }
  .rr-h { font-size:12px; font-weight:600; color:#6b7280; text-transform:uppercase;
    letter-spacing:.04em; margin:0 0 8px; }
  .rr-gaps { margin:0; padding-left:18px; color:#1f2937; font-size:14px; line-height:1.6; }
  .rr-nogap { margin:0; color:#047857; font-size:14px; }
  .rr-action { background:#f9fafb; border:1px solid #eef0f3; border-radius:8px; padding:14px 16px; }
  .rr-instruction { margin:0; color:#1f2937; font-size:14px; line-height:1.55; }
  `;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
})();

// Shared verdict mapping (rewrite-result + worklist).
function rewriteVerdict(priority) {
  return priority >= 60 ? { cls: 'rr-high', text: 'Worth refreshing' }
       : priority >= 30 ? { cls: 'rr-med', text: 'Could be refreshed' }
       : { cls: 'rr-low', text: 'Looks good as it is' };
}

// === Rewrite worklist — rank many listings by what to refresh first ===
// The batch entry over the same scorers as the single-paste core. Lightweight
// per-listing quality (NO per-item harvest or active-state mutation, so it scales)
// + freshness → priority → sort. Source of item numbers here is a pasted list; the
// LQR-xlsx (desktop bridge) and library.db are the shaped-for upgrades that feed
// the SAME buildRewriteWorklist(). See BYN-desktop-architecture §3B.
const WORKLIST_MAX = 50;

function quickListingQuality(data) {
  const titleLen = (data.title || '').length;
  const photoCount = (data.image ? 1 : 0) + ((data.additionalImages && data.additionalImages.length) || 0);
  const specCount = (data.localizedAspects || []).length;
  const titleScore = titleLen >= 70 ? 1 : titleLen / 70;
  const photoScore = Math.min(photoCount, 8) / 8;
  const specScore = Math.min(specCount, 15) / 15;   // ~15 specifics ≈ well-filled
  const score = 0.4 * specScore + 0.3 * titleScore + 0.3 * photoScore;
  const gaps = [];
  if (titleLen < 70) gaps.push(`title ${titleLen} chars`);
  if (photoCount < 6) gaps.push(`${photoCount} photo${photoCount === 1 ? '' : 's'}`);
  if (specCount < 8) gaps.push(`${specCount} specific${specCount === 1 ? '' : 's'}`);
  return { titleLen, photoCount, specCount, score, gaps };
}

async function buildRewriteWorklist(itemNumbers, opts = {}) {
  const ids = [];
  for (const s of itemNumbers) {
    const id = extractEbayItemId(s) || (/^\s*\d{8,}\s*$/.test('' + s) ? ('' + s).trim() : null);
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= WORKLIST_MAX) break;
  }
  const settled = await Promise.allSettled(ids.map(id => fetchItemAsReference(id).then(d => ({ id, d }))));
  const rows = [];
  for (const r of settled) {
    if (r.status !== 'fulfilled' || !r.value || !r.value.d) continue;
    const { id, d } = r.value;
    const freshness = scoreFreshness(d.itemCreationDate, opts.nowMs);
    const quality = quickListingQuality(d);
    rows.push({ itemId: id, title: d.title || '', freshness, quality, priority: rewritePriority(freshness, quality) });
  }
  rows.sort((a, b) => b.priority - a.priority);
  return rows;
}

function setWorklistStatus(text, kind) {
  const el = document.getElementById('worklistStatus');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('error', kind === 'error');
}

let _worklistRows = null;

// Rank the seller's imported inventory directly — no pasting. Pulls item numbers
// from the current inventory (saved + uploaded) and runs the same ranker the
// pasted-list path uses, so the worklist works off the items already on screen.
async function worklistRankInventory() {
  const items = (await currentInventoryItems()).filter(it => it.ebay_item_no);
  if (!items.length) {
    _worklistRows = null;
    renderWorklist();
    setWorklistStatus('Import your listings first — open My Inventory and upload your eBay report.', 'error');
    return;
  }
  const nums = items.map(it => it.ebay_item_no);
  setWorklistStatus(`Ranking ${nums.length} item${nums.length === 1 ? '' : 's'} from your inventory…`);
  let rows;
  try { rows = await buildRewriteWorklist(nums); }
  catch (e) { setWorklistStatus('Could not rank your inventory: ' + e.message, 'error'); return; }
  _worklistRows = rows;
  setWorklistStatus(rows.length ? '' : 'None of those could be loaded.', rows.length ? '' : 'error');
  renderWorklist();
}

async function worklistRank() {
  const ta = document.getElementById('worklistInput');
  const lines = ((ta && ta.value) || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) { setWorklistStatus('Paste at least one listing.', 'error'); return; }
  setWorklistStatus(`Ranking ${lines.length} listing${lines.length === 1 ? '' : 's'}…`);
  let rows;
  try { rows = await buildRewriteWorklist(lines); }
  catch (e) { setWorklistStatus('Could not rank those: ' + e.message, 'error'); return; }
  _worklistRows = rows;
  setWorklistStatus(rows.length ? '' : 'None of those could be loaded.', rows.length ? '' : 'error');
  renderWorklist();
}

function renderWorklist() {
  const el = document.getElementById('worklistResults');
  if (!el) return;
  const rows = _worklistRows;
  if (!rows) { el.innerHTML = ''; return; }
  if (!rows.length) { el.innerHTML = '<div class="rr-empty">Nothing to rank yet.</div>'; return; }
  el.innerHTML = rows.map((r, i) => {
    const v = rewriteVerdict(r.priority);
    const meta = [r.freshness.label, ...(r.quality.gaps || [])].filter(Boolean).join(' · ');
    return `
    <div class="wl-row">
      <div class="wl-rank">${i + 1}</div>
      <div class="wl-main">
        <div class="wl-title">${escapeHtml(r.title || ('Item ' + r.itemId))}</div>
        <div class="wl-meta">${escapeHtml(meta)}</div>
      </div>
      <div class="wl-side">
        <span class="wl-pill ${v.cls}">${escapeHtml(v.text)}</span>
        <button class="button small wl-rewrite" data-id="${escapeHtml(r.itemId)}">Rewrite &rarr;</button>
      </div>
    </div>`;
  }).join('');
  el.querySelectorAll('.wl-rewrite').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.id;
    b.disabled = true; b.textContent = 'Loading…';
    try { await analyzeListingForRewrite(id, { harvest: false }); routeTo('rewrite-result'); }
    catch (e) { b.disabled = false; b.textContent = 'Rewrite →'; setWorklistStatus('Could not load that listing: ' + e.message, 'error'); }
  }));
}
(function injectWorklistStyles() {
  const css = `
  .worklist-results { margin-top:18px; display:flex; flex-direction:column; gap:8px; }
  .wl-row { display:flex; align-items:center; gap:12px; padding:10px 12px; border:1px solid #eef0f3;
    border-radius:8px; background:#fff; }
  .wl-rank { font-size:13px; font-weight:600; color:#9ca3af; width:20px; text-align:center; flex:none; }
  .wl-main { flex:1; min-width:0; }
  .wl-title { font-size:14px; color:#1f2937; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .wl-meta { font-size:12px; color:#6b7280; margin-top:2px; }
  .wl-side { display:flex; align-items:center; gap:10px; flex:none; }
  .wl-pill { font-size:12px; font-weight:600; padding:3px 10px; border-radius:12px; white-space:nowrap; }
  .button.small { font-size:12px; padding:5px 10px; }
  .wl-entry-link { color:#2d6cdf; text-decoration:none; }
  .wl-entry-link:hover { text-decoration:underline; }
  `;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
})();
document.getElementById('worklistRankBtn')?.addEventListener('click', worklistRank);
document.getElementById('worklistRankInvBtn')?.addEventListener('click', worklistRankInventory);

document.getElementById('rewriteSubmitBtn')?.addEventListener('click', rewriteSubmit);
document.getElementById('rewriteInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); rewriteSubmit(); }
});

// === Buy mode (sourcing) ===
// Search eBay for items to grab and resell, filtered by listing format and
// sorted cheapest-first. Picking one hands off to List via the shared
// startListingFromEbayItem(). "Stale items" filtering is deferred here, but the
// age signal DOES exist — item.php (and search summaries) carry itemCreationDate;
// the Rewrite-from-31-day core uses it (scoreFreshness). Buy just doesn't filter
// on it yet.
const BUY_FORMAT_FILTERS = { auction: 'AUCTION', bin: 'FIXED_PRICE', offer: 'BEST_OFFER' };

function setBuyStatus(text) {
  const el = document.getElementById('buyStatus');
  if (el) el.textContent = text || '';
}

function selectedBuyFormats() {
  return [...document.querySelectorAll('.buy-chip.active')].map(c => c.dataset.format);
}

function buyPriceText(it) {
  // Auctions expose currentBidPrice; fixed-price exposes price.
  const p = it.price || it.currentBidPrice;
  if (!p || p.value == null) return '—';
  const sym = p.currency === 'USD' ? '$' : (p.currency ? p.currency + ' ' : '');
  const bids = (it.bidCount != null) ? ` · ${it.bidCount} bid${it.bidCount === 1 ? '' : 's'}` : '';
  return `${sym}${p.value}${bids}`;
}

function buyFormatBadge(it) {
  const opts = it.buyingOptions || [];
  if (opts.includes('AUCTION')) return 'Auction';
  if (opts.includes('BEST_OFFER')) return 'Best Offer';
  if (opts.includes('FIXED_PRICE')) return 'Buy It Now';
  return '';
}

async function buySearch() {
  const q = (document.getElementById('buyInput')?.value || '').trim();
  const listEl = document.getElementById('buyResults');
  if (!q) { setBuyStatus("Type what you're looking to source."); return; }
  const formats = selectedBuyFormats();
  const filter = formats.length
    ? `buyingOptions:{${formats.map(f => BUY_FORMAT_FILTERS[f]).join('|')}}`
    : '';
  setBuyStatus('Searching eBay…');
  if (listEl) listEl.innerHTML = '';
  try {
    const items = await searchComps(q, { filter, sort: 'price', limit: 24 });
    if (!items.length) { setBuyStatus('No matches. Try different words or fewer filters.'); return; }
    setBuyStatus(`${items.length} candidate${items.length === 1 ? '' : 's'}, cheapest first.`);
    renderBuyResults(items);
  } catch (err) {
    setBuyStatus('Search failed: ' + err.message);
  }
}

function renderBuyResults(items) {
  const listEl = document.getElementById('buyResults');
  if (!listEl) return;
  listEl.innerHTML = items.map(it => {
    const img = it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || '';
    const id = stripItemIdEnvelope(it.itemId || '');
    const badge = buyFormatBadge(it);
    return `
    <div class="buy-card">
      <div class="buy-thumb">${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy">` : ''}</div>
      <div class="buy-info">
        <div class="buy-title">${escapeHtml(it.title || '')}</div>
        <div class="buy-meta">
          <span class="buy-price">${escapeHtml(buyPriceText(it))}</span>
          ${badge ? `<span class="buy-badge">${escapeHtml(badge)}</span>` : ''}
        </div>
      </div>
      <div class="buy-actions">
        <button class="button primary buy-send" data-item-id="${escapeHtml(id)}">Send to List</button>
        ${it.itemWebUrl ? `<a class="buy-view" href="#" data-url="${escapeHtml(it.itemWebUrl)}">View on eBay</a>` : ''}
      </div>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.buy-send').forEach(b =>
    b.addEventListener('click', () => sendToList(b.dataset.itemId, b)));
  listEl.querySelectorAll('.buy-view').forEach(a =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const url = a.dataset.url;
      if (window.pywebview?.api?.open_url) window.pywebview.api.open_url(url);
      else window.open(url, '_blank');
    }));
}

async function sendToList(itemId, btn) {
  if (!itemId) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Pulling…'; }
  try {
    await startListingFromEbayItem(itemId, 'buy');
    switchTab('listing');
    routeTo('title');
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Send to List'; }
    setBuyStatus('Could not pull that listing: ' + err.message);
  }
}

document.querySelectorAll('.buy-chip').forEach(c =>
  c.addEventListener('click', () => c.classList.toggle('active')));
document.getElementById('buyFindBtn')?.addEventListener('click', buySearch);
document.getElementById('buyInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); buySearch(); }
});

// === Sell mode — Listing fixes ===
// Diagnose a listing that isn't selling: fetch it through the broker, score it
// against cassini.db (what buyers search), and show ranked Issues & Fixes — the
// same engine as the desktop Item Analyzer (cassini_analyzer.py), ported to JS.
// Reads-only, no auth. Account / Behavior / Promotions need seller OAuth — later.
const SELL_CONDITION_WORDS = [
  'new without tags', 'new with tags', 'serviced', 'restored',
  'excellent condition', 'mint', 'like new', 'nwt', 'nib', 'nos',
  'refurbished', 'seller refurbished', 'pre-owned', 'remanufactured', 'new (other)',
];

// Sell mode: harvest the listing's category peers and compute, per aspect, the
// fraction of comparable listings that actually fill it. That fill-rate is the
// honest demand signal — a field real peers fill is worth recommending; one they
// ignore (Band Type on a pocket watch ≈ 0%) is not, no matter what eBay's schema
// lists. Returns {rates: Map(lowerName→0..1), peerCount} or null when too sparse.
// Shared core: given a query ladder + category, fetch up to 8 broad peers and
// return per-aspect fill-rate {rates: Map(lowerName→0..1), peerCount} or null
// when too sparse to trust. The ladder lets an obscure-brand query widen to the
// item's own words (same lesson as the Rewrite flow). Used by both Sell (score
// a single listing) and List (decide which fields a category's items carry).
async function peerFillRatesFromQueries(queries, catId, selfId) {
  if (!catId || !queries || !queries.length) return null;
  const self = selfId || '';
  const ids = [];
  for (const q of queries) {
    if (!q || !q.trim()) continue;
    let raw;
    try { raw = await searchComps(q, { categoryId: catId, limit: 25 }); } catch (e) { continue; }
    for (const s of dedupeComps(raw || [])) {
      const id = stripItemIdEnvelope(s.itemId);
      if (id && id !== self && !ids.includes(id)) ids.push(id);
    }
    if (ids.length >= 8) break;
  }
  const pickIds = ids.slice(0, 8);
  if (pickIds.length < 3) return null;
  const settled = await Promise.allSettled(pickIds.map(id => fetchItemAsReference(id)));
  const peers = settled.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  if (peers.length < 3) return null;
  const counts = new Map();
  for (const p of peers) {
    for (const [k, v] of Object.entries(aspectsToSpecs(p.localizedAspects))) {
      if (v && v.toString().trim()) {
        const key = k.toLowerCase();
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  const rates = new Map();
  for (const [k, c] of counts) rates.set(k, c / peers.length);
  return { rates, peerCount: peers.length };
}

// Sell mode: fill-rates for a single existing listing's category peers.
async function harvestPeerFillRates(item, catId) {
  if (!catId) return null;
  const specs = aspectsToSpecs(item.localizedAspects);
  const pick = n => (Object.entries(specs).find(([k]) => k.toLowerCase() === n) || [])[1] || '';
  const bt = [pick('brand'), pick('type')].filter(Boolean).join(' ').trim();
  const titleQ = (item.title || '').split(/\s+/).slice(0, 4).join(' ').trim();
  const queries = [];
  if (bt) queries.push(bt);
  if (titleQ && titleQ.toLowerCase() !== bt.toLowerCase()) queries.push(titleQ);
  return peerFillRatesFromQueries(queries, catId, stripItemIdEnvelope(item.itemId || ''));
}

// List mode: fill-rates for the active in-flight item's category, used to gate
// the union's FIELD SET (drop leaf-dead facets like Band Type on a pocket
// watch). The curated comps still decide the field VALUES.
async function peerFillRatesForActiveItem(item) {
  const catId = item.category?.id;
  if (!catId) return null;
  const primary = (buildSearchQuery(item, { mode: 'primary' }) || '').trim();
  const desc = (item.identify?.userDescription || '').trim();
  const queries = [];
  if (primary) queries.push(primary);
  if (desc && desc.toLowerCase() !== primary.toLowerCase()) {
    queries.push(desc.split(/\s+/).slice(0, 5).join(' '));
  }
  return peerFillRatesFromQueries(queries, catId, '');
}

function scoreListing(item, schema, peerData) {
  const title = (item.title || '').trim();
  const tl = title.toLowerCase();
  const specs = aspectsToSpecs(item.localizedAspects);
  const have = new Set(Object.keys(specs).map(k => k.toLowerCase()));
  // Drop never-searched compliance/logistics fields so we don't recommend them.
  const facetSchema = (schema || []).filter(a => isBuyerFacet(a.name));
  let score = 60;
  const fixes = [];

  if (title.length < 50) {
    fixes.push({ issue: `Title is short — ${title.length} characters`, fix: 'Expand it toward 80 characters, leading with the words buyers type.' });
    score -= 8;
  } else if (title.length > 90) {
    fixes.push({ issue: `Title is long — ${title.length} characters`, fix: 'Trim it to 80 characters or fewer.' });
    score -= 6;
  }
  if (!SELL_CONDITION_WORDS.some(w => tl.includes(w))) {
    fixes.push({ issue: 'No condition signal in the title', fix: 'Add a clear condition — New, New old stock, Pre-owned excellent.' });
    score -= 10;
  }
  for (const a of facetSchema.filter(x => x.required)) {
    if (!have.has((a.name || '').toLowerCase())) {
      fixes.push({ issue: `Missing required field: ${a.name}`, fix: `Add ${a.name} to the item specifics.` });
      score -= 10;
    }
  }
  // Recommended fields. With peer fill-rates, recommend ONLY fields comparable
  // listings actually fill (≥ threshold), ranked by how often they do — so a
  // field like Band Type (≈0% on pocket watches) never appears and "buyers
  // filter on it" is true. Without peer data, fall back to schema (cassini)
  // order with neutral copy, since demand is then unverified.
  const rates = peerData?.rates || null;
  const REC_FILL_THRESHOLD = 0.4; // a plurality of comparable listings fill it
  const blankRec = facetSchema.filter(x => !x.required && !have.has((x.name || '').toLowerCase()));
  let recScored = 0, recMissing = 0;
  let ranked;
  if (rates) {
    ranked = blankRec
      .map(a => ({ a, rate: rates.get((a.name || '').toLowerCase()) || 0 }))
      .filter(x => x.rate >= REC_FILL_THRESHOLD)
      .sort((x, y) => y.rate - x.rate);
  } else {
    ranked = blankRec.map(a => ({ a, rate: null }));
  }
  for (const { a } of ranked) {
    recMissing++;
    if (recScored < 5) {
      const fix = rates ? `Add ${a.name} — buyers filter on it.` : `Add ${a.name} — recommended field.`;
      fixes.push({ issue: `Missing recommended field: ${a.name}`, fix });
      score -= 5;
      recScored++;
    }
  }
  score = Math.max(15, Math.min(100, score));
  const priority = score <= 45 ? 'CRITICAL' : score <= 65 ? 'HIGH' : score <= 80 ? 'MEDIUM' : 'GOOD';
  return { score, priority, fixes, title, specsCount: have.size,
           recMissingExtra: Math.max(0, recMissing - recScored),
           buyerBlank: recMissing, peerBacked: !!rates, peerCount: peerData?.peerCount || 0 };
}

async function analyzeSellListing() {
  const input = document.getElementById('sellItemInput');
  const out = document.getElementById('sellFixResult');
  if (!input || !out) return;
  const raw = input.value.trim();
  const itemId = extractEbayItemId(raw) || (/^\d{9,15}$/.test(raw) ? raw : '');
  out.classList.remove('hidden');
  if (!itemId) {
    out.innerHTML = '<p class="sell-fix-msg">That doesn\'t look like an eBay item number — they\'re 9 to 15 digits.</p>';
    return;
  }
  out.innerHTML = '<p class="sell-fix-msg">Checking…</p>';
  let item;
  try {
    item = await fetchItemAsReference(itemId);
  } catch (e) {
    out.innerHTML = '<p class="sell-fix-msg">Couldn\'t reach that listing. Check the item number and try again.</p>';
    return;
  }
  const catId = (item.categoryIdPath || '').split('|').pop() || item.categoryId || '';
  let schema = [];
  try { if (catId) schema = await fetchItemAspects(catId); } catch (e) { schema = []; }
  let peerData = null;
  try { peerData = await harvestPeerFillRates(item, catId); } catch (e) { peerData = null; }
  renderSellFixes(out, scoreListing(item, schema, peerData), itemId);
}

// Subtitle in buyer-outcome voice (never narrates the comp mechanism). When the
// score is peer-backed we anchor it to the blank buyer-demand fields so the
// number is legible; otherwise we fall back to a plain specifics count.
function sellSub(r) {
  if (!r.peerBacked) {
    return `${r.specsCount} item specific${r.specsCount === 1 ? '' : 's'} on the listing now`;
  }
  if (r.buyerBlank > 0) {
    return `${r.buyerBlank} field${r.buyerBlank === 1 ? '' : 's'} buyers search still blank · ${r.specsCount} filled`;
  }
  return `Covers the fields buyers search · ${r.specsCount} filled`;
}

function renderSellFixes(out, r, itemId) {
  const tone = { CRITICAL: '#b42318', HIGH: '#c2410c', MEDIUM: '#b7791f', GOOD: '#1a7f37' }[r.priority] || '#6b7280';
  const rows = r.fixes.length
    ? r.fixes.map((f, i) => `<tr><td class="sf-n">${i + 1}</td><td class="sf-issue">${escapeHtml(f.issue)}</td><td class="sf-fix">${escapeHtml(f.fix)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="sf-clean">No blocking issues found — this listing covers the basics.</td></tr>';
  const more = r.recMissingExtra
    ? `<p class="sell-fix-msg">${r.recMissingExtra} more recommended field${r.recMissingExtra === 1 ? '' : 's'} could still be filled.</p>` : '';
  out.innerHTML = `
    <div class="sf-head">
      <div class="sf-score" style="color:${tone};border-color:${tone}">${r.score}<span>/100</span></div>
      <div class="sf-head-meta">
        <div class="sf-priority" style="color:${tone}">${r.priority}</div>
        <div class="sf-title" title="${escapeHtml(r.title)}">${escapeHtml(r.title || '—')}</div>
        <div class="sf-sub">${escapeHtml(sellSub(r))}</div>
      </div>
    </div>
    <table class="sf-table"><thead><tr><th></th><th>Issue</th><th>Fix</th></tr></thead><tbody>${rows}</tbody></table>
    ${more}
    <div class="sf-actions"><button class="sell-fix-btn" id="sellRewriteBtn">Rewrite this listing →</button></div>`;
  out.querySelector('#sellRewriteBtn')?.addEventListener('click', () => startListingFromEbayItem(itemId, 'rewrite'));
}

document.getElementById('sellAnalyzeBtn')?.addEventListener('click', analyzeSellListing);
document.getElementById('sellItemInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); analyzeSellListing(); }
});

(function injectSellStyles() {
  const css = `
  .sell-fix-row { display:flex; gap:10px; margin:10px 0 0; max-width:560px; }
  .sell-fix-input { flex:1; padding:9px 12px; border:1px solid #d4d8e0; border-radius:7px; font-size:14px; }
  .sell-fix-btn { background:#2d6cdf; color:#fff; border:0; border-radius:7px; padding:9px 16px; cursor:pointer; font-size:14px; white-space:nowrap; }
  .sell-fix-result { margin:18px 0 8px; max-width:760px; }
  .sell-fix-result.hidden { display:none; }
  .sell-fix-msg { color:#6b7280; font-size:14px; margin:8px 0; }
  .sf-head { display:flex; gap:16px; align-items:center; margin-bottom:14px; }
  .sf-score { font-size:30px; font-weight:800; border:3px solid; border-radius:12px; padding:8px 14px; line-height:1; }
  .sf-score span { font-size:13px; font-weight:600; opacity:.6; }
  .sf-priority { font-size:12px; font-weight:800; letter-spacing:.5px; }
  .sf-title { font-weight:600; font-size:15px; color:#1f2430; margin-top:2px; }
  .sf-sub { font-size:12px; color:#6b7280; margin-top:2px; }
  .sf-table { width:100%; border-collapse:collapse; font-size:13px; }
  .sf-table th { text-align:left; color:#8a92a8; font-size:11px; text-transform:uppercase; letter-spacing:.5px; padding:6px 10px; border-bottom:1px solid #e6e9ef; }
  .sf-table td { padding:9px 10px; border-bottom:1px solid #f0f2f6; vertical-align:top; }
  .sf-n { color:#8a92a8; width:24px; }
  .sf-issue { color:#1f2430; width:42%; }
  .sf-fix { color:#475067; }
  .sf-clean { color:#1a7f37; padding:12px 10px; }
  .sf-actions { margin-top:16px; }
  `;
  const s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);
})();

// === Template library + File menu (Stage 2: local store) ===
// Reusable category templates. Backed by localStorage today (browser-testable,
// portable via JSON export/import to the seller's drive); the SQLite-on-USB-C-SSD
// backend is a drop-in swap behind these same calls. See memory
// bynari-seller-sovereignty-local-store.
const TEMPLATES_KEY = 'bynari.templates';

// The template library is backed by SQLite on the seller's own drive when
// running in the desktop app (Pywebview bridge), and by localStorage in the
// browser / free tier. Same interface either way; the desktop path is async.
function nativeStore() {
  return (window.pywebview && window.pywebview.api && window.pywebview.api.templates_list)
    ? window.pywebview.api : null;
}
function _localTemplates() {
  try { return JSON.parse(localStorage.getItem(TEMPLATES_KEY) || '[]'); } catch { return []; }
}
function _saveLocalTemplates(list) {
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list));
}

async function loadTemplates() {
  const api = nativeStore();
  if (api) { try { return (await api.templates_list()) || []; } catch (e) { console.error('templates_list', e); return []; } }
  return _localTemplates();
}
async function upsertTemplate(t) {
  const api = nativeStore();
  if (api) { try { return await api.template_save(t); } catch (e) { console.error('template_save', e); return t; } }
  const list = _localTemplates();
  const idx = list.findIndex(x => x.id === t.id);
  if (idx >= 0) list[idx] = t; else list.unshift(t);
  _saveLocalTemplates(list);
  return t;
}
async function deleteTemplate(id) {
  const api = nativeStore();
  if (api) { try { await api.template_delete(id); return; } catch (e) { console.error('template_delete', e); } }
  _saveLocalTemplates(_localTemplates().filter(t => t.id !== id));
}
async function clearAllTemplates() {
  const api = nativeStore();
  if (api) {
    try {
      const list = (await api.templates_list()) || [];
      for (const t of list) { try { await api.template_delete(t.id); } catch (e) {} }
    } catch (e) { console.error('clearAllTemplates', e); }
    return;
  }
  _saveLocalTemplates([]);
}

// === Two-layer templates (heuristic + pin; shaped for corpus-learning) ===
// A template splits its specifics into two layers:
//   constants{}  — field→value that CARRY FORWARD to every item (Department,
//                  Watch Shape, Country of Origin, shipping origin, policies…).
//   deltaFields[] — field NAMES (no value) that CLEAR and re-prompt every item
//                  (Brand, Model, Reference, Case Size, colors, year…).
// This kills the lie-class where a saved template asserted the FIRST item's
// identity (the Arnex's 34.8mm / A.S 1187/94) about the next one. See memory
// bynari-management-system-first + bynari-epid-product-match's session.
//
// classifyAspect is a category-AGNOSTIC heuristic seed: it nails the universal
// identity/measurement fields. Category-specific deltas the heuristic can't know
// (e.g. "Number of Jewels" on a watch) are handled by the seller's PIN at save
// time, and later by corpus-learning (a field that varies across the seller's
// own items in that category is a delta). `pins` is the seller's explicit
// override and always wins; corpus-learning will only ever move NON-pinned
// fields, so pins are durable. That's the shaping for the later upgrade.
function classifyAspect(name, pins) {
  if (pins && pins[name]) return pins[name];           // seller override wins
  const n = (name || '').toLowerCase().trim();
  const IDENTITY = ['brand','model','mpn','manufacturer part','reference',
    'serial','upc','ean','isbn','gtin','sku','product id','epid'];
  if (IDENTITY.some(k => n.includes(k))) return 'delta';
  if (/\b(size|diameter|width|length|height|depth|weight|capacity)\b/.test(n)) return 'delta';
  if (/colou?r/.test(n)) return 'delta';
  if (/\byear\b/.test(n)) return 'delta';
  return 'constant';
}

// Migration-aware accessors: a v2 template carries constants/deltaFields
// directly; a legacy template (constantSpecifics only) is split on read via the
// classifier, so old templates upgrade transparently the first time they're used.
function templateConstants(t) {
  if (t && t.constants) return t.constants;
  const out = {};
  for (const [k, v] of Object.entries((t && t.constantSpecifics) || {})) {
    if (classifyAspect(k, t && t.pins) === 'constant') out[k] = v;
  }
  return out;
}
function templateDeltaFields(t) {
  if (t && Array.isArray(t.deltaFields)) return t.deltaFields;
  return Object.keys((t && t.constantSpecifics) || {})
    .filter(k => classifyAspect(k, t && t.pins) === 'delta');
}

// Desktop escape hatch: wipe every saved listing and template from this device.
// The desktop persists by design (the seller's inventory brain), so clearing is
// a deliberate, confirmed action rather than something that happens on close.
async function clearAllData() {
  if (!(await showConfirm('Clear all saved listings and templates from this device? This cannot be undone.'))) return;
  try {
    for (const store of [localStorage, sessionStorage]) {
      store.removeItem(STORAGE_KEY); store.removeItem(ACTIVE_KEY);
    }
    await clearAllTemplates();
    _dataUrls.clear();
  } catch (e) { console.error('clearAllData', e); }
  location.reload();
}

// Build a reusable Template from the active item's finished datasheet.
// `opts.pins` (name→'constant'|'delta') are the seller's explicit overrides from
// the save dialog; `opts.name` overrides the default category-leaf name. With no
// opts, classification is pure heuristic (back-compatible call shape).
async function templateFromActive(opts) {
  opts = opts || {};
  const pins = opts.pins || {};
  const item = getActive();
  if (!item) { alert('Open a listing first.'); return null; }
  if (!item.category) { alert('Pick a category before saving this as a template.'); return null; }
  const specs = specificsForRender(item);
  const constants = {};
  const deltaFields = [];
  [...specs.required, ...specs.optional].forEach(r => {
    if (!r.value) return;
    if (classifyAspect(r.name, pins) === 'delta') {
      if (!deltaFields.includes(r.name)) deltaFields.push(r.name);  // name only — value is per-item
    } else {
      constants[r.name] = r.value;
    }
  });
  // Keep only pins that actually DIFFER from the heuristic — `pins` then means
  // "true seller override," which is what corpus-learning must never touch.
  const realPins = {};
  for (const [k, v] of Object.entries(pins)) {
    if (classifyAspect(k, null) !== v) realPins[k] = v;
  }
  const name = opts.name || (item.category.path && item.category.path.slice(-1)[0]) || item.category.name || itemLabel(item);
  return await upsertTemplate({
    id: `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    schemaVersion: 2,
    categoryId: item.category.id || '',
    categoryPath: item.category.path || [],
    constants,
    deltaFields,
    pins: realPins,
    titleSample: item.title || '',
    descriptionBoilerplate: item.description || '',
    conditionDefault: item.conditionStatement || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

// The template prefill patch — Layer 1 constants + category + boilerplate, and a
// spec matrix seeded from the category schema so the constants show immediately.
// Layer 2 (delta) fields stay blank and get flagged "fill each item" so the
// template never asserts the previous item's identity (_templateDeltaFields).
// Shared by single-item start and batch spawn.
async function buildTemplatePatch(t) {
  const patch = {
    category: t.categoryId
      ? { id: t.categoryId, name: (t.categoryPath.slice(-1)[0] || ''), path: t.categoryPath || [] }
      : null,
    specificsOverrides: { ...templateConstants(t) },
    _templateDeltaFields: templateDeltaFields(t),
    description: t.descriptionBoilerplate || '',
    conditionStatement: t.conditionDefault || '',
  };
  if (t.categoryId) {
    try {
      const schema = await fetchItemAspects(t.categoryId);
      patch._consensusMatrix = buildConsensus([], schema);
    } catch (e) { console.error('template prefill schema', e); }
  }
  return patch;
}

// Start a single new listing pre-seeded from a Template (the reuse loop).
async function startFromTemplate(id) {
  const t = (await loadTemplates()).find(x => x.id === id);
  if (!t) return;
  newItem();
  updateActive(await buildTemplatePatch(t));
  closeTemplateModal();
  routeTo('photos');
}

// Batch spawn — the spine of Gary's workflow: one category template, N draft
// slots. Builds the template patch ONCE (one schema fetch) and clones it into N
// fresh items, each tagged with the batch so the queue can group them. The
// per-item fill happens later through the normal walkthrough.
async function spawnBatch(templateId, count) {
  const t = (await loadTemplates()).find(x => x.id === templateId);
  if (!t) return 0;
  const n = Math.max(1, Math.min(100, parseInt(count, 10) || 0));
  const basePatch = await buildTemplatePatch(t);
  const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  for (let i = 1; i <= n; i++) {
    newItem();
    // Deep-clone the patch so the N items never share a spec-matrix reference.
    const patch = JSON.parse(JSON.stringify(basePatch));
    patch.batchId = batchId;
    patch.batchSeq = i;
    patch.batchTotal = n;
    patch.batchTemplateName = t.name || 'Batch';
    updateActive(patch);
  }
  setActive(null);  // land on the queue, no single item active
  return n;
}

// Populate the batch-setup screen: template picker + count.
async function renderBatchSetup() {
  const sel = document.getElementById('batchTemplate');
  const note = document.getElementById('batchTemplateNote');
  const createBtn = document.getElementById('batchCreateBtn');
  const status = document.getElementById('batchStatus');
  if (!sel) return;
  if (status) status.textContent = '';
  const templates = (await loadTemplates()) || [];
  sel.innerHTML = templates.map(t =>
    `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || 'Untitled template')}</option>`
  ).join('');
  const none = templates.length === 0;
  sel.disabled = none;
  if (createBtn) createBtn.disabled = none;
  if (note) {
    note.textContent = none
      ? "You don't have any templates yet. Open an item, fill it, and choose Save as template — then come back to spawn a batch."
      : 'Every draft starts from this template — its category, condition, description, and shipping.';
  }
}

// === Batch export — bank-and-export (phases 5 → 6) ===
// A CSV worksheet: one row per draft with a staggered go-live time. It replaces
// the seller's spreadsheet AND feeds eBay's bulk tools. Bynari never publishes —
// the seller takes this to eBay's bulk editor and presses go.
const _batchExported = {};  // batchId -> { path }

function _batchScheduleStart() {
  const d = new Date();
  d.setDate(d.getDate() + 1);   // next day, like the high-volume cadence
  d.setHours(12, 0, 0, 0);      // starting at noon
  return d;
}
function _fmtSchedule(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function _csvCell(s) {
  s = (s == null ? '' : String(s));
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function buildBatchCsv(members) {
  const start = _batchScheduleStart();
  const headers = ['Go-live time', 'SKU', 'Title', 'Category', 'Category ID', 'Condition', 'Item specifics', 'Description'];
  const lines = [headers.map(_csvCell).join(',')];
  members.forEach((m, i) => {
    const t = new Date(start.getTime() + i * 60000);  // one listing a minute
    const specs = specificsForRender(m);
    const filled = [...specs.required, ...specs.optional]
      .filter(r => r.value).map(r => `${r.name}: ${r.value}`).join('; ');
    const row = [
      _fmtSchedule(t),
      itemLabel(m),
      m.title || '',
      ((m.category && m.category.path) || []).join(' > '),
      (m.category && m.category.id) || '',
      m.conditionStatement || '',
      filled,
      (m.description || '').replace(/\s*\n\s*/g, ' '),
    ];
    lines.push(row.map(_csvCell).join(','));
  });
  return lines.join('\r\n');
}

async function exportBatch(batchId) {
  const members = loadItems().filter(i => i.batchId === batchId)
    .sort((a, b) => (a.batchSeq || 0) - (b.batchSeq || 0));
  if (!members.length) return;
  const csv = buildBatchCsv(members);
  const slug = ((members[0].batchTemplateName || 'batch').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) || 'batch';
  const api = window.pywebview && window.pywebview.api;
  if (!api || !api.save_datasheet) { alert('Exporting needs the desktop app.'); return; }
  try {
    const r = await api.save_datasheet(csv, `batch-${slug}.csv`);
    if (r && r.saved) {
      _batchExported[batchId] = { path: r.path };
      renderHome();
    }
  } catch (e) {
    console.error('exportBatch', e);
    alert('Could not export the batch.');
  }
}

// Save-as-template dialog. Shows the two-layer split with a heuristic default and
// lets the seller move any field between layers (the PIN). Zero marking required —
// Save accepts the defaults — so it stays Susan-fast while exposing the control.
function openSaveTemplateModal() {
  const item = getActive();
  if (!item) { alert('Open a listing first.'); return; }
  if (!item.category) { alert('Pick a category before saving this as a template.'); return; }
  const specs = specificsForRender(item);
  const fieldNames = [];
  const seen = new Set();
  [...specs.required, ...specs.optional].forEach(r => {
    if (r.value && !seen.has(r.name)) { seen.add(r.name); fieldNames.push(r.name); }
  });
  const state = {};
  fieldNames.forEach(n => { state[n] = classifyAspect(n, null); });
  const defaultName = (item.category.path && item.category.path.slice(-1)[0]) || item.category.name || itemLabel(item);

  document.getElementById('saveTplModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'saveTplModal';
  modal.className = 'tpl-modal';
  modal.innerHTML = `
    <div class="tpl-card stpl-card">
      <div class="tpl-head"><h2>Save as template</h2><button class="tpl-close" aria-label="Close">&times;</button></div>
      <div class="tpl-body">
        <label class="stpl-name-label">Template name
          <input id="stplName" class="stpl-name" type="text" value="${escapeHtml(defaultName)}">
        </label>
        <p class="stpl-hint">Tap a field to move it. <strong>Carry forward</strong> fields fill every new item in this category. <strong>Fill each item</strong> fields stay blank for you to set on each one.</p>
        <div class="stpl-cols">
          <div class="stpl-col"><h3>Carry forward</h3><div class="stpl-chips" id="stplConstant"></div></div>
          <div class="stpl-col"><h3>Fill each item</h3><div class="stpl-chips" id="stplDelta"></div></div>
        </div>
      </div>
      <div class="tpl-foot">
        <button class="tpl-foot-btn" id="stplCancel">Cancel</button>
        <button class="tpl-foot-btn stpl-save" id="stplSave">Save template</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const paint = () => {
    const c = modal.querySelector('#stplConstant');
    const d = modal.querySelector('#stplDelta');
    c.innerHTML = ''; d.innerHTML = '';
    fieldNames.forEach(n => {
      const chip = document.createElement('button');
      chip.className = 'stpl-chip';
      chip.textContent = n;
      chip.title = 'Tap to move to the other layer';
      chip.addEventListener('click', () => {
        state[n] = state[n] === 'constant' ? 'delta' : 'constant';
        paint();
      });
      (state[n] === 'constant' ? c : d).appendChild(chip);
    });
    if (!c.children.length) c.innerHTML = '<span class="stpl-empty">none</span>';
    if (!d.children.length) d.innerHTML = '<span class="stpl-empty">none</span>';
  };
  paint();

  const close = () => modal.remove();
  modal.querySelector('.tpl-close').addEventListener('click', close);
  modal.querySelector('#stplCancel').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.querySelector('#stplSave').addEventListener('click', async () => {
    const nm = (modal.querySelector('#stplName').value || '').trim();
    const saved = await templateFromActive({ pins: state, name: nm || defaultName });
    close();
    if (saved) alert('Saved. Find it under File → Templates…');
  });
}
(function injectSaveTplStyles() {
  const css = `
  .stpl-card { max-width: 560px; }
  .stpl-name-label { display:block; font-size:12px; color:#6b7280; margin-bottom:12px; }
  .stpl-name { display:block; width:100%; margin-top:4px; padding:8px 10px; font-size:14px;
    border:1px solid #d1d5db; border-radius:6px; box-sizing:border-box; }
  .stpl-hint { font-size:12px; color:#6b7280; line-height:1.5; margin:0 0 14px; }
  .stpl-cols { display:flex; gap:14px; }
  .stpl-col { flex:1; min-width:0; }
  .stpl-col h3 { font-size:12px; font-weight:600; color:#374151; margin:0 0 8px;
    text-transform:uppercase; letter-spacing:.04em; }
  .stpl-chips { display:flex; flex-wrap:wrap; gap:6px; align-content:flex-start;
    min-height:60px; padding:8px; background:#f9fafb; border:1px solid #eef0f3; border-radius:8px; }
  .stpl-chip { font-size:12px; padding:4px 10px; border:1px solid #d1d5db; border-radius:14px;
    background:#fff; cursor:pointer; color:#1f2937; line-height:1.4; }
  .stpl-chip:hover { border-color:#2d6cdf; color:#2d6cdf; }
  .stpl-empty { font-size:12px; color:#9ca3af; font-style:italic; }
  .stpl-save { background:#2d6cdf; color:#fff; border-color:#2d6cdf; }
  .ds-spec-delta { background:#eef4ff; color:#2d6cdf; }
  `;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
})();

async function exportLibrary() {
  const api = nativeStore();
  if (api && api.templates_export) {
    try { await api.templates_export(); return; } catch (e) { console.error('templates_export', e); }
  }
  const content = JSON.stringify({ kind: 'bynari-template-library', version: 1, templates: await loadTemplates() }, null, 2);
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'bynari-templates.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importLibraryFromText(text) {
  const api = nativeStore();
  if (api && api.templates_import_text) {
    try {
      const r = await api.templates_import_text(text);
      const n = (r && r.imported) || 0;
      alert(n ? `Imported ${n} template${n === 1 ? '' : 's'}.` : 'No templates found in that file.');
      renderTemplateModal();
      return;
    } catch (e) { console.error('templates_import_text', e); }
  }
  let data;
  try { data = JSON.parse(text); } catch { alert('That file is not a valid template library.'); return; }
  const incoming = Array.isArray(data) ? data : (data.templates || []);
  if (!incoming.length) { alert('No templates found in that file.'); return; }
  const byId = new Map(_localTemplates().map(t => [t.id, t]));
  incoming.forEach(t => { if (t && t.id) byId.set(t.id, t); });
  _saveLocalTemplates([...byId.values()]);
  alert(`Imported ${incoming.length} template${incoming.length === 1 ? '' : 's'}.`);
  renderTemplateModal();
}
function importLibrary() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => importLibraryFromText(String(reader.result || ''));
    reader.readAsText(f);
  });
  input.click();
}

// Choose the drive/folder the library lives on (desktop only — the sovereignty
// layer). Browser / free tier has no on-disk store, so it's a no-op there.
async function chooseStorage() {
  const api = nativeStore();
  if (!api || !api.choose_storage_dir) {
    alert('Choosing a storage drive is available in the desktop app.');
    return;
  }
  try {
    const r = await api.choose_storage_dir();
    if (r && r.changed) { alert('Your template library is now stored at:\n' + r.dir); renderTemplateModal(); }
  } catch (e) { console.error('choose_storage_dir', e); }
}

// --- Templates modal ---
function ensureTemplateModal() {
  let modal = document.getElementById('tplModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'tplModal';
  modal.className = 'tpl-modal hidden';
  modal.innerHTML = `
    <div class="tpl-card">
      <div class="tpl-head"><h2>Your templates</h2><button class="tpl-close" aria-label="Close">&times;</button></div>
      <div class="tpl-body" id="tplBody"></div>
      <div class="tpl-foot">
        <button class="tpl-foot-btn" id="tplImport">Import&hellip;</button>
        <button class="tpl-foot-btn" id="tplExport">Export all&hellip;</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.tpl-close').addEventListener('click', closeTemplateModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeTemplateModal(); });
  modal.querySelector('#tplImport').addEventListener('click', importLibrary);
  modal.querySelector('#tplExport').addEventListener('click', exportLibrary);
  return modal;
}
async function renderTemplateModal() {
  const body = document.getElementById('tplBody');
  if (!body) return;
  const list = await loadTemplates();
  if (!list.length) {
    body.innerHTML = '<p class="tpl-empty">No templates yet. On a finished datasheet, choose <strong>File &rarr; Save as Template</strong> to make one.</p>';
    return;
  }
  body.innerHTML = list.map(t => `
    <div class="tpl-row">
      <div class="tpl-row-main">
        <div class="tpl-row-name">${escapeHtml(t.name || 'Untitled')}</div>
        <div class="tpl-row-meta">${escapeHtml((t.categoryPath || []).join(' › ') || '—')} · ${Object.keys(templateConstants(t)).length} carry-forward · ${templateDeltaFields(t).length} per-item</div>
      </div>
      <div class="tpl-row-actions">
        <button class="tpl-use" data-id="${escapeHtml(t.id)}">Use</button>
        <button class="tpl-del" data-id="${escapeHtml(t.id)}">Delete</button>
      </div>
    </div>`).join('');
  body.querySelectorAll('.tpl-use').forEach(b => b.addEventListener('click', () => startFromTemplate(b.dataset.id)));
  body.querySelectorAll('.tpl-del').forEach(b => b.addEventListener('click', async () => {
    if (await showConfirm('Delete this template?')) { await deleteTemplate(b.dataset.id); renderTemplateModal(); }
  }));
}
function openTemplateModal() { ensureTemplateModal(); document.getElementById('tplModal').classList.remove('hidden'); renderTemplateModal(); }
function closeTemplateModal() { document.getElementById('tplModal')?.classList.add('hidden'); }

// --- Menu bar dropdowns (File wired; Edit/View/Tools/Help land next) ---
// Track the last focused editable so Edit → Cut/Copy/Paste act on the field
// you were in (opening the menu blurs it). Clipboard in a webview is best-effort:
// Cut/Copy work on a selection; Paste falls back to the browser's Ctrl+V.
let _lastEditable = null;
document.addEventListener('focusin', e => {
  const el = e.target;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) _lastEditable = el;
});
function clipboardCmd(cmd) {
  if (_lastEditable && document.body.contains(_lastEditable)) _lastEditable.focus();
  try {
    if (cmd === 'paste' && navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(text => {
        const el = _lastEditable;
        if (!el || text == null || !document.body.contains(el)) return;
        const s = el.selectionStart ?? el.value.length;
        const eN = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, s) + text + el.value.slice(eN);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }).catch(() => {});
    } else {
      document.execCommand(cmd);
    }
  } catch (_) { /* clipboard blocked in webview — Ctrl+X/C/V still work */ }
}

// Help modal — plain-language, no jargon, no "AI" (Susan reads this).
function openHelpModal() {
  let m = document.getElementById('helpModal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'helpModal';
    m.className = 'tpl-modal hidden';
    m.innerHTML = `
      <div class="tpl-card">
        <div class="tpl-head"><h2>How Bynari Insight works</h2><button class="tpl-close" aria-label="Close">&times;</button></div>
        <div class="tpl-body" style="padding:18px 22px;line-height:1.6;font-size:14px;color:#1f2430;">
          <p>Bynari Insight turns an item and its photos into a complete, ready-to-list datasheet.</p>
          <p style="margin-top:14px;font-weight:600;">How to use it</p>
          <ol style="margin:8px 0 0 18px;padding:0;">
            <li>Add your photos and tell us what you know — brand, model, anything.</li>
            <li>We find listings like yours. Pick the ones that match.</li>
            <li>We build the title, description, condition, and item specifics for you.</li>
            <li>Review and edit anything. Save the datasheet to your computer.</li>
          </ol>
          <p style="margin-top:16px;color:#6b7280;">You take the datasheet to eBay yourself. Bynari Insight never logs into your account and never publishes for you.</p>
        </div>
      </div>`;
    document.body.appendChild(m);
    m.querySelector('.tpl-close').addEventListener('click', () => m.classList.add('hidden'));
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
  }
  m.classList.remove('hidden');
}

const MENU_CONFIG = {
  file: [
    { label: 'New listing', accel: 'Ctrl+N', action: () => { newItem(); routeTo('photos'); } },
    { label: 'Open…', accel: 'Ctrl+O', action: () => routeTo('home') },
    { separator: true },
    { label: 'Save datasheet…', accel: 'Ctrl+S', action: () => saveDatasheetClicked() },
    { label: 'Save as Template', action: () => openSaveTemplateModal() },
    { label: 'Templates…', action: () => openTemplateModal() },
    { separator: true },
    { label: 'Export template library…', action: () => exportLibrary() },
    { label: 'Import template library…', action: () => importLibrary() },
    { separator: true },
    { label: 'Storage location…', action: () => chooseStorage() },
    // Desktop only: the free web tier already clears on browser close, so the
    // manual escape hatch belongs where data actually persists.
    ...(tierMode() === 'paid'
      ? [{ separator: true }, { label: 'Clear all data…', action: () => clearAllData() }]
      : []),
  ],
  edit: [
    { label: 'Edit item details', action: () => routeTo('identify') },
    { label: 'Edit photos', action: () => routeTo('photos') },
    { label: 'Edit title, condition & description', action: () => routeTo('title') },
    { label: 'Edit item specifics', action: () => routeTo('datasheet') },
    { separator: true },
    { label: 'Cut', accel: 'Ctrl+X', action: () => clipboardCmd('cut') },
    { label: 'Copy', accel: 'Ctrl+C', action: () => clipboardCmd('copy') },
    { label: 'Paste', accel: 'Ctrl+V', action: () => clipboardCmd('paste') },
  ],
  view: [
    { label: 'Datasheet', action: () => routeTo('datasheet') },
    { label: 'Home / Queue', action: () => routeTo('home') },
  ],
  tools: [
    { label: 'Go to Photos', action: () => routeTo('photos') },
    { label: 'Go to Items like yours', action: () => routeTo('comps') },
    { label: 'Go to Category', action: () => routeTo('category') },
    { separator: true },
    { label: 'Re-harvest details', action: async () => { await harvestForActiveItem(); routeTo('datasheet'); } },
  ],
  help: [
    { label: 'How to use Bynari Insight', action: () => openHelpModal() },
  ],
};
function closeAllMenus() {
  document.querySelectorAll('.menu-dropdown').forEach(d => d.remove());
  document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
}
function openMenu(el, key) {
  closeAllMenus();
  const items = MENU_CONFIG[key];
  if (!items) return;
  el.classList.add('open');
  const dd = document.createElement('div');
  dd.className = 'menu-dropdown';
  dd.innerHTML = items.map((it, i) => it.separator
    ? '<div class="menu-sep"></div>'
    : `<div class="menu-option" data-i="${i}"><span>${escapeHtml(it.label)}</span>${it.accel ? `<span class="menu-accel">${escapeHtml(it.accel)}</span>` : ''}</div>`).join('');
  const rect = el.getBoundingClientRect();
  dd.style.left = rect.left + 'px';
  dd.style.top = rect.bottom + 'px';
  document.body.appendChild(dd);
  dd.querySelectorAll('.menu-option').forEach(opt => {
    opt.addEventListener('click', ev => {
      ev.stopPropagation();
      const it = items[parseInt(opt.dataset.i, 10)];
      closeAllMenus();
      try { it.action(); } catch (e) { console.error('menu action failed', e); }
    });
  });
}
function initMenuBar() {
  document.querySelectorAll('.menu-bar .menu-item').forEach(el => {
    const key = el.dataset.menu || el.textContent.trim().toLowerCase();
    el.style.cursor = 'pointer';
    el.addEventListener('click', e => {
      e.stopPropagation();
      if (el.classList.contains('open')) { closeAllMenus(); return; }
      openMenu(el, key);
    });
  });
  document.addEventListener('click', closeAllMenus);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeAllMenus(); closeTemplateModal(); return; }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); saveDatasheetClicked(); }
      else if (k === 'n') { e.preventDefault(); newItem(); routeTo('photos'); }
      else if (k === 'o') { e.preventDefault(); routeTo('home'); }
    }
  });
}
initMenuBar();

// Injected styles for the menu dropdowns + templates modal (can move to
// styles.css later; kept here so the feature is self-contained).
(function injectMenuStyles() {
  const css = `
  .menu-item.open { background: rgba(0,0,0,0.08); }
  .menu-dropdown { position: fixed; z-index: 1000; min-width: 230px; background: #fff;
    border: 1px solid #d4d8e0; border-radius: 6px; box-shadow: 0 8px 28px rgba(0,0,0,0.18); padding: 4px 0; }
  .menu-option { display: flex; justify-content: space-between; gap: 24px; align-items: center;
    padding: 7px 14px; font-size: 13px; color: #1f2430; cursor: pointer; white-space: nowrap; }
  .menu-option:hover { background: #2d6cdf; color: #fff; }
  .menu-accel { font-size: 11px; opacity: 0.6; }
  .menu-option:hover .menu-accel { opacity: 0.85; }
  .menu-sep { height: 1px; background: #e6e9ef; margin: 4px 0; }
  .tpl-modal { position: fixed; inset: 0; background: rgba(15,20,30,0.45); display: flex;
    align-items: center; justify-content: center; z-index: 1100; }
  .tpl-modal.hidden { display: none; }
  .tpl-card { width: 560px; max-width: calc(100vw - 32px); max-height: 80vh; display: flex; flex-direction: column;
    background: #fff; border-radius: 10px; box-shadow: 0 18px 50px rgba(0,0,0,0.3); overflow: hidden; }
  .tpl-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #eceef3; }
  .tpl-head h2 { margin: 0; font-size: 17px; }
  .tpl-close { border: 0; background: none; font-size: 22px; line-height: 1; cursor: pointer; color: #6b7280; }
  .tpl-body { padding: 8px 12px; overflow-y: auto; }
  .tpl-empty { color: #6b7280; padding: 18px; text-align: center; font-size: 14px; }
  .tpl-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; }
  .tpl-row:hover { background: #f4f6fa; }
  .tpl-row-name { font-weight: 600; font-size: 14px; color: #1f2430; }
  .tpl-row-meta { font-size: 12px; color: #6b7280; margin-top: 2px; }
  .tpl-row-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .tpl-use { background: #2d6cdf; color: #fff; border: 0; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
  .tpl-del { background: none; color: #b42318; border: 0; padding: 6px 8px; cursor: pointer; font-size: 13px; }
  .tpl-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 16px; border-top: 1px solid #eceef3; }
  .tpl-foot-btn { background: #eef1f6; border: 1px solid #d4d8e0; border-radius: 6px; padding: 7px 14px; cursor: pointer; font-size: 13px; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
})();

// === Top tab bar (paid-desktop only) ===
function switchTab(name) {
  if (!name) return;  // the Connect-eBay action has no data-tab — not a content tab
  document.querySelectorAll('.tab-bar-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('hidden', c.dataset.tab !== name);
  });
  if (name === 'inventory') renderInventory();
  recordLocation();
}

document.querySelectorAll('.tab-bar-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// === Launcher home → tool ===
// The app opens on the launcher home (#debut): a "pick up where you left off"
// resume zone built from the saved queue, plus feature cards that route into the
// working app. enterTool() just hides the home; launchTo() hides it and routes.
function enterTool() {
  document.getElementById('debut')?.classList.add('hidden');
}
function launchTo(action) {
  enterTool();
  switch (action) {
    case 'list':      switchTab('listing'); startNewItem(); break;
    case 'edit':      switchTab('listing'); goToRewrite(); break;
    case 'analyze':   switchTab('analyze'); break;
    case 'inventory': switchTab('inventory'); break;
    default:          switchTab('listing');
  }
}
// "Pick up where you left off" — render the in-progress queue on the home; hidden
// when there's nothing going (empty containers stay hidden).
function renderLauncherResume() {
  const wrap = document.getElementById('launchResume');
  const list = document.getElementById('launchResumeList');
  if (!wrap || !list) return;
  const items = (typeof loadItems === 'function') ? loadItems() : [];
  if (!items.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  list.innerHTML = '';
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'launch-resume-row';
    const step = item.status ? item.status.charAt(0).toUpperCase() + item.status.slice(1) : 'In progress';
    row.innerHTML = `<span class="launch-resume-label">${escapeHtml(itemLabel(item))}</span>`
      + `<span class="launch-resume-meta">at: ${escapeHtml(step)} · ${escapeHtml(timeAgo(item.createdAt))}</span>`;
    row.addEventListener('click', () => {
      setActive(item.id);
      enterTool();
      switchTab('listing');
      routeTo(item.status || 'home');
    });
    list.appendChild(row);
  });
}
// Splash Home button — return to the launcher/splash and record it in history.
function goHome() {
  document.getElementById('debut')?.classList.remove('hidden');
  renderLauncherResume();
  recordLocation();
  updateGlobalNav();
}
document.getElementById('tabHomeBtn')?.addEventListener('click', goHome);

document.querySelectorAll('.launch-card').forEach(card => {
  card.addEventListener('click', () => launchTo(card.dataset.launch));
});
// "What we do" overlay — opens in-app, not the website or a browser.
document.getElementById('debutAboutBtn')?.addEventListener('click', () => {
  document.getElementById('aboutOverlay')?.classList.remove('hidden');
});
document.getElementById('aboutClose')?.addEventListener('click', () => {
  document.getElementById('aboutOverlay')?.classList.add('hidden');
});
document.getElementById('aboutOverlay')?.addEventListener('click', e => {
  if (e.target.id === 'aboutOverlay') e.target.classList.add('hidden');
});
// "How this works" — the welcome orientation, reopenable from the sidebar foot.
document.getElementById('howThisWorksLink')?.addEventListener('click', e => {
  e.preventDefault();
  document.getElementById('howOverlay')?.classList.remove('hidden');
});
document.getElementById('howClose')?.addEventListener('click', () => {
  document.getElementById('howOverlay')?.classList.add('hidden');
});
document.getElementById('howOverlay')?.addEventListener('click', e => {
  if (e.target.id === 'howOverlay') e.target.classList.add('hidden');
});
renderLauncherResume();
// Kept for the embedded-landing path (web free tier), harmless otherwise.
window.addEventListener('message', e => {
  if (e && e.data === 'bynari:open-tool') enterTool();
});

// === Inventory tab — the seller's own library.db (desktop only) ===
async function loadInventoryItems() {
  const api = window.pywebview?.api;
  if (api?.items_list) {
    try { return (await api.items_list()) || []; }
    catch (e) { console.error('items_list', e); return []; }
  }
  // No Pywebview bridge (browser app-mode / web): fall back to a static export
  // of library.db. Present in the desktop/localhost build; absent on free web.
  try {
    const res = await fetch('inventory.json', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data) ? data : (data.items || []);
    }
  } catch (e) { /* no export available → treat as desktop-only feature */ }
  return null;
}

function invBadgeClass(state, listingStatus) {
  const s = (listingStatus || state || '').toLowerCase();
  if (s === 'active' || s === 'listed') return 'listed';
  if (s === 'drafted' || s === 'draft') return 'drafted';
  if (s === 'sold') return 'sold';
  return 'new';
}

// === Active-listings ingestion (eBay report → inventory) ===
// The seller downloads their active-listings report from eBay (no login) and
// uploads the file here. We parse it in the browser and show the items; the
// seller caps how many to bring in (first N). Persisting to library.db is the
// desktop bridge's job — this view holds the imported set for the session.
let _uploadedInventory = [];
let _uploadedTotal = 0;
let _parsedAll = [];  // full parsed upload, retained so the "Import first N" cap can be re-applied
let _invListView = false;  // plain photo-less clickable list vs the default thumbnail view

// The "Import first" box is a free number — type any count; blank or an invalid
// value means "all". Returns 0 for "all".
function importCapValue() {
  const el = document.getElementById('invImportCount');
  const raw = el ? String(el.value).trim() : '';
  if (raw === '') return 0;
  const n = parseInt(raw, 10);
  return (Number.isFinite(n) && n > 0) ? n : 0;
}

// Slice the retained upload to the current cap and repaint the inventory.
async function applyImportCap() {
  const cap = importCapValue();
  _uploadedTotal = _parsedAll.length;
  _uploadedInventory = cap > 0 ? _parsedAll.slice(0, cap) : _parsedAll;
  await renderInventory();
}

function parseCsvLine(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') { q = true; }
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseEbayListingsReport(text) {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim() !== '');
  if (!lines.length) return [];
  const headerLine = lines.find(l => /item\s*(number|id)/i.test(l)) || lines[0];
  const delim = headerLine.includes('\t') ? '\t' : ',';
  let hi = lines.findIndex(l => /item\s*(number|id)/i.test(l));
  if (hi < 0) hi = 0;
  const headers = parseCsvLine(lines[hi], delim).map(h => h.trim().toLowerCase());
  const col = (...names) => {
    for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; }
    for (let i = 0; i < headers.length; i++) if (names.some(n => headers[i].includes(n))) return i;
    return -1;
  };
  const ci = {
    item: col('item number', 'itemid', 'item id', 'itemnumber'),
    title: col('title', 'item title'),
    price: col('current price', 'start price', 'buy it now price', 'price'),
    cond: col('condition'),
    cat: col('ebay category 1 name', 'category name', 'category'),
    catnum: col('ebay category 1 number', 'category 1 number', 'category number'),
  };
  const items = [];
  for (let i = hi + 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i], delim);
    const num = ci.item >= 0 ? (f[ci.item] || '').trim() : '';
    const title = ci.title >= 0 ? (f[ci.title] || '').trim() : '';
    if (!/^\d{6,}$/.test(num) && !title) continue;  // skip metadata / total rows
    const priceRaw = ci.price >= 0 ? (f[ci.price] || '').replace(/[^0-9.]/g, '') : '';
    items.push({
      ebay_item_no: num || null,
      listing_status: 'active',
      state: 'active',
      title: title || num,
      brand: '',
      category_path: ci.cat >= 0 ? (f[ci.cat] || '').trim() : '',
      category_id: ci.catnum >= 0 ? (f[ci.catnum] || '').trim() : '',
      condition: ci.cond >= 0 ? (f[ci.cond] || '').trim() : '',
      price: priceRaw ? parseFloat(priceRaw) : null,
      hero: null,
    });
  }
  return items;
}

function handleInvFile(file) {
  const status = document.getElementById('invStatus');
  const reader = new FileReader();
  reader.onload = () => {
    let parsed = [];
    try { parsed = parseEbayListingsReport(String(reader.result)); }
    catch (e) { console.error('parseEbayListingsReport', e); }
    if (!parsed.length) {
      if (status) {
        status.classList.add('error');
        status.textContent = "Couldn't read any listings from that file. Download it from eBay "
          + 'Seller Hub: Reports → All active listings (a CSV), then upload it here.';
      }
      return;
    }
    const withItemNo = parsed.filter(i => i.ebay_item_no).length;
    _parsedAll = parsed;
    applyImportCap().then(() => {
      if (!status) return;
      if (withItemNo === 0) {
        // Parsed rows, but none carry an item number — Save/Export can't work.
        status.classList.add('error');
        status.textContent = `Read ${parsed.length} row${parsed.length === 1 ? '' : 's'}, but none have an `
          + 'eBay item number — saving to your library and exporting photos both need it. '
          + 'Make sure the CSV includes the Item number column.';
      } else if (withItemNo < parsed.length) {
        status.classList.remove('error');
        const missing = parsed.length - withItemNo;
        status.textContent = `${parsed.length} listings loaded — ${missing} have no item number and can't be `
          + 'saved to your library or have photos exported.';
      }
    });
  };
  reader.readAsText(file);
}

function mergeInventory(dbItems, uploaded) {
  const seen = new Set(dbItems.map(i => i.ebay_item_no).filter(Boolean));
  return dbItems.concat(uploaded.filter(i => !i.ebay_item_no || !seen.has(i.ebay_item_no)));
}

// The inventory tab opens on its explainer (a page of text) before the working
// surface. Whether it's been seen is remembered across launches (persistent
// settings on the seller's drive — pywebview's http port isn't stable, so
// localStorage can't be trusted for this), so the orientation shows once, not
// every launch. "What is this?" reopens it for the current view without
// un-remembering it.
const INV_INTRO_SEEN_KEY = 'bynari:inv-intro-seen';
let _invIntroForceShow = false;
let _invIntroSeenMemo = false;  // last-resort in-memory fallback

async function invIntroSeen() {
  const api = window.pywebview?.api;
  if (api?.setting_get) {
    try { return (await api.setting_get(INV_INTRO_SEEN_KEY)) === '1'; }
    catch (e) { /* fall through to localStorage */ }
  }
  try { return localStorage.getItem(INV_INTRO_SEEN_KEY) === '1'; }
  catch (e) { return _invIntroSeenMemo; }
}

async function markInvIntroSeen() {
  _invIntroSeenMemo = true;
  const api = window.pywebview?.api;
  if (api?.setting_set) {
    try { await api.setting_set(INV_INTRO_SEEN_KEY, '1'); return; }
    catch (e) { /* fall through */ }
  }
  try { localStorage.setItem(INV_INTRO_SEEN_KEY, '1'); } catch (e) { /* memo only */ }
}

// Save-to-library and Export-photos need the desktop bridge; on the web build
// (no pywebview) they can't run, so disable them with a one-line note rather
// than letting a click fail silently.
function applyInventoryCapabilities() {
  const hasBridge = !!(window.pywebview && window.pywebview.api);
  ['invSaveLibraryBtn', 'invExportPhotosBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = !hasBridge;
    btn.title = hasBridge ? '' : 'Available in the desktop app';
  });
  document.getElementById('invDesktopNote')?.classList.toggle('hidden', hasBridge);
}

async function renderInventory() {
  const intro = document.getElementById('invIntro');
  const pane = document.getElementById('invPane');
  const showIntro = _invIntroForceShow || !(await invIntroSeen());
  if (intro && pane && showIntro) {
    intro.classList.remove('hidden');
    pane.classList.add('hidden');
    return;  // hold here until they continue — don't load the grid yet
  }
  if (intro) intro.classList.add('hidden');
  if (pane) pane.classList.remove('hidden');

  const status = document.getElementById('invStatus');
  if (status && !status.textContent) status.textContent = 'Loading your inventory…';
  await paintInventoryGrid();
  // Only clear our own "Loading…" placeholder — leave any caller's message
  // (e.g. a Save-to-library result) untouched.
  if (status && status.textContent === 'Loading your inventory…') status.textContent = '';
}

// Build the inventory list from the saved library + this session's upload.
// Deliberately does NOT touch invStatus, so a caller (after Save-to-library)
// can keep its success message visible while the grid refreshes beneath it.
// The one-line next-step guidance under the status row. Tells the seller what to
// do once their listings are imported, and confirms it once they're saved.
function setInvNextStep(mode) {
  const el = document.getElementById('invNextStep');
  if (!el) return;
  if (mode === 'saved') {
    el.innerHTML = '<strong>Saved to your library.</strong> Click any item to build or refresh its listing.';
    el.classList.remove('hidden');
  } else if (mode === 'import') {
    el.innerHTML = '<strong>Next: Save to library</strong> to keep these on your computer. '
      + 'Then click any item to build or refresh its listing.';
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

async function paintInventoryGrid() {
  const grid = document.getElementById('invGrid');
  const subtitle = document.getElementById('invSubtitle');
  if (!grid) return;
  applyInventoryCapabilities();
  const dbItems = (await loadInventoryItems()) || [];
  const items = mergeInventory(dbItems, _uploadedInventory);
  if (!items.length) {
    grid.innerHTML = '<div class="inv-empty"><div class="inv-empty-title">Fill your inventory</div>'
      + '<div>Download your eBay listings as a CSV file (in eBay Seller Hub: Reports → All active '
      + 'listings), then upload it here. No login — your data stays on your machine.</div>'
      + '<button class="button primary" id="invEmptyUploadBtn">Upload eBay listings…</button></div>';
    document.getElementById('invEmptyUploadBtn')?.addEventListener('click',
      () => document.getElementById('invFileInput')?.click());
    if (subtitle) subtitle.textContent = 'Everything you own, in one place — on your drive, not ours.';
    setInvNextStep('hidden');
    return;
  }
  setInvNextStep('import');
  if (subtitle) {
    if (_uploadedTotal && _uploadedTotal > _uploadedInventory.length) {
      subtitle.textContent = `Showing ${items.length} — first ${_uploadedInventory.length} of ${_uploadedTotal} `
        + 'from your eBay report. On your drive, not ours.';
    } else {
      subtitle.textContent = `${items.length} item${items.length === 1 ? '' : 's'} — on your drive, not ours.`;
    }
  }
  grid.innerHTML = '';
  // Inventory is a list — one line per item. The default view shows a hero
  // thumbnail (proof a saved item landed in the library); "List view" is a
  // plain, photo-less list. A row with an eBay item number is clickable and
  // opens its listing in ONE reused tab.
  grid.style.display = 'flex';
  grid.style.flexDirection = 'column';
  grid.classList.toggle('inv-grid--list', _invListView);
  items.forEach(it => {
    const row = document.createElement('div');
    row.className = 'inv-row' + (_invListView ? ' inv-row--list' : '');
    const badge = invBadgeClass(it.state, it.listing_status);
    const badgeLabel = it.listing_status || it.state || 'new';
    const price = (it.price != null && it.price !== '') ? `$${it.price}` : '';
    const meta = [it.brand, it.category_path, price].filter(Boolean).map(escapeHtml).join(' · ');
    const thumb = _invListView ? ''
      : (it.hero
          ? `<img class="inv-row-thumb" src="${it.hero}" alt="">`
          : '<span class="inv-row-thumb inv-row-thumb-empty" aria-hidden="true"></span>');
    if (it.ebay_item_no) {
      row.classList.add('inv-row--clickable');
      row.dataset.itemno = it.ebay_item_no;
      row.title = 'Open this listing (reuses one tab)';
    }
    row.innerHTML = thumb
      + `<span class="inv-row-title">${escapeHtml(it.title || it.what || it.slug)}</span>`
      + (meta ? `<span class="inv-row-meta">${meta}</span>` : '')
      + `<span class="inv-badge ${badge}">${escapeHtml(badgeLabel)}</span>`;
    grid.appendChild(row);
  });
  grid.querySelectorAll('.inv-row--clickable').forEach(row => {
    row.addEventListener('click', () => openInventoryListing(row.dataset.itemno));
  });
}

// Open an item's eBay listing. In the browser, reuse ONE named tab so clicking
// another item replaces it rather than piling up tabs. On the desktop app,
// route through the bridge (opens the system browser; no in-app navigation).
function openInventoryListing(itemNo) {
  if (!itemNo) return;
  const url = `https://www.ebay.com/itm/${encodeURIComponent(itemNo)}`;
  const api = window.pywebview?.api;
  if (api?.open_url) { api.open_url(url); return; }
  const w = window.open(url, 'bynari-inventory-view');
  if (w) w.focus();
}

// New item from the Inventory tab → jump into the Listings walkthrough.
document.getElementById('invNewItemBtn')?.addEventListener('click', () => {
  switchTab('listing');
  startNewItem();
});

// "Check your Listings" (batch) → the rank-a-batch worklist in the Listings tab.
document.getElementById('checkYourListingsBtn')?.addEventListener('click', () => {
  switchTab('listing');
  routeTo('worklist');
  worklistRankInventory();   // rank the imported inventory straight away — no pasting
});

// Upload an eBay active-listings report → fill the Inventory view.
document.getElementById('invUploadBtn')?.addEventListener('click', () => {
  document.getElementById('invFileInput')?.click();
});
document.getElementById('invFileInput')?.addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (f) handleInvFile(f);
  e.target.value = '';  // allow re-uploading the same file
});
// Re-apply the "Import first" cap when the number is changed after an upload.
document.getElementById('invImportCount')?.addEventListener('change', () => {
  if (_parsedAll.length) applyImportCap();
});
// Quick-amount presets: tap one to set the box (All = blank), or type your own.
document.querySelectorAll('.inv-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const el = document.getElementById('invImportCount');
    if (el) el.value = btn.dataset.count === '0' ? '' : btn.dataset.count;
    document.querySelectorAll('.inv-preset').forEach(b => b.classList.toggle('active', b === btn));
    if (_parsedAll.length) applyImportCap();
  });
});
// Typing a custom number deselects any active preset.
document.getElementById('invImportCount')?.addEventListener('input', () => {
  document.querySelectorAll('.inv-preset.active').forEach(b => b.classList.remove('active'));
});
// Toggle the plain photo-less list (clickable rows open the listing in one tab).
document.getElementById('invListViewBtn')?.addEventListener('click', () => {
  _invListView = !_invListView;
  const btn = document.getElementById('invListViewBtn');
  if (btn) btn.textContent = _invListView ? 'Photo view' : 'List view';
  paintInventoryGrid();
});

// The merged inventory (saved library + this session's upload).
async function currentInventoryItems() {
  const dbItems = (await loadInventoryItems()) || [];
  return mergeInventory(dbItems, _uploadedInventory);
}

// Create templates from your inventory — one category-level template per category
// (the reusable-template pattern), saved into your template library.
async function createTemplatesFromInventory() {
  const status = document.getElementById('invStatus');
  const items = await currentInventoryItems();
  if (!items.length) {
    if (status) { status.classList.remove('error'); status.textContent = 'Upload your listings first, then create templates.'; }
    return;
  }
  const byCat = new Map();
  for (const it of items) {
    const path = (it.category_path || '').trim();
    if (!path) continue;
    if (!byCat.has(path)) byCat.set(path, { catId: '', sample: it });
    if (!byCat.get(path).catId && it.category_id) byCat.get(path).catId = String(it.category_id);
  }
  if (!byCat.size) {
    if (status) { status.classList.remove('error'); status.textContent = 'No categories found in your inventory to template.'; }
    return;
  }
  let i = 0, n = 0;
  for (const [path, grp] of byCat) {
    const name = path.split(/[›>\/|]/).pop().trim() || path;
    await upsertTemplate({
      id: `tpl-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      schemaVersion: 2,
      categoryId: grp.catId || '',
      categoryPath: [path],
      constants: {},
      deltaFields: [],
      pins: {},
      titleSample: grp.sample.title || '',
      descriptionBoilerplate: '',
      conditionDefault: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    i++; n++;
  }
  if (status) {
    status.classList.remove('error', 'busy');
    status.innerHTML = `Created ${n} template${n === 1 ? '' : 's'} — one per category. `
      + '<a href="#" id="invToListingsLink">Go to Listings to use one →</a>';
    document.getElementById('invToListingsLink')?.addEventListener('click', e => {
      e.preventDefault();
      switchTab('listing');
    });
  }
}
document.getElementById('invCreateTemplatesBtn')?.addEventListener('click', createTemplatesFromInventory);

// Export photos — pull each listing's photos from eBay (through the broker, by item
// number) and save them to a folder you pick, one subfolder per item. Desktop-only
// (needs the file bridge); runs with progress since it fetches every listing.
async function exportInventoryPhotos() {
  const status = document.getElementById('invStatus');
  const api = window.pywebview?.api;
  if (!api?.export_photos) {
    if (status) { status.classList.add('error'); status.textContent = 'Photo export needs the desktop app.'; }
    return;
  }
  const items = (await currentInventoryItems()).filter(it => it.ebay_item_no);
  if (!items.length) {
    if (status) { status.classList.remove('error'); status.textContent = 'Upload your listings first (with eBay item numbers) to export photos.'; }
    return;
  }
  if (status) { status.classList.remove('error'); status.classList.add('busy'); }
  const payload = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (status) status.textContent = `Gathering photos… ${k + 1} of ${items.length}`;
    try {
      const data = await fetchItemAsReference(it.ebay_item_no);
      const urls = [];
      if (data?.image?.imageUrl) urls.push(data.image.imageUrl);
      for (const a of (data?.additionalImages || [])) if (a?.imageUrl) urls.push(a.imageUrl);
      if (urls.length) payload.push({ label: (it.title || it.ebay_item_no).slice(0, 60), item_no: it.ebay_item_no, urls });
    } catch (e) { /* skip listings that won't fetch */ }
  }
  if (!payload.length) {
    if (status) { status.classList.add('error'); status.textContent = 'No photos found to export.'; }
    return;
  }
  if (status) status.textContent = `Choose a folder to save photos for ${payload.length} items…`;
  try {
    const r = await api.export_photos(payload);
    if (r && r.saved) {
      status.classList.remove('error');
      status.textContent = `Exported ${r.photo_count} photo${r.photo_count === 1 ? '' : 's'} for ${r.item_count} item${r.item_count === 1 ? '' : 's'} → ${r.folder}`;
    } else if (status) {
      status.textContent = 'Photo export canceled.';
    }
  } catch (e) {
    console.error('export_photos', e);
    if (status) { status.classList.add('error'); status.textContent = 'Photo export failed.'; }
  }
}
document.getElementById('invExportPhotosBtn')?.addEventListener('click', exportInventoryPhotos);

// Save eBay listing photos INTO the library (copy-in + normalize), vs. exporting
// them to a loose folder. Fetches each listing's images in the browser (immune
// to the broker's cookie challenge), then hands URLs + metadata to the Python
// pipeline which pulls the largest JPEG, converts webp, dedups, and keys them.
async function saveInventoryToLibrary() {
  const status = document.getElementById('invStatus');
  const api = window.pywebview?.api;
  if (!api?.import_ebay_photos) {
    if (status) { status.classList.add('error'); status.textContent = 'Saving to your library needs the desktop app.'; }
    return;
  }
  const items = (await currentInventoryItems()).filter(it => it.ebay_item_no);
  if (!items.length) {
    if (status) { status.classList.remove('error'); status.textContent = 'Upload your listings first (with eBay item numbers) to save them to your library.'; }
    return;
  }
  if (status) { status.classList.remove('error'); status.classList.add('busy'); }
  const payload = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (status) status.textContent = `Gathering photos… ${k + 1} of ${items.length}`;
    try {
      const data = await fetchItemAsReference(it.ebay_item_no);
      const urls = [];
      if (data?.image?.imageUrl) urls.push(data.image.imageUrl);
      for (const a of (data?.additionalImages || [])) if (a?.imageUrl) urls.push(a.imageUrl);
      if (urls.length) payload.push({
        item_no: it.ebay_item_no,
        urls,
        title: it.title || '',
        brand: it.brand || '',
        category_id: it.category_id || null,
        category_path: it.category_path || '',
      });
    } catch (e) { /* skip listings that won't fetch */ }
  }
  if (!payload.length) {
    if (status) { status.classList.remove('busy'); status.classList.add('error'); status.textContent = 'No photos found to save.'; }
    return;
  }
  if (status) status.textContent = `Saving photos for ${payload.length} items to your library…`;
  try {
    const r = await api.import_ebay_photos(payload);
    if (r && r.saved) {
      status.classList.remove('error', 'busy');
      const dupNote = r.duplicate_count ? `, ${r.duplicate_count} already there` : '';
      status.textContent = `Saved ${r.photo_count} photo${r.photo_count === 1 ? '' : 's'} for ${r.item_count} item${r.item_count === 1 ? '' : 's'} to your library${dupNote}.`;
      // Repaint from the library so the saved items appear with their
      // thumbnails — without wiping the success message above.
      await paintInventoryGrid();
      setInvNextStep('saved');
    } else if (status) {
      status.classList.remove('busy');
      status.textContent = 'Nothing was saved.';
    }
  } catch (e) {
    console.error('import_ebay_photos', e);
    if (status) { status.classList.remove('busy'); status.classList.add('error'); status.textContent = 'Saving to your library failed.'; }
  }
}
document.getElementById('invSaveLibraryBtn')?.addEventListener('click', saveInventoryToLibrary);

// Inventory explainer gate — Continue reveals the working surface; the alt links
// let the seller go elsewhere instead; "What is this?" reopens the explainer.
document.getElementById('invContinueBtn')?.addEventListener('click', async () => {
  _invIntroForceShow = false;
  await markInvIntroSeen();
  renderInventory();
});
document.getElementById('invAboutLink')?.addEventListener('click', e => {
  e.preventDefault();
  _invIntroForceShow = true;  // reopen for this view only; stays "seen" for next launch
  renderInventory();
});
document.querySelectorAll('.inv-intro-alt [data-go]').forEach(a => {
  a.addEventListener('click', e => { e.preventDefault(); switchTab(a.dataset.go); });
});

function applyTierChrome() {
  // Free tier sees just the Listings walkthrough — the tab bar and all
  // non-Listings tabs are hidden per [[bynari-architecture-of-record]]. The
  // debut landing is a desktop opening; the web free tier arrives from the
  // public landing page already, so don't show it (or load its iframe) there.
  const tier = tierMode();
  const tabBar = document.getElementById('tabBar');
  if (tabBar) tabBar.classList.toggle('hidden', tier === 'free');
  if (tier === 'free') {
    switchTab('listing');
    const debut = document.getElementById('debut');
    if (debut) {
      document.getElementById('debutFrame')?.removeAttribute('src');
      debut.classList.add('hidden');
    }
  }
}
applyTierChrome();

// === Initial route ===
// The app lands on the inventory dashboard — the seller's own items are the
// home base. The welcome cards (#debut splash) are demoted: no longer the front
// door, still reachable via ⌂ Home. Deep links (a #screen in the hash) and the
// free tier (Listings-only) keep their own landings.
const _initHash = (location.hash || '').slice(1);
const _initDeep = _initHash && _initHash !== 'home'
  && document.querySelector(`[data-screen="${_initHash}"]`);
if (tierMode() === 'free') {
  routeTo(_initDeep ? _initHash : 'home');
} else if (_initDeep) {
  document.getElementById('debut')?.classList.add('hidden');
  switchTab('listing');
  routeTo(_initHash);
} else {
  document.getElementById('debut')?.classList.add('hidden');
  switchTab('inventory');
  _navHist = ['inventory'];
  _navIdx = 0;
  updateGlobalNav();
}
