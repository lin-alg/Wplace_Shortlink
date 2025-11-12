// ==UserScript==
// @name         Wplace Shortlink
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Only keep link-formatting: detect wplace.live URLs in readonly inputs/text and replace Copy button handler to copy normalized wplace.live/?lat=...&lng=... (rounded to 3 decimals).
// @match        https://*.wplace.live/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // --- configuration ---
  const SELECTOR_ATTR = '[readonly]';
  const SELECTOR_CLASS_MATCH = 'text-base-content/80';
  const POLL_MS = 500;
  const DEBOUNCE_MS = 250;

  // --- helper: round to 3 decimals, trim trailing zeros ---
  function round3(v) {
    const n = Number(v);
    if (!isFinite(n)) return null;
    const s = (Math.round(n * 1000) / 1000).toFixed(3);
    return s.replace(/(?:\.0+$|(\.\d+?)0+$)/, '$1');
  }

  // --- extract and format a wplace.live fragment from arbitrary text ---
  function extractAndFormatUrl(text) {
    if (!text) return null;

    // loose match for wplace.live URL fragment
    const reUrl = /(https?:\/\/)?(www\.)?wplace\.live[^\s'"]*/i;
    const m = String(text).match(reUrl);
    if (!m) return null;
    const matched = m[0];

    // try robust URL parsing first
    try {
      const url = new URL((/^https?:\/\//i.test(matched) ? '' : 'https://') + matched.replace(/^(https?:\/\/)?/, ''));
      const params = url.searchParams;
      if (!params.has('lat') || !params.has('lng')) return null;
      const lat = parseFloat(params.get('lat'));
      const lng = parseFloat(params.get('lng'));
      if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
      const latS = round3(lat);
      const lngS = round3(lng);
      const zoom = params.has('zoom') ? params.get('zoom') : null;
      return `wplace.live/?lat=${latS}&lng=${lngS}${zoom ? `&zoom=${zoom}` : ''}`;
    } catch (e) {
      // fallback: try to parse query string manually
      try {
        const raw = matched.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
        const qIdx = raw.indexOf('?');
        if (qIdx >= 0) {
          const qs = raw.slice(qIdx + 1);
          const sp = new URLSearchParams(qs);
          if (sp.has('lat') && sp.has('lng')) {
            const lat = parseFloat(sp.get('lat'));
            const lng = parseFloat(sp.get('lng'));
            if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
              const latS = round3(lat);
              const lngS = round3(lng);
              const zoom = sp.has('zoom') ? sp.get('zoom') : null;
              return `wplace.live/?lat=${latS}&lng=${lngS}${zoom ? `&zoom=${round3(zoom)}` : ''}`;
            }
          }
        }
      } catch (e2) {}
    }

    return null;
  }

  // --- find rendered text near an element (value / textContent / neighbors) ---
  function findRenderedText(el) {
    if (!el) return '';
    const cand = (el.value || el.getAttribute('value') || el.innerText || el.textContent || '').trim();
    if (cand) return cand;
    const parent = el.parentNode;
    if (parent) {
      for (const node of Array.from(parent.childNodes)) {
        const txt = (node.textContent || '').trim();
        if (txt && /wplace\.live/i.test(txt)) return txt;
      }
    }
    if (parent && parent.parentNode) {
      for (const node of Array.from(parent.parentNode.childNodes)) {
        const txt = (node.textContent || '').trim();
        if (txt && /wplace\.live/i.test(txt)) return txt;
      }
    }
    return '';
  }

  // --- test whether element should be target of formatting ---
  function isTargetInput(el) {
    if (!el || el.getAttribute == null) return false;
    if (el.getAttribute('readonly') == null) return false;
    const cls = el.getAttribute('class') || '';
    return cls.indexOf(SELECTOR_CLASS_MATCH) !== -1;
  }

  // --- apply formatted string into element if different (debounced) ---
  const debounceMap = new WeakMap();
  function applyFormattedIfNeeded(el, formatted) {
    if (!el || !formatted) return;
    const current = (el.value || el.getAttribute('value') || el.innerText || el.textContent || '').trim();
    if (current === formatted) return;
    const lastTimer = debounceMap.get(el);
    if (lastTimer) clearTimeout(lastTimer);
    const t = setTimeout(() => {
      try {
        if ('value' in el) el.value = formatted;
        else if ('innerText' in el) el.innerText = formatted;
        else el.textContent = formatted;
        el.setAttribute('title', `formatted → ${formatted}`);
      } catch (e) {
        try { el.innerText = formatted; } catch (ee) { el.textContent = formatted; }
      }
      debounceMap.delete(el);
    }, DEBOUNCE_MS);
    debounceMap.set(el, t);
  }

  function processElement(el) {
    if (!el) return;
    const text = findRenderedText(el);
    const formatted = extractAndFormatUrl(text);
    if (formatted) applyFormattedIfNeeded(el, formatted);
  }

  function scanAndProcess() {
    try {
      const candidates = Array.from(document.querySelectorAll(SELECTOR_ATTR)).filter(isTargetInput);
      for (const el of candidates) processElement(el);
    } catch (e) {}
  }

  function bindEventsTo(el) {
    if (!el) return;
    if (el.__wplace_bound) return;
    const handler = () => processElement(el);
    el.addEventListener('input', handler, { passive: true });
    el.addEventListener('change', handler, { passive: true });
    el.addEventListener('blur', handler, { passive: true });
    el.__wplace_bound = true;
  }

  function bindExistingAndFuture() {
    const list = Array.from(document.querySelectorAll(SELECTOR_ATTR)).filter(isTargetInput);
    for (const el of list) bindEventsTo(el);
  }

  // MutationObserver to catch dynamic content
  const mo = new MutationObserver((mutations) => {
    let needsScan = false;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes && m.addedNodes.length > 0) { needsScan = true; break; }
      if (m.type === 'attributes') {
        const attr = m.attributeName;
        if (['class', 'value', 'readonly', 'textContent', 'innerText'].includes(attr)) { needsScan = true; break; }
      }
      if (m.type === 'characterData') { needsScan = true; break; }
    }
    if (needsScan) {
      bindExistingAndFuture();
      scanAndProcess();
    }
  });

  mo.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'value', 'readonly', 'textContent', 'innerText'],
    characterData: true
  });

  const poll = setInterval(() => {
    bindExistingAndFuture();
    scanAndProcess();
  }, POLL_MS);

  bindExistingAndFuture();
  scanAndProcess();

  window.addEventListener('beforeunload', () => {
    mo.disconnect();
    clearInterval(poll);
  });

  // --- replace Copy button handler: find button, clone to remove existing handlers, install our copy routine ---
  (function replaceCopyButtonHandler() {
    try {
      function findCopyButton() {
        let btn = Array.from(document.querySelectorAll('button.btn-primary, .btn-primary button'))
          .find(b => (b.textContent || '').trim().toLowerCase() === 'copy');
        if (btn) return btn;
        btn = Array.from(document.querySelectorAll('button.btn-primary, .btn-primary button'))
          .find(b => /copy/i.test(b.textContent || ''));
        return btn || null;
      }

      function extractWplaceUrl(text) {
        if (!text) return null;
        const m = String(text).match(/(https?:\/\/)?(www\.)?wplace\.live[^\s'"]*/i);
        if (!m) return null;
        return m[0];
      }

      function findCandidateString(button) {
        // search ancestors
        let el = button;
        for (let depth = 0; depth < 4 && el; depth++, el = el.parentElement) {
          const txt = el.innerText || el.textContent || '';
          const u = extractWplaceUrl(txt);
          if (u) return u;
        }
        // search parent container readonly/text nodes
        const parent = button.parentElement || document.body;
        const candidates = parent.querySelectorAll('input[readonly], [readonly], .text, p, span, div');
        for (const c of candidates) {
          const txt = (c.value || (c.getAttribute && c.getAttribute('value')) || c.innerText || c.textContent || '').toString();
          const u = extractWplaceUrl(txt);
          if (u) return u;
        }
        // whole page fallback
        const allText = Array.from(document.querySelectorAll('input[readonly], [readonly], p, span, div'))
          .map(n => (n.value || (n.getAttribute && n.getAttribute('value')) || n.innerText || n.textContent || '').toString());
        for (const t of allText) {
          const u = extractWplaceUrl(t);
          if (u) return u;
        }
        return null;
      }

      function normalizeAndRoundUrl(raw) {
        if (!raw) return null;
        const hasProtocol = /^https?:\/\//i.test(raw);
        const urlStr = hasProtocol ? raw : 'https://' + raw;
        try {
          const u = new URL(urlStr);
          const params = u.searchParams;
          if (params.has('lat') && params.has('lng')) {
            const lat = round3(params.get('lat'));
            const lng = round3(params.get('lng'));
            const zoom = params.has('zoom') ? params.get('zoom') : null;
            return `wplace.live/?lat=${lat}&lng=${lng}` + (zoom ? `&zoom=${zoom}` : '');
          }
          const withoutProto = (u.host + u.pathname + u.search + u.hash).replace(/^\/+/, '');
          return withoutProto;
        } catch (e) {
          let s = raw.replace(/^https?:\/\//i, '');
          const m = s.match(/lat=([^&\s]+).*?lng=([^&\s]+)/i);
          if (m) {
            const lat = round3(m[1]);
            const lng = round3(m[2]);
            const zoomM = s.match(/[?&]zoom=([^&\s]+)/i);
            const zoom = zoomM ? zoomM[1] : null;
            return `wplace.live/?lat=${lat}&lng=${lng}` + (zoom ? `&zoom=${zoom}` : '');
          }
          return s.replace(/^\/\//, '');
        }
      }

      async function copyToClipboardAndToast(text) {
        let ok = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            ok = true;
          }
        } catch (e) { ok = false; }
        if (!ok) {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
          ta.remove();
        }
        const old = document.getElementById('__wplace_copy_toast');
        if (old) old.remove();
        const toast = document.createElement('div');
        toast.id = '__wplace_copy_toast';
        toast.textContent = ok ? `Copied: ${text}` : `Copy failed`;
        Object.assign(toast.style, {
          position: 'fixed', left: '50%', transform: 'translateX(-50%)',
          bottom: '22px', padding: '8px 12px', background: 'rgba(0,0,0,0.75)',
          color: '#fff', borderRadius: '8px', zIndex: 2147483647, fontSize: '13px'
        });
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 900);
        return ok;
      }

      function installReplacement() {
        const btn = findCopyButton();
        if (!btn) return false;
        const replacement = btn.cloneNode(true);
        replacement.disabled = false;
        btn.parentNode && btn.parentNode.replaceChild(replacement, btn);

        replacement.addEventListener('click', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const raw = findCandidateString(replacement);
          if (!raw) {
            await copyToClipboardAndToast('No wplace link found');
            return;
          }
          const normalized = normalizeAndRoundUrl(raw);
          if (!normalized) {
            await copyToClipboardAndToast('No wplace link found');
            return;
          }
          await copyToClipboardAndToast(normalized);
        }, { passive: false });

        return true;
      }

      let attempts = 0;
      const maxAttempts = 8;
      function tryInstallLater() {
        attempts++;
        const ok = installReplacement();
        if (ok) return;
        if (attempts < maxAttempts) {
          setTimeout(tryInstallLater, 400 + attempts * 150);
        }
      }
      tryInstallLater();
    } catch (e) {
      console.error('replaceCopyButtonHandler failed', e);
    }
  })();

})();
