(function(){
"use strict";

/* =============================================================
   Constants & tiny helpers
   ============================================================= */
const LS_KEY    = "placecard.v1";
const DATA_PATH = "data/plan.json";
const THUMB     = 160;            // stored photo edge, px
const RING_R    = 94;             // ring radius for the plan disc

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/** Diacritic-insensitive fold — Romanian ș/ț/ă/î/â all flatten. */
function fold(s){
  return (s || "").normalize("NFD").replace(/\p{Diacritic}|\p{Mn}/gu, "").toLowerCase().trim();
}
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
    {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]
  ));
}
function initialsOf(name){
  const p = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "?";
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}
function shortName(name){
  const p = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (p.length < 2) return p[0] || "";
  return p[0] + " " + p[p.length - 1][0] + ".";
}

const GROUP_COLORS = ["#9E3A56","#4C5B8C","#4F7355","#B08133","#2F6E70","#74497E","#A45C43","#5E6A72"];

/* =============================================================
   State
   ============================================================= */
let S = null;              // { plan, photos }
let artifactNS = null;
let downloadsNS = null;
let filesFormOK = true;
let readOnly = false;

let selectedId = null;
let query      = "";
let groupFilter = null;
let view       = "plan";
let dragId     = null;

const undoStack = [];
const tiles = new Map();   // guestId -> reused DOM node

function blank(){
  return {
    plan: {
      v: 1,
      updatedAt: 0,
      couple: "Our wedding",
      guests: [],
      tables: [],
      groups: [
        { id: uid(), name: "Bride's side",  color: GROUP_COLORS[0] },
        { id: uid(), name: "Groom's side",  color: GROUP_COLORS[1] },
        { id: uid(), name: "Family",        color: GROUP_COLORS[2] },
        { id: uid(), name: "Friends",       color: GROUP_COLORS[3] }
      ]
    },
    photos: {}
  };
}

const guestById = id => S.plan.guests.find(g => g.id === id);
const tableById = id => S.plan.tables.find(t => t.id === id);
const groupById = id => S.plan.groups.find(g => g.id === id);
const tableOf   = id => S.plan.tables.find(t => t.guestIds.indexOf(id) > -1) || null;
const seatedIds = () => new Set(S.plan.tables.flatMap(t => t.guestIds));

/* =============================================================
   Persistence — localStorage now, artifact data file debounced
   ============================================================= */
function readLocal(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return (o && o.plan && Array.isArray(o.plan.guests)) ? o : null;
  } catch (e){ return null; }
}
function writeLocal(){
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); }
  catch (e){ setStatus("error", "Too big for this browser"); }
}

let saveTimer = null, saving = false, again = false;

function commit(opts){
  S.plan.updatedAt = Date.now();
  writeLocal();
  render();
  if (!(opts && opts.noSave)) scheduleSave();
}
function scheduleSave(){
  clearTimeout(saveTimer);
  if (artifactNS && !readOnly && filesFormOK) setStatus("unsaved", "Not saved yet");
  saveTimer = setTimeout(doSave, 1200);
}
async function doSave(){
  if (!artifactNS || readOnly || !filesFormOK){ setStatus("idle", "This device only"); return; }
  if (saving){ again = true; return; }
  saving = true;
  setStatus("saving", "Saving");
  try {
    await artifactNS.publish({ [DATA_PATH]: JSON.stringify(S) });
    setStatus("saved", "Saved");
  } catch (err){
    const code = (err && err.code) || "upstream_error";
    if (code === "conflict"){
      // Someone published first. Their version is the truth — drop our local
      // copy so the reload does not resurrect it, then reload.
      try { localStorage.removeItem(LS_KEY); } catch (e){}
      toast("Someone else saved first. Loading their latest plan…");
      setTimeout(() => location.reload(), 1400);
    } else if (code === "not_writer" || code === "not_granted" ||
               code === "not_declared" || code === "consent_required"){
      readOnly = true;
      setStatus("readonly", "View only");
      toast("You can look but not change this plan.");
    } else if (code === "capability_disabled" || code === "capability_removed"){
      filesFormOK = false;
      setStatus("idle", "This device only");
      toast("Saving to the shared plan isn't available here. Your work stays in this browser — download a backup to keep it.");
    } else if (code === "too_large"){
      setStatus("error", "Too large");
      toast("The plan is too big to save. Try removing a few photos.");
    } else if (code === "rate_limited"){
      setStatus("unsaved", "Waiting");
      setTimeout(doSave, 5000);
    } else {
      setStatus("error", "Save failed");
    }
  } finally {
    saving = false;
    if (again){ again = false; scheduleSave(); }
  }
}
function setStatus(kind, text){
  const el = $("#status");
  el.dataset.s = kind;
  el.textContent = text || kind;
}

