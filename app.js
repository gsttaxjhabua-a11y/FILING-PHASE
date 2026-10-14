/* ==========================================================
   app.js — interface for the AIS/TIS raw computation page.
   Everything runs in the browser. Calculation logic is in engine.js.
   ========================================================== */
(function () {
  'use strict';
  const E = window.Engine;
  const { CATS, inr, toPaise, toInput } = E;
  const KEY = 'ais_tis_raw_computation_v1';
  const MAX_FILE = 15 * 1024 * 1024;
  const PAGE = 50;
  const files = new Map();      // doc id -> { buf } (kept in memory only, for PDF retry)
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- State ---------- */
  function fresh() {
    return {
      v: 1, fy: '2025-26', fyAuto: true, taxpayer: { name: '', pan: '' }, docs: [], records: [], seq: 1, docSeq: 1, customSeq: 1, missSeq: 1,
      tisMode: 'accepted', recon: {}, adjust: {}, custom: [], cg: {}, presum: { cash: null, digital: null }, missingManual: [], missingResolved: {}, audit: [], exports: [],
      review: { name: '', notes: '' }, view: 'upload', ui: { rf: { src: '', cat: '', q: '', flag: '', page: 1, ids: null } }
    };
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY); if (!raw) return null;
      const s = Object.assign(fresh(), JSON.parse(raw));
      s.ui = fresh().ui; s.taxpayer = Object.assign({ name: '', pan: '' }, s.taxpayer); s.taxpayer.pan = '';
      return s;
    } catch (e) { return null; }
  }
  let state = load() || fresh();
  let warnedSave = false;
  function save() {
    try {
      const copy = Object.assign({}, state, { taxpayer: Object.assign({}, state.taxpayer, { pan: '' }) });
      localStorage.setItem(KEY, JSON.stringify(copy));
    } catch (e) { if (!warnedSave) { warnedSave = true; toast('Could not save in this browser (storage full or blocked). Export your work before closing.'); } }
  }
  const model = () => E.buildModel(state);
  function audit(action, entity, prev, next, reason) {
    state.audit.push({ ts: new Date().toISOString(), action: action, entity: entity, prev: prev === undefined ? null : prev, next: next === undefined ? null : next, reason: reason || '' });
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 5000);
  }
  const fmtVal = v => v === null || v === undefined || v === '' ? '—' : (typeof v === 'number' ? inr(v) : esc(typeof v === 'object' ? JSON.stringify(v) : v));
  const fmtTs = ts => new Date(ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const maskPan = p => p ? p.slice(0, 2) + '••••••' + p.slice(-2) : '';
  function parseAmt(str, allowNeg) {
    const s = String(str === undefined ? '' : str).replace(/[₹,\s]/g, '');
    if (s === '') return { ok: true, p: null };
    if (!/^-?\d{1,13}(\.\d{1,2})?$/.test(s)) return { ok: false, msg: 'Enter a number with at most 2 decimals, for example 125000.50' };
    const p = toPaise(s);
    if (p < 0 && !allowNeg) return { ok: false, msg: 'This line cannot be negative.' };
    return { ok: true, p: p };
  }

  /* ---------- Navigation ---------- */
  const TITLES = { upload: 'Upload', records: 'Extracted records', recon: 'Reconciliation', comp: 'Raw computation', missing: 'Missing information', review: 'Review & export', audit: 'Audit trail' };
  function go(view) {
    state.view = view;
    $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + view));
    $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
    $('#viewTitle').textContent = TITLES[view];
    $('#sidebar').classList.remove('open');
    render(); window.scrollTo(0, 0);
  }
  function render() {
    E.setTisMode(state.tisMode);
    const name = state.taxpayer.name || 'No taxpayer';
    $('#caseChip').innerHTML = '<b>' + esc(name) + '</b> · FY ' + esc(state.fy) + ' (AY ' + E.ayOf(state.fy) + ')';
    const v = state.view;
    if (v === 'upload') renderUpload();
    else if (v === 'records') renderRecords();
    else if (v === 'recon') renderRecon();
    else if (v === 'comp') renderComp();
    else if (v === 'missing') renderMissing();
    else if (v === 'review') renderReview();
    else if (v === 'audit') renderAudit();
    save();
  }
  const empty = (icon, title, text, btn) => '<div class="empty"><span class="material-symbols-outlined">' + icon + '</span><div class="strong">' + title + '</div><p>' + text + '</p>' + (btn || '') + '</div>';
  const goBtn = (view, label) => '<button class="btn btn-primary btn-sm" data-action="go" data-view="' + view + '">' + label + '</button>';

  /* ---------- Upload ---------- */
  function renderUpload() {
    const sel = $('#fySel');
    if (!sel.options.length) sel.innerHTML = E.fyOptions().map(f => '<option>' + f + '</option>').join('');
    sel.value = state.fy;
    $('#ayText').textContent = 'Assessment year ' + E.ayOf(state.fy);
    if (document.activeElement !== $('#tpName')) $('#tpName').value = state.taxpayer.name;
    if (document.activeElement !== $('#tpPan')) $('#tpPan').value = state.taxpayer.pan;
    const box = $('#docList');
    if (!state.docs.length) { box.innerHTML = empty('upload_file', 'No documents yet', 'Drop an AIS and a TIS above, or load the sample data to try the workflow.'); return; }
    const badge = s => ({ Processed: 'badge-paid', Failed: 'badge-incomplete', Rejected: 'badge-incomplete', Duplicate: 'badge-partial', Processing: 'badge-info', Queued: 'badge-info' }[s] || 'badge-neutral');
    box.innerHTML = '<div class="table-wrap"><table><thead><tr><th>File</th><th>Kind</th><th>Status</th><th>FY found</th><th class="num">Records</th><th>Uploaded</th><th>Notes</th><th></th></tr></thead><tbody>' +
      state.docs.map(d => {
        const notes = d.errors.map(x => '<div class="neg">' + esc(x) + '</div>').join('') + d.warnings.slice(0, 6).map(x => '<div class="muted">' + esc(x) + '</div>').join('') + (d.warnings.length > 6 ? '<div class="muted">+' + (d.warnings.length - 6) + ' more warnings</div>' : '');
        const retry = d.type === 'pdf' && d.status === 'Failed' && files.has(d.id) ? '<button class="btn-text" data-action="retry" data-id="' + d.id + '"><span class="material-symbols-outlined">refresh</span>Retry</button>' : '';
        return '<tr><td><div class="line-desc">' + esc(d.name) + '</div><div class="muted">' + d.id + ' · ' + (d.checksum ? 'SHA-256 ' + esc(d.checksum.slice(0, 10)) : '') + '</div></td><td><span class="badge badge-info">' + d.kind + '</span></td><td><span class="badge ' + badge(d.status) + '">' + d.status + '</span></td><td>' + esc(d.fy || '—') + '</td><td class="num">' + d.count + '</td><td class="nowrap">' + fmtTs(d.uploaded) + '</td><td class="small">' + (notes || '—') + '</td><td class="nowrap">' + retry + '<button class="btn-text" data-action="removeDoc" data-id="' + d.id + '"><span class="material-symbols-outlined">delete</span>Remove</button></td></tr>';
      }).join('') + '</tbody></table></div>' +
      (state.records.length ? '<div class="flex gap-2 mt-4 wrap">' + goBtn('records', 'Review extracted records') + goBtn('recon', 'Go to reconciliation') + '</div>' : '');
  }

  async function sha256(buf) {
    try { const h = await crypto.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join(''); }
    catch (e) { let h = 5381; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) h = ((h << 5) + h + u[i]) | 0; return 'weak-' + (h >>> 0).toString(16) + '-' + u.length; }
  }
  async function addFiles(list, kind) {
    for (const f of Array.from(list)) {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      const doc = { id: 'D' + (state.docSeq++), name: f.name, kind: kind, type: ext, size: f.size, uploaded: new Date().toISOString(), status: 'Queued', count: 0, errors: [], warnings: [], fy: null, parser: E.PARSER_VERSION, checksum: '' };
      state.docs.push(doc);
      if (['json', 'csv', 'pdf'].indexOf(ext) < 0) { doc.status = 'Rejected'; doc.errors.push('Unsupported file type ".' + ext + '". Upload JSON, CSV or PDF.'); continue; }
      if (f.size === 0) { doc.status = 'Rejected'; doc.errors.push('The file is empty.'); continue; }
      if (f.size > MAX_FILE) { doc.status = 'Rejected'; doc.errors.push('The file is larger than 15 MB.'); continue; }
      const buf = await f.arrayBuffer();
      doc.checksum = await sha256(buf);
      const dup = state.docs.find(d => d !== doc && d.checksum === doc.checksum && d.status !== 'Rejected');
      if (dup) { doc.status = 'Duplicate'; doc.errors.push('Same content as ' + dup.name + ' (' + dup.id + '). It was not processed again.'); toast('Duplicate file skipped: ' + f.name); continue; }
      files.set(doc.id, { buf: buf });
      await processDoc(doc, $('#pdfPw').value);
    }
    render();
  }

  let pdfReady = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve();
    if (pdfReady) return pdfReady;
    const base = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
    pdfReady = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = base + 'pdf.min.js';
      s.onload = async () => {
        try {
          const r = await fetch(base + 'pdf.worker.min.js');
          const blob = new Blob([await r.text()], { type: 'text/javascript' });
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
          res();
        } catch (e) { rej(new Error('Could not load the PDF reader. Check your internet connection.')); }
      };
      s.onerror = () => rej(new Error('Could not load the PDF reader. Check your internet connection.'));
      document.head.appendChild(s);
    }).catch(e => { pdfReady = null; throw e; });
    return pdfReady;
  }
  let ocrWorker = null;
  function loadScript(src, err) {
    return new Promise((res, rej) => { const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error(err)); document.head.appendChild(el); });
  }
  async function getOcrWorker() {
    if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', 'Could not load the OCR engine. Check your internet connection.');
    if (!ocrWorker) {
      ocrWorker = await window.Tesseract.createWorker('eng');
      await ocrWorker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    }
    return ocrWorker;
  }
  async function renderForOcr(page) {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(300 / 72, Math.sqrt(16000000 / (base.width * base.height)));
    const vp = page.getViewport({ scale: scale });
    const canvas = document.createElement('canvas'); canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    // keep only dark pixels: removes the light watermark and stamp that confuse OCR
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 100 ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }
  async function extractPdfPages(buf, password, progress) {
    await loadPdfJs();
    let pdf;
    try { pdf = await window.pdfjsLib.getDocument({ data: buf.slice(0), password: password || undefined }).promise; }
    catch (e) {
      if (e && e.name === 'PasswordException') throw new Error(e.code === 2 ? 'The PDF password is incorrect. Enter the right password above and press Retry.' : 'This PDF is password-protected. Enter the password above and press Retry.');
      throw new Error('Could not read this PDF: ' + (e && e.message ? e.message : e));
    }
    const pdfPages = [], pages = []; let count = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i), vp = page.getViewport({ scale: 1 }), tc = await page.getTextContent(), words = [];
      tc.items.forEach(it => {
        const str = it.str || ''; if (!str.trim()) return;
        const h = it.height || 10, y = vp.height - it.transform[5] - h, parts = str.split(/\s+/).filter(Boolean);
        let pos = 0;
        parts.forEach(p => { const at = str.indexOf(p, pos); pos = at + p.length; words.push({ s: p, x: it.transform[4] + it.width * (at / str.length), y: y, w: it.width * (p.length / str.length), h: h }); });
      });
      pdfPages.push(page); pages.push({ words: words }); count += words.length;
    }
    if (count >= 15 * pdf.numPages) return { pages: pages, ocr: false };
    progress('Scanned PDF: loading OCR engine');
    const worker = await getOcrWorker(), out = [];
    for (let i = 0; i < pdfPages.length; i++) {
      progress('Reading page ' + (i + 1) + ' of ' + pdfPages.length + ' with OCR');
      const canvas = await renderForOcr(pdfPages[i]);
      const res = await worker.recognize(canvas), data = res.data || {};
      const ws = (data.words || []).map(w => ({ s: String(w.text).trim(), x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0 })).filter(w => w.s);
      if (!ws.length) throw new Error('OCR returned no words for page ' + (i + 1) + '.');
      out.push({ words: ws });
    }
    return { pages: out, ocr: true };
  }

  async function processDoc(doc, password) {
    const item = files.get(doc.id);
    doc.errors = []; doc.warnings = []; doc.status = 'Processing'; doc.count = 0;
    state.records = state.records.filter(r => r.docId !== doc.id);
    const seq = () => 'R' + (state.seq++);
    try {
      let recs, text;
      if (doc.type === 'pdf') {
        const res = await extractPdfPages(item.buf, password, msg => { doc.status = msg; if (state.view === 'upload') renderUpload(); });
        const parsed = E.parsePdfWords(res.pages, doc, seq);
        if (parsed) {
          recs = parsed.records; text = parsed.text;
          if (parsed.kind !== doc.kind) { doc.warnings.push('Uploaded as ' + doc.kind + ' but this document is a ' + parsed.kind + '. It was read as a ' + parsed.kind + '.'); doc.kind = parsed.kind; }
          doc.warnings.push.apply(doc.warnings, parsed.warnings);
          if (parsed.name && !state.taxpayer.name) state.taxpayer.name = parsed.name;
        } else {
          const lines = res.pages.map((p, i) => E.pdfToLines(p.words, i + 1).map(l => l.words.map(w => w.s)));
          text = lines.map(p => p.map(l => l.join(' ')).join('\n')).join('\n');
          recs = E.parsePDFLines(lines, doc, seq);
          doc.warnings.push('This PDF does not look like a portal AIS or TIS. Amounts were picked by position. Check every record.');
        }
        if (res.ocr) { doc.ocr = true; doc.warnings.unshift('Scanned PDF read with OCR. Check the records against the PDF. Totals are cross-checked where the document allows.'); }
      } else {
        text = new TextDecoder('utf-8').decode(item.buf);
        recs = doc.type === 'csv' ? E.parseCSVText(text, doc, seq) : E.parseJSONText(text, doc, seq);
      }
      doc.fy = E.detectFY(text);
      const pan = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/.exec(text);
      if (pan && !state.taxpayer.pan) { state.taxpayer.pan = pan[0]; doc.warnings.push('PAN taken from the document. Verify it on the Upload screen.'); }
      if (doc.fy && state.fyAuto) { state.fy = doc.fy; state.fyAuto = false; }
      if (!doc.fy) doc.warnings.push('Financial year not found in the document. Using case year ' + state.fy + '.');
      else if (doc.fy !== state.fy) doc.warnings.push('Document year ' + doc.fy + ' differs from case year ' + state.fy + '. Check you uploaded the right year.');
      state.records.push.apply(state.records, recs);
      doc.count = recs.length; doc.status = 'Processed';
      audit('Document processed', 'document:' + doc.id, null, doc.name + ': ' + recs.length + ' records');
    } catch (e) {
      doc.status = 'Failed'; doc.errors.push(e.message);
      audit('Document failed', 'document:' + doc.id, null, doc.name, e.message);
    }
  }

  /* ---------- Sample data (synthetic) ---------- */
  const SAMPLE_AIS = 'Information Source,Information Code,Information Description,Transaction Date,Amount Reported,TDS Deducted\n' +
    'SAMPLE BANK LTD,194A,Interest from savings account,2026-03-31,18450.50,0\n' +
    'SAMPLE BANK LTD,194A,Interest from deposit,2026-03-31,62000,6200\n' +
    'ACME TECH PVT LTD,192,Salary,2026-03-31,1450000,120000\n' +
    'DEMO CORP LTD,194,Dividend,2025-09-15,12400,1240\n' +
    'DEMO CORP LTD,194,Dividend,2025-09-15,12400,1240\n' +
    'SAMPLE BROKER,SFT-017,Sale of listed securities,2025-11-10,310000,0\n' +
    'SAMPLE BROKER,SFT-017,Purchase of listed securities,2025-06-02,200000,0\n' +
    'SAMPLE MF,SFT-018,Redemption of mutual fund units,2026-01-20,150000,0\n' +
    'CONSULT CO,194J,Professional fees,2025-12-10,45000,4500\n' +
    'UNKNOWN ENTITY,XYZ-99,Miscellaneous credit received,2025-08-01,5000,0\n';
  const SAMPLE_TIS = 'Information Category,Amount Reported,Amount Processed,Tax Deducted\n' +
    'Salary,1450000,1450000,120000\n' +
    'Interest from savings account,18450.50,18450.50,0\n' +
    'Interest from deposit,62000,62000,6200\n' +
    'Dividend,12400,12400,1240\n' +
    'Sale of securities and units of mutual fund,460000,460000,0\n' +
    'Purchase of securities and units of mutual fund,200000,200000,0\n' +
    'Professional fees,45000,45000,4500\n';
  async function loadSample() {
    if (!state.taxpayer.name) state.taxpayer.name = 'Sample Taxpayer (synthetic)';
    state.fy = '2025-26'; state.fyAuto = false;
    await addFiles([new File([SAMPLE_AIS], 'sample-AIS-synthetic.csv', { type: 'text/csv' })], 'AIS');
    await addFiles([new File([SAMPLE_TIS], 'sample-TIS-synthetic.csv', { type: 'text/csv' })], 'TIS');
    toast('Sample data loaded. All names and amounts are made up.');
  }

  /* ---------- Records ---------- */
  const catOpts = sel => Object.keys(CATS).map(k => '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + esc(CATS[k].label) + '</option>').join('');
  function flagsOf(r, dups) {
    const f = r.warnings.slice();
    if (dups.has(r.id)) f.push('Possible duplicate');
    if (r.date && !E.inFY(r.date, state.fy)) f.push('Date outside FY ' + state.fy);
    if (!r.date) f.push('No valid date');
    if (r.cat === 'unclassified') f.push('Unclassified');
    return f;
  }
  function renderRecords() {
    const rf = state.ui.rf, el = $('#view-records');
    if (!state.records.length) { el.innerHTML = '<div class="card">' + empty('table_rows', 'No records yet', 'Upload an AIS or TIS first.', goBtn('upload', 'Go to upload')) + '</div>'; return; }
    el.innerHTML = '<div class="card"><div class="card-title"><h4>Extracted records</h4><span class="muted" id="recCount"></span></div>' +
      '<div class="notice mb-4"><span class="material-symbols-outlined">info</span><div>Original reported amounts are never changed. Excluding a record keeps it on file but leaves it out of totals. Changing a category is logged in the audit trail.</div></div>' +
      (rf.ids ? '<div class="notice success mb-4"><span class="material-symbols-outlined">filter_alt</span><div class="grow">Showing only the records behind one computation line. <button class="btn-text" data-action="clearIds">Show all</button></div></div>' : '') +
      '<div class="filters">' +
      '<div class="field"><label for="f-src">Source</label><select id="f-src" data-change="rf-src"><option value="">All</option><option value="AIS"' + (rf.src === 'AIS' ? ' selected' : '') + '>AIS</option><option value="TIS"' + (rf.src === 'TIS' ? ' selected' : '') + '>TIS</option></select></div>' +
      '<div class="field"><label for="f-cat">Category</label><select id="f-cat" data-change="rf-cat"><option value="">All</option>' + catOpts(rf.cat) + '</select></div>' +
      '<div class="field"><label for="f-flag">Show</label><select id="f-flag" data-change="rf-flag">' + [['', 'All records'], ['flagged', 'With flags'], ['unclassified', 'Unclassified only'], ['dup', 'Possible duplicates'], ['excluded', 'Excluded only']].map(o => '<option value="' + o[0] + '"' + (rf.flag === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
      '<div class="field grow"><label for="f-q">Search</label><input id="f-q" placeholder="Description, entity or code" value="' + esc(rf.q) + '"></div></div>' +
      '<div id="recTable"></div></div>';
    renderRecTable();
  }
  function renderRecTable() {
    const rf = state.ui.rf, dupIds = new Set([].concat.apply([], E.dupGroups(state)));
    const q = rf.q.trim().toLowerCase();
    const rows = state.records.filter(r => {
      if (rf.ids && rf.ids.indexOf(r.id) < 0) return false;
      if (rf.src && r.source !== rf.src) return false;
      if (rf.cat && r.cat !== rf.cat) return false;
      if (rf.flag === 'excluded' && !r.excluded) return false;
      if (rf.flag === 'unclassified' && r.cat !== 'unclassified') return false;
      if (rf.flag === 'dup' && !dupIds.has(r.id)) return false;
      if (rf.flag === 'flagged' && !flagsOf(r, dupIds).length) return false;
      if (q && (r.desc + ' ' + r.entity + ' ' + r.code).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    const pages = Math.max(1, Math.ceil(rows.length / PAGE)); rf.page = Math.min(rf.page, pages);
    const slice = rows.slice((rf.page - 1) * PAGE, rf.page * PAGE);
    const docName = id => (state.docs.find(d => d.id === id) || {}).name || id;
    $('#recCount').textContent = rows.length + ' of ' + state.records.length + ' records';
    $('#recTable').innerHTML = rows.length ? '<div class="table-wrap"><table><thead><tr><th>Source</th><th>Entity and description</th><th>Category</th><th>Date</th><th class="num">Reported</th><th class="num">Processed</th><th class="num">Accepted</th><th>Where from</th><th>Flags</th><th></th></tr></thead><tbody>' +
      slice.map(r => {
        const fl = flagsOf(r, dupIds);
        return '<tr class="' + (r.excluded ? 'excluded' : '') + '"><td><span class="badge badge-info">' + r.source + '</span></td><td><div class="line-desc">' + esc(r.desc) + '</div><div class="line-sub">' + esc(r.entity || '—') + (r.code ? ' · ' + esc(r.code) : '') + '</div></td>' +
          '<td><select class="cell-input" data-change="cat" data-id="' + r.id + '" aria-label="Category for ' + esc(r.desc) + '">' + catOpts(r.cat) + '</select><div class="line-sub">' + esc(r.ruleId === 'MANUAL' ? 'Set by reviewer' : 'Rule ' + r.ruleId + ': ' + r.ruleNote) + '</div></td>' +
          '<td class="nowrap">' + esc(r.date || r.dateRaw || '—') + '</td><td class="num">' + inr(r.reported) + '</td><td class="num">' + inr(r.processed) + '</td><td class="num">' + inr(r.accepted) + '</td>' +
          '<td class="small">' + esc(docName(r.docId)) + '<div class="line-sub">' + esc(r.loc) + '</div></td>' +
          '<td>' + (fl.length ? fl.map(x => '<span class="badge badge-partial" style="margin:1px 0">' + esc(x) + '</span>').join('<br>') : '<span class="muted">—</span>') + '</td>' +
          '<td><button class="btn-text" data-action="toggleExclude" data-id="' + r.id + '">' + (r.excluded ? 'Include' : 'Exclude') + '</button></td></tr>';
      }).join('') + '</tbody></table></div>' +
      (pages > 1 ? '<div class="pager"><button class="btn btn-outline btn-sm" data-action="page" data-d="-1"' + (rf.page <= 1 ? ' disabled' : '') + '>Previous</button><span class="small">Page ' + rf.page + ' of ' + pages + '</span><button class="btn btn-outline btn-sm" data-action="page" data-d="1"' + (rf.page >= pages ? ' disabled' : '') + '>Next</button></div>' : '')
      : empty('search_off', 'No records match', 'Change or clear the filters.');
  }

  /* ---------- Reconciliation ---------- */
  function renderRecon() {
    const el = $('#view-recon'), m = model(), rr = m.rr;
    if (!rr.length) { el.innerHTML = '<div class="card">' + empty('compare_arrows', 'Nothing to reconcile', 'Upload an AIS and a TIS to compare them.', goBtn('upload', 'Go to upload')) + '</div>'; return; }
    const sb = s => ({ 'Exact match': 'badge-paid', 'Probable match': 'badge-partial', 'Difference': 'badge-incomplete' }[s] || 'badge-info');
    const dups = E.dupGroups(state), rec = id => state.records.find(r => r.id === id);
    const needs = rr.filter(r => r.needs).length;
    el.innerHTML = '<div class="card"><div class="card-title"><h4>AIS and TIS by category</h4><span class="badge ' + (needs ? 'badge-partial' : 'badge-paid') + '">' + (needs ? needs + ' to resolve' : 'All resolved') + '</span></div>' +
      '<div class="field" style="max-width:340px"><label for="tisMode">TIS amount to use</label><select id="tisMode" data-change="tismode"><option value="accepted"' + (state.tisMode === 'accepted' ? ' selected' : '') + '>Accepted by taxpayer</option><option value="processed"' + (state.tisMode === 'processed' ? ' selected' : '') + '>Processed by system</option><option value="reported"' + (state.tisMode === 'reported' ? ' selected' : '') + '>Reported by source</option></select></div>' +
      '<div class="notice mb-4"><span class="material-symbols-outlined">info</span><div>AIS and TIS describe the same activity, so their totals are never added together. For each category, pick the one source the computation uses. A TIS total does not replace the AIS detail: the detailed records stay available. Equal amounts are not proof of a duplicate.</div></div>' +
      '<div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">AIS</th><th class="num">TIS</th><th class="num">Difference</th><th>Status</th><th>Use in computation</th><th></th></tr></thead><tbody>' +
      rr.map(r => {
        const manual = r.basis === 'MANUAL' ? '<input class="cell-input mt-2" style="margin-top:6px" data-change="manual" data-cat="' + r.cat + '" value="' + esc(toInput(r.dec.manual)) + '" aria-label="Manual amount for ' + esc(CATS[r.cat].label) + '" placeholder="0.00">' : '';
        const done = r.dec.resolved ? '<span class="badge badge-reviewed"><span class="material-symbols-outlined">check_circle</span>Resolved</span>' : (r.status === 'Exact match' ? '<span class="muted">Automatic</span>' : (r.cat === 'unclassified' ? '' : '<button class="btn btn-outline btn-sm" data-action="resolveRecon" data-cat="' + r.cat + '">Resolve</button>'));
        return '<tr><td><div class="line-desc">' + esc(CATS[r.cat].label) + '</div><div class="line-sub">' + (CATS[r.cat].kind === 'credit' ? 'Tax credit' : CATS[r.cat].kind === 'income' ? 'Income' : CATS[r.cat].kind === 'cg' ? 'Gross proceeds, not gain' : 'Review') + '</div></td>' +
          '<td class="num">' + (r.AIS.n ? inr(r.AIS.sum) + '<div class="line-sub">' + r.AIS.n + ' record(s)</div>' : '—') + '</td><td class="num">' + (r.TIS.n ? inr(r.TIS.sum) + '<div class="line-sub">' + r.TIS.n + ' record(s)</div>' : '—') + '</td>' +
          '<td class="num ' + (r.diff ? 'neg' : '') + '">' + (r.diff === null ? '—' : inr(r.diff)) + '</td><td><span class="badge ' + sb(r.status) + '">' + r.status + '</span></td>' +
          '<td><select class="cell-input" data-change="basis" data-cat="' + r.cat + '" aria-label="Source for ' + esc(CATS[r.cat].label) + '"><option value="AIS"' + (r.basis === 'AIS' ? ' selected' : '') + '>AIS</option><option value="TIS"' + (r.basis === 'TIS' ? ' selected' : '') + '>TIS</option><option value="MANUAL"' + (r.basis === 'MANUAL' ? ' selected' : '') + '>Manual amount</option></select>' + manual + '<div class="line-sub">Using ' + inr(r.used) + '</div></td>' +
          '<td>' + done + '<button class="btn-text" data-action="showCat" data-cat="' + r.cat + '">Records</button></td></tr>';
      }).join('') + '</tbody></table></div></div>' +
      '<div class="card"><div class="card-title"><h4>Possible duplicate records</h4><span class="muted">' + dups.length + ' group(s)</span></div>' +
      (dups.length ? '<p class="muted">Same source, category, entity, date, amount and description. Nothing is deleted. Exclude a record only after checking the source document.</p><div class="table-wrap"><table><thead><tr><th>Group</th><th>Description</th><th>Date</th><th class="num">Amount</th><th>Records</th></tr></thead><tbody>' +
        dups.map((g, i) => { const a = rec(g[0]); return '<tr><td>' + (i + 1) + '</td><td>' + esc(a.source) + ': ' + esc(a.desc) + '</td><td>' + esc(a.date) + '</td><td class="num">' + inr(E.effAmt(a)) + '</td><td>' + g.map(id => '<button class="btn-text" data-action="toggleExclude" data-id="' + id + '">' + id + ' · Exclude</button>').join('') + '</td></tr>'; }).join('') + '</tbody></table></div>'
        : empty('task_alt', 'No possible duplicates found', 'Matching uses exact source, entity, date, amount and description.')) + '</div>';
  }

  /* ---------- Computation ---------- */
  const SB = { Reviewed: ['badge-reviewed', 'check_circle'], 'Needs review': ['badge-review', 'schedule'], Incomplete: ['badge-incomplete', 'warning'], Derived: ['badge-derived', 'functions'] };
  const statusBadge = s => '<span class="badge ' + SB[s][0] + '"><span class="material-symbols-outlined">' + SB[s][1] + '</span>' + s + '</span>';
  function lineRow(l) {
    const srcBtn = l.sources.length ? '<button class="btn-text" data-action="showIds" data-key="' + esc(l.key) + '">' + l.sources.length + ' source record(s)</button>' : '';
    const actions = l.derived ? '' : '<button class="btn-text" data-action="editLine" data-key="' + esc(l.key) + '"><span class="material-symbols-outlined">edit</span>Edit</button>' +
      (l.final !== null && l.final !== undefined ? '<button class="btn-text" data-action="toggleRev" data-key="' + esc(l.key) + '" aria-label="Toggle reviewed">' + (l.status === 'Reviewed' ? 'Unmark' : 'Mark reviewed') + '</button>' : '');
    return '<tr class="' + (l.derived ? 'sub-row' : '') + '"><td><div class="line-desc">' + esc(l.desc) + '</div><div class="line-sub">' + esc(l.method) + (l.adj && l.adj.reason ? ' · Reason: ' + esc(l.adj.reason) : '') + '</div>' +
      l.warn.map(w => '<div class="line-sub neg">' + esc(w) + '</div>').join('') + srcBtn + '</td>' +
      '<td class="num">' + inr(l.extracted) + '</td><td class="num">' + inr(l.calc) + '</td><td class="num">' + (l.adj && l.adj.amount !== null && l.adj.amount !== undefined ? inr(l.adj.amount) : '—') + '</td>' +
      '<td class="num strong">' + inr(l.final) + '</td><td>' + statusBadge(l.status) + '</td><td class="nowrap">' + actions + '</td></tr>';
  }
  const lineHead = '<thead><tr><th>Line</th><th class="num">Extracted</th><th class="num">Calculated</th><th class="num">Manual</th><th class="num">Final</th><th>Status</th><th></th></tr></thead>';
  function renderComp() {
    const el = $('#view-comp'), m = model();
    let h = (!state.records.length ? '<div class="notice"><span class="material-symbols-outlined">info</span><div>No AIS or TIS uploaded yet. You can still enter turnover and add lines by hand, or <button class="btn-text" data-action="go" data-view="upload">upload documents</button>.</div></div>' : '') + '<div class="notice warning"><span class="material-symbols-outlined">edit_note</span><div><b>Draft computation.</b> AIS and TIS do not show every income, cost or deduction. Lines marked Incomplete are left out of the totals until you enter the missing information. This is not a final or filed return.</div></div>';
    h += '<div class="tiles"><div class="tile primary"><div class="label">Gross total income</div><div class="value">' + inr(m.gti) + '</div></div><div class="tile"><div class="label">Deductions</div><div class="value">' + inr(m.ded) + '</div></div><div class="tile"><div class="label">Total income</div><div class="value">' + inr(m.ti) + '</div></div><div class="tile"><div class="label">TDS and TCS credits</div><div class="value">' + inr(m.credits) + '</div></div></div>';
    h += '<div class="notice ' + (m.incomplete ? 'danger' : '') + '"><span class="material-symbols-outlined">' + (m.incomplete ? 'warning' : 'info') + '</span><div>' + (m.incomplete ? m.incomplete + ' line(s) are incomplete and excluded from totals. ' : '') + (m.tax.supported ? 'Tax is calculated below with FY 2025-26 new-regime rules. Read the assumptions under the tax table.' : m.tax.reason) + '</div></div>';
    E.SCHEDULES.forEach(s => {
      const ls = m.lines.filter(l => l.sched === s);
      h += '<div class="card"><div class="sched-head"><h4>' + s + '</h4><button class="btn btn-outline btn-sm" data-action="addLine" data-sched="' + esc(s) + '"><span class="material-symbols-outlined">add</span>Add line</button></div>';
      if (s === 'Business or profession') h += presumPanel();
      if (s === 'Capital gains' && m.cgItems.length) {
        h += '<div class="notice warning mb-4"><span class="material-symbols-outlined">warning</span><div>Gross sale proceeds are not capital gains. Enter the cost and choose short-term or long-term for each sale. Cost is never assumed to be zero, and a gain is not shown until both are entered.</div></div>';
        h += '<div class="table-wrap"><table><thead><tr><th>Sale</th><th class="num">Proceeds</th><th class="num">Cost</th><th class="num">Expenses</th><th>Term</th><th>Tax treatment</th><th class="num">Gain</th><th>Status</th><th></th></tr></thead><tbody>' +
          m.cgItems.map(it => {
            const v = it.view, cg = state.cg[it.id] || {}, l = m.lines.find(x => x.key === 'cg:' + it.id);
            return '<tr><td><div class="line-desc">' + esc(it.desc) + '</div><div class="line-sub">' + esc(it.entity || '') + (it.date ? ' · ' + esc(it.date) : '') + (v.fromAis ? ' · <b>cost/term from AIS, verify</b>' : '') + '</div></td><td class="num">' + inr(it.proceeds) + '</td>' +
              '<td class="num"><input class="cell-input" data-change="cg" data-f="cost" data-id="' + esc(it.id) + '" value="' + esc(toInput(v.cost)) + '" placeholder="Required" aria-label="Cost of acquisition"></td>' +
              '<td class="num"><input class="cell-input" data-change="cg" data-f="exp" data-id="' + esc(it.id) + '" value="' + esc(toInput(cg.exp)) + '" placeholder="0.00" aria-label="Transfer expenses"></td>' +
              '<td><select class="cell-input" data-change="cg" data-f="type" data-id="' + esc(it.id) + '" aria-label="Short or long term"><option value="">Choose</option><option value="ST"' + (v.type === 'ST' ? ' selected' : '') + '>Short-term</option><option value="LT"' + (v.type === 'LT' ? ' selected' : '') + '>Long-term</option></select></td>' +
              '<td><select class="cell-input" data-change="cg" data-f="treat" data-id="' + esc(it.id) + '" aria-label="Tax treatment"><option value="EQ"' + (v.treat === 'EQ' ? ' selected' : '') + '>Listed equity / equity fund</option><option value="OTHER"' + (v.treat === 'OTHER' ? ' selected' : '') + '>Other asset</option></select></td>' +
              '<td class="num strong">' + inr(l.final) + '</td><td>' + statusBadge(l.status) + '</td><td class="nowrap"><button class="btn-text" data-action="editLine" data-key="' + esc(l.key) + '"><span class="material-symbols-outlined">edit</span>Edit</button></td></tr>';
          }).join('') + '</tbody></table></div>';
        const rest = ls.filter(l => l.key.indexOf('cg:') !== 0 || l.key === 'cg:net');
        if (rest.length) h += '<div class="table-wrap mt-4"><table>' + lineHead + '<tbody>' + rest.map(lineRow).join('') + '</tbody></table></div>';
      } else if (ls.length) h += '<div class="table-wrap"><table>' + lineHead + '<tbody>' + ls.map(lineRow).join('') + '</tbody></table></div>';
      else h += '<p class="muted mb-0">No lines in this schedule.</p>';
      h += '</div>';
    });
    h += '<div class="card"><div class="sched-head"><h4>Summary</h4></div><div class="table-wrap"><table><tbody>' +
      Object.keys(m.heads).map(k => '<tr><td>' + k + '</td><td class="num">' + inr(m.heads[k]) + '</td></tr>').join('') +
      '<tr class="total-row"><td>Gross total income</td><td class="num">' + inr(m.gti) + '</td></tr><tr><td>Less: deductions</td><td class="num">' + inr(m.ded) + '</td></tr><tr class="total-row"><td>Total income</td><td class="num">' + inr(m.ti) + '</td></tr>' +
      '<tr><td>Tax liability</td><td class="num">' + (m.tax.rows ? inr(m.tax.total) : '<span class="muted">Not calculated</span>') + '</td></tr><tr><td>TDS, TCS and other credits</td><td class="num">' + inr(m.credits) + '</td></tr></tbody></table></div></div>' + taxCard(m);
    if (m.info.length) h += '<div class="card"><div class="sched-head"><h4>Reported but not income</h4></div><p class="muted">These items are shown for reference. They are not added to income.</p><div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Amount used</th><th>Source</th><th></th></tr></thead><tbody>' +
      m.info.map(r => '<tr><td>' + esc(CATS[r.cat].label) + '</td><td class="num">' + inr(r.used) + '</td><td>' + r.basis + '</td><td><button class="btn-text" data-action="showCat" data-cat="' + r.cat + '">Records</button></td></tr>').join('') + '</tbody></table></div></div>';
    if (m.unclassified.length) h += '<div class="card"><div class="sched-head"><h4>Unclassified / review required</h4><button class="btn btn-outline btn-sm" data-action="showCat" data-cat="unclassified">Review ' + m.unclassified.length + ' record(s)</button></div><div class="table-wrap"><table><thead><tr><th>Description</th><th>Entity</th><th class="num">Amount</th></tr></thead><tbody>' +
      m.unclassified.slice(0, 20).map(r => '<tr><td>' + esc(r.desc) + '</td><td>' + esc(r.entity) + '</td><td class="num">' + inr(E.effAmt(r)) + '</td></tr>').join('') + '</tbody></table></div></div>';
    el.innerHTML = h;
  }


  function presumPanel() {
    const ps = state.presum || {};
    return '<div class="notice mb-4"><span class="material-symbols-outlined">info</span><div class="grow"><b>Section 44AD presumptive profit.</b> Enter turnover received in cash and turnover received through bank, UPI, NEFT, RTGS or account-payee cheque. Profit is 8% of cash plus 6% of digital. Leave both blank to enter business profit yourself.</div></div>' +
      '<div class="grid grid-2 mb-4"><div class="field mb-0"><label for="ps-cash">Cash turnover (₹)</label><input id="ps-cash" inputmode="decimal" data-change="presum" data-f="cash" value="' + esc(toInput(ps.cash)) + '" placeholder="0.00"></div>' +
      '<div class="field mb-0"><label for="ps-dig">Digital turnover (₹)</label><input id="ps-dig" inputmode="decimal" data-change="presum" data-f="digital" value="' + esc(toInput(ps.digital)) + '" placeholder="0.00"></div></div>';
  }
  function taxCard(m) {
    const t = m.tax;
    if (!t.rows) return '<div class="card"><div class="sched-head"><h4>Tax computation</h4></div><p class="muted mb-0">' + esc(t.reason) + '</p></div>';
    const strong = ['Total tax liability', 'Net tax payable (rounded to ₹10)', 'Refund due (rounded to ₹10)', 'Total income (rounded to ₹10)'];
    return '<div class="card"><div class="sched-head"><h4>Tax computation</h4><span class="badge ' + (t.provisional ? 'badge-partial' : 'badge-info') + '">' + (t.provisional ? 'Provisional' : esc(t.label)) + '</span></div>' +
      (t.provisional ? '<div class="notice warning mb-4"><span class="material-symbols-outlined">warning</span><div>' + esc(t.reason) + '</div></div>' : '') +
      '<div class="table-wrap"><table><tbody>' + t.rows.map(r => '<tr class="' + (strong.indexOf(r[0]) >= 0 ? 'total-row' : '') + '"><td>' + esc(r[0]) + '</td><td class="num">' + inr(r[1]) + '</td></tr>').join('') + '</tbody></table></div>' +
      t.warn.map(w => '<div class="notice warning mt-4"><span class="material-symbols-outlined">warning</span><div>' + esc(w) + '</div></div>').join('') +
      '<p class="muted mt-4 mb-0">' + esc(t.label) + '. ' + esc(t.notes) + ' Interest under sections 234A, 234B and 234C is not calculated.</p></div>';
  }
  const treatOpts = sel => Object.keys(E.BUCKETS).map(k => '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + esc(E.BUCKETS[k]) + '</option>').join('');

  /* ---------- Missing information ---------- */
  function renderMissing() {
    const el = $('#view-missing'), m = model(), open = m.missing.filter(x => !x.resolved).length;
    el.innerHTML = '<div class="card"><div class="card-title"><h4>Missing information</h4><div class="flex gap-2 items-center"><span class="badge ' + (open ? 'badge-partial' : 'badge-paid') + '">' + open + ' open</span><button class="btn btn-outline btn-sm" data-action="addMissing"><span class="material-symbols-outlined">add</span>Add item</button></div></div>' +
      (m.missing.length ? '<div class="table-wrap"><table><thead><tr><th>Done</th><th>Item</th><th>Schedule</th><th>Why it is needed</th><th>Document to request</th></tr></thead><tbody>' +
        m.missing.map(x => '<tr class="' + (x.resolved ? 'excluded' : '') + '"><td><input type="checkbox" style="width:20px;min-height:20px" data-change="miss" data-key="' + esc(x.key) + '"' + (x.resolved ? ' checked' : '') + ' aria-label="Mark resolved"></td><td class="line-desc">' + esc(x.field) + '</td><td>' + esc(x.sched) + '</td><td class="small">' + esc(x.reason) + '</td><td class="small">' + esc(x.doc) + '</td></tr>').join('') + '</tbody></table></div>'
        : empty('task_alt', 'Nothing missing', 'Items appear here when uploaded data is not enough to complete a line.')) + '</div>';
  }

  /* ---------- Review and export ---------- */
  function renderReview() {
    const el = $('#view-review'), m = model();
    const unresolved = m.rr.filter(r => r.needs).length, openMiss = m.missing.filter(x => !x.resolved).length;
    const items = [
      [E.hasKind(state, 'AIS') && E.hasKind(state, 'TIS'), 'AIS and TIS both uploaded'],
      [unresolved === 0, unresolved + ' reconciliation item(s) unresolved'],
      [m.unclassified.length === 0, m.unclassified.length + ' unclassified record(s)'],
      [m.incomplete === 0, m.incomplete + ' incomplete computation line(s)'],
      [m.needsReview === 0, m.needsReview + ' line(s) not yet marked reviewed'],
      [openMiss === 0, openMiss + ' missing-information item(s) open'],
      [!!m.tax.supported, m.tax.supported ? 'Tax calculated with FY 2025-26 new-regime rules. Verify the assumptions.' : 'Tax is not final: ' + m.tax.reason]
    ];
    const ready = items.slice(0, 6).every(i => i[0]);
    const hist = state.exports.length ? '<div class="table-wrap"><table><thead><tr><th>When</th><th>Format</th><th>Status at export</th></tr></thead><tbody>' + state.exports.slice().reverse().map(x => '<tr><td>' + fmtTs(x.ts) + '</td><td>' + x.fmt + '</td><td>' + esc(x.status) + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="muted mb-0">No reports generated yet.</p>';
    el.innerHTML = '<div class="card"><div class="card-title"><h4>Review checklist</h4><span class="badge ' + (ready ? 'badge-paid' : 'badge-partial') + '">' + (ready ? 'Ready for professional review' : 'Not ready') + '</span></div><ul class="checklist">' +
      items.map(i => '<li><span class="material-symbols-outlined ' + (i[0] ? 'ok' : 'bad') + '">' + (i[0] ? 'check_circle' : 'error') + '</span><div>' + esc(i[1]) + '</div></li>').join('') + '</ul></div>' +
      '<div class="card"><div class="card-title"><h4>Export</h4></div><div class="notice warning mb-4"><span class="material-symbols-outlined">edit_note</span><div>Every export is labelled as a draft preliminary computation, whatever the checklist says.</div></div>' +
      '<div class="grid grid-2"><div class="field"><label for="rvName">Reviewed by</label><input id="rvName" data-change="rv-name" value="' + esc(state.review.name) + '" placeholder="Name of reviewer"></div><div class="field"><label for="rvNotes">Review notes</label><textarea id="rvNotes" data-change="rv-notes" placeholder="Notes to print on the report">' + esc(state.review.notes) + '</textarea></div></div>' +
      '<div class="flex gap-2 wrap"><button class="btn btn-primary" data-action="exportXlsx"><span class="material-symbols-outlined">table_chart</span>Excel</button><button class="btn btn-primary" data-action="exportDoc"><span class="material-symbols-outlined">article</span>Word</button><button class="btn btn-primary" data-action="exportPdf"><span class="material-symbols-outlined">picture_as_pdf</span>PDF</button></div>' +
      '<p class="muted mt-4 mb-0">Word opens as a .doc file. For PDF, the print window opens: choose "Save as PDF" as the printer. Turn on headers and footers there to get page numbers.</p></div>' +
      '<div class="card"><div class="card-title"><h4>Report history</h4></div>' + hist + '</div>';
  }

  /* ---------- Audit ---------- */
  function renderAudit() {
    const el = $('#view-audit');
    const rows = state.audit.slice().reverse();
    el.innerHTML = '<div class="card"><div class="card-title"><h4>Audit trail</h4><span class="muted">' + rows.length + ' event(s)</span></div>' +
      (rows.length ? '<div class="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>Item</th><th>Previous</th><th>New</th><th>Reason</th></tr></thead><tbody>' +
        rows.slice(0, 500).map(a => '<tr><td class="nowrap">' + fmtTs(a.ts) + '</td><td class="line-desc">' + esc(a.action) + '</td><td class="small">' + esc(a.entity) + '</td><td class="small num">' + fmtVal(a.prev) + '</td><td class="small num">' + fmtVal(a.next) + '</td><td class="small">' + esc(a.reason || '—') + '</td></tr>').join('') + '</tbody></table></div>'
        : empty('history', 'No changes yet', 'Uploads, manual edits and decisions are recorded here with the previous and new value.')) + '</div>';
  }

  /* ---------- Dialogs ---------- */
  function openDlg(title, body, foot) {
    const d = $('#dlg');
    d.innerHTML = '<div class="dlg-head"><h4 id="dlgTitle">' + esc(title) + '</h4><button class="icon-btn" data-action="closeDlg" aria-label="Close"><span class="material-symbols-outlined">close</span></button></div><div class="dlg-body">' + body + '</div><div class="dlg-foot">' + foot + '</div>';
    if (!d.open) d.showModal();
  }
  const closeDlg = () => { const d = $('#dlg'); if (d.open) d.close(); };
  const errBox = () => '<div class="field-error" id="dlgErr" role="alert"></div>';
  const showErr = msg => { $('#dlgErr').textContent = msg; };

  function editDialog(key) {
    const l = model().lines.find(x => x.key === key); if (!l) return;
    const hist = state.audit.filter(a => a.entity === key).reverse().slice(0, 8);
    const custom = state.custom.find(c => c.key === key);
    let body = '<dl class="kv"><dt>Schedule</dt><dd>' + esc(l.sched) + '</dd><dt>Original extracted</dt><dd>' + inr(l.extracted) + '</dd><dt>Calculated</dt><dd>' + inr(l.calc) + '</dd><dt>Calculation</dt><dd>' + esc(l.method) + '</dd><dt>Source records</dt><dd>' + (l.sources.length ? l.sources.join(', ') : '—') + '</dd></dl>';
    if (custom) body += '<div class="field"><label for="ed-head">Schedule</label><select id="ed-head" data-toggle="ed-treat-wrap:Capital gains,ed-spec-wrap:Business or profession">' + E.SCHEDULES.map(s => '<option' + (s === custom.head ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></div><div class="field' + (custom.head === 'Capital gains' ? '' : ' hidden') + '" id="ed-treat-wrap"><label for="ed-treat">Tax treatment of this gain</label><select id="ed-treat">' + treatOpts(custom.treat || 'SSLAB') + '</select></div><div class="field' + (custom.head === 'Business or profession' ? '' : ' hidden') + '" id="ed-spec-wrap"><label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="ed-spec" style="width:20px;min-height:20px"' + (custom.spec ? ' checked' : '') + '> Speculative business (intraday equity)</label></div><div class="field"><label for="ed-desc">Description</label><input id="ed-desc" value="' + esc(custom.desc) + '"></div>';
    body += '<div class="field"><label for="ed-amt">' + (custom ? 'Amount (₹)' : 'Manual amount (₹). Leave blank to use the calculated amount') + '</label><input id="ed-amt" inputmode="decimal" value="' + esc(custom ? toInput(custom.amount) : (l.adj ? toInput(l.adj.amount) : '')) + '" placeholder="0.00"></div>' +
      '<div class="field"><label for="ed-reason">Reason for change</label><textarea id="ed-reason" placeholder="Why is the amount changed? For example: per Form 16">' + esc(custom ? custom.reason : (l.adj ? l.adj.reason : '')) + '</textarea></div>' + errBox();
    if (!custom) body += '<label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="ed-rev" style="width:20px;min-height:20px"' + (l.adj && l.adj.reviewed ? ' checked' : '') + '> Mark this line as reviewed</label>';
    if (hist.length) body += '<h4 class="mt-5" style="font-size:16px">History</h4><div class="small">' + hist.map(a => '<div>' + fmtTs(a.ts) + ': ' + esc(a.action) + ', ' + fmtVal(a.prev) + ' to ' + fmtVal(a.next) + (a.reason ? ' (' + esc(a.reason) + ')' : '') + '</div>').join('') + '</div>';
    const foot = (custom ? '<button class="btn btn-danger btn-sm" data-action="removeLine" data-key="' + esc(key) + '">Remove line</button>' : (l.adj && l.adj.amount !== null && l.adj.amount !== undefined ? '<button class="btn btn-outline" data-action="restoreLine" data-key="' + esc(key) + '">Restore original</button>' : '')) +
      '<button class="btn btn-outline" data-action="closeDlg">Cancel</button><button class="btn btn-primary" data-action="saveEdit" data-key="' + esc(key) + '">Save changes</button>';
    openDlg(l.desc, body, foot);
  }
  function saveEdit(key) {
    const m = model(), l = m.lines.find(x => x.key === key), custom = state.custom.find(c => c.key === key);
    const allowNeg = E.ALLOW_NEG.indexOf(custom ? $('#ed-head').value : l.sched) >= 0;
    const a = parseAmt($('#ed-amt').value, allowNeg);
    if (!a.ok) return showErr(a.msg);
    const reason = $('#ed-reason').value.trim();
    if (custom) {
      if (a.p === null) return showErr('Enter an amount.');
      const desc = $('#ed-desc').value.trim(); if (!desc) return showErr('Enter a description.');
      if (a.p !== custom.amount) audit('Custom line amount changed', key, custom.amount, a.p, reason);
      custom.amount = a.p; custom.desc = desc; custom.head = $('#ed-head').value; custom.reason = reason; custom.treat = custom.head === 'Capital gains' ? $('#ed-treat').value : undefined; custom.spec = custom.head === 'Business or profession' ? $('#ed-spec').checked : undefined;
    } else {
      const adj = state.adjust[key] || { amount: null, reason: '', reviewed: false };
      const rev = $('#ed-rev').checked;
      if (a.p !== adj.amount) audit('Manual adjustment', key, l.final, a.p === null ? l.calc : a.p, reason);
      if (rev !== adj.reviewed) audit(rev ? 'Marked reviewed' : 'Review cleared', key, null, null, '');
      adj.amount = a.p; adj.reason = reason; adj.reviewed = rev;
      if (adj.amount === null && !adj.reason && !adj.reviewed) delete state.adjust[key]; else state.adjust[key] = adj;
    }
    closeDlg(); render();
  }
  function addLineDialog(sched) {
    const body = '<div class="field"><label for="al-head">Schedule</label><select id="al-head" data-toggle="al-treat-wrap:Capital gains,al-spec-wrap:Business or profession">' + E.SCHEDULES.map(s => '<option' + (s === sched ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></div>' +
      '<div class="field' + (sched === 'Capital gains' ? '' : ' hidden') + '" id="al-treat-wrap"><label for="al-treat">Tax treatment of this gain</label><select id="al-treat">' + treatOpts('S111A') + '</select></div>' +
      '<div class="field' + (sched === 'Business or profession' ? '' : ' hidden') + '" id="al-spec-wrap"><label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="al-spec" style="width:20px;min-height:20px"> Speculative business (intraday equity). A loss cannot be set off against other income.</label></div>' +
      '<div class="field"><label for="al-desc">Description</label><input id="al-desc" placeholder="For example: Rent from shop"></div><div class="field"><label for="al-amt">Amount (₹)</label><input id="al-amt" inputmode="decimal" placeholder="0.00"></div>' +
      '<div class="field"><label for="al-reason">Reason or source</label><textarea id="al-reason" placeholder="Where does this figure come from?"></textarea></div>' + errBox();
    openDlg('Add a line', body, '<button class="btn btn-outline" data-action="closeDlg">Cancel</button><button class="btn btn-primary" data-action="saveLine">Add line</button>');
  }
  function saveLine() {
    const head = $('#al-head').value, desc = $('#al-desc').value.trim();
    if (!desc) return showErr('Enter a description.');
    const a = parseAmt($('#al-amt').value, E.ALLOW_NEG.indexOf(head) >= 0);
    if (!a.ok) return showErr(a.msg); if (a.p === null) return showErr('Enter an amount.');
    const reason = $('#al-reason').value.trim(), key = 'custom:' + (state.customSeq++);
    state.custom.push({ key: key, head: head, desc: desc, amount: a.p, reason: reason, treat: head === 'Capital gains' ? $('#al-treat').value : undefined, spec: head === 'Business or profession' ? $('#al-spec').checked : undefined });
    audit('Line added', key, null, a.p, desc + (reason ? ' — ' + reason : ''));
    closeDlg(); render();
  }
  function addMissingDialog() {
    const body = '<div class="field"><label for="am-sched">Schedule</label><select id="am-sched"><option>All</option>' + E.SCHEDULES.map(s => '<option>' + s + '</option>').join('') + '</select></div>' +
      '<div class="field"><label for="am-field">What is missing</label><input id="am-field" placeholder="For example: Bank interest certificate"></div><div class="field"><label for="am-reason">Why it is needed</label><textarea id="am-reason"></textarea></div>' +
      '<div class="field"><label for="am-doc">Document to request</label><input id="am-doc"></div>' + errBox();
    openDlg('Add missing information', body, '<button class="btn btn-outline" data-action="closeDlg">Cancel</button><button class="btn btn-primary" data-action="saveMissing">Add item</button>');
  }
  function resolveDialog(cat) {
    const r = model().byCat[cat]; if (!r) return;
    const body = '<dl class="kv"><dt>Category</dt><dd>' + esc(CATS[cat].label) + '</dd><dt>AIS total</dt><dd>' + inr(r.AIS.sum) + ' (' + r.AIS.n + ')</dd><dt>TIS total</dt><dd>' + inr(r.TIS.sum) + ' (' + r.TIS.n + ')</dd><dt>Difference</dt><dd>' + (r.diff === null ? '—' : inr(r.diff)) + '</dd><dt>Currently using</dt><dd>' + r.basis + ' · ' + inr(r.used) + '</dd></dl>' +
      '<div class="field"><label for="rs-note">Decision note</label><textarea id="rs-note" placeholder="Why is this source correct?"></textarea></div>';
    openDlg('Resolve ' + CATS[cat].label, body, '<button class="btn btn-outline" data-action="closeDlg">Cancel</button><button class="btn btn-primary" data-action="saveResolve" data-cat="' + cat + '">Confirm decision</button>');
  }

  /* ---------- Reports ---------- */
  const STATUS_TEXT = () => { const m = model(); return m.incomplete || m.missing.some(x => !x.resolved) ? 'Draft, incomplete' : 'Draft, pending review'; };
  function reportHTML() {
    const m = model(), tp = state.taxpayer;
    const tbl = (head, rows, numFrom) => '<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;width:100%;margin-bottom:12px"><thead><tr style="background:#E9ECF8">' + head.map((x, i) => '<th style="text-align:' + (i >= numFrom ? 'right' : 'left') + '">' + esc(x) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map((x, i) => '<td style="text-align:' + (i >= numFrom ? 'right' : 'left') + '">' + x + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    let h = '<style>@page{@bottom-right{content:"Page " counter(page) " of " counter(pages)}} #print-report h2{color:#3A4DA1;margin:0 0 4px} #print-report h3{color:#3A4DA1;margin:14px 0 6px;font-size:13px}</style>' +
      '<div style="border:2px solid #B93232;color:#B93232;padding:6px 10px;font-weight:bold;margin-bottom:10px">DRAFT — PRELIMINARY RAW COMPUTATION. Not reviewed unless stated below. Not a final or filed return.</div>' +
      '<h2>Raw income-tax computation</h2><div style="margin-bottom:8px">Status: ' + STATUS_TEXT() + ' · Generated ' + fmtTs(new Date().toISOString()) + '</div>' +
      tbl(['Taxpayer details', ''], [['Name', esc(tp.name || '—')], ['PAN', esc(tp.pan || '—')], ['Financial year', esc(state.fy)], ['Assessment year', E.ayOf(state.fy)], ['Reviewed by', esc(state.review.name || 'Not reviewed')]], 1);
    E.SCHEDULES.forEach(s => {
      const ls = m.lines.filter(l => l.sched === s); if (!ls.length) return;
      h += '<h3>' + s + '</h3>' + tbl(['Line', 'Extracted', 'Calculated', 'Manual', 'Final', 'Status'], ls.map(l => [esc(l.desc) + '<br><small>' + esc(l.method) + (l.sources.length ? ' · Records ' + l.sources.slice(0, 8).join(', ') + (l.sources.length > 8 ? '…' : '') : '') + '</small>', inr(l.extracted), inr(l.calc), l.adj && l.adj.amount != null ? inr(l.adj.amount) : '—', inr(l.final), l.status]), 1);
    });
    h += '<h3>Summary</h3>' + tbl(['Item', 'Amount'], Object.keys(m.heads).map(k => [k, inr(m.heads[k])]).concat([['Gross total income', '<b>' + inr(m.gti) + '</b>'], ['Less: deductions', inr(m.ded)], ['Total income', '<b>' + inr(m.ti) + '</b>'], ['TDS, TCS and other credits', inr(m.credits)]]), 1);
    h += '<h3>Tax computation</h3>' + (m.tax.rows ? (m.tax.provisional ? '<p><b>Provisional:</b> ' + esc(m.tax.reason) + '</p>' : '') + tbl(['Item', 'Amount'], m.tax.rows.map(r => [esc(r[0]), inr(r[1])]), 1) + '<p><small>' + esc(m.tax.label) + '. ' + esc(m.tax.notes) + '</small></p>' : '<p>' + esc(m.tax.reason) + '</p>');
    h += '<h3>Reconciliation summary</h3>' + tbl(['Category', 'AIS', 'TIS', 'Difference', 'Status', 'Used'], m.rr.map(r => [esc(CATS[r.cat].label), r.AIS.n ? inr(r.AIS.sum) : '—', r.TIS.n ? inr(r.TIS.sum) : '—', r.diff === null ? '—' : inr(r.diff), r.status + (r.dec.resolved ? ' (resolved)' : ''), r.basis + ' ' + inr(r.used)]), 1);
    const open = m.missing.filter(x => !x.resolved);
    h += '<h3>Outstanding issues and missing documents</h3>' + (open.length ? tbl(['Item', 'Schedule', 'Why needed', 'Document'], open.map(x => [esc(x.field), esc(x.sched), esc(x.reason), esc(x.doc)]), 99) : '<p>None recorded.</p>');
    if (m.unclassified.length) h += '<h3>Unclassified information</h3>' + tbl(['Description', 'Entity', 'Amount'], m.unclassified.slice(0, 50).map(r => [esc(r.desc), esc(r.entity), inr(E.effAmt(r))]), 2);
    const adjs = state.audit.filter(a => /Manual adjustment|Custom line|Line added|Line removed|Restore/.test(a.action));
    if (adjs.length) h += '<h3>Manual adjustments</h3>' + tbl(['When', 'Action', 'Item', 'Previous', 'New', 'Reason'], adjs.map(a => [fmtTs(a.ts), esc(a.action), esc(a.entity), fmtVal(a.prev), fmtVal(a.next), esc(a.reason || '—')]), 99);
    h += '<h3>Review notes</h3><p>' + (esc(state.review.notes) || 'None.') + '</p>';
    h += '<h3>Documents used</h3>' + tbl(['File', 'Kind', 'Status', 'Records', 'Financial year found'], state.docs.map(d => [esc(d.name), d.kind, d.status, String(d.count), esc(d.fy || '—')]), 99);
    return h;
  }
  const fileBase = () => 'Raw-computation_' + (state.taxpayer.name || 'case').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 30) + '_FY' + state.fy;
  function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
  function logExport(fmt) { state.exports.push({ ts: new Date().toISOString(), fmt: fmt, status: STATUS_TEXT() }); audit('Report generated', 'export', null, fmt); render(); }
  function exportDoc() {
    const html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>Raw computation</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:10pt}table{font-size:9pt}</style></head><body><div id="print-report">' + reportHTML() + '</div></body></html>';
    download(new Blob(['\ufeff', html], { type: 'application/msword' }), fileBase() + '.doc'); logExport('Word');
  }
  function exportPdf() { $('#print-report').innerHTML = reportHTML(); logExport('PDF (print)'); setTimeout(() => window.print(), 100); }
  function exportXlsx() {
    if (!window.XLSX) return toast('The Excel library did not load. Check your internet connection and reload the page.');
    const m = model(), X = window.XLSX, wb = X.utils.book_new(), n = p => p === null || p === undefined ? '' : p / 100;
    const sheet = (name, aoa, widths) => { const ws = X.utils.aoa_to_sheet(aoa); ws['!cols'] = (widths || aoa[0].map(() => 22)).map(w => ({ wch: w })); X.utils.book_append_sheet(wb, ws, name); return ws; };
    sheet('Taxpayer', [['DRAFT — preliminary raw computation, not a final or filed return', ''], ['Name', state.taxpayer.name], ['PAN', state.taxpayer.pan], ['Financial year', state.fy], ['Assessment year', E.ayOf(state.fy)], ['Status', STATUS_TEXT()], ['Reviewed by', state.review.name || 'Not reviewed'], ['Review notes', state.review.notes]], [28, 60]);
    ['AIS', 'TIS'].forEach(src => sheet(src + ' records', [['ID', 'Category', 'Description', 'Entity', 'Code', 'Date', 'Reported (₹)', 'Processed (₹)', 'Accepted (₹)', 'Excluded', 'Rule', 'Location']].concat(state.records.filter(r => r.source === src).map(r => [r.id, CATS[r.cat].label, r.desc, r.entity, r.code, r.date || r.dateRaw, n(r.reported), n(r.processed), n(r.accepted), r.excluded ? 'Yes' : '', r.ruleId, r.loc])), [8, 28, 40, 28, 12, 12, 16, 16, 16, 9, 8, 18]));
    sheet('Reconciliation', [['Category', 'AIS (₹)', 'TIS (₹)', 'Difference (₹)', 'Status', 'Source used', 'Amount used (₹)', 'Resolved', 'Note']].concat(m.rr.map(r => [CATS[r.cat].label, r.AIS.n ? n(r.AIS.sum) : '', r.TIS.n ? n(r.TIS.sum) : '', r.diff === null ? '' : n(r.diff), r.status, r.basis, n(r.used), r.dec.resolved ? 'Yes' : '', r.dec.note || ''])), [32, 16, 16, 16, 16, 12, 16, 10, 40]);
    sheet('Income schedules', [['Schedule', 'Line', 'Extracted (₹)', 'Calculated (₹)', 'Manual (₹)', 'Final (₹)', 'Status', 'Calculation']].concat(m.lines.filter(l => ['Capital gains', 'Tax credits'].indexOf(l.sched) < 0 || l.key === 'cg:net').map(l => [l.sched, l.desc, n(l.extracted), n(l.calc), l.adj && l.adj.amount != null ? n(l.adj.amount) : '', n(l.final), l.status, l.method]))
      .concat([[], ['Gross total income', '', '', '', '', n(m.gti)], ['Deductions', '', '', '', '', n(m.ded)], ['Total income', '', '', '', '', n(m.ti)]]), [24, 50, 16, 16, 14, 16, 14, 60]);
    sheet('Tax computation', [[m.tax.rows ? m.tax.label + (m.tax.provisional ? ' (PROVISIONAL)' : '') : m.tax.reason, '']].concat((m.tax.rows || []).map(r => [r[0], n(r[1])])), [64, 18]);
    const cgRows = m.lines.filter(l => l.sched === 'Capital gains' && l.key.indexOf('cg:') === 0 && l.key !== 'cg:net');
    const ws = sheet('Capital gains', [['Sale', 'Proceeds (₹)', 'Cost (₹)', 'Expenses (₹)', 'Term', 'Gain (₹)', 'Status']].concat(m.cgItems.map(it => { const cg = state.cg[it.id] || {}, l = m.lines.find(x => x.key === 'cg:' + it.id); return [it.desc, n(it.proceeds), n(cg.cost), n(cg.exp), cg.type === 'ST' ? 'Short-term' : cg.type === 'LT' ? 'Long-term' : '', n(l.final), l.status]; })), [50, 16, 16, 16, 12, 16, 14]);
    if (cgRows.length) { const last = cgRows.length + 1; ws['!ref'] = 'A1:G' + (last + 1); ws['A' + (last + 1)] = { t: 's', v: 'Total of completed gains' }; ws['F' + (last + 1)] = { t: 'n', f: 'SUM(F2:F' + last + ')', v: cgRows.reduce((a, l) => a + (l.final || 0), 0) / 100 }; }
    const cr = m.lines.filter(l => l.sched === 'Tax credits');
    const ws2 = sheet('Tax credits', [['Credit', 'Final (₹)', 'Status']].concat(cr.map(l => [l.desc, n(l.final), l.status])), [40, 18, 14]);
    if (cr.length) { ws2['!ref'] = 'A1:C' + (cr.length + 2); ws2['A' + (cr.length + 2)] = { t: 's', v: 'Total' }; ws2['B' + (cr.length + 2)] = { t: 'n', f: 'SUM(B2:B' + (cr.length + 1) + ')', v: m.credits / 100 }; }
    sheet('Missing information', [['Item', 'Schedule', 'Why needed', 'Document', 'Resolved']].concat(m.missing.map(x => [x.field, x.sched, x.reason, x.doc, x.resolved ? 'Yes' : 'No'])), [44, 22, 60, 40, 10]);
    sheet('Audit adjustments', [['When', 'Action', 'Item', 'Previous', 'New', 'Reason']].concat(state.audit.map(a => [fmtTs(a.ts), a.action, a.entity, typeof a.prev === 'number' ? a.prev / 100 : (a.prev === null ? '' : String(a.prev)), typeof a.next === 'number' ? a.next / 100 : (a.next === null ? '' : String(a.next)), a.reason])), [20, 28, 24, 24, 24, 40]);
    X.writeFile(wb, fileBase() + '.xlsx'); logExport('Excel');
  }

  /* ---------- Events ---------- */
  document.addEventListener('click', e => {
    const nav = e.target.closest('#nav a'); if (nav) { e.preventDefault(); go(nav.dataset.view); return; }
    const dz = e.target.closest('.dropzone'); if (dz) { if (e.target.tagName !== 'INPUT') dz.querySelector('input').click(); return; }
    const t = e.target.closest('[data-action]'); if (!t) return;
    const a = t.dataset.action, d = t.dataset, rf = state.ui.rf;
    if (a === 'go') go(d.view);
    else if (a === 'sample') loadSample();
    else if (a === 'clear') { if (confirm('Remove all documents, records, edits and the audit trail from this browser?')) { state = fresh(); files.clear(); try { localStorage.removeItem(KEY); } catch (x) { } $('#pdfPw').value = ''; render(); toast('All data cleared.'); } }
    else if (a === 'retry') { const doc = state.docs.find(x => x.id === d.id); processDoc(doc, $('#pdfPw').value).then(render); }
    else if (a === 'removeDoc') { const doc = state.docs.find(x => x.id === d.id); if (doc && confirm('Remove ' + doc.name + ' and the ' + doc.count + ' records read from it?')) { state.records = state.records.filter(r => r.docId !== doc.id); state.docs = state.docs.filter(x => x !== doc); files.delete(doc.id); audit('Document removed', 'document:' + doc.id, doc.name, null); render(); } }
    else if (a === 'toggleExclude') { const r = state.records.find(x => x.id === d.id); r.excluded = !r.excluded; audit(r.excluded ? 'Record excluded' : 'Record included', r.id, null, null, r.desc); render(); }
    else if (a === 'page') { rf.page += +d.d; renderRecTable(); }
    else if (a === 'clearIds') { rf.ids = null; render(); }
    else if (a === 'showCat') { rf.cat = d.cat; rf.src = ''; rf.flag = ''; rf.q = ''; rf.ids = null; rf.page = 1; go('records'); }
    else if (a === 'showIds') { const l = model().lines.find(x => x.key === d.key); rf.ids = l.sources; rf.cat = ''; rf.src = ''; rf.flag = ''; rf.q = ''; rf.page = 1; go('records'); }
    else if (a === 'editLine') editDialog(d.key);
    else if (a === 'saveEdit') saveEdit(d.key);
    else if (a === 'restoreLine') { const adj = state.adjust[d.key]; if (adj) { audit('Restore original', d.key, adj.amount, null, 'Manual amount removed'); adj.amount = null; adj.reason = ''; if (!adj.reviewed) delete state.adjust[d.key]; } closeDlg(); render(); }
    else if (a === 'removeLine') { const c = state.custom.find(x => x.key === d.key); audit('Line removed', d.key, c.amount, null, c.desc); state.custom = state.custom.filter(x => x !== c); closeDlg(); render(); }
    else if (a === 'toggleRev') { const adj = state.adjust[d.key] || { amount: null, reason: '', reviewed: false }; adj.reviewed = !adj.reviewed; state.adjust[d.key] = adj; audit(adj.reviewed ? 'Marked reviewed' : 'Review cleared', d.key); render(); }
    else if (a === 'addLine') addLineDialog(d.sched);
    else if (a === 'saveLine') saveLine();
    else if (a === 'addMissing') addMissingDialog();
    else if (a === 'saveMissing') {
      const f = $('#am-field').value.trim(); if (!f) return showErr('Describe what is missing.');
      const key = 'manual:' + (state.missSeq++);
      state.missingManual.push({ key: key, sched: $('#am-sched').value, field: f, reason: $('#am-reason').value.trim() || '—', doc: $('#am-doc').value.trim() || '—' });
      audit('Missing item added', key, null, f); closeDlg(); render();
    }
    else if (a === 'resolveRecon') resolveDialog(d.cat);
    else if (a === 'saveResolve') { const dec = state.recon[d.cat] || {}; dec.resolved = true; dec.note = $('#rs-note').value.trim(); state.recon[d.cat] = dec; audit('Reconciliation resolved', 'recon:' + d.cat, null, dec.basis || 'default source', dec.note); closeDlg(); render(); }
    else if (a === 'exportXlsx') exportXlsx();
    else if (a === 'exportDoc') exportDoc();
    else if (a === 'exportPdf') exportPdf();
    else if (a === 'closeDlg') closeDlg();
  });
  document.addEventListener('keydown', e => {
    const dz = e.target.closest && e.target.closest('.dropzone');
    if (dz && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); dz.querySelector('input').click(); }
  });
  document.addEventListener('input', e => { if (e.target.id === 'f-q') { state.ui.rf.q = e.target.value; state.ui.rf.page = 1; renderRecTable(); } });
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.type === 'file') { const kind = t.closest('.dropzone').dataset.kind; addFiles(t.files, kind).then(() => { t.value = ''; }); return; }
    if (t.dataset.toggle) { t.dataset.toggle.split(',').forEach(p => { const kv = p.split(':'), w = $('#' + kv[0]); if (w) w.classList.toggle('hidden', t.value !== kv[1]); }); return; }
    const c = t.dataset.change; if (!c) return; const rf = state.ui.rf;
    if (c === 'name') { state.taxpayer.name = t.value.trim(); render(); }
    else if (c === 'pan') { state.taxpayer.pan = t.value.trim().toUpperCase(); if (state.taxpayer.pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(state.taxpayer.pan)) toast('PAN format looks wrong. It should be like ABCDE1234F.'); render(); }
    else if (c === 'fy') { audit('Financial year changed', 'case', state.fy, t.value); state.fy = t.value; state.fyAuto = false; render(); }
    else if (c === 'rf-src') { rf.src = t.value; rf.page = 1; renderRecTable(); }
    else if (c === 'rf-cat') { rf.cat = t.value; rf.page = 1; renderRecTable(); }
    else if (c === 'rf-flag') { rf.flag = t.value; rf.page = 1; renderRecTable(); }
    else if (c === 'cat') { const r = state.records.find(x => x.id === t.dataset.id); audit('Classification changed', r.id, CATS[r.cat].label, CATS[t.value].label, r.desc); r.cat = t.value; r.ruleId = 'MANUAL'; r.ruleNote = 'Set by reviewer'; render(); }
    else if (c === 'basis') { const cat = t.dataset.cat, dec = state.recon[cat] || {}; audit('Reconciliation source changed', 'recon:' + cat, dec.basis || 'default', t.value); dec.basis = t.value; dec.resolved = false; if (t.value === 'MANUAL' && dec.manual === undefined) dec.manual = 0; state.recon[cat] = dec; render(); }
    else if (c === 'manual') { const a = parseAmt(t.value, false); if (!a.ok || a.p === null) { toast(a.msg || 'Enter an amount.'); render(); return; } const dec = state.recon[t.dataset.cat]; audit('Manual category amount', 'recon:' + t.dataset.cat, dec.manual, a.p); dec.manual = a.p; render(); }
    else if (c === 'cg') {
      const id = t.dataset.id, f = t.dataset.f, cg = state.cg[id] || {};
      if (f === 'type') { audit('Capital-gain term', 'cg:' + id, cg.type || null, t.value || null); cg.type = t.value || undefined; }
      else if (f === 'treat') { audit('Capital-gain tax treatment', 'cg:' + id, cg.treat || null, t.value); cg.treat = t.value; }
      else { const a = parseAmt(t.value, false); if (!a.ok) { toast(a.msg); render(); return; } audit('Capital-gain ' + (f === 'cost' ? 'cost' : 'expenses'), 'cg:' + id, cg[f] === undefined ? null : cg[f], a.p); if (a.p === null) delete cg[f]; else cg[f] = a.p; }
      state.cg[id] = cg; render();
    }
    else if (c === 'tismode') { audit('TIS amount basis changed', 'case', state.tisMode, t.value); state.tisMode = t.value; render(); }
    else if (c === 'presum') { const a = parseAmt(t.value, false); if (!a.ok) { toast(a.msg); render(); return; } const f = t.dataset.f; audit('Section 44AD turnover (' + f + ')', 'presum', state.presum[f], a.p); state.presum[f] = a.p; render(); }
    else if (c === 'miss') { const k = t.dataset.key; if (t.checked) state.missingResolved[k] = true; else delete state.missingResolved[k]; audit(t.checked ? 'Missing item resolved' : 'Missing item reopened', k); render(); }
    else if (c === 'rv-name') { state.review.name = t.value.trim(); save(); }
    else if (c === 'rv-notes') { state.review.notes = t.value.trim(); save(); }
  });
  ['dragover', 'dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => {
    const dz = e.target.closest && e.target.closest('.dropzone'); if (!dz) return;
    e.preventDefault();
    dz.classList.toggle('over', ev === 'dragover');
    if (ev === 'drop') addFiles(e.dataTransfer.files, dz.dataset.kind);
  }));
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
  $('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  go(state.view && TITLES[state.view] ? state.view : 'upload');
})();
