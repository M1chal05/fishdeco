"use strict";

/* Fishdeco — klubová evidence dekorací.
 * Vanilla client: session gate → state poll (30 s while visible + on return) → shared checklist.
 * Každý člen upravuje jen vlastní sbírku; cizí sbírky jsou vždy jen ke čtení.
 * All server data is rendered through textContent / DOM APIs only.
 */

/* ---------------------------------------------------------------- dom */
const $ = (sel, root) => (root || document).querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function plural(n, forms) {
  return n === 1 ? forms[0] : n >= 2 && n <= 4 ? forms[1] : forms[2];
}

/* server ids may be strings or numbers — compare loosely via String */
function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

const fmtTime = new Intl.DateTimeFormat("cs-CZ", {
  hour: "2-digit",
  minute: "2-digit",
});

const fmtNum = new Intl.NumberFormat("cs-CZ");

/* Czech labels for fixed vocabulary coming from the wiki source. Unknown
   values fall through to the raw English text — never invent translations
   for data. */
const CZ = {
  type: {
    Wall: "Stěna",
    Floor: "Podlaha",
    Furniture: "Nábytek",
    Plant: "Rostlina",
    Painting: "Obraz",
  },
  rarity: {
    "Very common": "Velmi běžná",
    Common: "Běžná",
    Normal: "Normální",
    Uncommon: "Neobvyklá",
    Rare: "Vzácná",
    "Very rare": "Velmi vzácná",
    Epic: "Epická",
    Legendary: "Legendární",
    Unknown: "Neuvedeno",
  },
  source: {
    "Furniture Shop": "Obchod s nábytkem",
    "Furniture Factory": "Továrna na nábytek",
    "Mission reward": "Odměna za misi",
  },
  availability: {
    "Free in inventory": "Zdarma v inventáři",
    "Mission reward": "Odměna za misi",
    "Furniture Factory": "Továrna na nábytek",
    "FREE in inventory when you were a closed beta player":
      "Zdarma v inventáři pro hráče uzavřené bety",
  },
};

const MONTHS = {
  January: "leden",
  February: "únor",
  March: "březen",
  April: "duben",
  May: "květen",
  June: "červen",
  July: "červenec",
  August: "srpen",
  September: "září",
  October: "říjen",
  November: "listopad",
  December: "prosinec",
};

/* preferred ordering for filter option lists */
const VALUE_ORDER = {
  type: ["Wall", "Floor", "Furniture", "Plant", "Painting"],
  rarity: [
    "Very common", "Common", "Normal", "Uncommon", "Rare",
    "Very rare", "Epic", "Legendary", "Unknown",
  ],
};

function fold(s) {
  return String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function cz(map, value) {
  if (value == null || value === "") return null;
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value] : value;
}

function czSeason(value) {
  if (value == null || value === "") return null;
  if (value === "Always") return "Vždy";
  if (MONTHS[value]) return MONTHS[value][0].toUpperCase() + MONTHS[value].slice(1);
  const parts = String(value).split("-");
  if (parts.length === 2 && MONTHS[parts[0]] && MONTHS[parts[1]]) {
    return `${MONTHS[parts[0]]}–${MONTHS[parts[1]]}`;
  }
  return cz(CZ.availability, value);
}

function czAvailability(value) {
  if (value == null || value === "") return null;
  const m = /^Level (\d+)$/.exec(String(value));
  if (m) return `Úroveň ${m[1]}`;
  return cz(CZ.availability, value);
}

/* Czech catalogue names, with original names for older catalogues. */
function colName(col) {
  return col.nameCs || (col.name === "Other" ? "Ostatní" : col.name);
}

function itemName(item) { return item.nameCs || item.name; }

function fmtPrice(item) {
  return typeof item.price === "number" && Number.isFinite(item.price)
    ? fmtNum.format(item.price)
    : null;
}

/* signature of everything buildItemRow renders statically — a changed sig
   means the row is rebuilt instead of patched in place */
function itemSig(it) {
  return JSON.stringify([
    it.name, it.nameCs || "", it.description || "", it.image || "", it.sourceUrl || "",
    it.rarity || "", it.type || "", it.price ?? null, it.availability || "",
    it.level ?? null, it.season || "", it.source || "", it.set || "",
    it.acquisitionDetail || "", it.width || 0, it.height || 0,
  ]);
}

/* ---------------------------------------------------------------- api */
async function req(path, options) {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options && options.body
      ? { "Content-Type": "application/json" }
      : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || "Požadavek selhal.");
    err.status = res.status;
    throw err;
  }
  return data;
}

const api = {
  session: () => req("/api/session"),
  logout: () => req("/api/logout", { method: "POST" }),
  discordConfig: () => req("/api/auth/discord/config"),
  discordStart: (clubPassword) => req("/api/auth/discord/start", {
    method: "POST",
    body: JSON.stringify({ mode: "login", clubPassword }),
  }),
  state: async (etag) => {
    const headers = etag ? { "If-None-Match": etag } : undefined;
    const res = await fetch("/api/state", { credentials: "same-origin", headers });
    if (res.status === 304) {
      return { notModified: true, etag: res.headers.get("ETag") || etag };
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || "Požadavek selhal.");
      err.status = res.status;
      throw err;
    }
    return { data, etag: res.headers.get("ETag") };
  },
  /* vlastnictví zapisuje vždy jen přihlášený člen — server ho určí z relace;
     sběratele v sadě případně sám založí */
  setOwned: (collectionId, itemId, owned) =>
    req(`/api/me/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`, {
      method: "PUT",
      body: JSON.stringify({ owned }),
    }),
  setPrimary: (collectionId, primary) =>
    req(`/api/collections/${encodeURIComponent(collectionId)}/primary`, {
      method: "PUT",
      body: JSON.stringify({ primary }),
    }),
};

/* -------------------------------------------------------------- state */
const S = {
  authed: false,
  user: null,              // {id, name} — přihlášený člen (ze session/state)
  users: [],               // všichni registrovaní členové klubu
  collections: [],
  collectors: [],          // sběratelské záznamy vč. starších (userId === null)
  primaryAssignments: [],  // [{collectionId, userId}] — max 1 primární na sadu
  meta: null,              // optional catalog metadata (source attribution)
  collectionId: null,      // selected collection
  viewUserId: null,        // viewed registered member (null = own collection)
  viewCollectorId: null,   // viewed legacy collector record
  pending: new Map(),      // [userId, collectionId, itemId] -> optimistic owned
  primarySaving: false,
  polling: false,
  pollTimer: null,
  stateEtag: null,
  foregroundPollAt: 0,
  foregroundPollPending: false,
  lastSync: null,
  offline: false,
  epoch: 0,
  revision: 0,
  colQuery: "",            // collection-list search
  filters: { q: "", type: "", rarity: "", own: "" }, // per selected collection
};

function pendingKey(userId, collectionId, itemId) {
  return JSON.stringify([String(userId), String(collectionId), String(itemId)]);
}

function currentCollection() {
  return S.collections.find((c) => sameId(c.id, S.collectionId)) || null;
}
function collectorsHere() {
  return S.collectors.filter((c) => sameId(c.collectionId, S.collectionId));
}
function legacyHere() {
  return collectorsHere().filter((c) => c.userId == null);
}
function primaryUserId() {
  const a = S.primaryAssignments.find((x) => sameId(x.collectionId, S.collectionId));
  return a ? a.userId : null;
}
function mergeCollector(collector) {
  const i = S.collectors.findIndex((c) => sameId(c.id, collector.id));
  if (i >= 0) S.collectors[i] = collector;
  else S.collectors.push(collector);
}