/* =============================================================
   Undo — snapshots the plan only; photos are never in the stack
   ============================================================= */
function pushUndo(){
  undoStack.push(JSON.stringify(S.plan));
  if (undoStack.length > 40) undoStack.shift();
}
function undo(){
  if (!undoStack.length){ toast("Nothing to undo."); return; }
  S.plan = JSON.parse(undoStack.pop());
  if (selectedId && !guestById(selectedId)) selectedId = null;
  commit();
  toast("Undone.");
}

/* =============================================================
   Photos — downscale hard so 120 guests stay well inside limits
   ============================================================= */
function processImage(file){
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error("not an image"));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = THUMB;
        const ctx = c.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        // Square centre crop, biased upward — faces sit high in a portrait.
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) * 0.32;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, THUMB, THUMB);
        resolve(c.toDataURL("image/jpeg", 0.8));
      } catch (e){ reject(e); }
      finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable")); };
    img.src = url;
  });
}
async function setPhotoFromFile(guestId, file){
  try {
    S.photos[guestId] = await processImage(file);
    commit();
  } catch (e){
    toast("That file isn't an image I can read.");
  }
}
/** Unambiguous filename -> guest match, used by the folder import. */
function matchByFilename(filename){
  const base = fold(filename.replace(/\.[^.]+$/, "").replace(/[_\-.+]+/g, " ").replace(/\s+/g, " "));
  if (!base) return null;
  const exact = S.plan.guests.filter(g => fold(g.name) === base);
  if (exact.length === 1) return exact[0];
  const tokens = base.split(" ").filter(Boolean);
  if (!tokens.length) return null;
  const cands = S.plan.guests.filter(g => {
    const gt = fold(g.name).split(" ").filter(Boolean);
    return tokens.every(t => gt.some(u => u === t || u.startsWith(t) || t.startsWith(u)));
  });
  return cands.length === 1 ? cands[0] : null;
}
async function importPhotoFiles(fileList){
  const files = Array.from(fileList).filter(f => /^image\//.test(f.type));
  if (!files.length) return;
  let matched = 0;
  const missed = [];
  for (const f of files){
    const g = matchByFilename(f.name);
    if (!g){ missed.push(f.name); continue; }
    try { S.photos[g.id] = await processImage(f); matched++; }
    catch (e){ missed.push(f.name); }
  }
  commit();
  if (matched && !missed.length) toast(matched + " photo" + (matched === 1 ? "" : "s") + " matched by name.");
  else if (matched) toast(matched + " matched · " + missed.length + " couldn't be matched to a name.");
  else toast("None of those filenames matched a guest. Name the files after your guests, e.g. “Ana Popescu.jpg”.");
}

/* =============================================================
   Mutations
   ============================================================= */
function addGuests(text, groupId){
  const lines = text.split(/[\r\n]+/).map(s => s.replace(/^[\s,;\-•]+|[\s,;]+$/g, "")).filter(Boolean);
  const have = new Set(S.plan.guests.map(g => fold(g.name)));
  let added = 0, dupes = 0;
  pushUndo();
  for (const name of lines){
    if (have.has(fold(name))){ dupes++; continue; }
    have.add(fold(name));
    S.plan.guests.push({ id: uid(), name, groupId: groupId || null, note: "" });
    added++;
  }
  commit();
  let msg = added + " guest" + (added === 1 ? "" : "s") + " added";
  if (dupes) msg += " · " + dupes + " already on the list";
  toast(msg + ".");
  return added;
}
function seatGuest(guestId, tableId, slot){
  const from = tableOf(guestId);
  if (from && from.id === tableId && typeof slot !== "number") return;
  pushUndo();
  S.plan.tables.forEach(t => {
    const i = t.guestIds.indexOf(guestId);
    if (i > -1) t.guestIds.splice(i, 1);
  });
  if (tableId){
    const t = tableById(tableId);
    if (!t) return;
    if (typeof slot === "number" && slot < t.guestIds.length) t.guestIds.splice(slot, 0, guestId);
    else t.guestIds.push(guestId);
  }
  commit();
}
function addTable(seats){
  pushUndo();
  const n = S.plan.tables.length + 1;
  const last = S.plan.tables[S.plan.tables.length - 1];
  S.plan.tables.push({
    id: uid(),
    name: "Table " + n,
    seats: seats || (last ? last.seats : 8),
    guestIds: []
  });
  commit();
}
function removeTable(id){
  const t = tableById(id);
  if (!t) return;
  if (t.guestIds.length && !confirm(
    "Remove " + t.name + "? Its " + t.guestIds.length +
    " guest" + (t.guestIds.length === 1 ? "" : "s") + " will go back to Not seated."
  )) return;
  pushUndo();
  S.plan.tables = S.plan.tables.filter(x => x.id !== id);
  commit();
}
function deleteGuest(id){
  const g = guestById(id);
  if (!g || !confirm("Remove " + g.name + " from the guest list?")) return;
  pushUndo();
  S.plan.guests = S.plan.guests.filter(x => x.id !== id);
  S.plan.tables.forEach(t => {
    const i = t.guestIds.indexOf(id);
    if (i > -1) t.guestIds.splice(i, 1);
  });
  delete S.photos[id];
  if (selectedId === id) selectedId = null;
  commit();
}

/* =============================================================
   Guest tiles — cached nodes, moved rather than rebuilt
   ============================================================= */
function buildTile(g){
  const el = document.createElement("div");
  el.className = "g";
  el.draggable = true;
  el.tabIndex = 0;
  el.dataset.gid = g.id;
  el.innerHTML =
    '<div class="face"><span class="ini"></span></div>' +
    '<span class="rib"></span>' +
    '<span class="nm"></span>';

  el.addEventListener("click", ev => { ev.stopPropagation(); select(g.id); });
  el.addEventListener("keydown", ev => {
    if (ev.key === "Enter" || ev.key === " "){ ev.preventDefault(); select(g.id); }
  });
  el.addEventListener("dragstart", ev => {
    dragId = g.id;
    ev.dataTransfer.setData("text/plain", "guest:" + g.id);
    ev.dataTransfer.effectAllowed = "move";
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => { dragId = null; el.classList.remove("dragging"); });

  // Dropping an image file straight onto a face sets that guest's photo.
  el.addEventListener("dragover", ev => {
    if (!hasFiles(ev)) return;
    ev.preventDefault(); ev.stopPropagation();
    ev.dataTransfer.dropEffect = "copy";
    el.classList.add("photo-drop");
  });
  el.addEventListener("dragleave", () => el.classList.remove("photo-drop"));
  el.addEventListener("drop", ev => {
    if (!hasFiles(ev)) return;
    ev.preventDefault(); ev.stopPropagation();
    el.classList.remove("photo-drop");
    setPhotoFromFile(g.id, ev.dataTransfer.files[0]);
  });
  return el;
}
function tileFor(g, size){
  let el = tiles.get(g.id);
  if (!el){ el = buildTile(g); tiles.set(g.id, el); }

  el.style.setProperty("--tile", size + "px");

  const grp = g.groupId ? groupById(g.groupId) : null;
  el.style.setProperty("--gc", grp ? grp.color : "transparent");

  const photo = S.photos[g.id] || null;
  if (el._photo !== photo){
    el._photo = photo;
    const face = el.firstElementChild;
    if (photo){
      face.innerHTML = '<img alt="" decoding="async">';
      face.firstElementChild.src = photo;
    } else {
      face.innerHTML = '<span class="ini"></span>';
      face.firstElementChild.textContent = initialsOf(g.name);
    }
  }

  const nm = el.lastElementChild;
  const label = size >= 46 ? shortName(g.name) : (g.name.split(/\s+/)[0] || g.name);
  if (nm.textContent !== label) nm.textContent = label;
  el.title = g.name + (grp ? " — " + grp.name : "");

  el.classList.toggle("sel", selectedId === g.id);
  const hit = query && fold(g.name).indexOf(fold(query)) > -1;
  el.classList.toggle("hit", !!hit && selectedId !== g.id);
  el.classList.toggle("dim", !!query && !hit);
  return el;
}

/* =============================================================
   Render
   ============================================================= */
function render(){
  $("#couple").value = S.plan.couple || "";
  renderChips();
  renderPool();
  renderTables();
  renderInspector();
  renderTally();
}

function renderTally(){
  const total = S.plan.guests.length;
  const seated = seatedIds().size;
  const seats = S.plan.tables.reduce((n, t) => n + t.seats, 0);
  $("#tally").innerHTML =
    "<b>" + seated + "</b> <span>of " + total + " seated</span>" +
    (seats ? " <span>· " + seats + " seats</span>" : "");
  $("#meter").style.width = (total ? (seated / total) * 100 : 0) + "%";
}

function renderChips(){
  const wrap = $("#chips");
  wrap.innerHTML = "";
  if (!S.plan.groups.length) return;
  S.plan.groups.forEach(gr => {
    const b = document.createElement("button");
    b.className = "chip";
    b.style.setProperty("--dot", gr.color);
    b.setAttribute("aria-pressed", groupFilter === gr.id ? "true" : "false");
    b.innerHTML = '<i></i>' + esc(gr.name);
    b.addEventListener("click", () => {
      groupFilter = groupFilter === gr.id ? null : gr.id;
      render();
    });
    wrap.appendChild(b);
  });
}

function poolGuests(){
  const seated = seatedIds();
  return S.plan.guests
    .filter(g => !seated.has(g.id))
    .filter(g => !groupFilter || g.groupId === groupFilter)
    .filter(g => !query || fold(g.name).indexOf(fold(query)) > -1)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function renderPool(){
  const pool = $("#pool");
  const list = poolGuests();
  const seated = seatedIds();
  $("#pool-count").textContent = S.plan.guests.length - seated.size;

  pool.innerHTML = "";
  if (!list.length){
    const p = document.createElement("div");
    p.className = "pool-empty";
    if (!S.plan.guests.length) p.textContent = "No guests yet. Use “Add guests” to paste your list.";
    else if (query || groupFilter) p.textContent = "Nobody here matches that.";
    else p.textContent = "Everyone has a seat. ✨";
    pool.appendChild(p);
    return;
  }
  list.forEach(g => pool.appendChild(tileFor(g, 52)));
}

function renderTables(){
  const wrap = $("#tables");
  const plan = $("#plan");
  plan.classList.toggle("compact", view === "compact");

  // First run with nothing at all: offer a setup rather than a blank grid.
  if (!S.plan.tables.length && !S.plan.guests.length){
    wrap.innerHTML = "";
    const b = document.createElement("div");
    b.className = "blank";
    b.innerHTML =
      "<h2>Let's lay the tables.</h2>" +
      "<p>Start with the room, then paste in your guest list. " +
      "Add each face as you go &mdash; a table is far easier to read when you can see who's at it.</p>" +
      '<div class="setup">' +
        '<div class="field"><label for="n-tables">Tables</label><input id="n-tables" type="number" min="1" max="60" value="12"></div>' +
        '<div class="field"><label for="n-seats">Seats each</label><input id="n-seats" type="number" min="2" max="20" value="8"></div>' +
        '<button class="btn btn-primary" id="do-setup">Lay them out</button>' +
      "</div>";
    wrap.appendChild(b);
    $("#do-setup").addEventListener("click", () => {
      const n = clamp(parseInt($("#n-tables").value, 10) || 12, 1, 60);
      const s = clamp(parseInt($("#n-seats").value, 10) || 8, 2, 20);
      pushUndo();
      for (let i = 0; i < n; i++){
        S.plan.tables.push({ id: uid(), name: "Table " + (i + 1), seats: s, guestIds: [] });
      }
      commit();
      openGuests();
    });
    return;
  }

  wrap.innerHTML = "";
  S.plan.tables.forEach(t => wrap.appendChild(tableCard(t)));

  const add = document.createElement("button");
  add.className = "add-t";
  add.innerHTML = "<span>+</span><span>Add a table</span>";
  add.addEventListener("click", () => addTable());
  wrap.appendChild(add);
}

function tableCard(t){
  const card = document.createElement("section");
  card.className = "t";
  card.dataset.tid = t.id;
  const taken = t.guestIds.length;
  if (taken === t.seats && t.seats > 0) card.classList.add("is-full");
  if (taken > t.seats) card.classList.add("is-over");
  if (selectedId) card.classList.add("armed");

  /* --- head --- */
  const head = document.createElement("div");
  head.className = "t-head";

  const name = document.createElement("input");
  name.className = "t-name";
  name.value = t.name;
  name.setAttribute("aria-label", "Table name");
  name.addEventListener("click", ev => ev.stopPropagation());
  name.addEventListener("change", () => {
    const v = name.value.trim();
    if (!v || v === t.name){ name.value = t.name; return; }
    pushUndo(); t.name = v; commit();
  });
  name.addEventListener("keydown", ev => { if (ev.key === "Enter") name.blur(); });

  const cap = document.createElement("span");
  cap.className = "t-cap";
  cap.textContent = taken + "/" + t.seats;
  cap.title = taken > t.seats ? "More guests than seats" : (t.seats - taken) + " seats free";

  const tools = document.createElement("div");
  tools.className = "t-tools";
  tools.appendChild(iconBtn("−", "One seat fewer", ev => {
    ev.stopPropagation();
    if (t.seats <= 1) return;
    pushUndo(); t.seats--; commit();
  }));
  tools.appendChild(iconBtn("+", "One seat more", ev => {
    ev.stopPropagation();
    if (t.seats >= 24) return;
    pushUndo(); t.seats++; commit();
  }));
  tools.appendChild(iconBtn("×", "Remove this table", ev => {
    ev.stopPropagation(); removeTable(t.id);
  }));

  head.append(name, cap, tools);
  card.appendChild(head);

  /* --- body --- */
  const slots = Math.max(t.seats, taken);
  if (view === "plan"){
    const size = clamp(Math.floor((2 * Math.PI * RING_R) / Math.max(slots, 1)) - 6, 28, 50);
    const box  = (RING_R + size / 2 + 6) * 2;
    const disc = document.createElement("div");
    disc.className = "disc";
    disc.style.width = disc.style.height = box + "px";

    const inner = RING_R * 2 - size - 16;
    const cloth = document.createElement("div");
    cloth.className = "cloth";
    cloth.style.width = cloth.style.height = Math.max(inner, 60) + "px";
    disc.appendChild(cloth);

    const lbl = document.createElement("div");
    lbl.className = "cloth-lbl";
    lbl.innerHTML = '<div class="n">' + esc(t.name.replace(/^Table\s+/i, "")) + "</div>" +
                    '<div class="s">' + (t.seats - taken > 0 ? (t.seats - taken) + " free" : (taken > t.seats ? "over" : "full")) + "</div>";
    disc.appendChild(lbl);

    for (let i = 0; i < slots; i++){
      const a = (-90 + (360 / slots) * i) * Math.PI / 180;
      const slot = document.createElement("div");
      slot.className = "slot";
      slot.style.left = (box / 2 + Math.cos(a) * RING_R) + "px";
      slot.style.top  = (box / 2 + Math.sin(a) * RING_R) + "px";
      slot.style.transform = "translate(-50%,-50%)";
      slot.style.setProperty("--tile", size + "px");

      const gid = t.guestIds[i];
      if (gid && guestById(gid)) slot.appendChild(tileFor(guestById(gid), size));
      else slot.appendChild(emptySeat(t, i, size));
      disc.appendChild(slot);
    }
    card.appendChild(disc);
  } else {
    const pack = document.createElement("div");
    pack.className = "pack";
    t.guestIds.forEach(gid => {
      const g = guestById(gid);
      if (g) pack.appendChild(tileFor(g, 44));
    });
    for (let i = taken; i < t.seats; i++) pack.appendChild(emptySeat(t, i, 40));
    card.appendChild(pack);
  }

  /* --- printed name list (screen-hidden) --- */
  const ul = document.createElement("ul");
  ul.className = "print-list";
  t.guestIds.forEach(gid => {
    const g = guestById(gid);
    if (!g) return;
    const li = document.createElement("li");
    li.textContent = g.name;
    ul.appendChild(li);
  });
  card.appendChild(ul);

  /* --- card as drop target / click target --- */
  card.addEventListener("click", () => {
    if (selectedId){ seatGuest(selectedId, t.id); selectedId = null; render(); }
  });
  card.addEventListener("dragover", ev => {
    if (hasFiles(ev) || !dragId) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    card.classList.add("drop-on");
  });
  card.addEventListener("dragleave", ev => {
    if (!card.contains(ev.relatedTarget)) card.classList.remove("drop-on");
  });
  card.addEventListener("drop", ev => {
    card.classList.remove("drop-on");
    const id = readGuestDrag(ev);
    if (!id) return;
    ev.preventDefault();
    seatGuest(id, t.id);
  });
  return card;
}

function emptySeat(t, index, size){
  const b = document.createElement("button");
  b.className = "empty-seat";
  b.style.setProperty("--tile", size + "px");
  b.textContent = "+";
  b.setAttribute("aria-label", "Empty seat at " + t.name);
  b.addEventListener("click", ev => {
    ev.stopPropagation();
    if (selectedId){ seatGuest(selectedId, t.id, index); selectedId = null; render(); }
    else toast("Pick a guest first, then click a seat.");
  });
  b.addEventListener("dragover", ev => {
    if (hasFiles(ev) || !dragId) return;
    ev.preventDefault(); ev.stopPropagation();
    b.classList.add("drop-on");
  });
  b.addEventListener("dragleave", () => b.classList.remove("drop-on"));
  b.addEventListener("drop", ev => {
    b.classList.remove("drop-on");
    const id = readGuestDrag(ev);
    if (!id) return;
    ev.preventDefault(); ev.stopPropagation();
    seatGuest(id, t.id, index);
  });
  return b;
}

function iconBtn(glyph, label, fn){
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = glyph;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", fn);
  return b;
}

function hasFiles(ev){
  const dt = ev.dataTransfer;
  return !!(dt && dt.types && Array.prototype.indexOf.call(dt.types, "Files") > -1);
}
function readGuestDrag(ev){
  let raw = "";
  try { raw = ev.dataTransfer.getData("text/plain") || ""; } catch (e){}
  if (raw.indexOf("guest:") === 0) return raw.slice(6);
  return dragId || null;
}

/* =============================================================
   Inspector
   ============================================================= */
function select(id){
  selectedId = (selectedId === id) ? null : id;
  render();
}

function renderInspector(){
  const box = $("#insp");
  const g = selectedId ? guestById(selectedId) : null;

  if (!g){
    box.className = "insp empty";
    box.innerHTML =
      "Click a guest to see them here — then press <kbd>Ctrl</kbd>+<kbd>V</kbd> to " +
      "drop in a photo you've copied, or click a table to seat them.";
    return;
  }

  const at = tableOf(g.id);
  const grp = g.groupId ? groupById(g.groupId) : null;
  const photo = S.photos[g.id];

  box.className = "insp";
  box.innerHTML =
    '<div class="insp-top">' +
      '<div class="insp-face"' + (grp ? ' style="--gc:' + esc(grp.color) + '"' : "") + '>' +
        (photo ? '<img alt="" src="' + esc(photo) + '">' : '<span class="ini">' + esc(initialsOf(g.name)) + "</span>") +
      "</div>" +
      '<div class="insp-fields">' +
        '<input type="text" id="i-name" value="' + esc(g.name) + '" aria-label="Guest name" spellcheck="false">' +
        '<select id="i-group" aria-label="Group"><option value="">No group</option>' +
          S.plan.groups.map(x =>
            '<option value="' + esc(x.id) + '"' + (x.id === g.groupId ? " selected" : "") + ">" + esc(x.name) + "</option>"
          ).join("") +
        "</select>" +
        '<div class="where">' + (at ? esc(at.name) : "Not seated") + "</div>" +
      "</div>" +
    "</div>" +
    '<div class="insp-acts">' +
      '<button class="btn" id="i-paste">Paste photo</button>' +
      '<button class="btn" id="i-upload">Choose file</button>' +
      (photo ? '<button class="btn" id="i-clear">Remove photo</button>' : "") +
      (at ? '<button class="btn" id="i-unseat">Unseat</button>' : "") +
      '<button class="btn btn-danger" id="i-del">Delete</button>' +
    "</div>";

  $("#i-name", box).addEventListener("change", ev => {
    const v = ev.target.value.trim();
    if (!v || v === g.name) return;
    pushUndo(); g.name = v; commit();
  });
  $("#i-group", box).addEventListener("change", ev => {
    pushUndo(); g.groupId = ev.target.value || null; commit();
  });
  $("#i-paste", box).addEventListener("click", () => pasteFromClipboard(g.id));
  $("#i-upload", box).addEventListener("click", () => {
    const inp = $("#file-photo");
    inp.onchange = () => {
      if (inp.files && inp.files[0]) setPhotoFromFile(g.id, inp.files[0]);
      inp.value = "";
    };
    inp.click();
  });
  const clr = $("#i-clear", box);
  if (clr) clr.addEventListener("click", () => { pushUndo(); delete S.photos[g.id]; commit(); });
  const uns = $("#i-unseat", box);
  if (uns) uns.addEventListener("click", () => seatGuest(g.id, null));
  $("#i-del", box).addEventListener("click", () => deleteGuest(g.id));
}

async function pasteFromClipboard(guestId){
  if (!navigator.clipboard || !navigator.clipboard.read){
    toast("Click the guest, then press Ctrl+V to paste a copied photo.");
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const it of items){
      const type = it.types.find(t => t.indexOf("image/") === 0);
      if (!type) continue;
      const blob = await it.getType(type);
      await setPhotoFromFile(guestId, new File([blob], "pasted.png", { type }));
      return;
    }
    toast("There's no image on your clipboard right now.");
  } catch (e){
    toast("Your browser wouldn't hand over the clipboard. Press Ctrl+V instead.");
  }
}

/* =============================================================
   Dialogs
   ============================================================= */
function openGuests(){
  const sel = $("#guest-group");
  sel.innerHTML = '<option value="">No group</option>' +
    S.plan.groups.map(g => '<option value="' + esc(g.id) + '">' + esc(g.name) + "</option>").join("");
  $("#guest-names").value = "";
  $("#guest-note").textContent = "";
  $("#dlg-guests").showModal();
  setTimeout(() => $("#guest-names").focus(), 30);
}
$("#guest-names").addEventListener("input", ev => {
  const n = ev.target.value.split(/[\r\n]+/).filter(s => s.trim()).length;
  $("#guest-note").textContent = n ? n + " name" + (n === 1 ? "" : "s") : "";
});
$("#guest-save").addEventListener("click", () => {
  const txt = $("#guest-names").value;
  if (!txt.trim()){ $("#dlg-guests").close(); return; }
  addGuests(txt, $("#guest-group").value || null);
  $("#dlg-guests").close();
});

function openGroups(){
  const body = $("#groups-body");
  const draw = () => {
    body.innerHTML = "";
    S.plan.groups.forEach(gr => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:7px";
      row.innerHTML =
        '<input type="color" value="' + esc(gr.color) + '" aria-label="Colour" ' +
          'style="width:30px;height:30px;padding:0;border:1px solid var(--rule);border-radius:3px;background:none;cursor:pointer">' +
        '<input type="text" value="' + esc(gr.name) + '" aria-label="Group name" ' +
          'style="flex:1;padding:6px 8px;background:var(--surface-2);border:1px solid var(--rule);border-radius:3px">' +
        '<button class="btn btn-danger" style="padding:5px 9px">Remove</button>';
      const [color, nameI, del] = row.children;
      color.addEventListener("change", () => { pushUndo(); gr.color = color.value; commit(); });
      nameI.addEventListener("change", () => {
        const v = nameI.value.trim();
        if (!v) { nameI.value = gr.name; return; }
        pushUndo(); gr.name = v; commit();
      });
      del.addEventListener("click", () => {
        pushUndo();
        S.plan.groups = S.plan.groups.filter(x => x.id !== gr.id);
        S.plan.guests.forEach(g => { if (g.groupId === gr.id) g.groupId = null; });
        if (groupFilter === gr.id) groupFilter = null;
        commit(); draw();
      });
      body.appendChild(row);
    });
  };
  draw();
  $("#group-add").onclick = () => {
    pushUndo();
    S.plan.groups.push({
      id: uid(),
      name: "New group",
      color: GROUP_COLORS[S.plan.groups.length % GROUP_COLORS.length]
    });
    commit(); draw();
  };
  $("#dlg-groups").showModal();
}

$$("[data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));

/* =============================================================
   Export / import
   ============================================================= */
function planCSV(){
  const rows = [["Table", "Seat", "Guest", "Group"]];
  S.plan.tables.forEach(t => {
    t.guestIds.forEach((gid, i) => {
      const g = guestById(gid);
      if (!g) return;
      const gr = g.groupId ? groupById(g.groupId) : null;
      rows.push([t.name, String(i + 1), g.name, gr ? gr.name : ""]);
    });
  });
  const seated = seatedIds();
  S.plan.guests.filter(g => !seated.has(g.id)).forEach(g => {
    const gr = g.groupId ? groupById(g.groupId) : null;
    rows.push(["Not seated", "", g.name, gr ? gr.name : ""]);
  });
  return rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(",")).join("\r\n");
}

async function offerFile(filename, data, fallbackName){
  if (!downloadsNS){
    toast("Downloads aren't available in this view.");
    return;
  }
  try {
    await downloadsNS.save({ filename, data });
    toast("Saved.");
  } catch (err){
    const code = (err && err.code) || "unavailable";
    if (code === "extension_not_enabled" && fallbackName){
      return offerFile(fallbackName, data, null);
    }
    if (code === "declined") return;
    if (code === "too_large") toast("That file is too big to download.");
    else toast("Couldn't save that file.");
  }
}

function restoreFrom(obj){
  if (!obj || !obj.plan || !Array.isArray(obj.plan.guests)) throw new Error("bad");
  pushUndo();
  S = {
    plan: Object.assign({ v: 1, updatedAt: 0, couple: "Our wedding", guests: [], tables: [], groups: [] }, obj.plan),
    photos: obj.photos && typeof obj.photos === "object" ? obj.photos : {}
  };
  S.plan.tables.forEach(t => { if (!Array.isArray(t.guestIds)) t.guestIds = []; });
  tiles.clear();
  selectedId = null;
  commit();
}

/* =============================================================
   Wiring
   ============================================================= */
$("#add-guests").addEventListener("click", openGuests);
$("#m-table").addEventListener("click", () => { closeMenu(); addTable(); });
$("#m-groups").addEventListener("click", () => { closeMenu(); openGroups(); });
$("#m-print").addEventListener("click", () => { closeMenu(); setTimeout(() => window.print(), 60); });
$("#m-photos").addEventListener("click", () => {
  closeMenu();
  const inp = $("#file-photos");
  inp.onchange = () => { if (inp.files && inp.files.length) importPhotoFiles(inp.files); inp.value = ""; };
  inp.click();
});
$("#m-export").addEventListener("click", () => {
  closeMenu();
  offerFile("placecard-backup.json", JSON.stringify(S));
});
$("#m-csv").addEventListener("click", () => {
  closeMenu();
  offerFile("seating-plan.csv", planCSV(), "seating-plan.txt");
});
$("#m-import").addEventListener("click", () => {
  closeMenu();
  const inp = $("#file-json");
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    inp.value = "";
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try { restoreFrom(JSON.parse(r.result)); toast("Backup restored."); }
      catch (e){ toast("That doesn't look like a Placecard backup."); }
    };
    r.readAsText(f);
  };
  inp.click();
});
$("#m-reset").addEventListener("click", () => {
  closeMenu();
  if (!confirm("Clear every guest, table and photo and start over? Download a backup first if you're unsure.")) return;
  pushUndo();
  S = blank();
  tiles.clear();
  selectedId = null;
  commit();
});
function closeMenu(){ const d = $("details.menu"); if (d) d.open = false; }
document.addEventListener("click", ev => {
  const d = $("details.menu");
  if (d && d.open && !d.contains(ev.target)) d.open = false;
});

