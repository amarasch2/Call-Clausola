// Flusso call — editor del discorso con salvataggio condiviso su Firebase Firestore.
// Non serve modificare questo file: la configurazione va in firebase-config.js.
import { firebaseConfig } from './firebase-config.js';

const FIREBASE_VERSION = '10.12.2';
const KIND = { passaggio: 'Passaggio', bivio: 'Bivio', chiusura: 'Chiusura' };
const NEWTITLE = { passaggio: 'Nuovo passaggio', bivio: 'Nuovo bivio', chiusura: 'Chiusura' };

// Più flussi con lo stesso sito: indirizzo#nome (es. .../flusso-call/#rinnovo). Senza #, si usa "principale".
const FLOW_ID = (decodeURIComponent(location.hash.slice(1)) || 'principale').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'principale';
window.addEventListener('hashchange', () => location.reload());

const EXAMPLE = normalize(JSON.parse(document.getElementById('flow-data').textContent));
const DRAFT_KEY = 'flusso-call-bozza:' + FLOW_ID;
const NAME_KEY = 'flusso-call-nome';

let flow = clone(EXAMPLE);
let pubCanon = JSON.stringify(flow);   // ultima versione condivisa conosciuta
let baseVersion = 0;                    // numero di versione su cui stiamo lavorando
let lastAuthor = '', lastAt = null;
let conn = 'connecting';                // local | connecting | online | error
let fb = null, firstRemote = true, connTimer = null;
let saving = false, savingJSON = null, remotePending = null;
let sel = null, zoom = 1, act = null, editing = false;
const undoStack = [], redoStack = [];

const $ = s => document.querySelector(s);
const els = {
  canvas: $('#canvas'), sizer: $('#sizer'), world: $('#world'), svg: $('#edges'), nodes: $('#nodes'), labels: $('#labels'), panel: $('#panel'),
  status: $('#save-status'), save: $('#btn-save'), zoomVal: $('#zoom-val'), name: $('#flow-name'),
  banner: $('#draft-banner'), conflict: $('#conflict-banner'), toast: $('#toast')
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function normalize(d) {
  if (!d || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new Error('formato non valido');
  d.nodes.forEach(n => { if (!KIND[n.type]) n.type = 'passaggio'; n.x = +n.x || 40; n.y = +n.y || 40; n.title = n.title || ''; n.text = n.text || ''; n.note = n.note || ''; });
  const ids = new Set(d.nodes.map(n => n.id));
  d.edges = d.edges.filter(e => ids.has(e.from) && ids.has(e.to) && e.from !== e.to).map(e => ({ id: e.id, from: e.from, to: e.to, label: e.label || '' }));
  let max = 0; d.nodes.concat(d.edges).forEach(o => { const m = /(\d+)$/.exec(o.id || ''); if (m) max = Math.max(max, +m[1]); });
  d.nextId = Math.max(+d.nextId || 0, max + 1);
  d.name = d.name || 'Flusso call';
  if (!ids.has(d.start)) d.start = d.nodes[0] ? d.nodes[0].id : null;
  return d;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function ph(s) { return s.replace(/\[([^\]\n]{1,120})\]/g, '<mark class="ph">[$1]</mark>'); }
function rich(s) { return ph(esc(s)).replace(/\n/g, '<br>'); }
function byId(id) { return flow.nodes.find(n => n.id === id) || null; }
function edgeById(id) { return flow.edges.find(e => e.id === id) || null; }
function outsOf(id) { return flow.edges.filter(e => e.from === id && byId(e.to)); }
function snap(v) { return Math.max(20, Math.round(v / 10) * 10); }
function isSel(k, id) { return !!(sel && sel.kind === k && sel.id === id); }
function fmtTime(d) { return d ? d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) + ' alle ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : ''; }
function getName() { try { return (localStorage.getItem(NAME_KEY) || '').slice(0, 60); } catch (e) { return ''; } }

let toastT;
function toast(msg) { els.toast.textContent = msg; els.toast.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { els.toast.hidden = true; }, 3600); }

function order() {
  const map = new Map(), q = []; let n = 1;
  if (byId(flow.start)) q.push(flow.start);
  while (q.length) { const id = q.shift(); if (map.has(id)) continue; map.set(id, n++); outsOf(id).forEach(e => { if (!map.has(e.to)) q.push(e.to); }); }
  flow.nodes.forEach(nd => { if (!map.has(nd.id)) map.set(nd.id, n++); });
  return map;
}
function reachable() { const seen = new Set(), q = byId(flow.start) ? [flow.start] : []; while (q.length) { const id = q.shift(); if (seen.has(id)) continue; seen.add(id); outsOf(id).forEach(e => q.push(e.to)); } return seen; }

/* ---------- cronologia annulla/ripeti ---------- */
function snapshot() { undoStack.push(JSON.stringify(flow)); if (undoStack.length > 80) undoStack.shift(); redoStack.length = 0; updateUndo(); }
function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(flow)); flow = JSON.parse(undoStack.pop()); afterHistory(); }
function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(flow)); flow = JSON.parse(redoStack.pop()); afterHistory(); }
function afterHistory() { validateSel(); renderAll(); changed(); updateUndo(); }
function validateSel() { if (sel && !(sel.kind === 'node' ? byId(sel.id) : edgeById(sel.id))) sel = null; }
function updateUndo() { $('#btn-undo').disabled = !undoStack.length; $('#btn-redo').disabled = !redoStack.length; }