/* One row per club member: every registered user — even without a collector
   in this set (counts 0) — plus every legacy collector record. Pending
   optimistic writes overlay only the session user's own row. */
function personRows() {
  const col = currentCollection();
  const items = (col && col.items) || [];
  const valid = new Set(items.map((it) => String(it.id)));
  const total = items.length;
  const primary = primaryUserId();
  const rows = [];
  for (const u of S.users) {
    const owned = new Set();
    for (const c of collectorsHere()) {
      if (!sameId(c.userId, u.id)) continue;
      for (const id of c.ownedItemIds || []) {
        if (valid.has(String(id))) owned.add(String(id));
      }
    }
    if (S.user && sameId(u.id, S.user.id) && S.pending.size) {
      for (const [k, v] of S.pending) {
        const key = JSON.parse(k);
        if (!sameId(key[0], u.id) || !sameId(key[1], S.collectionId)) continue;
        if (v) owned.add(String(key[2]));
        else owned.delete(String(key[2]));
      }
    }
    rows.push({
      key: "u:" + String(u.id),
      kind: "user",
      userId: u.id,
      name: u.name,
      owned,
      got: owned.size,
      total,
      isSelf: !!(S.user && sameId(u.id, S.user.id)),
      isPrimary: primary != null && sameId(primary, u.id),
      legacy: false,
    });
  }
  for (const c of legacyHere()) {
    const owned = new Set();
    for (const id of c.ownedItemIds || []) {
      if (valid.has(String(id))) owned.add(String(id));
    }
    rows.push({
      key: "c:" + String(c.id),
      kind: "legacy",
      collectorId: c.id,
      name: c.name,
      owned,
      got: owned.size,
      total,
      isSelf: false,
      isPrimary: false,
      legacy: true,
    });
  }
  return rows;
}

function isSelfView() {
  return !!S.user && S.viewUserId == null && S.viewCollectorId == null;
}

function currentViewKey() {
  if (S.viewCollectorId != null) return "c:" + String(S.viewCollectorId);
  if (S.viewUserId != null) return "u:" + String(S.viewUserId);
  return S.user ? "u:" + String(S.user.id) : "";
}

/* whose checklist is on screen — own collection by default, a registered
   member (even without a collector here → 0 owned) or a legacy record */
function viewTarget(rows) {
  const list = rows || personRows();
  if (S.viewCollectorId != null) {
    return list.find(
      (r) => r.kind === "legacy" && sameId(r.collectorId, S.viewCollectorId),
    ) || null;
  }
  const uid = S.viewUserId != null ? S.viewUserId : S.user && S.user.id;
  if (uid == null) return null;
  return list.find((r) => r.kind === "user" && sameId(r.userId, uid)) || null;
}

function viewOwns(item) {
  const t = viewTarget();
  return !!(t && t.owned.has(String(item.id)));
}

function resetViewToSelf() {
  S.viewUserId = null;
  S.viewCollectorId = null;
}

function personLink(row, extraClass) {
  const b = el("button", "person-link" + (extraClass ? " " + extraClass : ""), row.name);
  b.type = "button";
  b.dataset.personKey = row.key;
  b.addEventListener("click", () => openPerson(row));
  return b;
}

function openPerson(row) {
  if (!row) return;
  if (row.kind === "user") {
    if (S.user && sameId(row.userId, S.user.id)) {
      viewSelf();
      return;
    }
    S.viewUserId = row.userId;
    S.viewCollectorId = null;
  } else {
    S.viewUserId = null;
    S.viewCollectorId = row.collectorId;
  }
  paintViewBanner();
  paintItems();
  paintClub();
  itemsSec.scrollIntoView({ block: "start" });
}

function viewSelf() {
  resetViewToSelf();
  paintViewBanner();
  paintItems();
  paintClub();
}

/* --------------------------------------------------------------- refs */
const loginView = $("#login-view");
const loginForm = $("#login-form");
const loginClubPass = $("#login-clubpass");
const clubVerifyBtn = $("#club-verify");
const authConfigHint = $("#auth-config-hint");
const loginError = $("#login-error");
const loginNotice = $("#login-notice");
const discordAuth = $("#discord-auth");
const discordAuthBtn = $("#discord-login");
const discordAuthHint = $("#discord-auth-hint");
const discordAccount = $("#discord-account");
const discordAccountLabel = $("#discord-account-label");

const appView = $("#app");
const railUser = $("#rail-user");
const colListEl = $("#collection-list");
const colSearch = $("#col-search");
const colTotal = $("#col-total");
const colEmpty = $("#col-empty");
const statusEl = $("#sync-status");
const refreshBtn = $("#refresh");
const logoutBtn = $("#logout");

const colTitle = $("#col-title");
const colDesc = $("#col-desc");
const colStats = $("#col-stats");
const appEmpty = $("#app-empty");

const summarySec = $("#summary-sec");
const summaryEl = $("#set-summary");
const primaryName = $("#primary-name");
const primaryCount = $("#primary-count");
const primaryBtn = $("#primary-btn");
const doneList = $("#done-list");
const leadersList = $("#leaders-list");

const itemsSec = $("#items-sec");
const viewBanner = $("#view-banner");
const viewBannerText = $("#view-banner-text");
const viewSelfBtn = $("#view-self");
const filtersEl = $("#filters");
const itemSearch = $("#item-search");
const filterType = $("#filter-type");
const filterRarity = $("#filter-rarity");
const filterOwn = $("#filter-own");
const filterClear = $("#filter-clear");
const itemsCount = $("#items-count");
const itemsEl = $("#items");
const itemsEmpty = $("#items-empty");

const clubSec = $("#club-sec");
const peopleEl = $("#people");
const clubEmpty = $("#club-empty");
const legacyNote = $("#legacy-note");

const sourceNote = $("#source-note");

const toastsEl = $("#toasts");

/* -------------------------------------------------------------- toast */
function toast(message) {
  while (toastsEl.children.length >= 3) toastsEl.firstChild.remove();
  const t = el("div", "toast", message);
  t.setAttribute("role", "alert");
  toastsEl.appendChild(t);
  setTimeout(() => t.remove(), 7000);
}

/* -------------------------------------------------------------- status */
function paintStatus(loading) {
  if (loading) {
    statusEl.textContent = "Načítám…";
    statusEl.dataset.state = "";
  } else if (S.offline) {
    statusEl.textContent = "Offline — zkouším znovu";
    statusEl.dataset.state = "error";
  } else if (S.lastSync) {
    statusEl.textContent = "Aktualizováno " + fmtTime.format(S.lastSync);
    statusEl.dataset.state = "ok";
  } else {
    statusEl.textContent = "Načítám…";
    statusEl.dataset.state = "";
  }
}

/* -------------------------------------------------------------- views */
function clearCredentialFields() {
  loginClubPass.value = "";
}

