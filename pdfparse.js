/* ==========================================================
   pdfparse.js — reads the portal AIS and TIS PDF layouts.
   Input: pages of word boxes { s, x, y, w, h } (y grows downward),
   from OCR or from the PDF text layer. Layout checked against
   one real FY 2023-24 AIS and TIS only. Totals are cross-checked
   and mismatches are reported as warnings, never hidden.
   ========================================================== */
(function (root) {
  'use strict';
  const E = root.Engine || require('./engine.js');
  const NUM = /^\(?-?\d[\d,]*(\.\d*)?\)?$/;
  const DATE = /^\d{2}\/\d{2}\/\d{4}$/;
  const isNum = s => NUM.test(s);
  const P = s => E.toPaise(String(s).replace(/\.$/, ''));
  const isDash = s => /^[-–—]$/.test(s);
  const isJunk = t => /Download\s*ID|Generation\s*Date|IP\s*Address|Page\s+\d+\s+of\s+\d+/i.test(t) || /^PAN\b.*Assessment\s+Year/i.test(t) || /^[A-Z]{5}\d{4}[A-Z]\s+.*\d{4}-\d{2}$/.test(t);
  const clean = s => String(s).replace(/\s+/g, ' ').trim();

  function toLines(words, page) {
    words = words.filter(w => w.s && !/^[|¦_]+$/.test(w.s));
    if (!words.length) return [];
    const hs = words.map(w => w.h).sort((a, b) => a - b);
    const thr = (hs[Math.floor(hs.length / 2)] || 20) * 0.6;
    const ws = words.slice().sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
    const lines = [];
    ws.forEach(w => {
      const yc = w.y + w.h / 2, L = lines[lines.length - 1];
      if (L && Math.abs(L.yc - yc) <= thr) { L.words.push(w); L.yc = (L.yc * (L.words.length - 1) + yc) / L.words.length; }
      else lines.push({ yc: yc, words: [w], page: page });
    });
    lines.forEach(L => { L.words.sort((a, b) => a.x - b.x); L.text = L.words.map(w => w.s).join(' '); });
    return lines;
  }
  const findW = (ws, re, from) => { for (let i = from || 0; i < ws.length; i++) if (re.test(ws[i].s)) return i; return -1; };
  const stripId = s => { const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(s); return m ? { name: clean(m[1]), id: m[2] } : { name: clean(s), id: '' }; };

  function mkRec(doc, seq, o) {
    const r = Object.assign({ id: seq(), docId: doc.id, source: doc.kind, loc: '', entity: '', code: '', date: null, dateRaw: '', raw: {}, warnings: [], conf: 'ocr', excluded: false,
      desc: '', rawCat: '', reported: null, processed: null, accepted: null, cat: null }, o);
    E.classify(r); return r;
  }

  /* ---------------- TIS ---------------- */
  function colsTIS(l) {
    const ws = l.words, ip = findW(ws, /^PART$/i); if (ip < 0) return null;
    const i1 = findW(ws, /^INFORMATION$/i, ip + 1), i2 = findW(ws, /^INFORMATION$/i, i1 + 1), ia = findW(ws, /^AMOUNT$/i, i2 + 1);
    const ir = findW(ws, /^REPORTED$/i, ia + 1), ipr = findW(ws, /^PROCESSED$/i, ir + 1), iac = findW(ws, /^ACCEPTED$/i, ipr + 1);
    if ([i1, i2, ia, ir, ipr, iac].some(i => i < 0)) return null;
    return { part: ws[ip].x, desc: ws[i1].x, src: ws[i2].x, amt: ws[ia].x, rep: ws[ir].x, proc: ws[ipr].x, acc: ws[iac].x };
  }
  function parseTIS(lines, doc, seq, out) {
    const L = lines.filter(l => !isJunk(l.text));
    let start = L.findIndex(l => /information\s+details\s+under\s+each|Annexure\s+to\s+Taxpayer/i.test(l.text));
    if (start < 0) { const f = L.findIndex(l => l.page >= 2); start = f > 0 ? f - 1 : -1; }
    const summary = [], h0 = L.findIndex(l => /INFORMATION\s+CATEGORY/i.test(l.text)), end0 = start < 0 ? L.length : start;
    if (h0 >= 0 && h0 < end0) for (let i = h0 + 1; i < end0; i++) {
      if (/information\s+details\s+under/i.test(L[i].text)) break;
      const m = /^(?:\d+\s+)?(.+?)\s+([\d,]+)\s+([\d,]+)$/.exec(L[i].text);
      if (m && /[A-Za-z]{3}/.test(m[1])) summary.push({ name: clean(m[1]), processed: P(m[2]), accepted: P(m[3]) });
    }
    let cat = null, catIdx = -1, cols = null, row = null, mode = '';
    const sums = {};   // category -> { rowsAccepted, total }
    function flush() {
      if (!row) return; const r = row; row = null;
      const c = r.cols, starts = [c.part, c.desc, c.src, c.amt, c.rep, c.proc, c.acc], tol = 25, cells = [[], [], [], [], [], [], []];
      r.lines.forEach(l => l.words.forEach(w => { if (w.x < c.part - tol) return; let k = 0; for (let i = 0; i < starts.length; i++) if (w.x >= starts[i] - tol) k = i; cells[k].push(w.s); }));
      const txt = i => clean(cells[i].join(' '));
      const numCell = i => { for (const t of cells[i]) { if (isDash(t)) return 0; if (isNum(t)) return P(t); } return null; };
      let rep = numCell(4), prc = numCell(5), acc = numCell(6);
      const tok = r.lines[0].words.filter(w => w.x >= c.rep - 120 && (isNum(w.s) || isDash(w.s)));
      if (tok.length >= 3) { const v = w => isDash(w.s) ? 0 : P(w.s); rep = v(tok[0]); prc = v(tok[1]); acc = v(tok[2]); }
      const warns = [];
      if (rep !== null && prc === null && acc === null) { prc = 0; acc = 0; warns.push('Processed and accepted amounts are blank ("-") in the TIS, so they count as 0. This is how the system removes duplicates.'); }
      if (rep === null && prc === null && acc === null) { out.warnings.push('A TIS row under "' + (cat || '?') + '" (' + txt(1) + ') had no readable amounts. Check the PDF.'); }
      const src = stripId(txt(2)), desc = txt(1), cm = /\((SFT[-\s]?\d+[^)]*)\)/i.exec(desc), sec = /Section\s+(\w+)/i.exec(desc);
      const rec = mkRec(doc, seq, { loc: 'page ' + r.lines[0].page + ', TIS annexure', entity: src.name, code: cm ? cm[1].replace(/\s+/g, '') : (sec ? 'TDS-' + sec[1] : ''), desc: desc, rawCat: cat || '', ctext: (cat || '') + ' ' + desc,
        reported: rep, processed: prc, accepted: acc, warnings: warns, raw: { part: txt(0), amountDescription: txt(3), sourceId: src.id } });
      out.records.push(rec);
      const s = sums[cat || '?'] || (sums[cat || '?'] = { rows: 0, total: null }); if (acc !== null) s.rows += acc;
    }
    for (let i = start + 1; i < L.length; i++) {
      const l = L[i], t = l.text;
      if (start < 0 && i === 0) continue;
      if (/INFORMATION\s+CATEGORY/i.test(t)) { flush(); mode = 'cat'; continue; }
      const isDetailHdr = /\bPART\b/i.test(t) && /INFORMATION/i.test(t) && /SOURCE/i.test(t);
      if (mode === 'cat') {
        if (/^(SYSTEM|TAXPAYER|BY\b)/i.test(t) && !/\d/.test(t)) continue;
        catIdx++;
        if (isDetailHdr) { const s = summary[catIdx]; cat = s ? s.name : 'Category ' + (catIdx + 1); sums[cat] = { rows: 0, total: s ? s.accepted : null }; out.warnings.push('The category heading row was not read for "' + cat + '". Name taken from the summary page.'); }
        else {
          const ws = l.words.slice(); if (ws.length && /^\d{1,2}$/.test(ws[0].s)) ws.shift();
          const nums = []; while (ws.length && (isNum(ws[ws.length - 1].s) || isDash(ws[ws.length - 1].s)) && nums.length < 2) nums.unshift(ws.pop().s);
          cat = clean(ws.map(w => w.s).join(' '));
          const tot = nums.length === 2 ? P(nums[1]) : (summary[catIdx] ? summary[catIdx].accepted : null);
          sums[cat] = { rows: 0, total: tot };
        }
        mode = 'after'; if (!isDetailHdr) continue;
      }
      if (isDetailHdr) { flush(); cols = colsTIS(l); mode = cols ? 'detail' : 'after'; if (!cols) out.warnings.push('A TIS table header could not be read (page ' + l.page + '). Rows under it were skipped.'); continue; }
      if (mode === 'detail' && cols) {
        const startsRow = l.words.some(w => Math.abs(w.x - cols.part) <= 45 && /^(S[FE][TI]|TDS\/?)$/i.test(w.s));
        if (startsRow) { flush(); row = { cols: cols, lines: [l] }; }
        else if (row) row.lines.push(l);
      }
    }
    flush();
    Object.keys(sums).forEach(k => {
      const s = sums[k]; if (s.total === null) return;
      if (Math.abs(s.rows - s.total) > 100) out.warnings.push('TIS "' + k + '": rows add to ' + E.inr(s.rows) + ' but the category total is ' + E.inr(s.total) + '. An amount may be misread or missing.');
    });
    if (!out.records.length) throw new Error('No TIS rows could be read from this PDF.');
  }

  /* ---------------- AIS ---------------- */
  function colsAIS(l) {
    const ws = l.words, i1 = findW(ws, /^INFORMATION$/i), i2 = findW(ws, /^INFORMATION$/i, i1 + 1), i3 = findW(ws, /^INFORMATION$/i, i2 + 1);
    const ic = findW(ws, /^COUNT$/i, i3 + 1), ia = findW(ws, /^AMOUNT/i, ic + 1);
    if ([i1, i2, i3, ic].some(i => i < 0)) return null;
    return { code: ws[i1].x, desc: ws[i2].x, src: ws[i3].x, count: ws[ic].x, amt: ia >= 0 ? ws[ia].x : ws[ic].x + 200 };
  }
  function blockType(t) {
    if (/QUARTER/i.test(t) && /(PAYMENT|CREDIT)/i.test(t)) return 'tds';
    if (/REPORTED\s*ON/i.test(t) && /DIVIDEND/i.test(t)) return 'div';
    if (/REPORTED\s*ON/i.test(t) && /ACCOUNT/i.test(t)) return 'int';
    if (/DATE\s*OF\s*SALE|SECURITY\s*NAME|AMC\s*NAME.*DATE|DATE.*SECURITY/i.test(t)) return 'sale';
    if (/QUARTER/i.test(t)) return 'pur';
    return 'other';
  }
  function colsSale(hdr) {
    const ws = hdr.reduce((a, l) => a.concat(l.words), []);
    const g = re => { const i = findW(ws, re); return i < 0 ? null : ws[i]; };
    const qty = g(/^QUANTITY$/i), price = g(/^SALE$/i), cons = g(/^SALES$/i), cost = g(/^COST/i), unit = g(/^UNIT$/i), fair = g(/^FAIR$/i), idx = g(/^INDEX/i), name = g(/^SECURITY$/i);
    const iClass = findW(ws, /^CLASS$/i);
    const needed = [qty, price, cons, cost, unit, fair, idx];
    return { starts: needed.every(Boolean) ? needed.map(w => w.x) : null, nameX: name ? name.x : null, classX: iClass > 0 ? ws[iClass - 1].x : null };
  }
  function parseAIS(lines, doc, seq, out) {
    const L = lines.filter(l => !isJunk(l.text));
    const blocks = []; let blk = null, mode = '';
    L.forEach(l => {
      const t = l.text;
      if (/INFORMATION\s+CODE/i.test(t) && /INFORMATION\s+SOURCE/i.test(t)) { blk = { cols: colsAIS(l), info: [], hdr: [], kids: [], type: null, page: l.page }; blocks.push(blk); mode = 'info'; return; }
      if (/^Part\s+B\d/i.test(t)) { blk = null; return; }
      if (!blk) return;
      if (mode === 'info') {
        if (/^SR\.?\s*(NO|AMC|DATE|QUARTER|REPORTED)/i.test(t)) { mode = 'kids'; blk.type = blockType(t); blk.hdr.push(l); return; }
        blk.info.push(l); return;
      }
      if (/^Note\b|may\s+rely\s+on\s+the\s+information/i.test(t)) return;
      if (/^(Purchase of|Sale of|Dividend$|Interest from|Information relating)/i.test(t)) return;
      if (!blk.kids.length && !l.words.some(w => DATE.test(w.s)) && !/^\d+\s+Q\d/i.test(t) && blk.type === 'sale' && blk.hdr.length < 4) { blk.hdr.push(l); return; }
      blk.kids.push(l);
    });
    if (!blocks.length) throw new Error('No AIS information blocks were found in this PDF.');
    let n = 0;
    blocks.forEach(b => {
      n++;
      if (b.info.some(l => /No\s+Transactions/i.test(l.text))) return;
      if (!b.cols || !b.info.length) { out.warnings.push('AIS block ' + n + ' header could not be read. It was skipped.'); return; }
      const l0 = b.info[0], c = b.cols, tail = [];
      for (let i = l0.words.length - 1; i >= 0 && isNum(l0.words[i].s) && tail.length < 2; i--) tail.unshift(l0.words[i]);
      const amount = tail.length ? P(tail[tail.length - 1].s) : null, count = tail.length === 2 ? parseInt(tail[0].s, 10) : null;
      const codeW = l0.words.find(w => /^(TDS|TCS|SFT)/i.test(w.s));
      const code = codeW ? codeW.s : '';
      const skip = new Set(tail), desc = [], srcT = [];
      b.info.forEach(l => l.words.forEach(w => { if (skip.has(w) || w === codeW) return; if (w.x >= c.src - 25) srcT.push(w.s); else if (w.x >= c.desc - 25) desc.push(w.s); }));
      const descTxt = clean(desc.join(' ')), src = stripId(clean(srcT.join(' ')));
      const type = b.type, kids = b.kids;
      const dateTok = kids.map(l => l.words.find(w => DATE.test(w.s))).find(Boolean);
      const base = { entity: src.name, code: code, desc: descTxt, rawCat: '', ctext: code + ' ' + descTxt, loc: 'page ' + b.page + ', AIS block ' + n, raw: { sourceId: src.id, count: count },
        date: dateTok ? E.parseDate(dateTok.s.split('/').reverse().join('-')) : null, dateRaw: dateTok ? dateTok.s : '' };
      if (type === 'sale') {
        const cs = colsSale(b.hdr), rows = [];
        kids.forEach(l => { if (l.words.some(w => DATE.test(w.s))) rows.push({ lines: [l] }); else if (rows.length) rows[rows.length - 1].lines.push(l); });
        let activeSum = 0, activeN = 0;
        rows.forEach((r, ri) => {
          const l = r.lines[0], di = findW(l.words, DATE), dw = l.words[di], all = r.lines.reduce((a, x) => a.concat(x.words), []);
          const vals = new Array(7).fill(null);
          if (cs.starts) l.words.slice(di + 1).filter(w => isNum(w.s)).forEach(w => { const re = w.x + w.w; let k = -1; cs.starts.forEach((s, i) => { if (re > s + 10) k = i; }); if (k >= 0 && vals[k] === null) vals[k] = P(w.s); });
          else { const nums = l.words.slice(di + 1).filter(w => isNum(w.s)).map(w => P(w.s)); const k = nums.length; for (let i = 0; i < 7; i++) vals[6 - i] = nums[k - 1 - i] === undefined ? null : nums[k - 1 - i]; }
          const text = all.map(w => w.s).join(' ');
          const term = /\bShort\b/i.test(text) ? 'ST' : (/\bLong\b/i.test(text) ? 'LT' : undefined);
          const inactive = all.some(w => /^(in|ln|l)active$/i.test(w.s)), statusSeen = all.some(w => /^(in|ln)?active$/i.test(w.s));
          const nameWords = all.filter(w => cs.nameX !== null && w.x >= cs.nameX - 25 && (cs.classX === null || w.x < cs.classX - 25) && !isNum(w.s) && !DATE.test(w.s)).map(w => w.s);
          const name = clean(nameWords.join(' ')), isin = /\b(IN[EF][0-9A-Z]{9})\b/.exec(name);
          const warns = []; if (!statusSeen) warns.push('Status (Active/Inactive) was not read. Treated as active.');
          if (vals[2] === null) { out.warnings.push('Sale row ' + (ri + 1) + ' of AIS block ' + n + ' had no readable sales consideration. It was skipped.'); return; }
          if (inactive) warns.push('Marked Inactive in the AIS (superseded by another row). Excluded from totals.');
          if (vals[3] === 0) warns.push('AIS shows cost of acquisition 0. Enter the real cost.');
          if (term === 'LT' && vals[4] > 0) warns.push('A fair market value on 31 Jan 2018 is shown. Grandfathering is not applied.');
          if (!inactive) { activeSum += vals[2]; activeN++; }
          out.records.push(mkRec(doc, seq, Object.assign({}, base, { desc: descTxt + (name ? ': ' + name : ''), date: E.parseDate(dw.s.split('/').reverse().join('-')), dateRaw: dw.s,
            reported: vals[2], cost: vals[3], term: term, qty: vals[0], fmv: vals[5], excluded: inactive, warnings: warns, loc: base.loc + ', row ' + (ri + 1), raw: { isin: isin ? isin[1] : '', sourceId: src.id } })));
        });
        if (amount !== null && Math.abs(activeSum - amount) > Math.max(500, activeN * 100)) out.warnings.push('AIS block ' + n + ' (' + descTxt + '): active rows add to ' + E.inr(activeSum) + ' but the block total is ' + E.inr(amount) + '. A row may be misread.');
        if (count !== null && count !== activeN) out.warnings.push('AIS block ' + n + ' (' + descTxt + '): the block says ' + count + ' record(s) but ' + activeN + ' active row(s) were read.');
        return;
      }
      if (amount === null) { out.warnings.push('AIS block ' + n + ' (' + descTxt + ') had no readable amount. It was skipped.'); return; }
      out.records.push(mkRec(doc, seq, Object.assign({}, base, { reported: amount })));
      if (type === 'tds') {
        let ded = 0;
        kids.forEach(l => { const di = findW(l.words, DATE); if (di < 0) return; const nums = l.words.slice(di + 1).filter(w => isNum(w.s)).map(w => P(w.s)); if (nums.length >= 2 && !l.words.some(w => /^(in|ln)active$/i.test(w.s))) ded += nums[1] || 0; });
        if (ded > 0) out.records.push(mkRec(doc, seq, Object.assign({}, base, { desc: 'Tax deducted: ' + descTxt, reported: ded, cat: 'tds', ctext: 'TDS tax deducted', loc: base.loc + ' (TDS deducted)' })));
      }
    });
    if (!out.records.length) throw new Error('No AIS records could be read from this PDF.');
  }

  /* ---------------- entry ---------------- */
  function parsePdfWords(pages, doc, seq) {
    const lines = []; pages.forEach((p, i) => toLines(p.words || p, i + 1).forEach(l => lines.push(l)));
    const text = lines.map(l => l.text).join('\n');
    const nA = (text.match(/Annual\s+Information\s+Statement/gi) || []).length, nT = (text.match(/Taxpayer\s+Information\s+Summary/gi) || []).length;
    if (!nA && !nT) return null;
    const kind = nA >= nT ? 'AIS' : 'TIS';
    const out = { kind: kind, records: [], warnings: [], pan: '', name: '', fy: E.detectFY(text), text: text };
    const gi = /([A-Z]{5}\d{4}[A-Z])\s+X{4}\s+X{4}\s+\d{4}\s+(.+)$/m.exec(text);
    if (gi) { out.pan = gi[1]; out.name = clean(gi[2]); } else { const pm = /\b[A-Z]{5}\d{4}[A-Z]\b/.exec(text); if (pm) out.pan = pm[0]; }
    const d = Object.assign({}, doc, { kind: kind });
    if (kind === 'TIS') parseTIS(lines, d, seq, out); else parseAIS(lines, d, seq, out);
    return out;
  }
  E.parsePdfWords = parsePdfWords;
  E.pdfToLines = toLines;
  if (typeof module !== 'undefined' && module.exports) module.exports = E;
})(typeof window !== 'undefined' ? window : this);