$("#q").addEventListener("input", ev => { query = ev.target.value; render(); });
$("#couple").addEventListener("change", ev => {
  const v = ev.target.value.trim() || "Our wedding";
  if (v === S.plan.couple) return;
  pushUndo(); S.plan.couple = v; commit();
});
$("#v-plan").addEventListener("click", () => setView("plan"));
$("#v-compact").addEventListener("click", () => setView("compact"));
function setView(v){
  view = v;
  $("#v-plan").setAttribute("aria-pressed", String(v === "plan"));
  $("#v-compact").setAttribute("aria-pressed", String(v === "compact"));
  try { localStorage.setItem(LS_KEY + ".view", v); } catch (e){}
  render();
}

/* pool as a drop target: guests come back, photo files bulk-import */
const pool = $("#pool");
pool.addEventListener("dragover", ev => {
  ev.preventDefault();
  ev.dataTransfer.dropEffect = hasFiles(ev) ? "copy" : "move";
  pool.classList.add("drop-on");
});
pool.addEventListener("dragleave", ev => {
  if (!pool.contains(ev.relatedTarget)) pool.classList.remove("drop-on");
});
pool.addEventListener("drop", ev => {
  ev.preventDefault();
  pool.classList.remove("drop-on");
  if (hasFiles(ev)) return importPhotoFiles(ev.dataTransfer.files);
  const id = readGuestDrag(ev);
  if (id) seatGuest(id, null);
});
$("#plan").addEventListener("click", ev => {
  if (ev.target === ev.currentTarget || ev.target.id === "tables"){
    if (selectedId){ selectedId = null; render(); }
  }
});