function showLogin(notice) {
  S.epoch += 1;
  discordConfigEpoch += 1;
  discordEnabled = false;
  discordLinked = false;
  discordConfigUsername = "";
  S.authed = false;
  S.user = null;
  S.users = [];
  S.collections = [];
  S.collectors = [];
  S.primaryAssignments = [];
  S.meta = null;
  S.collectionId = null;
  resetViewToSelf();
  S.lastSync = null;
  S.stateEtag = null;
  S.foregroundPollPending = false;
  S.offline = false;
  S.primarySaving = false;
  railUser.textContent = "";
  discordAccount.hidden = true;
  discordAccountLabel.textContent = "";
  loginForm.hidden = false;
  clearAuthStage();
  loginError.hidden = true;
  loginError.textContent = "";
  discordAuthHint.hidden = false;
  discordAuthHint.textContent = "Přihlášení přes Discord zatím není nastavené.";
  discordAuthBtn.disabled = true;
  colListEl.replaceChildren();
  delete colListEl.dataset.sig;
  delete colListEl.dataset.active;
  colSearch.value = "";
  S.colQuery = "";
  colTotal.textContent = "";
  colEmpty.hidden = true;
  resetFilters();
  itemsCount.textContent = "";
  itemsEl.replaceChildren();
  peopleEl.replaceChildren();
  delete peopleEl.dataset.sig;
  delete summaryEl.dataset.sig;
  delete summaryEl.dataset.psig;
  primaryName.replaceChildren();
  primaryCount.textContent = "";
  primaryBtn.hidden = true;
  doneList.replaceChildren();
  leadersList.replaceChildren();
  viewBanner.hidden = true;
  sourceNote.hidden = true;
  sourceNote.replaceChildren();
  colTitle.textContent = "Fishdeco";
  colTitle.title = "";
  colDesc.textContent = "";
  colStats.textContent = "";
  toastsEl.replaceChildren();
  S.pending.clear();
  stopPolling();
  appView.hidden = true;
  loginView.hidden = false;
  loginError.hidden = true;
  clearCredentialFields();
  if (notice) {
    loginNotice.textContent = notice;
    loginNotice.hidden = false;
  } else {
    loginNotice.hidden = true;
  }
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
}

function sessionExpired() {
  if (!S.authed) return;
  showLogin("Relace vypršela. Přihlas se znovu.");
  refreshDiscordConfig();
}

/* ------------------------------------------------------------ polling */
function startPolling() {
  stopPolling();
  if (!S.authed || document.hidden) return;
  S.pollTimer = setInterval(poll, 30000);
}
function stopPolling() {
  if (S.pollTimer) clearInterval(S.pollTimer);
  S.pollTimer = null;
}

function pollOnReturn() {
  if (!S.authed || document.hidden) return;
  const now = Date.now();
  if (now - S.foregroundPollAt < 1000) return;
  S.foregroundPollAt = now;
  if (S.polling) {
    S.foregroundPollPending = true;
    return;
  }
  S.foregroundPollPending = false;
  poll();
}

async function poll() {
  if (!S.authed || document.hidden || S.polling) return;
  S.polling = true;
  const epoch = S.epoch;
  const revision = S.revision;
  try {
    const result = await api.state(S.stateEtag);
    if (!S.authed || document.hidden || epoch !== S.epoch || revision !== S.revision || S.pending.size || S.primarySaving) return;
    S.offline = false;
    S.stateEtag = result.etag || null;
    if (!result.notModified) mergeState(result.data);
    S.lastSync = Date.now();
  } catch (e) {
    if (epoch !== S.epoch) return;
    if (e.status === 401) {
      sessionExpired();
    } else {
      S.offline = true;
    }
  } finally {
    S.polling = false;
    paintStatus(false);
    if (S.foregroundPollPending && S.authed && !document.hidden) {
      S.foregroundPollPending = false;
      poll();
    }
  }
}

function mergeState(data) {
  S.collections = Array.isArray(data.collections) ? data.collections : [];
  S.collectors = Array.isArray(data.collectors) ? data.collectors : [];
  S.users = Array.isArray(data.users) ? data.users : [];
  S.primaryAssignments = Array.isArray(data.primaryAssignments)
    ? data.primaryAssignments
    : [];
  S.meta = data.meta && typeof data.meta === "object" ? data.meta : null;
  if (data.currentUser && typeof data.currentUser === "object") {
    S.user = { id: data.currentUser.id, name: data.currentUser.name };
  }

  if (!S.collections.some((c) => sameId(c.id, S.collectionId))) {
    S.collectionId = S.collections.length ? S.collections[0].id : null;
    resetViewToSelf();
    resetFilters();
  }
  // prohlížená osoba mohla zmizet — vrať výchozí pohled na vlastní sbírku
  if (
    S.viewCollectorId != null &&
    !S.collectors.some(
      (c) =>
        sameId(c.id, S.viewCollectorId) &&
        c.userId == null &&
        sameId(c.collectionId, S.collectionId),
    )
  ) {
    resetViewToSelf();
  }
  if (
    S.viewUserId != null &&
    !S.users.some((u) => sameId(u.id, S.viewUserId))
  ) {
    resetViewToSelf();
  }
  renderAll();
}

/* ------------------------------------------------------------- render */
function renderAll() {
  paintCollections();
  paintHead();
  paintRailUser();
  paintSummary();
  paintViewBanner();
  paintItems();
  paintClub();
  paintSource();
}

function paintCollections() {
  const q = fold(S.colQuery.trim());
  const visible = q
    ? S.collections.filter((c) =>
        fold(c.name).includes(q) || fold(colName(c)).includes(q))
    : S.collections;
  const sig = JSON.stringify([S.collections.map((c) => [c.id, (c.items || []).length, c.name, c.nameCs || "", c.image || ""]), q]);
  const activeOk = S.collectionId == null ? "" : String(S.collectionId);
  if (colListEl.dataset.sig === sig && colListEl.dataset.active === activeOk) {
    paintColTotals(visible);
    return;
  }
  colListEl.dataset.sig = sig;
  colListEl.dataset.active = activeOk;

  const focusId = colListEl.contains(document.activeElement)
    ? document.activeElement.dataset.collectionId
    : null;

  colListEl.textContent = "";
  for (const c of visible) {
    const li = el("li");
    const btn = el("button", "col-link");
    btn.type = "button";
    btn.dataset.collectionId = String(c.id);
    if (c.image) {
      const icon = el("img", "col-link__image");
      icon.src = c.image;
      icon.alt = "";
      icon.loading = "lazy";
      icon.addEventListener("error", () => icon.remove(), { once: true });
      btn.appendChild(icon);
    }
    const nameEl = el("span", "col-link__name", colName(c));
    if (colName(c) !== c.name) nameEl.title = c.name;
    btn.appendChild(nameEl);
    const n = c.items ? c.items.length : 0;
    btn.appendChild(el("span", "col-link__count", String(n)));
    if (sameId(c.id, S.collectionId)) btn.setAttribute("aria-current", "true");
    btn.addEventListener("click", () => selectCollection(c.id));
    li.appendChild(btn);
    colListEl.appendChild(li);
  }
  if (focusId) {
    const again = colListEl.querySelector(
      `button[data-collection-id="${CSS.escape(focusId)}"]`,
    );
    if (again) again.focus({ preventScroll: true });
  }
  paintColTotals(visible);
}

function paintColTotals(visible) {
  const nCol = S.collections.length;
  const totalItems = S.collections.reduce(
    (n, c) => n + (c.items ? c.items.length : 0), 0,
  );
  const searching = !!fold(S.colQuery.trim());
  colTotal.textContent =
    nCol === 0
      ? ""
      : searching || visible.length !== nCol
        ? `${visible.length} z ${nCol} ${plural(nCol, ["sada", "sady", "sad"])}`
        : `${nCol} ${plural(nCol, ["sada", "sady", "sad"])} · ${totalItems} ${plural(totalItems, ["dekorace", "dekorace", "dekorací"])}`;
  colEmpty.hidden = !(searching && visible.length === 0);
  if (!colEmpty.hidden) colEmpty.textContent = "Žádná sada neodpovídá hledání.";
}

