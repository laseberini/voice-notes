// Voice Notes: main app logic.
(() => {
  const $ = id => document.getElementById(id);
  const VERSION = self.APP_VERSION;

  const state = {
    busy: false,          // true while recording or saving (we don't auto-reload then)
    recording: false,
    pendingReload: false,
    openId: null,
    tab: 'note',          // 'note' or 'list' (to-do): which tab the home screen shows
    kind: 'note',         // what's being recorded right now
    appendTo: null,       // id being continued (null = make a new one)
    before: '',           // its text so far, shown above the new words while recording
  };

  function read(k, d) { try { return localStorage.getItem('vn-' + k) || d; } catch { return d; } }
  function write(k, v) { try { localStorage.setItem('vn-' + k, v); } catch {} }

  // ---------- Small helpers ----------
  const fmtDate = iso => new Date(iso).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
  const isList = it => it.format === 'list';
  const listLines = text => text.split('\n').map(s => s.trim()).filter(Boolean);
  const capitalise = s => s.replace(/^[a-z]/, c => c.toUpperCase());

  let toastTimer;
  // A short message at the bottom. Can carry one button, e.g. "Undo".
  function toast(msg, actionLabel, action) {
    const t = $('toast');
    t.textContent = msg;
    if (action) {
      const b = document.createElement('button');
      b.className = 'toast-btn';
      b.textContent = actionLabel;
      b.onclick = () => { t.hidden = true; action(); };
      t.append(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), action ? 5000 : 2500);
  }
  function setStatus(msg) { $('status').textContent = msg || ''; }

  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {}
  }

  function setBusy(b) {
    state.busy = b;
    keepAwake(b);
    if (!b && state.pendingReload) location.reload();
  }

  // ---------- Screens ----------
  function show(view) {
    for (const v of ['home', 'rec', 'detail', 'settings']) $(v).hidden = v !== view;
    window.scrollTo(0, 0);
  }
  // Use browser history so the phone's Back button closes a screen instead of the app.
  function go(view, id) {
    history.pushState({ view, id }, '');
    render(view, id);
  }
  function render(view, id) {
    if (unsaved) saveDetailNow(); // e.g. the phone's Back button pressed right after typing
    flushTicks(); // finish removing ticked items before leaving the screen
    closeFix();
    if (view === 'detail') openDetail(id);
    else if (view === 'settings') { renderAccents(); renderFixes(); show('settings'); }
    else {
      state.openId = null;
      show('home');
      renderList();
    }
  }
  window.addEventListener('popstate', e => {
    // Back while recording = stop and save. The recording screen moves on by itself afterwards.
    if (state.recording) { stopRecording(); return; }
    const s = e.state || {};
    render(s.view === 'rec' ? 'home' : s.view || 'home', s.id);
  });

  // ---------- Home: tabs + list ----------
  function setTab(t) {
    state.tab = t;
    $('tab-note').setAttribute('aria-pressed', t === 'note');
    $('tab-list').setAttribute('aria-pressed', t === 'list');
    $('new-label').textContent = t === 'list' ? 'New to-do list' : 'New note';
    $('list-title').textContent = t === 'list' ? 'Your to-do lists' : 'Your notes';
    $('empty').textContent = t === 'list'
      ? 'No to-do lists yet. Tap the button above and start talking.'
      : 'No notes yet. Tap the button above and start talking.';
    setStatus('');
    renderList();
  }
  $('tab-note').onclick = () => setTab('note');
  $('tab-list').onclick = () => setTab('list');
  $('new').onclick = () => startRecording(state.tab, null);

  async function renderList() {
    const items = (await DB.all()).filter(it => (state.tab === 'list') === isList(it));
    const list = $('list');
    list.textContent = '';
    for (const it of items) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'item';
      if (it.title) {
        const h = document.createElement('span');
        h.className = 'item-title';
        h.textContent = it.title;
        btn.append(h);
      }
      const d = document.createElement('span');
      d.className = 'item-date';
      d.textContent = fmtDate(it.createdAt);
      btn.append(d);
      if (isList(it)) {
        const lines = listLines(it.text);
        for (const line of lines.slice(0, 3)) {
          const s = document.createElement('span');
          s.className = 'preview-todo';
          s.textContent = line;
          btn.append(s);
        }
        const meta = document.createElement('span');
        meta.className = 'item-meta';
        meta.textContent = !lines.length ? 'All done' : lines.length === 1 ? '1 item' : lines.length + ' items';
        btn.append(meta);
      } else {
        const t = document.createElement('span');
        t.className = 'item-text';
        t.textContent = it.text || '(empty)';
        btn.append(t);
      }
      btn.onclick = () => go('detail', it.id);
      li.append(btn);
      list.append(li);
    }
    $('empty').hidden = items.length > 0;
  }

  // ---------- Detail screen ----------
  let saveTimer, unsaved = false;
  let currentFormat = 'text';
  async function openDetail(id) {
    const it = await DB.get(id);
    if (!it) { render('home'); return; }
    state.openId = id;
    currentFormat = isList(it) ? 'list' : 'text';
    $('detail-date').textContent = fmtDate(it.createdAt);
    $('detail-text').value = it.text;
    $('detail-title').value = it.title || '';
    $('save-state').textContent = it.updatedAt !== it.createdAt ? 'Edited ' + fmtDate(it.updatedAt) : '';
    $('words-hint').textContent = isList(it)
      ? 'Tap a box to tick an item off. Tap a word to correct it.'
      : 'Tap a word to correct or delete it.';
    setEditAll(false);
    show('detail');
  }

  // ---------- Tap a word to correct or delete it ----------
  // The text is split into words and the spaces/line breaks between them.
  // Punctuation stuck to a word ("milk." or "(note") is kept when you fix it.
  let tokens = [], editingAll = false;
  const PUNCT_START = /^[("'“‘[]+/;
  const PUNCT_END = /[.,!?;:)"'”’…\]]+$/;
  const isSpace = t => /^\s+$/.test(t || '');
  function splitToken(tok) {
    const pre = (tok.match(PUNCT_START) || [''])[0];
    const rest = tok.slice(pre.length);
    const suf = (rest.match(PUNCT_END) || [''])[0];
    return { pre, core: rest.slice(0, rest.length - suf.length), suf };
  }

  function wordSpan(tok, i, flashIndex) {
    const s = document.createElement('span');
    s.className = 'w' + (i === flashIndex ? ' flash' : '');
    s.dataset.i = i;
    s.textContent = tok;
    return s;
  }

  function renderWords(flashIndex) {
    const box = $('detail-words');
    box.textContent = '';
    tokens = $('detail-text').value.split(/(\s+)/);
    const asList = currentFormat === 'list';
    box.classList.toggle('as-list', asList);

    if (!asList) {
      tokens.forEach((tok, i) => {
        if (!tok) return;
        if (isSpace(tok)) box.append(tok);
        else box.append(wordSpan(tok, i, flashIndex));
      });
      if (!box.textContent.trim()) {
        box.innerHTML = '<span class="placeholder">(empty) Tap “Edit all text” to type something.</span>';
      }
    } else {
      // To-do list: every line becomes an item with a tick box.
      const ul = document.createElement('ul');
      ul.className = 'todo-list';
      box.append(ul);
      let line = 0, words = null;
      tokens.forEach((tok, i) => {
        if (!tok) return;
        if (isSpace(tok)) {
          const breaks = (tok.match(/\n/g) || []).length;
          if (breaks) { line += breaks; words = null; }
          else if (words) words.append(tok);
          return;
        }
        if (!words) {
          const li = document.createElement('li');
          li.className = 'todo';
          li.dataset.line = line;
          const check = document.createElement('button');
          check.className = 'check';
          check.setAttribute('aria-label', 'Tick off');
          words = document.createElement('span');
          words.className = 'todo-text';
          li.append(check, words);
          ul.append(li);
        }
        words.append(wordSpan(tok, i, flashIndex));
      });
      if (!ul.children.length) {
        box.innerHTML = '<span class="placeholder">All done! 🎉 Tap “Continue recording” to add more items.</span>';
      }
    }
    const flashed = box.querySelector('.flash');
    if (flashed) setTimeout(() => flashed.classList.remove('flash'), 50);
  }

  $('detail-words').onclick = e => {
    const check = e.target.closest('.check');
    if (check) { tick(check.closest('.todo')); return; }
    const w = e.target.closest('.w');
    if (w) openFix(+w.dataset.i);
  };

  // Ticking items off: they're removed a moment later (so you can tick several),
  // with an Undo button in case of a mistake.
  let tickTimer = null;
  function tick(li) {
    li.classList.toggle('done');
    clearTimeout(tickTimer);
    tickTimer = setTimeout(removeTicked, 900);
  }
  function flushTicks() {
    if (tickTimer) { clearTimeout(tickTimer); removeTicked(); }
  }
  async function removeTicked() {
    tickTimer = null;
    const done = [...document.querySelectorAll('.todo.done')].map(li => +li.dataset.line);
    const id = state.openId;
    if (!done.length || !id) return;
    const before = $('detail-text').value;
    const after = before.split('\n').filter((_, k) => !done.includes(k)).join('\n');
    $('detail-text').value = after;
    await saveDetailNow();
    if (state.openId === id) renderWords();
    else if (!$('home').hidden) renderList(); // you already went back: refresh the list preview
    toast(done.length === 1 ? 'Ticked off' : `${done.length} items ticked off`, 'Undo', async () => {
      const it = await DB.get(id);
      if (!it) return;
      it.text = before;
      it.updatedAt = new Date().toISOString();
      await DB.put(it);
      if (state.openId === id) { $('detail-text').value = before; if (!editingAll) renderWords(); }
      else if (!$('home').hidden) renderList();
    });
  }

  // Text for Copy/Share: the title (if any) on top, and to-do lists get a bullet in front of each item.
  function exportText() {
    let text = $('detail-text').value;
    if (currentFormat === 'list') text = listLines(text).map(s => '• ' + s).join('\n');
    const title = $('detail-title').value.trim();
    return title ? title + '\n\n' + text : text;
  }

  // The words being corrected: token indices fixStart..fixEnd. Usually one word, but
  // "+ word before / after" grows it, because Google often splits an unusual name
  // into several words ("Seberini" heard as "sever Rini").
  let fixStart = -1, fixEnd = -1;
  const isWord = t => !!t && !isSpace(t);
  const sameLine = t => isSpace(t) && !t.includes('\n');
  const canGrow = dir => dir < 0
    ? sameLine(tokens[fixStart - 1]) && isWord(tokens[fixStart - 2])
    : sameLine(tokens[fixEnd + 1]) && isWord(tokens[fixEnd + 2]);
  // The selected words without punctuation at either end, e.g. "sever Rini".
  function fixPhrase() {
    return tokens.slice(fixStart, fixEnd + 1).join('')
      .replace(PUNCT_START, '').replace(PUNCT_END, '').replace(/\s+/g, ' ').trim();
  }

  function openFix(i) {
    fixStart = fixEnd = i;
    updateFixSheet();
    $('fix-always').checked = true;
    $('fix-sheet').hidden = false;
    $('fix-input').focus();
    $('fix-input').select(); // typing replaces the whole word
  }

  function updateFixSheet() {
    const heard = fixPhrase();
    for (const s of document.querySelectorAll('.w.sel')) s.classList.remove('sel');
    for (let k = fixStart; k <= fixEnd; k++) {
      const span = document.querySelector(`.w[data-i="${k}"]`);
      if (span) span.classList.add('sel');
    }
    const several = fixEnd > fixStart;
    $('fix-title').textContent = several ? 'Correct words' : 'Correct word';
    $('fix-was').textContent = heard || tokens[fixStart];
    $('fix-input').value = heard || tokens[fixStart];
    $('fix-always-word').textContent = heard;
    $('fix-always-row').hidden = !heard;
    $('fix-delete').textContent = several ? 'Delete words' : 'Delete word';
    $('fix-prev').disabled = !canGrow(-1);
    $('fix-next').disabled = !canGrow(1);
    renderSuggestions(heard);
  }

  // Grow the selection by one word, keeping the text box ready for typing.
  function growFix(dir) {
    if (!canGrow(dir)) return;
    if (dir < 0) fixStart -= 2; else fixEnd += 2;
    updateFixSheet();
    $('fix-input').focus();
    $('fix-input').select();
  }
  $('fix-prev').onclick = () => growFix(-1);
  $('fix-next').onclick = () => growFix(1);

  // One-tap suggestions: corrections you've saved before that look like what was heard,
  // so a name Google gets wrong in a new way is quick to fix (and gets remembered too).
  function similarity(a, b) {
    a = a.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    b = b.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!a || !b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, k) => k);
    for (let x = 1; x <= a.length; x++) {
      const cur = [x];
      for (let y = 1; y <= b.length; y++) {
        cur[y] = Math.min(prev[y] + 1, cur[y - 1] + 1, prev[y - 1] + (a[x - 1] === b[y - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }
  function renderSuggestions(heard) {
    const box = $('fix-suggest');
    box.textContent = '';
    const targets = [...new Set(Object.values(fixes))]
      .filter(t => t.toLowerCase() !== heard.toLowerCase())
      .map(t => ({ t, score: similarity(heard, t) }))
      .filter(s => s.score >= 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    for (const { t } of targets) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = t;
      b.onclick = () => { $('fix-input').value = t; $('fix-input').focus(); };
      box.append(b);
    }
    box.hidden = !targets.length;
  }

  function closeFix() {
    if ($('fix-sheet').hidden) return;
    $('fix-sheet').hidden = true;
    fixStart = fixEnd = -1;
    $('fix-input').blur();
    for (const s of document.querySelectorAll('.w.sel')) s.classList.remove('sel');
  }

  async function applyFix(replacement) {
    const i = fixStart, j = fixEnd;
    if (i < 0) return;
    const heard = fixPhrase();
    const { pre } = splitToken(tokens[i]);
    const { suf } = splitToken(tokens[j]);
    replacement = replacement.replace(/\s+/g, ' ').trim();
    for (let k = i + 1; k <= j; k++) tokens[k] = ''; // the words after the first are replaced too
    let flash, remembered = false;
    if (replacement) {
      tokens[i] = heard ? pre + replacement + suf : replacement;
      flash = i;
      if (heard && replacement !== heard && $('fix-always').checked) {
        rememberFix(heard, replacement);
        remembered = true;
      }
    } else {
      // Delete the words. Keep punctuation after them (e.g. "milk extra." → "milk.")
      // and remove one of the spaces around them.
      if (heard && suf && isSpace(tokens[i - 1]) && !tokens[i - 1].includes('\n') && i >= 2) {
        tokens[i - 1] = '';
        tokens[i] = suf;
      } else if (heard && suf) {
        tokens[i] = suf;
      } else {
        tokens[i] = '';
        if (isSpace(tokens[i - 1]) && !tokens[i - 1].includes('\n')) tokens[i - 1] = '';
        else if (isSpace(tokens[j + 1]) && !tokens[j + 1].includes('\n')) tokens[j + 1] = '';
      }
      toast(j > i ? 'Words deleted' : 'Word deleted');
    }
    let text = tokens.join('');
    if (remembered) {
      // Fix the same mistake anywhere else in this note too.
      const others = countMatches(heard, text);
      text = applyFixes(text);
      toast(others > 0
        ? `Corrected here and in ${others} other place${others > 1 ? 's' : ''}. It’ll be fixed automatically from now on.`
        : 'Corrected. It’ll be fixed automatically from now on.');
    } else if (replacement) {
      toast('Corrected');
    }
    $('detail-text').value = text;
    closeFix();
    await saveDetailNow();
    renderWords(flash);
  }
  const countMatches = (phrase, text) => (text.match(fixRegex([phrase.toLowerCase()])) || []).length;

  $('fix-save').onclick = () => applyFix($('fix-input').value);
  $('fix-delete').onclick = () => applyFix('');
  $('fix-cancel').onclick = closeFix;
  $('fix-sheet').onclick = e => { if (e.target === $('fix-sheet')) closeFix(); }; // tap outside the box
  $('fix-input').onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); applyFix($('fix-input').value); }
    else if (e.key === 'Escape') closeFix();
  };

  // ---------- Remembered word fixes ----------
  // Correcting words with "Always fix" ticked saves the swap (e.g. "sever Rini" → "Seberini"),
  // and it's made automatically in everything recorded after that. Fixes are kept in the
  // same database as the notes (plus a copy in localStorage) and only go when you remove
  // them in Settings. Deleting notes doesn't touch them.
  let fixes = {};
  const fixKey = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const loadFixes = () => ({ ...fixes });
  function saveFixes(f) {
    fixes = { ...f };
    write('fixes', JSON.stringify(fixes));
    DB.setSetting('fixes', fixes).catch(() => {});
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }
  async function initFixes() {
    let local = {};
    try { local = JSON.parse(read('fixes', '{}')) || {}; } catch {}
    let stored = {};
    try { stored = (await DB.getSetting('fixes')) || {}; } catch {}
    fixes = { ...local, ...stored };
    // Keep both copies in step (e.g. fixes saved by v2.0, which only used localStorage).
    if (Object.keys(fixes).length !== Object.keys(stored).length) saveFixes(fixes);
  }
  function rememberFix(from, to) {
    saveFixes({ ...fixes, [fixKey(from)]: to });
  }
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Whole words only, any capitalisation: "Lawrence" and "lawrence" both match, "Lawrences" doesn't.
  // Phrases match with any spacing between their words.
  function fixRegex(keys) {
    const alts = keys.map(k => escapeRe(k).replace(/ /g, '[ \\t]+'));
    return new RegExp(`(?<![\\p{L}\\p{N}'’])(?:${alts.join('|')})(?![\\p{L}\\p{N}'’])`, 'giu');
  }
  function applyFixes(t) {
    const keys = Object.keys(fixes).sort((a, b) => b.length - a.length); // longest first
    if (!keys.length || !t) return t;
    return t.replace(fixRegex(keys), m => {
      const to = fixes[fixKey(m)];
      if (to == null) return m;
      // Keep a capital at the start of a sentence: "Wool" → "Woolies" even if saved as "woolies".
      return /^\p{Lu}/u.test(m) && /^\p{Ll}/u.test(to) ? to[0].toUpperCase() + to.slice(1) : to;
    });
  }

  function renderFixes() {
    const list = $('fixes');
    list.textContent = '';
    for (const from of Object.keys(fixes).sort()) {
      const li = document.createElement('li');
      const pair = document.createElement('span');
      pair.className = 'fix-pair';
      const was = document.createElement('s');
      was.textContent = from;
      pair.append(was, ' → ', fixes[from]);
      const del = document.createElement('button');
      del.className = 'fix-remove';
      del.textContent = '×';
      del.setAttribute('aria-label', `Stop fixing ${from}`);
      del.onclick = () => {
        const now = loadFixes();
        delete now[from];
        saveFixes(now);
        renderFixes();
        toast('Removed');
      };
      li.append(pair, del);
      list.append(li);
    }
    $('fixes-empty').hidden = list.children.length > 0;
    $('fixes-clear').hidden = !list.children.length;
  }
  $('fixes-clear').onclick = () => {
    if (!confirm('Remove all word fixes? The app will stop correcting these words for you.')) return;
    saveFixes({});
    renderFixes();
    toast('All word fixes removed');
  };

  // "Edit all text" switches to a normal text box for bigger changes.
  function setEditAll(on) {
    editingAll = on;
    $('detail-text').hidden = !on;
    $('detail-words').hidden = on;
    $('words-hint').hidden = on;
    $('edit-all').textContent = on ? '✓ Done editing' : '✎ Edit all text';
    if (on) $('detail-text').focus();
    else renderWords();
  }
  $('edit-all').onclick = async () => {
    if (editingAll) { await saveDetailNow(); setEditAll(false); }
    else setEditAll(true);
  };

  // "Continue recording": record more and add it to the end of this note or list.
  $('continue').onclick = async () => {
    flushTicks();
    await saveDetailNow();
    startRecording(currentFormat === 'list' ? 'list' : 'note', state.openId);
  };
  // Reads the screen straight away (before any waiting), so it still saves the right
  // note when called just as you leave the screen.
  async function saveDetailNow() {
    clearTimeout(saveTimer);
    unsaved = false;
    const id = state.openId;
    if (!id) return;
    const text = $('detail-text').value;
    const title = $('detail-title').value.replace(/\s+/g, ' ').trim();
    const it = await DB.get(id);
    if (!it || (it.text === text && (it.title || '') === title)) return;
    it.text = text;
    if (title) it.title = title; else delete it.title;
    it.updatedAt = new Date().toISOString();
    await DB.put(it);
    if (state.openId === id) $('save-state').textContent = 'Saved';
    else if (!$('home').hidden) renderList(); // already back on the list: show the change
  }
  for (const el of [$('detail-text'), $('detail-title')]) {
    el.addEventListener('input', () => {
      unsaved = true;
      $('save-state').textContent = 'Saving…';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveDetailNow, 600);
    });
    el.addEventListener('blur', saveDetailNow);
  }
  $('detail-title').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = $('detail-text');
      ta.focus(); ta.select();
      document.execCommand('copy');
    }
    toast('Copied');
  }
  $('copy').onclick = () => copyText(exportText());
  $('share').onclick = async () => {
    const text = exportText();
    if (navigator.share) {
      try { await navigator.share({ text }); } catch (e) { if (e.name !== 'AbortError') copyText(text); }
    } else {
      copyText(text);
    }
  };
  $('delete').onclick = async () => {
    if (!confirm(currentFormat === 'list' ? 'Delete this to-do list? This cannot be undone.' : 'Delete this note? This cannot be undone.')) return;
    clearTimeout(saveTimer);
    await DB.remove(state.openId);
    state.openId = null;
    toast('Deleted');
    history.back();
  };
  $('back').onclick = () => { saveDetailNow(); history.back(); };

  $('open-settings').onclick = () => go('settings');
  $('settings-back').onclick = () => history.back();

  // Spoken commands: saying "new line" starts a new line.
  // "Buy milk. New line. Call the dentist." becomes "Buy milk.\nCall the dentist."
  // The speech engine doesn't always spell it the same way, so this also
  // accepts "newline", "new-line", "new lines", "knew line", "nu line",
  // and the words wrapped in quotes or followed by "...".
  const NEW_LINE = /[,;:]?[ \t]*["'“”‘’]?\b(?:new|knew|nu|neu)(?:[ \t]*[-‐‑–—][ \t]*|[ \t]*)lines?\b["'“”‘’]?(?:[ \t.,;:!?…"'“”‘’]*)/gi;
  function applyVoiceCommands(t) {
    return t
      .replace(/[ \t]+/g, ' ')        // tidy spaces, but keep any line breaks already there
      .replace(NEW_LINE, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n([a-z])/g, (m, c) => '\n' + c.toUpperCase()) // capital letter after a new line
      .replace(/^[ \t]+|[ \t]+$/g, '');
  }

  // ---------- Recording ----------
  // Uses the browser's built-in speech recognition (Google on Android Chrome).
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null, finals = [], interim = '', timer = null, startedAt = 0;

  async function startRecording(kind, appendTo) {
    if (!SR) {
      setStatus('This browser can’t turn speech into text. Please open the app in Chrome.');
      return;
    }
    state.kind = kind;
    state.appendTo = appendTo;
    state.before = '';
    let title = '';
    if (appendTo) {
      const it = await DB.get(appendTo);
      state.before = it ? it.text : '';
      title = (it && it.title) || '';
    }
    const list = kind === 'list';
    $('rec-title').textContent = title || (appendTo ? (list ? 'Add to list' : 'Add to note') : (list ? 'New to-do list' : 'New note'));
    $('rec-live').className = 'live-card' + (list ? '' : ' note');
    $('rec-hint').textContent = list
      ? 'Say an item, tap New line, say the next one. Tap the stop button when you’re done.'
      : 'Tap New line to start a new line. Tap the stop button when you’re done.';
    history.pushState({ view: 'rec' }, '');
    show('rec');

    finals = []; interim = '';
    try {
      startRecognition();
    } catch (e) {
      history.back();
      toast('Could not start recording: ' + e.message);
      return;
    }
    state.recording = true;
    setBusy(true);
    $('record').classList.add('recording');
    startedAt = Date.now();
    const tickClock = () => ($('record-label').textContent = fmtTime((Date.now() - startedAt) / 1000));
    tickClock();
    timer = setInterval(tickClock, 500);
    showLive();
  }

  function startRecognition() {
    recognition = new SR();
    recognition.lang = 'en-ZA'; // South African English: better with local accents, names and places
    recognition.interimResults = true;
    // One phrase per session, restarted automatically. This avoids repeated
    // words that Android Chrome produces in "continuous" mode.
    recognition.continuous = false;
    recognition.onresult = e => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals.push(r[0].transcript.trim());
        else interim += r[0].transcript;
      }
      showLive();
    };
    recognition.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('Microphone blocked. Allow the microphone for this site and try again.');
        stopRecording();
      } else if (e.error === 'network') {
        toast('Speech-to-text needs an internet connection.');
        stopRecording();
      }
    };
    recognition.onend = () => {
      if (interim) { finals.push(interim.trim()); interim = ''; showLive(); }
      if (state.recording && recognition) { try { recognition.start(); } catch {} }
      else if (recognitionDone) { recognitionDone(); recognitionDone = null; }
    };
    recognition.start();
  }

  // What's been said so far, with voice commands and remembered word fixes applied.
  const spokenText = () => applyFixes(applyVoiceCommands([...finals, interim].filter(Boolean).join(' ')));

  // "New line" button: the next words start a new line (in a to-do list, a new item).
  // Whatever is still being recognised is kept on the current line, and the
  // recogniser restarts so its late result can't land on the new line.
  $('newline').onclick = () => {
    if (!state.recording) return;
    const said = spokenText();
    // Adding to a note: tapping first starts the new words on their own line.
    // (A to-do list does that by itself, each addition is a new item.)
    const startOfAddition = !said && state.kind !== 'list' && state.before.trim();
    if (!said.split('\n').pop().trim() && !startOfAddition) return; // nothing said on this line yet
    if (interim) {
      finals.push(interim.trim());
      interim = '';
      try { recognition.abort(); } catch {}
    }
    finals.push('\n');
    showLive();
  };

  function showLive() {
    const box = $('rec-live');
    const said = spokenText();
    box.textContent = '';
    if (state.kind !== 'list') {
      const before = state.before.trim();
      const text = said.startsWith('\n') ? before + said : [before, said].filter(Boolean).join(' ');
      if (text) box.textContent = text;
      else box.innerHTML = '<p class="placeholder">Listening…</p>';
    } else {
      // Earlier items, then what's being said now; the last line is the one being filled.
      const lines = [...listLines(state.before), ...said.split('\n').map(s => s.trim())];
      const ul = document.createElement('ul');
      ul.className = 'todo-list';
      lines.forEach((text, i) => {
        const li = document.createElement('li');
        li.className = 'todo' + (i === lines.length - 1 ? ' current' : '');
        li.innerHTML = '<span class="check" aria-hidden="true"></span><span class="todo-text"></span>';
        li.querySelector('.todo-text').textContent = capitalise(text);
        ul.append(li);
      });
      box.append(ul);
    }
    window.scrollTo(0, document.body.scrollHeight); // keep the newest words in view
  }

  let recognitionDone = null;
  async function stopRecording() {
    if (!state.recording) return;
    state.recording = false;
    clearInterval(timer);
    $('record').classList.remove('recording');
    const rec = recognition;
    await new Promise(r => {
      recognitionDone = r;
      try { rec.stop(); } catch { r(); }
      setTimeout(r, 2500); // don't hang if the browser never says it's finished
    });
    recognition = null;
    let text = spokenText().replace(/\n{2,}/g, '\n').replace(/\n+$/, '');
    if (!state.appendTo) text = text.replace(/^\n+/, ''); // a new line at the start only matters when adding
    let newItemId = null;
    try {
      if (!text) toast('No speech heard. Try again.');
      else newItemId = await saveResult(text, (Date.now() - startedAt) / 1000);
    } catch (e) {
      toast('Could not save: ' + e.message);
    }
    setBusy(false);
    leaveRec(newItemId);
  }
  $('record').onclick = stopRecording;
  $('rec-back').onclick = stopRecording;

  // Leave the recording screen. A new item replaces it in the history, so Back
  // from the new item goes home. Otherwise go back to where recording started.
  function leaveRec(newItemId) {
    const onRec = (history.state || {}).view === 'rec';
    if (newItemId) {
      history[onRec ? 'replaceState' : 'pushState']({ view: 'detail', id: newItemId }, '');
      render('detail', newItemId);
    } else if (onRec) {
      history.back(); // popstate shows the previous screen
    } else {
      render(state.appendTo ? 'detail' : 'home', state.appendTo); // Back was pressed: already there
    }
  }

  // Save the result: add it to the note/list being continued, or make a new one.
  // Returns the id of a newly made item.
  async function saveResult(text, seconds) {
    const id = state.appendTo;
    const it = id && await DB.get(id);
    if (!it) return saveNew(text, seconds);
    const before = it.text.replace(/[ \t]+$/, '');
    // Join with a space, unless either side is already a new line.
    // In a to-do list, each new recording starts a new item.
    const joiner = !before || before.endsWith('\n') || text.startsWith('\n') ? '' : isList(it) ? '\n' : ' ';
    if (isList(it)) text = capitalise(text);
    it.text = before + joiner + text;
    it.updatedAt = new Date().toISOString();
    it.seconds = (it.seconds || 0) + Math.round(seconds);
    await DB.put(it);
    toast(isList(it) ? 'Added to list' : 'Added to note');
    return null;
  }

  async function saveNew(text, seconds) {
    // A new note starts with a capital letter, not a blank line.
    text = capitalise(text.replace(/^\n+/, ''));
    const now = new Date().toISOString();
    const item = { id: newId(), createdAt: now, updatedAt: now, text, mode: 'google', seconds: Math.round(seconds) };
    if (state.kind === 'list') item.format = 'list';
    await DB.put(item);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    setTab(state.kind); // so Back from the new item lands on its tab
    toast('Saved');
    return item.id;
  }

  // ---------- Accent colour ----------
  // One colour for buttons, tabs, the record button and highlights. Chosen in Settings.
  const ACCENTS = [
    { id: 'terracotta', name: 'Terracotta', color: '#c2552d' },
    { id: 'ocean', name: 'Ocean', color: '#2f6db5' },
    { id: 'forest', name: 'Forest', color: '#2f7a4f' },
    { id: 'plum', name: 'Plum', color: '#8a3f86' },
    { id: 'raspberry', name: 'Raspberry', color: '#c2185b' },
    { id: 'ink', name: 'Ink', color: '#2a2420' },
  ];
  const currentAccent = () => ACCENTS.find(a => a.id === read('accent', '')) || ACCENTS[0];
  function applyAccent() {
    document.documentElement.style.setProperty('--accent', currentAccent().color);
  }
  function renderAccents() {
    const box = $('accents');
    box.textContent = '';
    for (const a of ACCENTS) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = a.color;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', a.id === currentAccent().id);
      b.setAttribute('aria-label', a.name);
      b.onclick = () => { write('accent', a.id); applyAccent(); renderAccents(); };
      box.append(b);
    }
    $('accent-name').textContent = currentAccent().name;
  }

  // ---------- Backup & restore ----------
  $('backup').onclick = async () => {
    const items = await DB.all();
    if (!items.length) { toast('Nothing to back up yet'); return; }
    const data = JSON.stringify({ app: 'voice-notes', appVersion: VERSION, exportedAt: new Date().toISOString(), transcripts: items, fixes: loadFixes() }, null, 1);
    const name = `voice-notes-backup-${new Date().toISOString().slice(0, 10)}.txt`;
    // Saved as .txt because Android's share menu accepts text files (it refuses .json).
    const file = new File([data], name, { type: 'text/plain' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Voice Notes backup' }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Backup file downloaded');
  };

  $('restore').onclick = () => $('restore-file').click();
  $('restore-file').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'voice-notes' || !Array.isArray(data.transcripts)) throw new Error('not a Voice Notes backup');
      let added = 0, updated = 0, kept = 0;
      for (const t of data.transcripts) {
        if (!t || !t.id || typeof t.text !== 'string' || !t.createdAt) continue;
        const existing = await DB.get(t.id);
        if (!existing) { await DB.put(t); added++; }
        else if ((t.updatedAt || '') > (existing.updatedAt || '')) { await DB.put(t); updated++; }
        else kept++;
      }
      // Word fixes: add the backup's, but keep any made on this phone.
      if (data.fixes && typeof data.fixes === 'object') saveFixes({ ...data.fixes, ...loadFixes() });
      toast(`Restored: ${added} added, ${updated} updated, ${kept} already here`);
    } catch (err) {
      toast('Could not restore: ' + err.message);
    }
  };

  // ---------- Auto-update ----------
  // The service worker (sw.js) lets the app open offline and install to the home
  // screen. Whenever a new version is published, the phone fetches it, and the
  // page reloads itself (waiting until you're not recording).
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return; // first install: nothing to update
      if (state.busy) state.pendingReload = true;
      else location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      const check = () => reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
      setInterval(check, 15 * 60 * 1000);
    }).catch(() => {});
  }

  // ---------- Start ----------
  for (const el of document.querySelectorAll('.app-version')) el.textContent = VERSION;
  applyAccent();
  initFixes();
  history.replaceState({ view: 'home' }, '');
  setTab('note');

  // Exposed for testing only.
  window.VoiceNotes = { state, applyVoiceCommands };
})();