/* ---------- bozza locale + stato ---------- */
let draftT;
function isDirty() { return JSON.stringify(flow) !== pubCanon; }
function changed() { clearTimeout(draftT); draftT = setTimeout(writeDraft, 400); updateStatus(); els.name.textContent = flow.name || 'Senza nome'; document.title = (flow.name || 'Flusso call'); }
function writeDraft() { try { if (isDirty()) localStorage.setItem(DRAFT_KEY, JSON.stringify({ base: baseVersion, at: Date.now(), data: flow })); else localStorage.removeItem(DRAFT_KEY); } catch (e) { } }
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { } }
function updateStatus() {
  const d = isDirty(); let t, c = '', title = '';
  if (conn === 'local') { t = 'Database non configurato'; c = 'warn'; title = 'Compila firebase-config.js seguendo la GUIDA. Intanto le modifiche restano in questo browser.'; }
  else if (conn === 'connecting') { t = 'Connessione…'; }
  else if (conn === 'error') { t = 'Non connesso · modifiche solo in questo browser'; c = 'warn'; }
  else if (saving) { t = 'Salvataggio…'; }
  else if (baseVersion === 0) { t = 'Non ancora pubblicato'; c = 'warn'; title = 'Premi Pubblica per salvare il flusso nel database condiviso.'; }
  else if (d) { t = 'Modifiche non salvate'; c = 'warn'; }
  else { t = 'Salvato · v' + baseVersion; c = 'ok'; title = lastAuthor || lastAt ? 'Ultimo salvataggio' + (lastAuthor ? ' di ' + lastAuthor : '') + (lastAt ? ' il ' + fmtTime(lastAt) : '') : ''; }
  els.status.textContent = t; els.status.className = 'status ' + c; els.status.title = title;
  els.save.textContent = baseVersion === 0 ? 'Pubblica' : 'Salva';
  els.save.hidden = conn === 'local';
  els.save.disabled = conn !== 'online' || saving || !!remotePending || (!d && baseVersion !== 0);
}