function paintHead() {
  const col = currentCollection();
  if (!col) {
    colTitle.textContent = "Fishdeco";
    colTitle.title = "";
    colDesc.textContent = "Klubová evidence sbírek dekorací.";
    colStats.textContent = "";
    appEmpty.textContent =
      "Zatím tu nejsou žádné kolekce. Až správce doplní katalog, objeví se tady — zkontrolovat to můžeš tlačítkem Obnovit.";
    appEmpty.hidden = false;
    summarySec.hidden = true;
    itemsSec.hidden = true;
    clubSec.hidden = true;
    return;
  }
  appEmpty.hidden = true;
  summarySec.hidden = false;
  itemsSec.hidden = false;
  clubSec.hidden = false;

  colTitle.replaceChildren();
  if (col.image) {
    const icon = el("img", "collection-heading__image");
    icon.src = col.image;
    icon.alt = "";
    icon.addEventListener("error", () => icon.remove(), { once: true });
    colTitle.appendChild(icon);
  }
  colTitle.appendChild(el("span", "collection-heading__name", colName(col)));
  if (col.name !== colName(col)) colTitle.title = col.name;
  else colTitle.title = "";
  colDesc.textContent = col.description || "";
  const items = col.items || [];
  const people = personRows();
  colStats.textContent =
    `${items.length} ${plural(items.length, ["předmět", "předměty", "předmětů"])}` +
    ` · ${people.length} ${plural(people.length, ["sběratel", "sběratelé", "sběratelů"])}`;
}

function paintRailUser() {
  railUser.textContent = S.user ? `Účet: ${S.user.name}` : "";
}

/* -------------------------------------------------- summary + primary */
function paintSummary() {
  const col = currentCollection();
  if (!col) return;
  const total = col.items ? col.items.length : 0;
  const rows = personRows();
  const pId = primaryUserId();
  const pRow =
    pId == null
      ? null
      : rows.find((r) => r.kind === "user" && sameId(r.userId, pId)) || null;
  const mePrimary = pId != null && S.user && sameId(pId, S.user.id);
  const primaryBox = $("#primary-box");
  primaryBox.classList.toggle("primary--assigned", pId != null);
  primaryBox.classList.toggle("primary--self", !!mePrimary);

  const lineSig = pRow
    ? `${pRow.key}:${pRow.name}`
    : pId == null ? "none" : "unknown";
  if (summaryEl.dataset.psig !== lineSig) {
    summaryEl.dataset.psig = lineSig;
    primaryName.textContent = "";
    if (pRow) {
      primaryName.appendChild(personLink(pRow, "person-link--strong"));
    } else if (pId != null) {
      primaryName.appendChild(el("span", "primary__none", "—"));
    } else {
      primaryName.appendChild(el("span", "primary__none", "zatím nikdo"));
    }
  }
  primaryCount.textContent = pRow ? ` ${pRow.got}/${total}` : "";

  if (!S.user) {
    primaryBtn.hidden = true;
    delete primaryBtn.dataset.mode;
  } else if (pId == null) {
    primaryBtn.hidden = false;
    primaryBtn.dataset.mode = "claim";
    primaryBtn.textContent = S.primarySaving
      ? "Ukládám…"
      : "Sbírat primárně";
  } else if (mePrimary) {
    primaryBtn.hidden = false;
    primaryBtn.dataset.mode = "release";
    primaryBtn.textContent = S.primarySaving
      ? "Ukládám…"
      : "Uvolnit hlavní roli";
  } else {
    // sadu drží někdo jiný — primární roli nelze přebírat
    primaryBtn.hidden = true;
    delete primaryBtn.dataset.mode;
  }
  primaryBtn.disabled = S.primarySaving;

  const done = rows.filter((r) => total > 0 && r.got === total);
  const progressed = rows
    .filter((r) => r.got > 0)
    .sort((a, b) => b.got - a.got || a.name.localeCompare(b.name, "cs"));
  const cutoff = progressed.length
    ? progressed[Math.min(2, progressed.length - 1)].got
    : Infinity;
  const leaders = progressed.filter((r) => r.got >= cutoff);
  const sig = JSON.stringify([
    done.map((r) => r.key),
    leaders.map((r) => [r.key, r.got]),
    total,
  ]);
  if (summaryEl.dataset.sig === sig) return;
  summaryEl.dataset.sig = sig;

  doneList.textContent = "";
  if (done.length) {
    done.forEach((r, i) => {
      if (i) doneList.appendChild(document.createTextNode(", "));
      doneList.appendChild(personLink(r, "person-link--complete"));
    });
  } else {
    doneList.appendChild(el("span", "set-summary__none", "zatím nikdo"));
  }

  leadersList.textContent = "";
  if (leaders.length) {
    leaders.forEach((r, i) => {
      if (i) leadersList.appendChild(document.createTextNode(", "));
      const link = personLink(r, "person-link--leader");
      link.appendChild(el("span", "person-link__frac", ` ${r.got}/${total}`));
      leadersList.appendChild(link);
    });
  } else {
    leadersList.appendChild(el("span", "set-summary__none", "zatím nikdo"));
  }
}

/* --------------------------------------------------------- view banner */
function paintViewBanner() {
  const t = viewTarget();
  const foreign = !!t && !t.isSelf;
  viewBanner.hidden = !foreign;
  if (foreign) {
    viewBannerText.textContent =
      `Prohlížíš „${t.name}“ — pouze pro čtení` +
      (t.legacy ? " (starší záznam)" : "");
  }
}

/* -------------------------------------------------------------- items */
const SVG_NS = "http://www.w3.org/2000/svg";
let thumbPh = null;

/* neutral tile shown when a decoration has no image or the file fails */
function placeholderIcon() {
  if (!thumbPh) {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [name, value] of Object.entries({
      viewBox: "0 0 24 24", width: "22", height: "22", fill: "none",
      stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round",
      "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
    })) svg.setAttribute(name, value);
    const frame = document.createElementNS(SVG_NS, "rect");
    for (const [name, value] of Object.entries({
      x: "3.5", y: "4.5", width: "17", height: "15", rx: "2",
    })) frame.setAttribute(name, value);
    const sun = document.createElementNS(SVG_NS, "circle");
    for (const [name, value] of Object.entries({ cx: "9", cy: "9", r: "1.6" }))
      sun.setAttribute(name, value);
    const ridge = document.createElementNS(SVG_NS, "path");
    ridge.setAttribute("d", "M3.5 16.5l4.8-4.8 3.4 3.4 3.4-3.4 5.4 5.4");
    svg.append(frame, sun, ridge);
    thumbPh = svg;
  }
  return thumbPh.cloneNode(true);
}

function buildThumb(item) {
  const t = el("span", "item__thumb");
  t.setAttribute("aria-hidden", "true");
  const src = typeof item.image === "string" ? item.image : "";
  if (!src) {
    t.classList.add("item__thumb--ph");
    t.appendChild(placeholderIcon());
    return t;
  }
  const img = el("img");
  img.src = src;
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  if (Number.isFinite(item.width)) img.width = item.width;
  if (Number.isFinite(item.height)) img.height = item.height;
  img.addEventListener(
    "error",
    () => {
      t.classList.add("item__thumb--ph");
      t.replaceChildren(placeholderIcon());
    },
    { once: true },
  );
  t.appendChild(img);
  return t;
}