/* paste an image straight onto the selected guest */
document.addEventListener("paste", async ev => {
  if (!selectedId) return;
  const items = ev.clipboardData && ev.clipboardData.items;
  if (!items) return;
  for (const it of items){
    if (it.type && it.type.indexOf("image/") === 0){
      ev.preventDefault();
      const f = it.getAsFile();
      if (f) await setPhotoFromFile(selectedId, f);
      return;
    }
  }
});

document.addEventListener("keydown", ev => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName) || ev.target.isContentEditable;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z" && !ev.shiftKey){
    if (typing) return;
    ev.preventDefault(); undo(); return;
  }
  if (ev.key === "Escape" && selectedId && !$("dialog[open]")){ selectedId = null; render(); return; }
  if (typing) return;
  if (ev.key === "/" ){ ev.preventDefault(); $("#q").focus(); }
});

let toastTimer = null;
function toast(msg){
  const box = $("#toasts");
  box.innerHTML = '<div class="toast">' + esc(msg) + "</div>";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.innerHTML = ""; }, 4200);
}

/* =============================================================
   Boot
   ============================================================= */
async function use(name){
  try {
    return (window.claude && typeof window.claude.use === "function")
      ? await window.claude.use(name) : null;
  } catch (e){ return null; }
}

async function boot(){
  const local = readLocal();

  let remote = null;
  try {
    const res = await fetch(DATA_PATH, { cache: "no-store" });
    if (res.ok){
      const parsed = await res.json();
      if (parsed && parsed.plan && Array.isArray(parsed.plan.guests)) remote = parsed;
    }
  } catch (e){ /* no data file yet, or the host served the shell — fine */ }

  const lu = local  ? (local.plan.updatedAt  || 0) : -1;
  const ru = remote ? (remote.plan.updatedAt || 0) : -1;
  S = (ru >= lu ? remote : local) || blank();
  if (!S.photos) S.photos = {};
  S.plan.tables.forEach(t => { if (!Array.isArray(t.guestIds)) t.guestIds = []; });

  try {
    const v = localStorage.getItem(LS_KEY + ".view");
    if (v === "compact") view = "compact";
  } catch (e){}
  $("#v-plan").setAttribute("aria-pressed", String(view === "plan"));
  $("#v-compact").setAttribute("aria-pressed", String(view === "compact"));

  setStatus("idle", "This device only");
  render();

  // Capabilities arrive later — light the shared save up when they do.
  artifactNS  = await use("artifact");
  downloadsNS = await use("downloads");
  if (artifactNS){
    setStatus("saved", remote ? "Saved" : "Ready");
    // If local was ahead of the published file, push it up straight away.
    if (lu > ru) scheduleSave();
  }
}

boot();
})();
