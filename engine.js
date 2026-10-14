/* ==========================================================
   engine.js — parsing, classification, reconciliation, computation.
   No DOM access, so it can be tested in Node.
   All money is held as integer paise (no floating point).
   AIS / TIS file layouts are NOT verified: parsers are heuristic.
   ========================================================== */
(function (root) {
  'use strict';

  const PARSER_VERSION = '0.1-unverified';

  /* ---------- Money ---------- */
  function toPaise(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'boolean' || typeof v === 'object') return null;
    if (typeof v === 'number') { if (!isFinite(v)) return null; v = v.toFixed(4); }
    let s = String(v).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[₹,\s]|rs\.?|inr/gi, '');
    if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    const parts = s.split('.');
    const f = parts[1] || '';
    let paise = parseInt(parts[0], 10) * 100 + parseInt((f + '00').slice(0, 2), 10);
    if (f.length > 2 && parseInt(f[2], 10) >= 5) paise += 1;
    return neg ? -paise : paise;
  }
  function inr(p) {
    if (p === null || p === undefined) return '—';
    const a = Math.abs(p);
    const whole = Math.floor(a / 100);
    const frac = String(a % 100).padStart(2, '0');
    return (p < 0 ? '-' : '') + '₹' + new Intl.NumberFormat('en-IN').format(whole) + '.' + frac;
  }
  function toInput(p) {
    if (p === null || p === undefined) return '';
    const a = Math.abs(p);
    return (p < 0 ? '-' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
  }

  /* ---------- Financial year helpers ---------- */
  function ayOf(fy) { const y = parseInt(fy.slice(0, 4), 10); return (y + 1) + '-' + String(y + 2).slice(2); }
  function fyOptions() { const o = []; for (let y = 2018; y <= 2026; y++) o.push(y + '-' + String(y + 1).slice(2)); return o; }
  function inFY(iso, fy) {
    if (!iso) return true;
    const y = parseInt(fy.slice(0, 4), 10);
    return iso >= y + '-04-01' && iso <= (y + 1) + '-03-31';
  }
  function detectFY(text) {
    const t = String(text).slice(0, 60000);
    let m = /(?:financial\s*year|\bF\.?\s?Y\.?)\D{0,20}(20\d{2})\s*[-–\/]\s*(\d{2,4})/i.exec(t);
    if (m && (parseInt(m[1], 10) + 1) % 100 === parseInt(String(m[2]).slice(-2), 10)) return m[1] + '-' + String(m[2]).slice(-2);
    m = /(?:assessment\s*year|\bA\.?\s?Y\.?)\D{0,20}(20\d{2})\s*[-–\/]\s*(\d{2,4})/i.exec(t);
    if (m && (parseInt(m[1], 10) + 1) % 100 === parseInt(String(m[2]).slice(-2), 10)) {
      const a = parseInt(m[1], 10); return (a - 1) + '-' + String(a).slice(-2);
    }
    return null;
  }
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function parseDate(s) {
    if (s === null || s === undefined) return null;
    s = String(s).trim();
    let y, m, d, x;
    if ((x = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) { y = +x[1]; m = +x[2]; d = +x[3]; }
    else if ((x = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/.exec(s))) { d = +x[1]; m = +x[2]; y = +x[3]; }
    else if ((x = /^(\d{1,2})[\s\-]([A-Za-z]{3})[a-z]*[\s\-,]*(\d{4})/.exec(s))) { d = +x[1]; m = MONTHS[x[2].toLowerCase()]; y = +x[3]; }
    else return null;
    if (!m || m > 12 || d < 1 || d > 31 || y < 1990) return null;
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  /* ---------- Categories and rules (configurable) ---------- */
  const CATS = {
    salary:              { label: 'Salary', kind: 'income' },
    interest:            { label: 'Interest income', kind: 'income' },
    dividend:            { label: 'Dividend income', kind: 'income' },
    securities_sale:     { label: 'Securities / mutual fund sale', kind: 'cg' },
    securities_purchase: { label: 'Securities / mutual fund purchase', kind: 'info' },
    property:            { label: 'Immovable property transaction', kind: 'cg' },
    rent:                { label: 'Rent received', kind: 'review' },
    business:            { label: 'Business / professional receipts', kind: 'review' },
    other_income:        { label: 'Other income (winnings, VDA, etc.)', kind: 'review' },
    foreign:             { label: 'Foreign income / assets', kind: 'review' },
    cash:                { label: 'Cash deposits / withdrawals', kind: 'info' },
    refund:              { label: 'Income-tax refund', kind: 'info' },
    tds:                 { label: 'TDS', kind: 'credit' },
    tcs:                 { label: 'TCS', kind: 'credit' },
    unclassified:        { label: 'Unclassified / review required', kind: 'review' }
  };
  const SEC = /securit|mutual fund|\bunits?\b|\bshares?\b|equity|debenture|\bbonds?\b|demat/i;
  const RULES = [
    { id: 'R01', cat: 'interest', note: 'Interest on refund', test: t => /interest.*refund|refund.*interest/i.test(t) },
    { id: 'R02', cat: 'refund', note: 'Mentions refund', test: t => /refund/i.test(t) },
    { id: 'R03', cat: 'tcs', note: 'TCS / section 206C', test: t => /\btcs\b|collected at source|206C/i.test(t) },
    { id: 'R04', cat: 'salary', note: 'Salary / section 192', test: t => /salary|\b192\b/i.test(t) },
    { id: 'R05', cat: 'property', note: 'Property / 194IA / 26QB', test: t => /194IA|26QB|immovable|property|registrar/i.test(t) },
    { id: 'R06', cat: 'rent', note: 'Rent / section 194I', test: t => /194I(?![AB])|\brent\b/i.test(t) },
    { id: 'R07', cat: 'dividend', note: 'Dividend / section 194 / 194K', test: t => /dividend|\b194\b(?![A-Za-z0-9])|194K/i.test(t) },
    { id: 'R08', cat: 'interest', note: 'Interest / section 194A', test: t => /194A|interest|savings account|fixed deposit/i.test(t) },
    { id: 'R09', cat: 'other_income', note: 'Winnings, VDA, other special sections', test: t => /194B|194BA|194R|194S|194DA|194EE|194G|194LA|lottery|winning|virtual digital|crypto|\bVDA\b|life insurance/i.test(t) },
    { id: 'R10', cat: 'business', note: 'Professional / contract / commission', test: t => /194J|194C|194H|194O|194Q|professional|contractor|commission|brokerage|\bGST\b|turnover/i.test(t) },
    { id: 'R11', cat: 'securities_purchase', note: 'Securities purchase', test: t => SEC.test(t) && /purchase|\bbuy\b|acquisition/i.test(t) },
    { id: 'R12', cat: 'securities_sale', note: 'Securities sale / redemption', test: t => SEC.test(t) && /\bsale\b|\bsell|redemption|redeem|transfer/i.test(t) },
    { id: 'R13', cat: 'unclassified', note: 'Securities, direction unclear', test: t => SEC.test(t) },
    { id: 'R14', cat: 'cash', note: 'Cash deposit / withdrawal', test: t => /cash deposit|cash withdrawal|194N/i.test(t) },
    { id: 'R15', cat: 'foreign', note: 'Foreign / remittance', test: t => /foreign|remittance|\bLRS\b|\bFSI\b|overseas/i.test(t) }
  ];
  function classify(rec) {
    const t = rec.ctext || [rec.code, rec.rawCat, rec.desc].filter(Boolean).join(' ');
    for (const r of RULES) if (r.test(t)) { rec.cat = r.cat; rec.ruleId = r.id; rec.ruleNote = r.note; return rec; }
    rec.cat = 'unclassified'; rec.ruleId = 'NONE'; rec.ruleNote = 'No rule matched'; return rec;
  }

  /* ---------- Field mapping for unknown headers / JSON keys ---------- */
  function mapKey(k) {
    const n = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!n) return null;
    if (/section|infocode|sftcode|^code$|informationcode/.test(n)) return 'code';
    if (/processed|considered|derived/.test(n)) return 'processed';
    if (/tds|taxdeducted|taxcollected/.test(n)) return 'tds';
    if (/date|period|month/.test(n)) return 'date';
    if (/source|entity|deductor|name|bank|party|payer|collector|reporter/.test(n)) return 'entity';
    if (/reported|amount|value|proceeds|consideration|paid/.test(n)) return 'reported';
    if (/desc|particular|narration|nature|details|information|infotype|sftname|category/.test(n)) return 'desc';
    if (/^type$|drcr|creditdebit|transactiontype/.test(n)) return 'ctype';
    return null;
  }

  function makeRecords(f, doc, loc, raw, seq) {
    const out = [];
    const rep = toPaise(f.reported), prc = toPaise(f.processed), tds = toPaise(f.tds);
    const desc = String(f.desc || f.code || '').trim();
    const base = {
      docId: doc.id, source: doc.kind, loc, entity: String(f.entity || '').trim(), code: String(f.code || '').trim(),
      date: parseDate(f.date), dateRaw: f.date ? String(f.date) : '', raw: raw || {}, warnings: [], conf: 'parsed', excluded: false
    };
    if (rep !== null || prc !== null) {
      out.push(Object.assign({}, base, { id: seq(), desc: desc || '(no description)', rawCat: '', reported: rep, processed: prc, cat: null }));
    }
    if (tds !== null && tds !== 0) {
      const isTcs = /tcs|collected|206c/i.test(desc + ' ' + base.code);
      out.push(Object.assign({}, base, {
        id: seq(), desc: (isTcs ? 'Tax collected: ' : 'Tax deducted: ') + (desc || '(no description)'),
        rawCat: '', reported: tds, processed: null, cat: isTcs ? 'tcs' : 'tds', ruleId: 'TAX-COL', ruleNote: 'From tax deducted/collected column'
      }));
    }
    out.forEach(r => { if (!r.cat) classify(r); });
    return out;
  }

  /* ---------- CSV ---------- */
  function splitCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 8);
    const cands = [',', '\t', ';', '|'];
    let delim = ',', best = -1;
    cands.forEach(c => { const n = lines.reduce((a, l) => a + l.split(c).length - 1, 0); if (n > best) { best = n; delim = c; } });
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch !== '\r') field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function tryHeader(cells) {
    const fields = cells.map(c => mapKey(String(c)));
    const set = new Set(fields.filter(Boolean));
    if (!(set.has('reported') || set.has('processed'))) return null;
    if (cells.some(c => String(c).trim() !== '' && toPaise(c) !== null)) return null;
    if (set.size < 2) return null;
    return { fields: fields, names: cells.map(c => String(c).trim()) };
  }
  function parseCSVText(text, doc, seq) {
    text = text.replace(/^\uFEFF/, '');
    const rows = splitCSV(text);
    let map = null; const recs = [];
    rows.forEach((cells, i) => {
      const rowNo = i + 1;
      if (cells.every(c => !String(c).trim())) return;
      const hdr = tryHeader(cells);
      if (hdr) { map = hdr; return; }
      if (!map) return;
      const f = {}, raw = {};
      cells.forEach((c, j) => {
        const val = String(c).trim(), fld = map.fields[j];
        if (map.names[j]) raw[map.names[j]] = val;
        if (!fld || val === '') return;
        if (fld === 'desc') (f.desc = f.desc || []).push(val); else if (f[fld] == null) f[fld] = val;
      });
      if (f.desc) f.desc = Array.from(new Set(f.desc)).join(' – ');
      const out = makeRecords(f, doc, 'row ' + rowNo, raw, seq);
      if (!out.length) { if (doc.warnings.length < 25) doc.warnings.push('Row ' + rowNo + ' skipped: no numeric amount found'); return; }
      recs.push.apply(recs, out);
    });
    if (!map) throw new Error('No header row with an amount column was found. Supported header names include "Amount Reported", "Amount Processed", "Information Description", "Transaction Date".');
    return recs;
  }

  /* ---------- JSON (generic walker, schema unverified) ---------- */
  function hasAmountKey(o) {
    return Object.keys(o).some(k => {
      const f = mapKey(k);
      return (f === 'reported' || f === 'processed' || f === 'tds') && o[k] !== null && typeof o[k] !== 'object' && toPaise(o[k]) !== null;
    });
  }
  function scalars(o, stringsOnly) {
    const r = {};
    Object.keys(o).forEach(k => {
      const v = o[k];
      if (v !== null && typeof v !== 'object' && (!stringsOnly || typeof v === 'string')) r[k] = v;
    });
    return r;
  }
  function walkJSON(node, path, ctx, rows) {
    if (Array.isArray(node)) {
      node.forEach((o, i) => {
        const p = path + '[' + i + ']';
        if (o && typeof o === 'object' && !Array.isArray(o) && hasAmountKey(o)) rows.push({ path: p, obj: Object.assign({}, ctx, scalars(o)) });
        else walkJSON(o, p, ctx, rows);
      });
      return;
    }
    if (node && typeof node === 'object') {
      const hasChildObjs = Object.keys(node).some(k => node[k] && typeof node[k] === 'object');
      if (!hasChildObjs && hasAmountKey(node)) { rows.push({ path: path, obj: Object.assign({}, ctx, scalars(node)) }); return; }
      const nctx = Object.assign({}, ctx, scalars(node, true));
      Object.keys(node).forEach(k => { if (node[k] && typeof node[k] === 'object') walkJSON(node[k], path + '.' + k, nctx, rows); });
    }
  }
  function parseJSONText(text, doc, seq) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Malformed JSON: ' + e.message); }
    const rows = []; walkJSON(data, '$', {}, rows);
    if (!rows.length) throw new Error('No records with amount fields were found in this JSON. The AIS/TIS JSON layout is not verified; try the CSV download or share the structure.');
    const recs = [];
    rows.forEach(r => {
      const f = {}, raw = {};
      Object.keys(r.obj).forEach(k => {
        const fld = mapKey(k), val = r.obj[k];
        raw[k] = val;
        if (!fld || val === '' || val === null) return;
        if (fld === 'desc') (f.desc = f.desc || []).push(String(val)); else if (f[fld] == null) f[fld] = val;
      });
      if (f.desc) f.desc = Array.from(new Set(f.desc)).join(' – ');
      const out = makeRecords(f, doc, r.path, raw, seq);
      if (!out.length) { if (doc.warnings.length < 25) doc.warnings.push(r.path + ' skipped: no numeric amount'); return; }
      recs.push.apply(recs, out);
    });
    return recs;
  }

  /* ---------- PDF text lines -> records (heuristic, low confidence) ---------- */
  const MONEY = /^\(?-?₹?\s?\d[\d,]*(\.\d+)?\)?$/;
  function parsePDFLines(pages, doc, seq) {
    const recs = []; let skippedTotals = 0;
    pages.forEach((lines, pi) => {
      lines.forEach((cells, li) => {
        cells = cells.map(c => String(c).trim()).filter(Boolean);
        const money = cells.filter(c => MONEY.test(c));
        let text = cells.filter(c => !MONEY.test(c)).join(' ').trim();
        if (cells.length && /^\d+$/.test(cells[0]) && money.length > 1 && text) money.shift();
        if (!money.length || text.length < 4 || !/[A-Za-z]{3}/.test(text)) return;
        if (/^page\b|\bpage\s+\d+\s+of\b/i.test(text)) return;
        if (/^total\b/i.test(text)) { skippedTotals++; return; }
        const f = { desc: text, reported: money[money.length >= 2 ? money.length - 2 : 0], processed: money.length >= 2 ? money[money.length - 1] : null };
        const dm = /\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}|\d{4}-\d{2}-\d{2})\b/.exec(text);
        if (dm) f.date = dm[1];
        const out = makeRecords(f, doc, 'page ' + (pi + 1) + ', line ' + (li + 1), { line: cells.join(' | ') }, seq);
        out.forEach(r => { r.conf = 'low'; r.warnings.push('PDF layout is unverified; amounts picked by position. Check against the PDF.'); });
        recs.push.apply(recs, out);
      });
    });
    if (skippedTotals) doc.warnings.push(skippedTotals + ' "Total" line(s) skipped to avoid double counting.');
    if (!recs.length) throw new Error('No amount rows could be read from this PDF. It may be scanned (needs OCR, not supported yet) or use an unsupported layout.');
    return recs;
  }

  /* ---------- Reconciliation ---------- */
  let tisMode = 'accepted';
  function setTisMode(m) { tisMode = ['accepted', 'processed', 'reported'].indexOf(m) >= 0 ? m : 'accepted'; }
  const has = v => v !== null && v !== undefined;
  function effAmt(r) {
    if (r.source === 'TIS') {
      if (tisMode === 'reported') return has(r.reported) ? r.reported : null;
      if (tisMode === 'processed') return has(r.processed) ? r.processed : r.reported;
      return has(r.accepted) ? r.accepted : (has(r.processed) ? r.processed : r.reported);
    }
    return has(r.processed) ? r.processed : r.reported;
  }

  function dupGroups(state) {
    const m = {};
    state.records.forEach(r => {
      if (r.excluded || r.reported === null || !r.date) return;
      const k = [r.source, r.cat, r.entity.toLowerCase(), r.date, effAmt(r), r.desc.toLowerCase()].join('|');
      (m[k] = m[k] || []).push(r.id);
    });
    return Object.keys(m).filter(k => m[k].length > 1).map(k => m[k]);
  }

  function hasKind(state, k) { return state.docs.some(d => d.kind === k && d.status === 'Processed'); }

  function reconRows(state) {
    const m = {};
    state.records.forEach(r => {
      if (r.excluded || !r.cat) return;
      const a = effAmt(r); if (a === null || a === undefined) return;
      const c = m[r.cat] || (m[r.cat] = { AIS: { sum: 0, n: 0 }, TIS: { sum: 0, n: 0 } });
      c[r.source].sum += a; c[r.source].n++;
    });
    const rows = Object.keys(m).map(cat => {
      const AIS = m[cat].AIS, TIS = m[cat].TIS, dec = state.recon[cat] || {};
      let status, diff = null;
      if (AIS.n && TIS.n) {
        diff = AIS.sum - TIS.sum;
        const mx = Math.max(Math.abs(AIS.sum), Math.abs(TIS.sum)) || 1;
        status = diff === 0 ? 'Exact match' : (Math.abs(diff) / mx <= 0.01 ? 'Probable match' : 'Difference');
      } else if (AIS.n) status = hasKind(state, 'TIS') ? 'Only in AIS' : 'TIS not uploaded';
      else status = hasKind(state, 'AIS') ? 'Only in TIS' : 'AIS not uploaded';
      const dflt = (cat === 'securities_sale' || cat === 'property') && AIS.n ? 'AIS' : (AIS.n && TIS.n ? 'TIS' : (AIS.n ? 'AIS' : 'TIS'));
      const basis = dec.basis || dflt;
      const used = basis === 'MANUAL' ? (dec.manual === undefined ? 0 : dec.manual) : (basis === 'AIS' ? AIS.sum : TIS.sum);
      const needs = cat !== 'unclassified' && ['Probable match', 'Difference', 'Only in AIS', 'Only in TIS'].indexOf(status) >= 0 && !dec.resolved;
      return { cat, AIS, TIS, diff, status, basis, used, needs, dec };
    });
    const order = Object.keys(CATS);
    return rows.sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat));
  }

  /* ---------- Computation model ---------- */
  const SCHEDULES = ['Salary', 'House property', 'Business or profession', 'Capital gains', 'Other sources', 'Virtual digital assets', 'Deductions', 'Tax credits'];
  const ALLOW_NEG = ['Capital gains', 'House property', 'Business or profession'];
  // Capital-gain tax treatments (bucket keys)
  const BUCKETS = {
    S111A: 'Short-term, listed equity / equity fund (20%)',
    L112A: 'Long-term, listed equity / equity fund (12.5% above ₹1.25 lakh)',
    SSLAB: 'Short-term, other assets (slab rate)',
    L112:  'Long-term, other assets (12.5%)'
  };
  const bucketOf = (type, treat) => type === 'ST' ? (treat === 'OTHER' ? 'SSLAB' : 'S111A') : (treat === 'OTHER' ? 'L112' : 'L112A');
  const rupeeRound10 = p => { const r = Math.floor(p / 100); const m = r % 10; return (m >= 5 ? r - m + 10 : r - m) * 100; };
  const PAISE = 100;

  /* Versioned tax rules. Only the rules listed here are implemented. */
  const TAX_RULES = {
    '2025-26': {
      label: 'FY 2025-26 (AY 2026-27), new regime (section 115BAC)',
      slabs: [[400000, 0], [800000, 0.05], [1200000, 0.10], [1600000, 0.15], [2000000, 0.20], [2400000, 0.25], [Infinity, 0.30]],
      rebateLimit: 1200000, rebateMax: 60000, cess: 0.04, surchargeFrom: 5000000,
      r111A: 0.20, r112A: 0.125, ex112A: 125000, r112: 0.125, rVDA: 0.30, basicExemption: 400000,
      notes: 'Slabs and rebate per Finance Act 2025. Rebate is not allowed against special-rate income. Surcharge, old regime, interest under 234A/B/C and indexation are not built in.'
    }
  };

  function netBuckets(b) {
    const n = Object.assign({}, b);
    const off = (loss, targets) => { targets.forEach(t => { if (n[loss] < 0 && n[t] > 0) { const u = Math.min(n[t], -n[loss]); n[t] -= u; n[loss] += u; } }); };
    ['S111A', 'SSLAB'].forEach(k => { if (n[k] < 0) off(k, ['S111A', 'SSLAB', 'L112A', 'L112'].filter(x => x !== k)); });
    ['L112A', 'L112'].forEach(k => { if (n[k] < 0) off(k, ['L112A', 'L112'].filter(x => x !== k)); });
    return n;
  }

  function computeTax(m, state) {
    const R = TAX_RULES[state.fy];
    if (!R) return { supported: false, reason: 'Tax rules are built only for FY 2025-26. Calculate tax for FY ' + state.fy + ' separately.' };
    if (m.incomplete) return { supported: false, partial: true, reason: m.incomplete + ' incomplete line(s) are excluded from income, so tax is not final. Showing a provisional figure.', provisional: true, ...calc() };
    return Object.assign({ supported: true }, calc());
    function calc() {
      const rows = [], B = m.cgNet || { S111A: 0, SSLAB: 0, L112A: 0, L112: 0 };
      const posB = {}; Object.keys(B).forEach(k => { posB[k] = Math.max(0, B[k]); });
      const vda = Math.max(0, m.heads['Virtual digital assets'] || 0);
      const ti = rupeeRound10(Math.max(0, m.gti - m.ded));
      const special = posB.S111A + posB.L112A + posB.L112 + vda;
      const slabIncome = Math.max(0, ti - special);
      let slabTax = 0, prev = 0;
      R.slabs.forEach(sl => { const top = sl[0] * PAISE; if (slabIncome > prev) slabTax += Math.round((Math.min(slabIncome, top) - prev) * sl[1]); prev = top; });
      let rebate = 0, relief = 0;
      if (slabIncome <= R.rebateLimit * PAISE) rebate = Math.min(slabTax, R.rebateMax * PAISE);
      else if (slabTax > slabIncome - R.rebateLimit * PAISE) relief = slabTax - (slabIncome - R.rebateLimit * PAISE);
      const slabAfter = slabTax - rebate - relief;
      // unused basic exemption can absorb special-rate gains (not VDA)
      let unused = Math.max(0, R.basicExemption * PAISE - slabIncome);
      const take = x => { const u = Math.min(unused, x); unused -= u; return x - u; };
      const t111A = take(posB.S111A);
      const t112A0 = Math.max(0, posB.L112A - R.ex112A * PAISE);
      const t112A = take(t112A0), t112 = take(posB.L112);
      const tax111A = Math.round(t111A * R.r111A), tax112A = Math.round(t112A * R.r112A), tax112 = Math.round(t112 * R.r112), taxVDA = Math.round(vda * R.rVDA);
      const before = slabAfter + tax111A + tax112A + tax112 + taxVDA;
      const cess = Math.round(before * R.cess);
      const total = before + cess;
      const net = total - m.credits;
      const netRounded = net >= 0 ? rupeeRound10(net) : -rupeeRound10(-net);
      const warn = [];
      if (ti >= R.surchargeFrom * PAISE) warn.push('Total income is ₹50 lakh or more. Surcharge is not built in.');
      if (m.ded > 0) warn.push('Deductions entered are not checked for new-regime eligibility.');
      if (m.specLoss > 0) warn.push('Speculative (intraday) loss of ' + inr(m.specLoss) + ' is not set off against other income. It can be carried forward for 4 years if the return is filed on time.');
      rows.push(['Total income (rounded to ₹10)', ti], ['Special-rate income (111A, 112A, 112, VDA)', special], ['Income taxed at slab rates', slabIncome], ['Tax at slab rates', slabTax]);
      if (rebate) rows.push(['Less: rebate under section 87A', -rebate]);
      if (relief) rows.push(['Less: marginal relief', -relief]);
      rows.push(['Tax on short-term equity gain (111A, 20%)', tax111A], ['Tax on long-term equity gain (112A, 12.5% above ₹1.25 lakh)', tax112A], ['Tax on other long-term gain (112, 12.5%)', tax112], ['Tax on virtual digital assets (115BBH, 30%)', taxVDA],
        ['Tax before cess', before], ['Health and education cess (4%)', cess], ['Total tax liability', total], ['Less: TDS, TCS and other credits', -m.credits], [net >= 0 ? 'Net tax payable (before rounding)' : 'Refund due (before rounding)', net], [net >= 0 ? 'Net tax payable (rounded to ₹10)' : 'Refund due (rounded to ₹10)', netRounded]);
      return { label: R.label, notes: R.notes, rows: rows, ti: ti, slabIncome: slabIncome, total: total, net: net, netRounded: netRounded, warn: warn };
    }
  }

  function buildModel(state) {
    const rr = reconRows(state);
    const byCat = {}; rr.forEach(r => { byCat[r.cat] = r; });
    const lines = [], missing = [];
    const used = c => byCat[c] ? byCat[c].used : null;
    const srcIds = c => {
      const r = byCat[c]; if (!r || r.basis === 'MANUAL') return [];
      return state.records.filter(x => !x.excluded && x.cat === c && x.source === r.basis).map(x => x.id);
    };
    function add(l) {
      const adj = state.adjust[l.key] || null;
      l.adj = adj;
      l.final = adj && adj.amount !== null && adj.amount !== undefined ? adj.amount : l.calc;
      l.status = l.derived ? 'Derived' : (l.final === null || l.final === undefined ? 'Incomplete' : (adj && adj.reviewed ? 'Reviewed' : 'Needs review'));
      l.warn = l.warn || []; l.sources = l.sources || [];
      lines.push(l); return l;
    }
    const miss = (key, sched, field, reason, doc) => missing.push({ key: key, sched: sched, field: field, reason: reason, doc: doc, auto: true });

    // Salary
    if (byCat.salary) {
      add({ key: 'salary', sched: 'Salary', desc: 'Gross salary reported', extracted: used('salary'), calc: used('salary'), sources: srcIds('salary'),
        method: 'Reported salary, source: ' + byCat.salary.basis, warn: ['Gross figure only. Exemptions, standard deduction and perquisites are not applied.'] });
      miss('auto:salary', 'Salary', 'Salary breakup', 'AIS/TIS show gross salary only. Exemptions and perquisites need the employer certificate.', 'Form 16 / payslips');
    } else add({ key: 'salary', sched: 'Salary', desc: 'Salary', extracted: null, calc: 0, method: 'No salary information found in AIS/TIS. Enter manually if applicable.' });

    // House property
    if (byCat.rent) {
      add({ key: 'hp', sched: 'House property', desc: 'House property income', extracted: used('rent'), calc: null, sources: srcIds('rent'),
        method: 'Rent reported is gross receipts, not income. Needs rent details and deductions.', warn: ['Incomplete: enter the computed income as a manual adjustment.'] });
      miss('auto:rent', 'House property', 'Rent, municipal tax and loan interest', 'Rent reported in AIS/TIS is not the same as taxable house property income.', 'Rent agreement, municipal tax receipt, home-loan interest certificate');
    } else add({ key: 'hp', sched: 'House property', desc: 'House property income', extracted: null, calc: 0, method: 'No house property information found. Enter manually if applicable.' });

    // Business: presumptive (44AD) if turnover entered, else placeholder
    const ps = state.presum || {}, hasP = (ps.cash !== null && ps.cash !== undefined) || (ps.digital !== null && ps.digital !== undefined);
    if (hasP) {
      const cash = ps.cash || 0, dig = ps.digital || 0, turn = cash + dig;
      const profit = Math.round(cash * 0.08) + Math.round(dig * 0.06);
      const limit = (turn > 0 && cash / turn <= 0.05 ? 300000000 : 200000000) * PAISE;
      const w = ['6% applies only to receipts through banking or electronic modes. 8% applies to cash. Cash share does not change the rate, it only changes the turnover limit.'];
      if (turn > limit) w.push('Turnover is above the Section 44AD limit. Presumptive taxation may not be available.');
      if (byCat.business) w.push('AIS/TIS report ' + inr(used('business')) + ' of business receipts. Compare with the turnover you entered.');
      add({ key: 'biz', sched: 'Business or profession', desc: 'Business income, presumptive (Section 44AD)', extracted: byCat.business ? used('business') : null, calc: profit, sources: srcIds('business'),
        method: '8% of cash receipts ' + inr(cash) + ' + 6% of digital receipts ' + inr(dig), warn: w });
    } else if (byCat.business) {
      add({ key: 'biz', sched: 'Business or profession', desc: 'Business / professional income', extracted: used('business'), calc: null, sources: srcIds('business'),
        method: 'Receipts reported are gross, not profit. Enter cash and digital turnover for Section 44AD, or enter profit manually.', warn: ['Incomplete: enter profit as a manual adjustment.'] });
      miss('auto:biz', 'Business or profession', 'Profit and loss / expenses', 'AIS/TIS report receipts only, not business expenses or net profit.', 'Books of account, bank statements');
    } else add({ key: 'biz', sched: 'Business or profession', desc: 'Business / professional income', extracted: null, calc: 0, method: 'No business information found. Enter turnover for Section 44AD or add lines manually.' });

    // Capital gains items from AIS/TIS records
    const cgItems = [];
    ['securities_sale', 'property'].forEach(cat => {
      const r = byCat[cat]; if (!r) return;
      if (r.basis === 'MANUAL') cgItems.push({ id: 'manual-' + cat, cat: cat, desc: CATS[cat].label + ' (manual total)', date: null, proceeds: r.used });
      else state.records.filter(x => !x.excluded && x.cat === cat && x.source === r.basis && effAmt(x) !== null)
        .forEach(x => cgItems.push({ id: x.id, cat: cat, desc: x.desc, date: x.date, proceeds: effAmt(x), entity: x.entity, aisCost: x.cost, aisTerm: x.term }));
    });
    const bucketSum = { S111A: 0, SSLAB: 0, L112A: 0, L112: 0 };
    cgItems.forEach(it => {
      const cg = state.cg[it.id] || {};
      const cost = cg.cost !== undefined ? cg.cost : (it.aisCost > 0 ? it.aisCost : undefined);
      const type = cg.type || it.aisTerm || undefined;
      const treat = cg.treat || (it.cat === 'property' ? 'OTHER' : 'EQ');
      const fromAis = (cg.cost === undefined && cost !== undefined) || (!cg.type && type);
      const complete = cost !== undefined && cost !== null && (type === 'ST' || type === 'LT');
      const gain = complete ? it.proceeds - cost - (cg.exp || 0) : null;
      const l = add({ key: 'cg:' + it.id, sched: 'Capital gains', desc: CATS[it.cat].label + ': ' + it.desc, extracted: it.proceeds, calc: gain,
        sources: it.id.toString().indexOf('manual-') === 0 ? [] : [it.id],
        method: 'Sale consideration − cost − expenses' + (type ? ' (' + (type === 'ST' ? 'short-term' : 'long-term') + ')' : ''),
        warn: ['Sale proceeds are not gains. Indexation and special exemptions are not applied.'].concat(fromAis ? ['Cost and term were taken from the AIS. Verify before relying on them.'] : []).concat(it.aisCost === 0 && cg.cost === undefined ? ['AIS shows cost 0. Cost is never assumed to be zero, so enter the real cost.'] : []) });
      l.cgType = type; l.bucket = complete ? bucketOf(type, treat) : null; l.cgTreat = treat;
      it.view = { cost: cost, type: type, treat: treat, fromAis: !!fromAis };
      if (cost === undefined || cost === null) miss('auto:cgcost:' + it.id, 'Capital gains', 'Acquisition cost and date for "' + it.desc + '"', 'Gain cannot be worked out without cost. Cost is never assumed to be zero.', 'Contract notes, broker capital-gains statement, purchase records');
      else if (!type) miss('auto:cgtype:' + it.id, 'Capital gains', 'Short-term or long-term decision for "' + it.desc + '"', 'Choose after checking purchase and sale dates.', 'Purchase and sale dates');
    });

    // Other sources
    if (byCat.interest) add({ key: 'interest', sched: 'Other sources', desc: 'Interest income', extracted: used('interest'), calc: used('interest'), sources: srcIds('interest'),
      method: 'Reported interest, source: ' + byCat.interest.basis, warn: ['No deduction is applied. Savings-interest deductions are not available in the new regime.'] });
    if (byCat.dividend) add({ key: 'dividend', sched: 'Other sources', desc: 'Dividend income', extracted: used('dividend'), calc: used('dividend'), sources: srcIds('dividend'),
      method: 'Reported dividend, source: ' + byCat.dividend.basis });
    if (byCat.other_income) {
      add({ key: 'other_income', sched: 'Other sources', desc: 'Other income reported (winnings, VDA, etc.)', extracted: used('other_income'), calc: null, sources: srcIds('other_income'),
        method: 'Special tax treatment may apply. Enter the taxable amount as a manual adjustment, or add a Virtual digital assets line.' });
      miss('auto:other_income', 'Other sources', 'Details of other income', 'These items may be taxed differently and need transaction details.', 'Transaction statements');
    }

    // Deductions
    add({ key: 'ded', sched: 'Deductions', desc: 'Chapter VI-A deductions (manual entry)', extracted: null, calc: 0, method: 'Eligibility is not checked. Most deductions are not allowed in the new regime.' });

    // Tax credits
    if (byCat.tds) add({ key: 'tds', sched: 'Tax credits', desc: 'TDS reported', extracted: used('tds'), calc: used('tds'), sources: srcIds('tds'), method: 'Tax credit, not income. Source: ' + byCat.tds.basis });
    if (byCat.tcs) add({ key: 'tcs', sched: 'Tax credits', desc: 'TCS reported', extracted: used('tcs'), calc: used('tcs'), sources: srcIds('tcs'), method: 'Tax credit, not income. Source: ' + byCat.tcs.basis });

    // Custom lines
    state.custom.forEach(c => {
      const l = add({ key: c.key, sched: c.head, desc: c.desc, extracted: null, calc: c.amount, custom: true, method: 'Added manually' + (c.reason ? ': ' + c.reason : '') });
      if (c.head === 'Capital gains') { l.bucket = c.treat || 'SSLAB'; l.warn.push('Tax treatment: ' + BUCKETS[l.bucket]); }
      if (c.spec) { l.spec = true; l.warn.push('Speculative business (intraday). A loss can be set off only against speculative gains and carried forward for 4 years if the return is filed on time.'); }
      if (c.head === 'Virtual digital assets') l.warn.push('Tax is charged on the gain (consideration less cost only). No other deduction or set-off is allowed.');
    });

    // Capital gains net (all bucketed lines)
    lines.filter(l => l.bucket && l.final !== null && l.final !== undefined).forEach(l => { bucketSum[l.bucket] += l.final; });
    const cgNet = netBuckets(bucketSum);
    const cgLines = lines.some(l => l.sched === 'Capital gains');
    if (cgLines) {
      const netTotal = Object.keys(cgNet).reduce((a, k) => a + Math.max(0, cgNet[k]), 0);
      add({ key: 'cg:net', sched: 'Capital gains', desc: 'Net capital gains included in total income', extracted: null, calc: netTotal, derived: true,
        method: 'Losses are set off within short-term and long-term groups. Short-term loss may reduce long-term gain. Long-term loss reduces only long-term gain. Unabsorbed losses are not carried forward here.' });
    }

    // Document-level and review items
    if (!hasKind(state, 'AIS')) miss('auto:noais', 'All', 'AIS not uploaded', 'Detailed reported transactions are in the AIS.', 'AIS download');
    if (!hasKind(state, 'TIS')) miss('auto:notis', 'All', 'TIS not uploaded', 'The TIS gives category summaries to compare against.', 'TIS download');
    const unclassified = state.records.filter(r => !r.excluded && r.cat === 'unclassified');
    if (unclassified.length) miss('auto:unclassified', 'All', unclassified.length + ' unclassified record(s)', 'These records were not matched to any category. Classify or exclude them.', 'None (review in Extracted records)');
    rr.filter(r => r.needs).forEach(r => miss('auto:recon:' + r.cat, 'Reconciliation', 'Resolve ' + CATS[r.cat].label + ': ' + r.status, 'AIS and TIS do not agree or exist in one source only.', 'None (review in Reconciliation)'));
    state.missingManual.forEach(m => missing.push({ key: m.key, sched: m.sched, field: m.field, reason: m.reason, doc: m.doc, auto: false }));
    missing.forEach(m => { m.resolved = !!state.missingResolved[m.key]; });

    // Totals
    const sum = s => lines.filter(l => l.sched === s && !l.derived && l.final !== null && l.final !== undefined).reduce((a, l) => a + l.final, 0);
    const cgNetLine = lines.find(l => l.key === 'cg:net');
    const specNet = lines.filter(l => l.sched === 'Business or profession' && l.spec && l.final !== null && l.final !== undefined).reduce((a, l) => a + l.final, 0);
    const bizTotal = sum('Business or profession') - specNet + Math.max(0, specNet);
    const heads = {
      'Salary': sum('Salary'), 'House property': sum('House property'), 'Business or profession': bizTotal,
      'Capital gains': cgNetLine ? cgNetLine.final : 0, 'Other sources': sum('Other sources'), 'Virtual digital assets': sum('Virtual digital assets')
    };
    const gti = Object.keys(heads).reduce((a, k) => a + heads[k], 0);
    const ded = sum('Deductions');
    const ti = Math.max(0, gti - ded);
    const credits = sum('Tax credits');
    const incomplete = lines.filter(l => l.status === 'Incomplete').length;
    const needsReview = lines.filter(l => l.status === 'Needs review').length;
    const info = rr.filter(r => ['refund', 'cash', 'securities_purchase', 'foreign'].indexOf(r.cat) >= 0);
    const model = { rr, byCat, lines, missing, cgItems, cgNet, heads, gti, ded, ti, credits, incomplete, needsReview, info, unclassified, specLoss: Math.max(0, -specNet) };
    model.tax = computeTax(model, state);
    return model;
  }

  const E = {
    PARSER_VERSION, CATS, RULES, SCHEDULES, ALLOW_NEG, BUCKETS, TAX_RULES, rupeeRound10,
    toPaise, inr, toInput, ayOf, fyOptions, inFY, detectFY, parseDate,
    classify, mapKey, makeRecords, splitCSV, parseCSVText, parseJSONText, parsePDFLines,
    effAmt, setTisMode, dupGroups, reconRows, hasKind, buildModel
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  else root.Engine = E;
})(typeof window !== 'undefined' ? window : this);