/* short meta line: rarity · type · price (price label lives in details) */
function fillMeta(metaEl, item) {
  const rarity = cz(CZ.rarity, item.rarity);
  const type = cz(CZ.type, item.type);
  const price = fmtPrice(item);
  if (rarity) {
    const tag = el("span", "item__tag item__tag--rarity", rarity);
    tag.dataset.rarity = item.rarity;
    metaEl.appendChild(tag);
  }
  if (type) metaEl.appendChild(el("span", "item__tag item__tag--type", type));
  if (price != null) {
    const p = el("span", "item__price", `${price} dom. b.`);
    p.title = "Cena / domovní body";
    metaEl.appendChild(p);
  }
  metaEl.hidden = metaEl.children.length === 0;
}

/* detail rows for the <details> toggle — fields that exist on the item;
   keys present with empty/null values are labelled Neuvedeno, keys absent
   entirely (old catalog shape) are skipped */
function specRows(item) {
  const has = (k) => Object.prototype.hasOwnProperty.call(item, k);
  const rows = [];
  const availability = czAvailability(item.availability);
  if (availability) rows.push(["Dostupnost", availability]);
  else if (has("availability")) rows.push(["Dostupnost", "Neuvedeno"]);
  // Úroveň separately only when availability doesn't already say it
  if (has("level")) {
    if (
      typeof item.level === "number" &&
      item.availability !== `Level ${item.level}`
    ) {
      rows.push(["Úroveň", String(item.level)]);
    } else if (item.level == null) {
      rows.push(["Úroveň", "Neuvedeno"]);
    }
  }
  const season = czSeason(item.season);
  // skip when it renders identically to Dostupnost (shared source string)
  if (season && season !== availability) rows.push(["Sezóna", season]);
  else if (!season && has("season")) rows.push(["Sezóna", "Neuvedeno"]);
  const source = cz(CZ.source, item.source);
  if (source) rows.push(["Zdroj", source]);
  else if (has("source")) rows.push(["Zdroj", "Neuvedeno"]);
  if (has("price")) {
    rows.push(["Cena / domovní body", fmtPrice(item) ?? "Neuvedeno"]);
  }
  if (typeof item.acquisitionDetail === "string" && item.acquisitionDetail) {
    rows.push(["Jak získat", item.acquisitionDetail]);
  }
  return rows;
}

function buildItemRow(item) {
  const li = el("li", "item");
  li.dataset.itemId = item.id;
  li.dataset.sig = itemSig(item);

  const line = el("div", "item__line");
  const label = el("label", "item__row");
  const cb = el("input", "item__check");
  cb.type = "checkbox";
  cb.setAttribute("aria-label", `Vlastnictví „${itemName(item)}“`);
  cb.addEventListener("change", () => onToggle(item, cb));

  const body = el("span", "item__body");
  body.appendChild(el("span", "item__name", itemName(item)));
  if (itemName(item) !== item.name) body.appendChild(el("span", "item__original-name", item.name));
  const desc = el("span", "item__desc", item.description || "");
  if (!item.description) desc.hidden = true;
  body.appendChild(desc);
  const meta = el("span", "item__meta");
  fillMeta(meta, item);
  const state = el("span", "item__state", "Chybí");
  state.dataset.state = "missing";
  meta.appendChild(state);
  meta.hidden = false;
  body.appendChild(meta);
  body.appendChild(el("span", "item__owners"));

  label.appendChild(cb);
  label.appendChild(buildThumb(item));
  label.appendChild(body);
  label.appendChild(el("span", "item__count"));
  line.appendChild(label);

  /* wiki link must sit outside the toggle label so it never flips the checkbox */
  if (typeof item.sourceUrl === "string" && item.sourceUrl) {
    const a = el("a", "item__wiki", "Wiki ↗︎");
    a.href = item.sourceUrl;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    a.setAttribute("aria-label", `„${item.name}“ na FishaoFunWiki`);
    line.appendChild(a);
  }
  li.appendChild(line);

  const rows = specRows(item);
  if (rows.length) {
    const det = el("details", "item__more");
    det.appendChild(el("summary", null, "Podrobnosti"));
    const dl = el("dl", "item__specs");
    for (const [k, v] of rows) {
      dl.appendChild(el("dt", null, k));
      dl.appendChild(el("dd", null, v));
    }
    det.appendChild(dl);
    li.appendChild(det);
  }
  return li;
}

function paintItem(item, li, rows) {
  const list = rows || personRows();
  const cb = $(".item__check", li);
  const ownersEl = $(".item__owners", li);
  const countEl = $(".item__count", li);
  const t = viewTarget(list);
  const self = isSelfView();
  const key = S.user ? pendingKey(S.user.id, S.collectionId, item.id) : null;
  const busy = !!(self && key && S.pending.has(key));
  const ownedByView = !!(t && t.owned.has(String(item.id)));
  li.classList.toggle("item--owned", ownedByView);
  li.classList.toggle("item--missing", !ownedByView);
  li.classList.toggle("item--readonly", !self);
  const state = $(".item__state", li);
  state.textContent = ownedByView ? "Získáno" : "Chybí";
  state.dataset.state = ownedByView ? "owned" : "missing";

  const owners = list.filter((r) => r.owned.has(String(item.id)));
  const ownerSig = JSON.stringify(owners.map((o) => [o.key, o.name]));
  if (ownersEl.dataset.sig !== ownerSig) {
    ownersEl.dataset.sig = ownerSig;
    ownersEl.textContent = "";
    if (owners.length) {
      ownersEl.appendChild(document.createTextNode("Má: "));
      owners.forEach((o, i) => {
        if (i) ownersEl.appendChild(document.createTextNode(", "));
        ownersEl.appendChild(personLink(o));
      });
    } else {
      ownersEl.textContent = "Zatím nikdo";
    }
  }
  countEl.textContent = `${owners.length}/${list.length}`;

  cb.checked = t ? t.owned.has(String(item.id)) : false;
  cb.disabled = !self || busy;
  cb.setAttribute("aria-busy", busy ? "true" : "false");
  li.classList.toggle("item--busy", busy);
}

/* ------------------------------------------------------------- filters */
function filtersActive() {
  const f = S.filters;
  return !!(f.q.trim() || f.type || f.rarity || f.own);
}

function resetFilters() {
  S.filters = { q: "", type: "", rarity: "", own: "" };
  itemSearch.value = "";
  filterType.value = "";
  filterRarity.value = "";
  filterOwn.value = "";
  delete filterType.dataset.sig;
  delete filterRarity.dataset.sig;
}

function itemMatches(item, target) {
  const f = S.filters;
  if (f.q.trim()) {
    const q = fold(f.q.trim());
    if (!fold(item.name).includes(q) && !fold(itemName(item)).includes(q)) return false;
  }
  if (f.type && item.type !== f.type) return false;
  if (f.rarity && item.rarity !== f.rarity) return false;
  if (f.own) {
    if (!target) return false;
    const owned = target.owned.has(String(item.id));
    if (f.own === "owned" && !owned) return false;
    if (f.own === "missing" && owned) return false;
  }
  return true;
}

/* option lists built only from values present in the selected collection;
   skipped while that select has focus so polling never steals an open menu */
function collectValues(items, key) {
  const counts = new Map();
  for (const it of items) {
    const v = it[key];
    if (v != null && v !== "") counts.set(v, (counts.get(v) || 0) + 1);
  }
  const order = VALUE_ORDER[key] || [];
  return [...counts.entries()].sort((a, b) => {
    const ia = order.indexOf(a[0]);
    const ib = order.indexOf(b[0]);
    if (ia !== -1 || ib !== -1) {
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    }
    return String(a[0]).localeCompare(String(b[0]), "cs");
  });
}