/* ---------- Firebase ---------- */
async function connect() {
  const cfg = firebaseConfig || {};
  if (!cfg.projectId || /INSERISCI/i.test(cfg.projectId)) { conn = 'local'; els.canvas.classList.remove('loading'); handleDraft(); renderAll(); changed(); return; }
  connTimer = setTimeout(() => { if (firstRemote) { conn = 'error'; els.canvas.classList.remove('loading'); updateStatus(); toast('Il database non risponde: controlla la connessione o la configurazione.'); } }, 10000);
  try {
    const [{ initializeApp }, F] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`)
    ]);
    const app = initializeApp(cfg);
    const db = F.getFirestore(app);
    fb = { F, db, mainRef: F.doc(db, 'flows', FLOW_ID), histCol: F.collection(db, 'flows', FLOW_ID, 'history') };
    F.onSnapshot(fb.mainRef, onRemote, err => {
      clearTimeout(connTimer); conn = 'error'; els.canvas.classList.remove('loading'); updateStatus();
      toast(err && err.code === 'permission-denied' ? 'Il database rifiuta la lettura: controlla le regole (vedi GUIDA).' : 'Connessione al database persa. Ricarica la pagina.');
    });
  } catch (e) {
    clearTimeout(connTimer); conn = 'error'; els.canvas.classList.remove('loading'); updateStatus();
    toast('Impossibile collegarsi a Firebase. Controlla firebase-config.js.');
  }
}
function applyRemote(d) {
  try { flow = normalize(JSON.parse(d.data)); } catch (e) { flow = clone(EXAMPLE); }
  pubCanon = JSON.stringify(flow);
  lastAuthor = d.author || '';
  lastAt = d.updatedAt && d.updatedAt.toDate ? d.updatedAt.toDate() : null;
}
function onRemote(s) {
  clearTimeout(connTimer);
  const exists = s.exists(), d = exists ? s.data() : null, v = exists ? (d.version || 0) : 0;
  if (firstRemote) {
    firstRemote = false; conn = 'online'; els.canvas.classList.remove('loading');
    baseVersion = v;
    if (exists) applyRemote(d); else pubCanon = JSON.stringify(EXAMPLE);
    handleDraft(); sel = null; renderAll(); changed(); initialFit();
    return;
  }
  conn = 'online';
  if (s.metadata && s.metadata.hasPendingWrites) return;
  if (saving && exists && d.data === savingJSON) return;   // è il nostro salvataggio
  if (v <= baseVersion) { if (exists && v === baseVersion) { lastAuthor = d.author || lastAuthor; lastAt = d.updatedAt && d.updatedAt.toDate ? d.updatedAt.toDate() : lastAt; } updateStatus(); return; }
  if (!isDirty()) {
    baseVersion = v; applyRemote(d); validateSel(); renderAll(); changed();
    toast((d.author || 'Un collega') + ' ha aggiornato il flusso');
  } else {
    remotePending = { v, json: d.data, author: d.author || '' }; showConflict();
  }
}
async function save() {
  if (!fb || conn !== 'online' || saving || remotePending) return;
  if (!isDirty() && baseVersion !== 0) return;
  const { F, db, mainRef, histCol } = fb;
  const json = JSON.stringify(flow), author = getName();
  saving = true; savingJSON = json; updateStatus();
  try {
    const nv = await F.runTransaction(db, async tx => {
      const s = await tx.get(mainRef);
      const rv = s.exists() ? (s.data().version || 0) : 0;
      if (rv !== baseVersion) { const e = new Error('conflict'); e.code = 'flow-conflict'; e.rv = rv; e.remote = s.data(); throw e; }
      const v = rv + 1;
      const rec = { data: json, version: v, updatedAt: F.serverTimestamp() };
      const h = { data: json, version: v, savedAt: F.serverTimestamp() };
      if (author) { rec.author = author; h.author = author; }
      tx.set(mainRef, rec);
      tx.set(F.doc(histCol), h);
      return v;
    });
    baseVersion = nv; pubCanon = json; lastAuthor = author; lastAt = new Date(); clearDraft();
    toast(nv === 1 ? 'Flusso pubblicato: ora chi ha il link vede questa versione' : 'Salvato per tutti (v' + nv + ')');
  } catch (e) {
    if (e && e.code === 'flow-conflict') { remotePending = { v: e.rv, json: e.remote && e.remote.data, author: (e.remote && e.remote.author) || '' }; showConflict(); }
    else if (e && e.code === 'permission-denied') toast('Il database ha rifiutato il salvataggio. Controlla le regole di sicurezza (vedi GUIDA).');
    else toast('Salvataggio non riuscito: controlla la connessione e riprova. Le modifiche restano in questo browser.');
    writeDraft();
  } finally { saving = false; savingJSON = null; updateStatus(); }
}
function showConflict() {
  $('#conflict-msg').textContent = (remotePending.author || 'Un collega') + ' ha salvato una nuova versione (v' + remotePending.v + ') mentre modificavi. Scegli quale tenere.';
  els.conflict.hidden = false; updateStatus();
}
$('#conflict-load').onclick = () => {
  if (!remotePending) return; snapshot();
  baseVersion = remotePending.v; applyRemote({ data: remotePending.json, author: remotePending.author });
  remotePending = null; els.conflict.hidden = true; clearDraft(); validateSel(); renderAll(); changed();
  toast('Caricata la versione più recente. Con Annulla (↶) puoi recuperare la tua.');
};
$('#conflict-overwrite').onclick = () => {
  if (!remotePending) return;
  baseVersion = remotePending.v;
  try { pubCanon = JSON.stringify(normalize(JSON.parse(remotePending.json))); } catch (e) { pubCanon = ''; }
  remotePending = null; els.conflict.hidden = true; updateStatus(); save();
};
function handleDraft() {
  let d = null; try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { d = null; }
  if (!d || !d.data) return;
  let data; try { data = normalize(d.data); } catch (e) { clearDraft(); return; }
  if (JSON.stringify(data) === pubCanon) { clearDraft(); return; }
  if (d.base === baseVersion) { flow = data; setTimeout(() => toast('Ho ripristinato le modifiche non salvate di questo browser.'), 300); return; }
  const when = new Date(d.at || Date.now());
  $('#draft-msg').textContent = 'In questo browser ci sono modifiche non salvate del ' + fmtTime(when) + ', fatte su una versione precedente.';
  els.banner.hidden = false;
  $('#draft-restore').onclick = () => { snapshot(); flow = data; sel = null; els.banner.hidden = true; renderAll(); changed(); };
  $('#draft-discard').onclick = () => { clearDraft(); els.banner.hidden = true; };
}
async function loadHistory() {
  const box = $('#hist-list'); if (!box || !fb) return;
  box.innerHTML = '<li><span class="muted">Caricamento…</span></li>';
  try {
    const { F, histCol } = fb;
    const res = await F.getDocs(F.query(histCol, F.orderBy('savedAt', 'desc'), F.limit(30)));
    const rows = []; res.forEach(s => rows.push(s.data()));
    histRows = rows;
    box.innerHTML = rows.length ? rows.map((r, i) => {
      const t = r.savedAt && r.savedAt.toDate ? fmtTime(r.savedAt.toDate()) : '';
      return '<li><span><span class="v">v' + (r.version || '?') + '</span>' + esc(r.author || 'Anonimo') + (t ? ' · ' + t : '') + '</span><button class="btn btn-outline btn-small" data-restore="' + i + '">Apri</button></li>';
    }).join('') : '<li><span class="muted">Nessun salvataggio ancora.</span></li>';
  } catch (e) { box.innerHTML = '<li><span class="muted">Impossibile leggere la cronologia.</span></li>'; }
}
let histRows = [];

/* ---------- disegno ---------- */
function sizeWorld() {
  let W = 1600, H = 1200;
  flow.nodes.forEach(n => { W = Math.max(W, n.x + 230 + 500); H = Math.max(H, n.y + 200 + 400); });
  els.world.style.width = W + 'px'; els.world.style.height = H + 'px'; els.world.style.transform = 'scale(' + zoom + ')';
  els.svg.setAttribute('width', W); els.svg.setAttribute('height', H);
  els.sizer.style.width = (W * zoom) + 'px'; els.sizer.style.height = (H * zoom) + 'px';
  els.zoomVal.textContent = Math.round(zoom * 100) + '%';
}
function renderNodes() {
  const num = order();
  els.nodes.innerHTML = flow.nodes.map(n =>
    '<div class="node t-' + n.type + (isSel('node', n.id) ? ' is-sel' : '') + '" data-id="' + esc(n.id) + '" style="left:' + n.x + 'px;top:' + n.y + 'px" tabindex="0" role="button" aria-label="' + esc('§' + num.get(n.id) + ' ' + n.title) + '">' +
    '<div class="node-head"><span class="node-num">§' + num.get(n.id) + '</span><span class="node-kind">' + KIND[n.type] + '</span>' + (n.id === flow.start ? '<span class="node-start">Inizio</span>' : '') + '</div>' +
    '<div class="node-title">' + (esc(n.title) || '<span class="muted">Senza titolo</span>') + '</div>' +
    (n.text ? '<div class="node-text">' + ph(esc(n.text)) + '</div>' : '<div class="node-text">Scrivi cosa dire…</div>') +
    '<span class="port" data-port title="Trascina su un altro blocco per creare una freccia"></span></div>').join('');
  sizeWorld();
}
function rects() { const r = {}; els.nodes.querySelectorAll('.node').forEach(el => { const n = byId(el.dataset.id); if (n) r[n.id] = { x: n.x, y: n.y, w: el.offsetWidth, h: el.offsetHeight }; }); return r; }
function clip(r, tx, ty) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2; let dx = tx - cx, dy = ty - cy; if (!dx && !dy) dy = 1;
  const t = Math.min(dx ? (r.w / 2) / Math.abs(dx) : Infinity, dy ? (r.h / 2) / Math.abs(dy) : Infinity), len = Math.hypot(dx, dy);
  return { x: cx + dx * (t + 6 / len), y: cy + dy * (t + 6 / len) };
}
function geom(e, R) {
  const a = R[e.from], b = R[e.to]; if (!a || !b) return null;
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const pair = flow.edges.some(o => o.from === e.to && o.to === e.from);
  const dx = bc.x - ac.x, dy = bc.y - ac.y, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, off = pair ? 38 : 0;
  const mid = { x: (ac.x + bc.x) / 2 + nx * off, y: (ac.y + bc.y) / 2 + ny * off };
  const p1 = clip(a, mid.x, mid.y), p2 = clip(b, mid.x, mid.y);
  const c = { x: (p1.x + p2.x) / 2 + nx * off, y: (p1.y + p2.y) / 2 + ny * off };
  return {
    d: 'M' + p1.x.toFixed(1) + ',' + p1.y.toFixed(1) + ' Q' + c.x.toFixed(1) + ',' + c.y.toFixed(1) + ' ' + p2.x.toFixed(1) + ',' + p2.y.toFixed(1),
    lab: { x: .25 * p1.x + .5 * c.x + .25 * p2.x, y: .25 * p1.y + .5 * c.y + .25 * p2.y }
  };
}
const DEFS = '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="arrowhead" d="M0,0L10,5L0,10z"/></marker><marker id="arr-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead sel" d="M0,0L10,5L0,10z"/></marker></defs>';
function renderEdges() {
  const R = rects(); let paths = '', labels = '';
  flow.edges.forEach(e => {
    const g = geom(e, R); if (!g) return; const s = isSel('edge', e.id);
    paths += '<path class="edge' + (s ? ' is-sel' : '') + '" d="' + g.d + '" marker-end="url(#' + (s ? 'arr-sel' : 'arr') + ')"/><path class="edge-hit" data-edge="' + esc(e.id) + '" d="' + g.d + '"/>';
    if (e.label) labels += '<button class="edge-label' + (s ? ' is-sel' : '') + '" data-edge="' + esc(e.id) + '" style="left:' + g.lab.x.toFixed(1) + 'px;top:' + g.lab.y.toFixed(1) + 'px">' + esc(e.label) + '</button>';
  });
  els.svg.innerHTML = DEFS + paths + '<path id="temp-line" class="edge temp" d=""/>';
  els.labels.innerHTML = labels;
}
function markSel() { els.nodes.querySelectorAll('.node').forEach(el => el.classList.toggle('is-sel', isSel('node', el.dataset.id))); }
function renderAll() { renderNodes(); renderEdges(); renderPanel(); }
function select(kind, id) { sel = kind ? { kind, id } : null; markSel(); renderEdges(); renderPanel(); }

/* ---------- pannello ---------- */
function checks() {
  const out = [], reach = reachable();
  flow.nodes.forEach(n => {
    const o = outsOf(n.id).length;
    if (!reach.has(n.id)) out.push({ id: n.id, msg: 'non si raggiunge dall’inizio' });
    else if (n.type !== 'chiusura' && !o) out.push({ id: n.id, msg: 'non ha frecce in uscita: il discorso si interrompe qui' });
    else if (n.type === 'bivio' && o < 2) out.push({ id: n.id, msg: 'è un bivio con una sola uscita' });
    if (n.type === 'bivio' && outsOf(n.id).some(e => !e.label)) out.push({ id: n.id, msg: 'ha una freccia senza etichetta' });
  });
  return out;
}
function renderPanel() {
  if (sel && sel.kind === 'node' && byId(sel.id)) return panelNode(byId(sel.id));
  if (sel && sel.kind === 'edge' && edgeById(sel.id)) return panelEdge(edgeById(sel.id));
  sel = null; panelOverview();
}
function panelOverview() {
  const num = order(), iss = checks();
  els.panel.innerHTML = '<div class="panel-head"><div><span class="eyebrow">Panoramica</span><h2>Il tuo discorso</h2></div></div>' +
    '<label class="field"><span>Nome della call</span><input id="f-name" type="text"></label>' +
    '<label class="field"><span>Il tuo nome</span><input id="f-author" type="text" data-nohist maxlength="60" placeholder="Compare nella cronologia dei salvataggi"></label>' +
    '<div class="stats"><div><b>' + flow.nodes.length + '</b><span>blocchi</span></div><div><b>' + flow.edges.length + '</b><span>frecce</span></div><div><b>' + flow.nodes.filter(n => n.type === 'bivio').length + '</b><span>bivi</span></div></div>' +
    '<section><h3>Controlli</h3>' + (!flow.nodes.length ? '<p class="hint">Aggiungi il primo blocco dalla barra in alto.</p>' :
      iss.length ? '<ul class="issues">' + iss.map(i => '<li><button class="link" data-goto="' + esc(i.id) + '">§' + num.get(i.id) + ' ' + esc(byId(i.id).title || 'Senza titolo') + '</button> ' + i.msg + '</li>').join('') + '</ul>' : '<p class="ok-line">Ogni percorso arriva a una chiusura.</p>') + '</section>' +
    (fb && conn === 'online' ? '<section><h3>Versioni salvate</h3><p class="hint">Ogni salvataggio resta conservato. Apri una versione precedente e premi Salva per farla tornare quella di tutti.</p><div class="row" style="margin-top:8px"><button class="btn btn-outline btn-small" data-act="history">Mostra cronologia</button></div><ul id="hist-list" class="hist"></ul></section>' : '') +
    '<section><h3>Come si usa</h3><ol class="howto">' +
    '<li>Clicca un blocco per scrivere cosa dici in quel passaggio.</li>' +
    '<li>Per creare una freccia, trascina il pallino in fondo a un blocco fino a un altro blocco. Se lo lasci su uno spazio vuoto, nasce un nuovo blocco già collegato.</li>' +
    '<li>Clicca una freccia per scriverne l’etichetta, ad esempio “Accetta” o “Ha dubbi”.</li>' +
    '<li>Usa i bivi per le reazioni dell’interlocutore: ogni freccia in uscita è una possibile risposta.</li>' +
    '<li>Con “Prova la call” segui il discorso un blocco alla volta.</li>' +
    '<li>Premi Salva (o Ctrl+S): la versione salvata è quella che vedono tutti.</li></ol></section>' +
    '<details class="backup"><summary>Backup del flusso</summary><p class="hint">Copia il testo per conservarne una copia, oppure incolla un backup e premi Carica.</p>' +
    '<textarea id="backup-text" rows="5" data-nohist aria-label="Backup in formato testo"></textarea><div class="row"><button class="btn btn-outline btn-small" data-act="copy-json">Copia backup</button><button class="btn btn-outline btn-small" data-act="load-json">Carica backup</button></div></details>';
  $('#f-name').value = flow.name || '';
  $('#f-author').value = getName();
}
function panelNode(n) {
  const num = order(), outs = outsOf(n.id), ins = flow.edges.filter(e => e.to === n.id && byId(e.from));
  const targets = flow.nodes.filter(o => o.id !== n.id && !outs.some(e => e.to === o.id)).sort((a, b) => num.get(a.id) - num.get(b.id));
  els.panel.innerHTML = '<div class="panel-head"><div><span class="eyebrow">Blocco §' + num.get(n.id) + (n.id === flow.start ? ' · inizio' : '') + '</span><h2>' + (esc(n.title) || 'Senza titolo') + '</h2></div><button class="btn btn-small btn-outline" data-act="deselect">Chiudi</button></div>' +
    '<label class="field"><span>Tipo</span><select id="f-type">' + Object.keys(KIND).map(k => '<option value="' + k + '"' + (n.type === k ? ' selected' : '') + '>' + KIND[k] + '</option>').join('') + '</select></label>' +
    '<label class="field"><span>Titolo</span><input id="f-title" type="text"></label>' +
    '<label class="field"><span>Cosa dico</span><textarea id="f-text" rows="7" placeholder="Il testo che pronunci in questo passaggio"></textarea></label>' +
    '<p class="hint">Metti tra [parentesi quadre] le parti da completare: vengono evidenziate.</p>' +
    '<label class="field"><span>Note per me</span><textarea id="f-note" rows="3" placeholder="Dati da avere sottomano, cosa evitare di dire"></textarea></label>' +
    '<section><h3>Frecce in uscita</h3>' + (outs.length ? '<ul class="outs">' + outs.map(e => { const t = byId(e.to); return '<li><input type="text" data-edge-label="' + esc(e.id) + '" value="' + esc(e.label) + '" placeholder="Etichetta (es. Accetta)" aria-label="Etichetta della freccia verso ' + esc(t.title) + '"><button class="icon-btn" data-del-edge="' + esc(e.id) + '" title="Elimina freccia" aria-label="Elimina freccia">✕</button><button class="link" data-goto="' + esc(t.id) + '">→ §' + num.get(t.id) + ' ' + esc(t.title || 'Senza titolo') + '</button></li>'; }).join('') + '</ul>' : '<p class="hint" style="margin-bottom:8px">Nessuna freccia: qui il discorso finisce.</p>') +
    (targets.length ? '<select id="f-connect" aria-label="Aggiungi freccia"><option value="">+ Aggiungi freccia verso…</option>' + targets.map(o => '<option value="' + esc(o.id) + '">§' + num.get(o.id) + ' ' + esc(o.title || 'Senza titolo') + '</option>').join('') + '</select>' : '') + '</section>' +
    (ins.length ? '<section><h3>Si arriva qui da</h3><ul class="ins">' + ins.map(e => { const f = byId(e.from); return '<li><button class="link" data-goto="' + esc(f.id) + '">§' + num.get(f.id) + ' ' + esc(f.title || 'Senza titolo') + '</button>' + (e.label ? ' <span class="muted">· ' + esc(e.label) + '</span>' : '') + '</li>'; }).join('') + '</ul></section>' : '') +
    '<div class="actions">' + (n.id !== flow.start ? '<button class="btn btn-outline btn-small" data-act="set-start">Imposta come inizio</button>' : '') + '<button class="btn btn-outline btn-small" data-act="dup">Duplica</button><button class="btn btn-outline btn-small btn-danger" data-act="del-node">Elimina blocco</button></div>';
  $('#f-title').value = n.title || ''; $('#f-text').value = n.text || ''; $('#f-note').value = n.note || '';
}
function panelEdge(e) {
  const num = order();
  const opts = cur => flow.nodes.slice().sort((a, b) => num.get(a.id) - num.get(b.id)).map(o => '<option value="' + esc(o.id) + '"' + (o.id === cur ? ' selected' : '') + '>§' + num.get(o.id) + ' ' + esc(o.title || 'Senza titolo') + '</option>').join('');
  els.panel.innerHTML = '<div class="panel-head"><div><span class="eyebrow">Freccia</span><h2>' + esc(byId(e.from).title) + ' → ' + esc(byId(e.to).title) + '</h2></div><button class="btn btn-small btn-outline" data-act="deselect">Chiudi</button></div>' +
    '<label class="field"><span>Etichetta</span><input id="e-label" type="text" placeholder="Es. Accetta, Ha dubbi, Vuole pensarci"></label>' +
    '<p class="hint">L’etichetta compare sulla freccia e come pulsante di scelta in “Prova la call”.</p>' +
    '<label class="field"><span>Parte da</span><select id="e-from">' + opts(e.from) + '</select></label>' +
    '<label class="field"><span>Arriva a</span><select id="e-to">' + opts(e.to) + '</select></label>' +
    '<div class="actions"><button class="btn btn-outline btn-small" data-act="reverse">Inverti direzione</button><button class="btn btn-outline btn-small btn-danger" data-act="del-edge">Elimina freccia</button></div>';
  $('#e-label').value = e.label || '';
}

els.panel.addEventListener('focusin', ev => { const t = ev.target; if ((t.matches('input') || t.matches('textarea')) && !t.hasAttribute('data-nohist') && !editing) { snapshot(); editing = true; } });
els.panel.addEventListener('focusout', () => { editing = false; });
els.panel.addEventListener('input', ev => {
  const t = ev.target, v = t.value;
  if (t.id === 'f-author') { try { localStorage.setItem(NAME_KEY, v.trim()); } catch (e) { } return; }
  if (t.id === 'backup-text') return;
  if (t.id === 'f-name') { flow.name = v; changed(); return; }
  if (t.id === 'f-title' || t.id === 'f-text' || t.id === 'f-note') {
    const n = byId(sel.id); n[t.id.slice(2)] = v; renderNodes(); renderEdges(); markSel();
    if (t.id === 'f-title') { const h = els.panel.querySelector('h2'); if (h) h.textContent = v || 'Senza titolo'; }
    changed(); return;
  }
  const eid = t.getAttribute('data-edge-label') || (t.id === 'e-label' ? sel.id : null);
  if (eid) { edgeById(eid).label = v; renderEdges(); changed(); }
});
els.panel.addEventListener('change', ev => {
  const t = ev.target;
  if (t.id === 'f-type') { snapshot(); byId(sel.id).type = t.value; renderNodes(); renderEdges(); changed(); }
  else if (t.id === 'f-connect' && t.value) { snapshot(); flow.edges.push({ id: 'e' + (flow.nextId++), from: sel.id, to: t.value, label: '' }); renderAll(); changed(); }
  else if (t.id === 'e-from' || t.id === 'e-to') {
    const e = edgeById(sel.id), f = t.id === 'e-from' ? t.value : e.from, to = t.id === 'e-to' ? t.value : e.to;
    if (f === to) { toast('Una freccia deve collegare due blocchi diversi.'); renderPanel(); return; }
    if (flow.edges.some(o => o !== e && o.from === f && o.to === to)) { toast('Esiste già una freccia tra questi due blocchi.'); renderPanel(); return; }
    snapshot(); e.from = f; e.to = to; renderAll(); changed();
  }
});
els.panel.addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b) return;
  if (b.dataset.goto) { select('node', b.dataset.goto); reveal(byId(b.dataset.goto)); return; }
  if (b.dataset.delEdge) { snapshot(); flow.edges = flow.edges.filter(e => e.id !== b.dataset.delEdge); renderAll(); changed(); return; }
  if (b.dataset.restore) {
    const r = histRows[+b.dataset.restore]; if (!r) return;
    try { const d = normalize(JSON.parse(r.data)); snapshot(); flow = d; sel = null; renderAll(); changed(); toast('Aperta la versione v' + r.version + ': premi Salva per renderla quella di tutti.'); }
    catch (e) { toast('Questa versione non si può aprire.'); }
    return;
  }
  const a = b.dataset.act; if (!a) return;
  if (a === 'deselect') select(null);
  else if (a === 'history') loadHistory();
  else if (a === 'set-start') { snapshot(); flow.start = sel.id; renderAll(); changed(); }
  else if (a === 'dup') { snapshot(); const n = byId(sel.id), c = { id: 'n' + (flow.nextId++), type: n.type, title: n.title + ' (copia)', text: n.text, note: n.note, x: n.x + 40, y: n.y + 40 }; flow.nodes.push(c); sel = { kind: 'node', id: c.id }; renderAll(); changed(); }
  else if (a === 'del-node' || a === 'del-edge') deleteSel();
  else if (a === 'reverse') { const e = edgeById(sel.id); if (flow.edges.some(o => o.from === e.to && o.to === e.from)) { toast('Esiste già una freccia nella direzione opposta.'); return; } snapshot(); [e.from, e.to] = [e.to, e.from]; renderAll(); changed(); }
  else if (a === 'copy-json') copyText(JSON.stringify(flow, null, 2), $('#backup-text'));
  else if (a === 'load-json') {
    try { const d = normalize(JSON.parse($('#backup-text').value)); snapshot(); flow = d; sel = null; renderAll(); changed(); toast('Backup caricato: premi Salva per condividerlo.'); }
    catch (err) { toast('Il testo incollato non è un backup valido.'); }
  }
});
function deleteSel() {
  if (!sel) return; snapshot();
  if (sel.kind === 'node') { const id = sel.id; flow.nodes = flow.nodes.filter(n => n.id !== id); flow.edges = flow.edges.filter(e => e.from !== id && e.to !== id); if (flow.start === id) flow.start = flow.nodes[0] ? flow.nodes[0].id : null; }
  else flow.edges = flow.edges.filter(e => e.id !== sel.id);
  sel = null; renderAll(); changed();
}
function copyText(t, fallback) {
  const fail = () => { if (fallback) { fallback.hidden = false; fallback.value = t; fallback.focus(); fallback.select(); toast('Testo selezionato: premi Ctrl+C per copiarlo'); } };
  try { navigator.clipboard.writeText(t).then(() => toast('Copiato negli appunti'), fail); } catch (e) { fail(); }
}

/* ---------- aggiunta blocchi ---------- */
function collides(x, y) { return flow.nodes.some(o => Math.abs(o.x - x) < 210 && Math.abs(o.y - y) < 140); }
function addNode(type, at, from) {
  snapshot();
  const id = 'n' + (flow.nextId++), base = from ? byId(from) : (sel && sel.kind === 'node' ? byId(sel.id) : null); let x, y;
  if (at) { x = at.x - 115; y = at.y - 20; }
  else if (base) { x = base.x; y = base.y + 240; let g = 0; while (collides(x, y) && g++ < 20) x += 280; }
  else { x = (els.canvas.scrollLeft + els.canvas.clientWidth / 2) / zoom - 115; y = (els.canvas.scrollTop + els.canvas.clientHeight / 2) / zoom - 60; let k = 0; while (collides(x, y) && k++ < 30) { x += 30; y += 30; } }
  const n = { id, type, title: NEWTITLE[type], text: '', note: '', x: snap(x), y: snap(y) };
  flow.nodes.push(n); if (!byId(flow.start)) flow.start = id;
  if (base) flow.edges.push({ id: 'e' + (flow.nextId++), from: base.id, to: id, label: '' });
  sel = { kind: 'node', id }; renderAll(); changed(); reveal(n);
  const f = $('#f-title'); if (f && matchMedia('(min-width: 821px)').matches) { f.focus(); f.select(); }
}
function reveal(n) {
  if (!n) return; const c = els.canvas, x = n.x * zoom, y = n.y * zoom, w = 230 * zoom, h = 130 * zoom;
  if (x < c.scrollLeft || x + w > c.scrollLeft + c.clientWidth || y < c.scrollTop || y + h > c.scrollTop + c.clientHeight)
    c.scrollTo({ left: x + w / 2 - c.clientWidth / 2, top: y + h / 2 - c.clientHeight / 2, behavior: 'smooth' });
}

/* ---------- puntatore: trascina, collega, sposta ---------- */
function worldPt(ev) { const r = els.world.getBoundingClientRect(); return { x: (ev.clientX - r.left) / zoom, y: (ev.clientY - r.top) / zoom }; }
els.canvas.addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return;
  const port = ev.target.closest('[data-port]'), nodeEl = ev.target.closest('.node'), edgeEl = ev.target.closest('[data-edge]');
  if (port && nodeEl) { ev.preventDefault(); act = { mode: 'connect', from: nodeEl.dataset.id, sx: ev.clientX, sy: ev.clientY }; return; }
  if (nodeEl) { const n = byId(nodeEl.dataset.id); act = { mode: 'drag', id: n.id, sx: ev.clientX, sy: ev.clientY, ox: n.x, oy: n.y, moved: false, el: nodeEl }; if (!isSel('node', n.id)) select('node', n.id); return; }
  if (edgeEl) { select('edge', edgeEl.dataset.edge); return; }
  if (ev.pointerType === 'mouse') { act = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, sl: els.canvas.scrollLeft, st: els.canvas.scrollTop, moved: false }; els.canvas.classList.add('panning'); }
  else act = { mode: 'tap' };
});
let lastDrop = null;
window.addEventListener('pointermove', ev => {
  if (!act) return;
  const dx = ev.clientX - act.sx, dy = ev.clientY - act.sy;
  if (act.mode === 'drag') {
    if (!act.moved && Math.hypot(dx, dy) < 4) return;
    if (!act.moved) { snapshot(); act.moved = true; }
    const n = byId(act.id); n.x = snap(act.ox + dx / zoom); n.y = snap(act.oy + dy / zoom);
    act.el.style.left = n.x + 'px'; act.el.style.top = n.y + 'px'; renderEdges();
  } else if (act.mode === 'connect') {
    const n = byId(act.from), el = els.nodes.querySelector('.node[data-id="' + CSS.escape(act.from) + '"]'), p = worldPt(ev);
    const tl = document.getElementById('temp-line'); if (tl && el) tl.setAttribute('d', 'M' + (n.x + el.offsetWidth / 2) + ',' + (n.y + el.offsetHeight) + ' L' + p.x + ',' + p.y);
    const hit = document.elementFromPoint(ev.clientX, ev.clientY), tn = hit && hit.closest('.node');
    if (lastDrop && lastDrop !== tn) lastDrop.classList.remove('drop-target');
    if (tn && tn.dataset.id !== act.from) { tn.classList.add('drop-target'); lastDrop = tn; } else lastDrop = null;
  } else if (act.mode === 'pan') {
    if (Math.hypot(dx, dy) > 3) act.moved = true;
    els.canvas.scrollLeft = act.sl - dx; els.canvas.scrollTop = act.st - dy;
  }
});
window.addEventListener('pointerup', ev => {
  if (!act) return; const a = act; act = null; els.canvas.classList.remove('panning');
  if (lastDrop) { lastDrop.classList.remove('drop-target'); lastDrop = null; }
  if (a.mode === 'drag' && a.moved) { sizeWorld(); renderEdges(); changed(); }
  else if (a.mode === 'connect') {
    const tl = document.getElementById('temp-line'); if (tl) tl.setAttribute('d', '');
    const hit = document.elementFromPoint(ev.clientX, ev.clientY), tn = hit && hit.closest('.node');
    if (tn && tn.dataset.id !== a.from) {
      const to = tn.dataset.id;
      if (flow.edges.some(e => e.from === a.from && e.to === to)) { toast('Questi due blocchi sono già collegati.'); return; }
      snapshot(); const id = 'e' + (flow.nextId++); flow.edges.push({ id, from: a.from, to, label: '' });
      sel = { kind: 'edge', id }; renderAll(); changed();
      const li = $('#e-label'); if (li && matchMedia('(min-width: 821px)').matches) li.focus();
    } else if (!tn && Math.hypot(ev.clientX - a.sx, ev.clientY - a.sy) > 40 && els.canvas.contains(hit)) {
      addNode('passaggio', worldPt(ev), a.from);
    }
  }
  else if ((a.mode === 'pan' && !a.moved) || a.mode === 'tap') select(null);
});
window.addEventListener('pointercancel', () => { if (act && act.mode === 'drag' && act.moved) { sizeWorld(); changed(); } act = null; els.canvas.classList.remove('panning'); });
els.canvas.addEventListener('dblclick', ev => { const n = ev.target.closest('.node'); if (n) { select('node', n.dataset.id); const t = $('#f-text'); if (t) t.focus(); } });
els.canvas.addEventListener('keydown', ev => { const n = ev.target.closest('.node'); if (n && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); select('node', n.dataset.id); } });
els.canvas.addEventListener('wheel', ev => { if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); setZoom(zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1), ev); } }, { passive: false });

/* ---------- zoom ---------- */
function setZoom(z, ev) {
  z = Math.min(1.6, Math.max(0.35, z)); const c = els.canvas, r = c.getBoundingClientRect();
  const px = ev ? ev.clientX - r.left : c.clientWidth / 2, py = ev ? ev.clientY - r.top : c.clientHeight / 2;
  const wx = (c.scrollLeft + px) / zoom, wy = (c.scrollTop + py) / zoom;
  zoom = z; sizeWorld(); c.scrollLeft = wx * zoom - px; c.scrollTop = wy * zoom - py;
}
function fit(minZ, maxZ) {
  if (!flow.nodes.length) { setZoom(1); return; }
  const R = rects(); let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0;
  Object.values(R).forEach(r => { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); });
  const c = els.canvas, z = Math.min(c.clientWidth / (x1 - x0 + 80), c.clientHeight / (y1 - y0 + 80));
  zoom = Math.min(maxZ, Math.max(minZ, z)); sizeWorld(); c.scrollLeft = x0 * zoom - 40; c.scrollTop = y0 * zoom - 40;
}
function initialFit() { if (matchMedia('(max-width: 820px)').matches) fit(0.45, 1); }
$('#zoom-in').onclick = () => setZoom(zoom * 1.2);
$('#zoom-out').onclick = () => setZoom(zoom / 1.2);
els.zoomVal.onclick = () => fit(0.35, 1);

/* ---------- barra ---------- */
$('#add-passaggio').onclick = () => addNode('passaggio');
$('#add-bivio').onclick = () => addNode('bivio');
$('#add-chiusura').onclick = () => addNode('chiusura');
$('#btn-undo').onclick = undo; $('#btn-redo').onclick = redo;
els.save.onclick = save;

/* ---------- prova la call ---------- */
let cmPath = [];
function openCall() {
  if (!byId(flow.start)) { toast('Aggiungi almeno un blocco per provare la call.'); return; }
  cmPath = [flow.start]; $('#callmode').hidden = false; document.body.style.overflow = 'hidden'; renderCall(); $('#cm-exit').focus();
}
function closeOverlays() { $('#callmode').hidden = true; $('#scriptview').hidden = true; document.body.style.overflow = ''; }
function renderCall() {
  const num = order(), n = byId(cmPath[cmPath.length - 1]); if (!n) { closeOverlays(); return; }
  const outs = outsOf(n.id);
  $('#cm-card').className = 'cm-card t-' + n.type;
  $('#cm-num').textContent = '§' + num.get(n.id); $('#cm-kind').textContent = KIND[n.type];
  $('#cm-title').textContent = n.title || 'Senza titolo'; $('#cm-text').innerHTML = rich(n.text || '');
  const note = $('#cm-note'); note.hidden = !n.note; note.innerHTML = n.note ? '<b>Nota</b>' + rich(n.note) : '';
  $('#cm-trail').innerHTML = cmPath.map(id => { const x = byId(id); return '<li>' + esc(x ? x.title : '') + '</li>'; }).join('');
  $('#cm-back').disabled = cmPath.length < 2;
  const ch = $('#cm-choices');
  if (!outs.length) { ch.innerHTML = '<div class="endbox"><strong>Fine del discorso</strong><button class="btn btn-outline" data-restart>Ricomincia</button><button class="btn btn-outline" data-exit>Esci</button></div>'; ch.style.display = 'block'; }
  else { ch.style.display = ''; ch.innerHTML = outs.map((e, i) => { const t = byId(e.to); return '<button class="choice" data-go="' + esc(t.id) + '"><span class="key">' + (i + 1) + '</span><span class="choice-label">' + esc(e.label || (outs.length === 1 ? 'Avanti' : 'Opzione ' + (i + 1))) + '</span><span class="choice-to">→ §' + num.get(t.id) + ' ' + esc(t.title || 'Senza titolo') + '</span></button>'; }).join(''); }
  $('#callmode').scrollTop = 0;
}
$('#cm-choices').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b) return;
  if (b.dataset.go) { cmPath.push(b.dataset.go); renderCall(); }
  else if (b.hasAttribute('data-restart')) { cmPath = [flow.start]; renderCall(); }
  else if (b.hasAttribute('data-exit')) closeOverlays();
});
$('#cm-back').onclick = () => { if (cmPath.length > 1) { cmPath.pop(); renderCall(); } };
$('#cm-exit').onclick = closeOverlays;
$('#btn-call').onclick = openCall;

/* ---------- script ---------- */
function scriptSections() {
  const num = order();
  return flow.nodes.slice().sort((a, b) => num.get(a.id) - num.get(b.id)).map(n => ({ n, num: num.get(n.id), outs: outsOf(n.id).map(e => ({ label: e.label, to: byId(e.to), num: num.get(e.to) })) }));
}
function scriptText() {
  let t = (flow.name || 'Flusso call') + '\n\n';
  scriptSections().forEach(s => {
    t += '§' + s.num + ' ' + (s.n.title || 'Senza titolo') + ' [' + KIND[s.n.type] + ']\n' + (s.n.text ? s.n.text + '\n' : '');
    if (s.n.note) t += 'Nota: ' + s.n.note + '\n';
    if (!s.outs.length) t += '■ Fine\n';
    s.outs.forEach(o => { t += '→ ' + (o.label ? o.label + ': ' : 'poi ') + 'vai a §' + o.num + ' ' + (o.to.title || '') + '\n'; });
    t += '\n';
  });
  return t.trim() + '\n';
}
function openScript() {
  $('#sc-name').textContent = flow.name || 'Flusso call'; $('#sc-raw').hidden = true;
  $('#sc-body').innerHTML = scriptSections().map(s =>
    '<section class="sc-sec"><h3><span class="node-num">§' + s.num + '</span>' + esc(s.n.title || 'Senza titolo') + '<span class="eyebrow">' + KIND[s.n.type] + '</span></h3>' +
    (s.n.text ? '<p>' + rich(s.n.text) + '</p>' : '') + (s.n.note ? '<p class="sc-note">Nota: ' + rich(s.n.note) + '</p>' : '') +
    '<ul class="sc-outs">' + (s.outs.length ? s.outs.map(o => '<li>→ ' + (o.label ? '<b>' + esc(o.label) + '</b>: ' : 'poi ') + 'vai a §' + o.num + ' ' + esc(o.to.title || '') + '</li>').join('') : '<li>■ Fine</li>') + '</ul></section>'
  ).join('') || '<p class="hint">Il flusso è vuoto.</p>';
  $('#scriptview').hidden = false; document.body.style.overflow = 'hidden'; $('#sc-close').focus();
}
$('#btn-script').onclick = openScript;
$('#sc-close').onclick = closeOverlays;
$('#sc-copy').onclick = () => copyText(scriptText(), $('#sc-raw'));

/* ---------- tastiera ---------- */
document.addEventListener('keydown', ev => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); return; }
  if (!$('#callmode').hidden) {
    if (ev.key === 'Escape') closeOverlays();
    else if (ev.key === 'ArrowLeft' || ev.key === 'Backspace') { ev.preventDefault(); $('#cm-back').click(); }
    else if (/^[1-9]$/.test(ev.key)) { const b = $('#cm-choices').querySelectorAll('[data-go]')[+ev.key - 1]; if (b) b.click(); }
    return;
  }
  if (!$('#scriptview').hidden) { if (ev.key === 'Escape') closeOverlays(); return; }
  if (inField) return;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redo(); return; }
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && sel) { ev.preventDefault(); deleteSel(); return; }
  if (ev.key === 'Escape' && sel) select(null);
});
window.addEventListener('beforeunload', ev => { if (conn === 'online' && isDirty()) { ev.preventDefault(); ev.returnValue = ''; } });
window.addEventListener('resize', () => renderEdges());
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => renderEdges());

/* ---------- avvio ---------- */
els.canvas.classList.add('loading');
renderAll(); updateUndo(); updateStatus();
connect();