function syncSelect(selectEl, pairs) {
  const sig = JSON.stringify(pairs);
  if (selectEl.dataset.sig === sig) return true;
  if (document.activeElement === selectEl) return false;
  selectEl.dataset.sig = sig;
  selectEl.textContent = "";
  const all = el("option", null, "Všechny");
  all.value = "";
  selectEl.appendChild(all);
  for (const [value, label] of pairs) {
    const o = el("option", null, label);
    o.value = value;
    selectEl.appendChild(o);
  }
  return true;
}

function paintFilters() {
  const col = currentCollection();
  const items = (col && col.items) || [];
  filtersEl.hidden = items.length === 0;

  if (syncSelect(
    filterType,
    collectValues(items, "type").map(([v, n]) => [v, `${cz(CZ.type, v)} (${n})`]),
  )) {
    if (filterType.value !== S.filters.type) filterType.value = S.filters.type;
    if (filterType.value !== S.filters.type) S.filters.type = filterType.value;
  }
  if (syncSelect(
    filterRarity,
    collectValues(items, "rarity").map(([v, n]) => [v, `${cz(CZ.rarity, v)} (${n})`]),
  )) {
    if (filterRarity.value !== S.filters.rarity) filterRarity.value = S.filters.rarity;
    if (filterRarity.value !== S.filters.rarity) S.filters.rarity = filterRarity.value;
  }

  // vlastnictví se řídí prohlíženou osobou — u cizí sbírky jen ke čtení
  const t = viewTarget();
  const self = isSelfView();
  const labels = self
    ? { "": "Všechny", missing: "Chybí mi", owned: "Vlastním" }
    : { "": "Všechny", missing: "Chybí", owned: "Má" };
  for (const o of filterOwn.options) {
    if (labels[o.value] != null) o.textContent = labels[o.value];
  }
  filterOwn.disabled = !t;
  filterOwn.title = "";
  if (!t && S.filters.own) {
    S.filters.own = "";
    filterOwn.value = "";
  }
  filterClear.disabled = !filtersActive();
}

function paintItems() {
  const col = currentCollection();
  const items = (col && col.items) || [];
  const rows = personRows();
  const target = viewTarget(rows);
  // Normalize unavailable filters before matching rows.
  paintFilters();

  itemsEl.classList.toggle("items--locked", !isSelfView());

  /* reconcile rows with the item set; keep DOM nodes so focus survives polls */
  const focusedControl = itemsEl.contains(document.activeElement) ? document.activeElement : null;
  const focusId = focusedControl
    ? (document.activeElement.closest(".item") || {}).dataset?.itemId
    : null;
  const seen = new Set();
  let shown = 0;
  for (const item of items) {
    seen.add(String(item.id));
    let li = itemsEl.querySelector(
      `li.item[data-item-id="${CSS.escape(String(item.id))}"]`,
    );
    const sig = itemSig(item);
    if (!li || li.dataset.sig !== sig) {
      const fresh = buildItemRow(item);
      if (li) li.replaceWith(fresh);
      li = fresh;
    }
    itemsEl.appendChild(li); // keep DOM order = server order
    const matches = itemMatches(item, target);
    li.hidden = !matches;
    if (matches) shown += 1;
    paintItem(item, li, rows);
  }
  for (const li of Array.from(itemsEl.children)) {
    if (!seen.has(li.dataset.itemId)) li.remove();
  }
  if (focusId) {
    const again = focusedControl?.isConnected ? focusedControl : itemsEl.querySelector(
      `li.item[data-item-id="${CSS.escape(focusId)}"] .item__check`,
    );
    if (again && !again.closest(".item")?.hidden) again.focus({ preventScroll: true });
  }

  if (S.collectionId == null) {
    itemsEmpty.hidden = true;
    itemsCount.textContent = "";
  } else if (items.length === 0) {
    itemsEmpty.textContent = "Tato kolekce zatím nemá žádné předměty.";
    itemsEmpty.hidden = false;
    itemsCount.textContent = "";
  } else if (shown === 0) {
    itemsEmpty.textContent = "Žádná dekorace neodpovídá zvoleným filtrům.";
    itemsEmpty.hidden = false;
    itemsCount.textContent = `Zobrazeno 0 z ${items.length} ${plural(items.length, ["dekorace", "dekorace", "dekorací"])}`;
  } else {
    itemsEmpty.hidden = true;
    itemsCount.textContent = shown === items.length
      ? `${items.length} ${plural(items.length, ["dekorace", "dekorace", "dekorací"])}`
      : `Zobrazeno ${shown} z ${items.length} ${plural(items.length, ["dekorace", "dekorace", "dekorací"])}`;
  }
}

/* ------------------------------------------------------------- source */
function paintSource() {
  const meta = S.meta && typeof S.meta === "object" ? S.meta : null;
  const fromCol = S.collections.find(
    (c) => typeof c.sourceUrl === "string" && c.sourceUrl,
  );
  const url =
    (meta && typeof meta.sourceUrl === "string" && meta.sourceUrl) ||
    (fromCol ? fromCol.sourceUrl : "");
  if (!url) {
    sourceNote.hidden = true;
    sourceNote.replaceChildren();
    return;
  }
  let label = meta && typeof meta.source === "string" && meta.source ? meta.source : "";
  if (!label) {
    try { label = new URL(url).hostname; } catch { label = url; }
  }
  const existing = sourceNote.querySelector("a");
  if (existing && existing.getAttribute("href") === url && existing.textContent === label) {
    sourceNote.hidden = false;
    return;
  }
  const a = el("a", null, label);
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  sourceNote.replaceChildren("Data a obrázky dekorací: ", a, ".");
  sourceNote.hidden = false;
}

/* --------------------------------------------------------------- club */
function paintClub() {
  const col = currentCollection();
  const rows = personRows()
    .sort((a, b) => b.got - a.got || a.name.localeCompare(b.name, "cs"));
  const viewKey = currentViewKey();
  const sig =
    rows
      .map(
        (r) =>
          `${r.key}=${r.name}=${r.got}/${r.total}=${r.isPrimary ? 1 : 0}=${r.isSelf ? 1 : 0}=${r.legacy ? 1 : 0}=${r.total > 0 && r.got === r.total ? 1 : 0}`,
      )
      .join("|") + "@" + viewKey;

  clubEmpty.hidden = rows.length > 0;
  if (!rows.length) {
    clubEmpty.textContent = "Zatím tu nikdo není.";
  }
  const hasLegacy = rows.some((r) => r.legacy);
  legacyNote.hidden = !hasLegacy;
  if (hasLegacy) {
    legacyNote.textContent =
      "Starší záznamy jsou jen ke čtení — správce je jednorázově přiřadí k účtům členů.";
  }
  if (peopleEl.dataset.sig === sig) return;
  peopleEl.dataset.sig = sig;

  const focusKey = peopleEl.contains(document.activeElement)
    ? document.activeElement.dataset.personKey
    : null;

  peopleEl.textContent = "";
  for (const r of rows) {
    const li = el("li", "person");
    if (r.key === viewKey) li.classList.add("person--viewing");
    li.classList.toggle("person--complete", r.total > 0 && r.got === r.total);
    li.classList.toggle("person--primary", !!r.isPrimary);
    li.classList.toggle("person--self", !!r.isSelf);

    const head = el("span", "person__name");
    const link = personLink(r, "person-link--row");
    if (r.key === viewKey) link.setAttribute("aria-current", "true");
    head.appendChild(link);
    if (r.key === viewKey) head.appendChild(el("span", "person__badge person__badge--viewing", "Prohlížíš"));
    if (r.total > 0 && r.got === r.total) head.appendChild(el("span", "person__badge person__badge--complete", "Hotovo"));
    if (r.isSelf) head.appendChild(el("span", "person__badge person__badge--self", "Ty"));
    if (r.isPrimary) head.appendChild(el("span", "person__badge person__badge--primary", "Primární"));
    if (r.legacy) head.appendChild(el("span", "person__badge person__badge--legacy", "Starší záznam"));
    li.appendChild(head);
    li.appendChild(el("span", "person__frac", `${r.got}/${r.total}`));

    const bar = el("span", "person__bar");
    bar.setAttribute("aria-hidden", "true");
    const fill = el("i");
    fill.style.setProperty("--w", r.total ? `${(r.got / r.total) * 100}%` : "0%");
    bar.appendChild(fill);
    li.appendChild(bar);
    peopleEl.appendChild(li);
  }
  if (focusKey) {
    const again = peopleEl.querySelector(
      `[data-person-key="${CSS.escape(focusKey)}"]`,
    );
    if (again) again.focus({ preventScroll: true });
  }
}

/* ------------------------------------------------------------- events */
function selectCollection(id) {
  if (sameId(id, S.collectionId)) return;
  S.collectionId = id;
  resetViewToSelf();
  resetFilters();
  renderAll();
}

/* Odpověď PUT obsahuje celého sběratele, ale přebíráme z ní jen stav jedné
   položky — souběžný zápis sourozence by jinak přepsal novější lokální stav.
   Výjimka: sběratel tu ještě není (auto-vytvořen při prvním zápisu), tehdy
   převezmeme celý záznam jednou. */
function applyOwnedFromResponse(collector, itemId) {
  const target = S.collectors.find((x) => sameId(x.id, collector.id));
  if (!target) {
    if (S.user) {
      const stale = S.collectors.findIndex(
        (x) =>
          sameId(x.collectionId, collector.collectionId) &&
          sameId(x.userId, S.user.id) &&
          !sameId(x.id, collector.id),
      );
      if (stale >= 0) S.collectors.splice(stale, 1);
    }
    mergeCollector(collector);
    return;
  }
  target.name = collector.name;
  if (collector.userId !== undefined) target.userId = collector.userId;
  target.ownedItemIds = (target.ownedItemIds || []).filter(
    (id) => !sameId(id, itemId),
  );
  if ((collector.ownedItemIds || []).some((id) => sameId(id, itemId))) {
    target.ownedItemIds.push(itemId);
  }
}

async function onToggle(item, checkbox) {
  if (!isSelfView() || !S.user) {
    checkbox.checked = viewOwns(item); // cizí sbírka — žádný zápis
    return;
  }
  const collectionId = S.collectionId;
  const owned = checkbox.checked;
  const key = pendingKey(S.user.id, collectionId, item.id);
  if (S.pending.has(key)) {
    checkbox.checked = S.pending.get(key);
    return;
  }
  const epoch = S.epoch;
  S.revision += 1;
  S.pending.set(key, owned);
  const li = checkbox.closest(".item");
  if (li) paintItem(item, li);
  paintSummary();
  paintClub();

  try {
    const data = await api.setOwned(collectionId, item.id, owned);
    if (epoch !== S.epoch || !S.authed) return;
    if (!data || !data.collector) throw new Error("Server nevrátil sběratele.");
    applyOwnedFromResponse(data.collector, item.id);
    S.pending.delete(key);
    S.revision += 1;
  } catch (e) {
    if (epoch !== S.epoch || !S.authed) return;
    S.pending.delete(key);
    S.revision += 1;
    if (e.status === 401) {
      sessionExpired();
      return;
    }
    const detail = e.status ? e.message : "Zkontroluj připojení a zkus to znovu.";
    toast(`Nepodařilo se uložit „${itemName(item)}“. ${detail}`);
  }
  const row = itemsEl.querySelector(
    `li.item[data-item-id="${CSS.escape(String(item.id))}"]`,
  );
  if (row && sameId(collectionId, S.collectionId)) paintItems();
  paintHead();
  paintSummary();
  paintClub();
}

async function onPrimary() {
  const mode = primaryBtn.dataset.mode;
  if (!S.user || S.primarySaving || !mode || S.collectionId == null) return;
  const primary = mode === "claim";
  const epoch = S.epoch;
  S.revision += 1;
  S.primarySaving = true;
  paintSummary();
  let refresh = false;
  try {
    const data = await api.setPrimary(S.collectionId, primary);
    if (epoch !== S.epoch || !S.authed) return;
    if (data && Array.isArray(data.primaryAssignments)) {
      S.primaryAssignments = data.primaryAssignments;
    }
    S.revision += 1;
  } catch (e) {
    if (epoch !== S.epoch || !S.authed) return;
    S.revision += 1;
    if (e.status === 401) {
      sessionExpired();
      return;
    }
    toast(e.status ? e.message : "Zkontroluj připojení a zkus to znovu.");
    refresh = true; // konflikt — dotáhni autoritativní stav ze serveru
  } finally {
    if (epoch === S.epoch) {
      S.primarySaving = false;
      paintSummary();
      paintClub();
      if (refresh) poll();
    }
  }
}

/* ------------------------------------------------------------ session */
let discordConfigEpoch = 0;
let discordEnabled = false;
let discordLinked = false;
let discordStarting = false;
let verifiedDiscordUrl = "";
let verifiedDiscordUntil = 0;
let authStage = "password";

function clearAuthStage() {
  verifiedDiscordUrl = "";
  verifiedDiscordUntil = 0;
  authStage = "password";
  loginForm.hidden = false;
  discordAuth.hidden = true;
  loginClubPass.value = "";
  if (clubVerifyBtn) clubVerifyBtn.disabled = !discordEnabled;
  if (discordAuthBtn) discordAuthBtn.disabled = true;
}

const discordErrorMessages = {
  disabled: "Přihlášení přes Discord teď není dostupné.",
  cancelled: "Přihlášení přes Discord bylo zrušeno.",
  expired: "Přihlášení přes Discord vypršelo. Zkus to znovu.",
  invite_required: "Heslo není správné nebo chybí. Zkontroluj ho a zkus to znovu.",
  already_linked: "Tento Discord účet už je propojený s jiným účtem.",
  invalid_client: "Discord odmítl přihlašovací údaje aplikace. Správce musí zkontrolovat Discord Client Secret.",
  invalid_grant: "Discord odmítl přihlašovací kód. Začni přihlášení znovu; pokud se chyba opakuje, správce musí zkontrolovat návratovou adresu.",
  token_exchange_failed: "Nepodařilo se dokončit ověření u Discordu. Zkus se přihlásit znovu. (Ověření aplikace)",
  profile_failed: "Discord neposkytl platný profil. Zkus se přihlásit znovu. (Načtení profilu)",
  storage_failed: "Přihlášení se nepodařilo uložit. Správce musí zkontrolovat databázi aplikace.",
  browser_mismatch: "Prohlížeč nepotvrdil začátek přihlášení. Povol cookies pro tento web a začni přihlášení znovu ve stejné kartě.",
  callback_mismatch: "Návratová adresa Discordu neodpovídá tomuto webu. Správce musí opravit nastavení přihlášení.",
  issuer_mismatch: "Návrat z Discordu neprošel kontrolou poskytovatele. Začni přihlášení znovu.",
  failed: "Přihlášení přes Discord se nepodařilo. Zkus to znovu.",
};

function takeDiscordCallbackNotice() {
  const url = new URL(window.location.href);
  const linked = url.searchParams.get("discord") === "linked";
  const code = url.searchParams.get("discord_error");
  if (!linked && !code) return "";
  url.searchParams.delete("discord");
  url.searchParams.delete("discord_error");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  if (linked) return "";
  return discordErrorMessages[code] || discordErrorMessages.failed;
}

function paintDiscordAccount() {
  const visible = !!(discordEnabled && S.authed);
  discordAccount.hidden = !visible;
  if (!visible) {
    discordAccountLabel.textContent = "";
  } else if (discordLinked) {
    discordAccountLabel.textContent = `Discord: @${discordConfigUsername || "Propojeno"} · Propojeno`;
  } else {
    discordAccountLabel.textContent = "Discord není propojený";
  }
}

let discordConfigUsername = "";
async function refreshDiscordConfig() {
  const epoch = ++discordConfigEpoch;
  discordEnabled = false;
  discordLinked = false;
  discordConfigUsername = "";
  discordAuth.hidden = true;
  discordAuthHint.hidden = false;
  discordAuthHint.textContent = "Přihlášení přes Discord zatím není nastavené.";
  discordAuthBtn.disabled = true;
  paintDiscordAccount();
  try {
    const config = await api.discordConfig();
    if (epoch !== discordConfigEpoch) return;
    discordEnabled = !!(config && config.enabled);
    authConfigHint.hidden = discordEnabled;
    discordLinked = !!(discordEnabled && S.authed && config.linked);
    discordConfigUsername = typeof (config && config.username) === "string" ? config.username : "";
    discordAuth.hidden = true;
    discordAuthHint.hidden = false;
    discordAuthHint.textContent = discordEnabled ? "Jméno převezmeme z tvého Discord účtu." : "Přihlášení přes Discord zatím není nastavené.";
    discordAuthBtn.textContent = "Přihlásit přes Discord";
    clubVerifyBtn.disabled = !discordEnabled;
    discordAuthBtn.disabled = !verifiedDiscordUrl;
    paintDiscordAccount();
  } catch {
    if (epoch !== discordConfigEpoch) return;
    discordEnabled = false;
    authConfigHint.hidden = false;
    discordLinked = false;
    discordAuth.hidden = true;
    discordAuthHint.hidden = false;
    discordAuthHint.textContent = "Přihlášení přes Discord zatím není nastavené.";
    clubVerifyBtn.disabled = true;
    discordAuthBtn.disabled = true;
    paintDiscordAccount();
  }
}

async function startDiscordAuth() {
  if (!discordEnabled || discordStarting || authStage !== "password") return;
  loginError.hidden = true;
  if (!loginClubPass.value) {
    authFail("Zadej heslo.", loginClubPass);
    return;
  }
  clubVerifyBtn.disabled = true;
  discordStarting = true;
  try {
    const result = await api.discordStart(loginClubPass.value);
    const target = new URL(result && result.url, window.location.href);
    if (target.protocol !== "https:" || target.hostname !== "discord.com" || target.port || target.pathname !== "/oauth2/authorize" || target.username || target.password) {
      throw new Error("Neplatná adresa Discordu.");
    }
    verifiedDiscordUrl = target.href;
    verifiedDiscordUntil = Date.now() + 9 * 60 * 1000;
    loginClubPass.value = "";
    authStage = "discord";
    loginForm.hidden = true;
    discordAuth.hidden = false;
    discordAuthHint.textContent = "Heslo ověřeno.";
    discordAuthBtn.disabled = false;
    discordAuthBtn.focus();
  } catch (err) {
    const message = err.status === 403
      ? "Nesprávné heslo. Zkontroluj ho a zkus to znovu."
      : err.status === 429
        ? "Příliš mnoho pokusů. Zkus to prosím později."
        : "Discord teď není dostupný. Zkus to znovu.";
    loginError.textContent = message;
    loginError.hidden = false;
  } finally {
    discordStarting = false;
    clubVerifyBtn.disabled = !discordEnabled;
  }
}

function authFail(message, field) {
  loginError.textContent = message;
  loginError.hidden = false;
  if (field) field.focus();
}

async function boot() {
  bindEvents();
  const discordNotice = takeDiscordCallbackNotice();
  paintStatus(true);
  try {
    const s = await api.session();
    if (s && s.authenticated) {
      S.authed = true;
      S.user = s.user && typeof s.user === "object" ? s.user : null;
      showApp();
      startPolling();
      await poll();
      await refreshDiscordConfig();
      if (discordNotice) toast(discordNotice);
      return;
    }
    showLogin(discordNotice);
    await refreshDiscordConfig();
  } catch {
    showLogin(discordNotice || "Nepodařilo se ověřit přihlášení — zkontroluj připojení a zkus to znovu.");
    await refreshDiscordConfig();
  }
}

async function onAuthSubmit(e) {
  e.preventDefault();
  await startDiscordAuth();
}

function continueDiscordAuth() {
  if (authStage !== "discord" || !verifiedDiscordUrl) return;
  if (Date.now() >= verifiedDiscordUntil) {
    clearAuthStage();
    loginError.textContent = "Ověření vypršelo. Zadej heslo znovu.";
    loginError.hidden = false;
    loginClubPass.focus();
    return;
  }
  const target = new URL(verifiedDiscordUrl);
  if (target.protocol !== "https:" || target.hostname !== "discord.com" || target.port || target.pathname !== "/oauth2/authorize" || target.username || target.password) {
    clearAuthStage();
    loginError.textContent = "Neplatná adresa Discordu.";
    loginError.hidden = false;
    return;
  }
  window.location.assign(target.href);
}

async function onLogout() {
  logoutBtn.disabled = true;
  try { await api.logout(); } catch {
    toast("Odhlášení se nepodařilo. Zkontroluj připojení a zkus to znovu.");
    logoutBtn.disabled = false;
    return;
  }
  logoutBtn.disabled = false;
  showLogin();
  refreshDiscordConfig();
}

function bindEvents() {
  loginForm.addEventListener("submit", onAuthSubmit);
  discordAuthBtn.addEventListener("click", continueDiscordAuth);
  logoutBtn.addEventListener("click", onLogout);
  refreshBtn.addEventListener("click", () => poll());
  primaryBtn.addEventListener("click", onPrimary);
  viewSelfBtn.addEventListener("click", viewSelf);

  colSearch.addEventListener("input", () => {
    S.colQuery = colSearch.value;
    paintCollections();
  });
  itemSearch.addEventListener("input", () => {
    S.filters.q = itemSearch.value;
    paintItems();
  });
  filterType.addEventListener("change", () => {
    S.filters.type = filterType.value;
    paintItems();
  });
  filterRarity.addEventListener("change", () => {
    S.filters.rarity = filterRarity.value;
    paintItems();
  });
  filterOwn.addEventListener("change", () => {
    S.filters.own = filterOwn.value;
    paintItems();
  });
  filterClear.addEventListener("click", () => {
    resetFilters();
    paintItems();
  });

  window.addEventListener("focus", pollOnReturn);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
    } else if (S.authed) {
      startPolling();
      pollOnReturn();
    }
  });
}

boot();
