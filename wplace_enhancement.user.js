// ==UserScript==
// @name         wplace_enhancement
// @namespace    https://tampermonkey.net/
// @version      2.1
// @description  wplace.live 帧率控制、动效开关与四坐标跳转
// @author       Assistant
// @match        *://wplace.live/*
// @match        *://*.wplace.live/*
// @run-at       document-start
// @grant        unsafeWindow
// @updateURL    https://raw.githubusercontent.com/<你的GitHub用户名>/<仓库名>/main/wplace.user.js
// @downloadURL  https://raw.githubusercontent.com/<你的GitHub用户名>/<仓库名>/main/wplace.user.js
// ==/UserScript==

(function () {
    'use strict';

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const TILE_SIZE = 1000;

    let savedFps = Number(win.localStorage.getItem('tm_fps_active'));
    let savedTimeout = Number(win.localStorage.getItem('tm_fps_timeout'));

    let ACTIVE_FPS = (savedFps && savedFps > 0) ? savedFps : 60;
    let IDLE_FPS = 1;
    let IDLE_TIMEOUT = (savedTimeout && savedTimeout > 0) ? savedTimeout : 10000;

    let INTERVAL_ACTIVE = 1000 / ACTIVE_FPS;
    const INTERVAL_IDLE = 1000 / IDLE_FPS;
    const SHOW_INDICATOR = true;

    let disableGifs = win.localStorage.getItem('tm_disable_gifs') !== 'false';

    let isUserActive = false;
    let lastActiveTime = performance.now();
    let lastRenderTime = 0;

    let lastMouseX = null;
    let lastMouseY = null;
    let masterTimer = null;
    let currentPixelCoords = null;

    function applyGifToggle() {
        if (!document.documentElement) return;
        if (disableGifs) {
            document.documentElement.classList.add('tm-disable-gifs');
        } else {
            document.documentElement.classList.remove('tm-disable-gifs');
        }
    }

    function markUserActive() {
        const wasIdle = !isUserActive;
        isUserActive = true;
        lastActiveTime = performance.now();

        if (document.documentElement) {
            document.documentElement.classList.remove('tm-idle-mode');
        }

        if (wasIdle) {
            updateIndicator();
            updatePanelFps();
            if (masterTimer) {
                clearTimeout(masterTimer);
                masterTimer = null;
                originalRAF(masterTick);
            }
        }
    }

    function onPointerMove(e) {
        if (!e.isTrusted) return;
        if (lastMouseX === null) {
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            return;
        }
        const dist = Math.abs(e.clientX - lastMouseX) + Math.abs(e.clientY - lastMouseY);
        if (dist >= 2) {
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            markUserActive();
        }
    }

    ['mousedown', 'mouseup', 'wheel', 'touchstart', 'touchmove', 'keydown'].forEach(evt => {
        win.addEventListener(evt, (e) => {
            if (e.isTrusted) markUserActive();
        }, { passive: true, capture: true });
    });

    win.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
    win.addEventListener('mousemove', onPointerMove, { passive: true, capture: true });

    function tileFourToLatLng(coords) {
        if (!Array.isArray(coords) || coords.length !== 4) return null;
        const TlX = Number(coords[0]), TlY = Number(coords[1]), PxX = Number(coords[2]), PxY = Number(coords[3]);
        if (![TlX, TlY, PxX, PxY].every(Number.isFinite)) return null;
        const A1 = 1023999.50188499956857413054;
        const B1 = 325949.32345220289425924420;
        const A2 = 1023999.50188501563388854265;
        const B2 = 325949.32345236750552430749;
        const X = TlX * TILE_SIZE + PxX;
        const Y = TlY * TILE_SIZE + PxY;
        const lng = (180 / Math.PI) * ((X - A1) / B1);
        const t = Math.exp((A2 - Y) / B2);
        const lat = (360 / Math.PI) * (Math.atan(t) - Math.PI / 4);
        return { lat, lng };
    }

    function latLngToTileFour(lat, lng) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const A1 = 1023999.50188499956857413054;
        const B1 = 325949.32345220289425924420;
        const A2 = 1023999.50188501563388854265;
        const B2 = 325949.32345236750552430749;

        const X = ((lng * Math.PI) / 180) * B1 + A1;
        const t = Math.tan((lat * Math.PI) / 360 + Math.PI / 4);
        if (t <= 0) return null;
        const Y = A2 - B2 * Math.log(t);

        const roundX = Math.round(X);
        const roundY = Math.round(Y);

        const TlX = Math.floor(roundX / TILE_SIZE);
        const PxX = ((roundX % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
        const TlY = Math.floor(roundY / TILE_SIZE);
        const PxY = ((roundY % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;

        return [TlX, TlY, PxX, PxY];
    }

    function getStoredCoords() {
        try {
            const raw = win.localStorage.getItem('location');
            if (!raw) return null;
            const loc = JSON.parse(raw);
            if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
                return latLngToTileFour(loc.lat, loc.lng);
            }
        } catch (_) {}
        return null;
    }

    function extractPixelCoords(urlStr) {
        try {
            const u = new URL(urlStr, win.location.href);
            const match = u.pathname.match(/\/pixel\/(\d+)\/(\d+)/);
            if (match) {
                const pxX = u.searchParams.get('x');
                const pxY = u.searchParams.get('y');
                if (pxX !== null && pxY !== null) {
                    return [Number(match[1]), Number(match[2]), Number(pxX), Number(pxY)];
                }
            }
        } catch (_) {
            const fallback = String(urlStr).match(/\/pixel\/(\d+)\/(\d+)\?.*x=(\d+).*y=(\d+)/);
            if (fallback) {
                return [Number(fallback[1]), Number(fallback[2]), Number(fallback[3]), Number(fallback[4])];
            }
        }
        return null;
    }

    function handleNewPixelCoords(coords) {
        currentPixelCoords = coords;
        const latLng = tileFourToLatLng(coords);
        if (latLng) {
            try {
                win.localStorage.setItem('location', JSON.stringify({
                    lat: latLng.lat,
                    lng: latLng.lng,
                    zoom: 12
                }));
            } catch (_) {}
        }
        scanAndTransformCoords();
        setTimeout(scanAndTransformCoords, 40);
        setTimeout(scanAndTransformCoords, 120);
        setTimeout(scanAndTransformCoords, 260);
    }

    if (win.fetch) {
        const origFetch = win.fetch;
        win.fetch = function (...args) {
            try {
                const url = (args[0] instanceof Request) ? args[0].url : String(args[0]);
                const coords = extractPixelCoords(url);
                if (coords) {
                    handleNewPixelCoords(coords);
                }
            } catch (_) {}
            return origFetch.apply(this, args);
        };
    }

    if (win.XMLHttpRequest) {
        const origOpen = win.XMLHttpRequest.prototype.open;
        win.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            try {
                const coords = extractPixelCoords(String(url));
                if (coords) {
                    handleNewPixelCoords(coords);
                }
            } catch (_) {}
            return origOpen.apply(this, [method, url, ...rest]);
        };
    }

    const originalRAF = win.requestAnimationFrame.bind(win);
    const originalCAF = win.cancelAnimationFrame.bind(win);

    const rafQueue = new Map();
    let nextId = 1;
    let isMasterLoopRunning = false;

    let renderedFramesCount = 0;
    let currentRealFPS = 0;
    let lastFpsCalcTime = performance.now();

    function customRAF(callback) {
        const id = nextId++;
        rafQueue.set(id, callback);

        if (!isMasterLoopRunning) {
            isMasterLoopRunning = true;
            scheduleMasterTick();
        }
        return id;
    }

    function customCAF(id) {
        rafQueue.delete(id);
    }

    function scheduleMasterTick() {
        if (rafQueue.size === 0) {
            isMasterLoopRunning = false;
            return;
        }
        if (masterTimer) {
            clearTimeout(masterTimer);
            masterTimer = null;
        }

        const now = performance.now();
        const targetInterval = isUserActive ? INTERVAL_ACTIVE : INTERVAL_IDLE;
        const timeSince = now - lastRenderTime;
        const remaining = targetInterval - timeSince - 2.5;

        if (remaining > 16) {
            masterTimer = setTimeout(() => {
                masterTimer = null;
                originalRAF(masterTick);
            }, remaining);
        } else {
            originalRAF(masterTick);
        }
    }

    function masterTick(timestamp) {
        if (rafQueue.size === 0) {
            isMasterLoopRunning = false;
            return;
        }

        const now = performance.now();

        if (isUserActive && (now - lastActiveTime > IDLE_TIMEOUT)) {
            isUserActive = false;
            if (document.documentElement) {
                document.documentElement.classList.add('tm-idle-mode');
            }
            updateIndicator();
            updatePanelFps();
        }

        const targetInterval = isUserActive ? INTERVAL_ACTIVE : INTERVAL_IDLE;
        const timeSinceLastRender = now - lastRenderTime;

        if (timeSinceLastRender >= targetInterval - 2.5) {
            lastRenderTime = now;
            renderedFramesCount++;

            const batch = Array.from(rafQueue.keys());
            for (let i = 0; i < batch.length; i++) {
                const id = batch[i];
                const cb = rafQueue.get(id);
                if (cb) {
                    rafQueue.delete(id);
                    try {
                        cb(timestamp);
                    } catch (e) {
                        console.error('[FPS Limiter] Render error:', e);
                    }
                }
            }
        }

        if (now - lastFpsCalcTime >= 1000) {
            currentRealFPS = renderedFramesCount;
            renderedFramesCount = 0;
            lastFpsCalcTime = now;
            updateIndicator();
            updatePanelFps();
        }

        scheduleMasterTick();
    }

    function hookAPI(target) {
        try {
            target.requestAnimationFrame = customRAF;
            target.cancelAnimationFrame = customCAF;
        } catch (e) {}
    }

    hookAPI(win);
    hookAPI(window);
    if (win.Window && win.Window.prototype) {
        hookAPI(win.Window.prototype);
    }

    function copyText(txt) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).catch(() => fallbackCopy(txt));
        } else {
            fallbackCopy(txt);
        }
    }

    function fallbackCopy(txt) {
        const el = document.createElement('textarea');
        el.value = txt;
        el.style.position = 'fixed';
        el.style.left = '-9999px';
        el.style.top = '-9999px';
        (document.body || document.documentElement).appendChild(el);
        el.focus();
        el.select();
        try {
            document.execCommand('copy');
        } catch (_) {}
        el.remove();
    }

    function attachCoordCopy(btn) {
        if (btn._tmCopyHooked) return;
        btn._tmCopyHooked = true;

        btn.addEventListener('click', (e) => {
            e.stopImmediatePropagation();
            e.preventDefault();

            const fresh = currentPixelCoords || getStoredCoords();
            const target = fresh ? fresh.join(', ') : btn.getAttribute('data-tm-coords');
            if (target) {
                copyText(target);
                const span = btn.querySelector('span');
                if (span) {
                    span.textContent = '已复制!';
                    setTimeout(() => {
                        const current = currentPixelCoords || getStoredCoords() || target;
                        span.textContent = Array.isArray(current) ? current.join(', ') : current;
                    }, 1000);
                }
            }
        }, true);
    }

    function updateSpanValue(span, text) {
        if (span.firstChild && span.firstChild.nodeType === Node.TEXT_NODE) {
            span.firstChild.nodeValue = text;
        } else {
            span.textContent = text;
        }
    }

    function scanAndTransformCoords() {
        const panels = document.querySelectorAll('.game-selected-panel, .selected-pixel, .game-floating-panel, [class*="game-selected"]');
        if (!panels.length) return;

        const coords = currentPixelCoords || getStoredCoords();
        if (!coords) return;
        const coordStr = coords.join(', ');

        panels.forEach(p => {
            const buttons = p.querySelectorAll('button');
            buttons.forEach(btn => {
                const hasPinSvg = btn.querySelector('svg path[d*="M480"]') || btn.querySelector('svg.fill-primary');
                const span = btn.querySelector('span');
                if (!span) return;

                const text = span.textContent.trim();
                const isCoordPattern = /^\s*-?\d+\s*[,，]\s*-?\d+(\s*[,，]\s*-?\d+\s*[,，]\s*-?\d+)?\s*$/.test(text);

                if (hasPinSvg || isCoordPattern) {
                    if (text !== coordStr && text !== '已复制!') {
                        updateSpanValue(span, coordStr);
                        btn.setAttribute('data-tm-coords', coordStr);
                    }
                    attachCoordCopy(btn);
                }
            });
        });
    }

    function initGlobalObserver() {
        const observer = new MutationObserver(() => {
            scanAndTransformCoords();
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.id = 'tm-fps-control-styles';
        style.textContent = `
            html.tm-disable-gifs img[src*=".gif"],
            html.tm-disable-gifs img[alt*="Profile frame"],
            html.tm-disable-gifs .patch-notes-pulse,
            html.tm-disable-gifs [class*="patch-notes-pulse"] {
                display: none !important;
                animation: none !important;
            }
            html.tm-idle-mode .patch-notes-pulse,
            html.tm-idle-mode [class*="patch-notes-pulse"] {
                display: none !important;
                animation: none !important;
            }
            html.tm-idle-mode img[src*=".gif"],
            html.tm-idle-mode img[alt*="Profile frame"] {
                visibility: hidden !important;
            }
            html.tm-idle-mode * {
                animation-play-state: paused !important;
            }
            html.tm-idle-mode #tm-fps-panel-container *,
            html.tm-idle-mode #tm-fps-indicator {
                visibility: visible !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
        applyGifToggle();
    }

    let indicatorEl = null;

    function initIndicator() {
        if (!SHOW_INDICATOR) return;

        indicatorEl = document.createElement('div');
        indicatorEl.id = 'tm-fps-indicator';
        Object.assign(indicatorEl.style, {
            position: 'fixed',
            bottom: '14px',
            left: '14px',
            padding: '5px 12px',
            borderRadius: '16px',
            background: 'rgba(15, 23, 42, 0.85)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            color: '#38bdf8',
            fontSize: '12px',
            fontWeight: 'bold',
            fontFamily: 'Consolas, Monaco, monospace',
            zIndex: '9999999',
            pointerEvents: 'none',
            userSelect: 'none',
            backdropFilter: 'blur(6px)',
            transition: 'color 0.2s, border-color 0.2s'
        });

        (document.body || document.documentElement).appendChild(indicatorEl);
        updateIndicator();
    }

    function updateIndicator() {
        if (!indicatorEl) return;
        if (isUserActive) {
            indicatorEl.innerHTML = `⚡ ${currentRealFPS} FPS <span style="font-weight:normal;opacity:0.8;">(操作中)</span>`;
            indicatorEl.style.color = '#4ade80';
            indicatorEl.style.borderColor = 'rgba(74, 222, 128, 0.3)';
        } else {
            indicatorEl.innerHTML = `💤 ${currentRealFPS} FPS <span style="font-weight:normal;opacity:0.8;">(挂机中)</span>`;
            indicatorEl.style.color = '#94a3b8';
            indicatorEl.style.borderColor = 'rgba(255, 255, 255, 0.1)';
        }
    }

    let container = null;
    let ballEl = null;
    let panelEl = null;
    let ballFpsEl = null;
    let ballIconEl = null;
    let panelFpsBadge = null;

    function updatePanelFps() {
        if (ballFpsEl) {
            ballFpsEl.textContent = currentRealFPS;
            ballFpsEl.style.color = isUserActive ? '#4ade80' : '#94a3b8';
        }
        if (ballIconEl) {
            ballIconEl.textContent = isUserActive ? '⚡' : '💤';
        }
        if (panelFpsBadge) {
            panelFpsBadge.textContent = `${currentRealFPS} FPS`;
            panelFpsBadge.style.color = isUserActive ? '#4ade80' : '#94a3b8';
            panelFpsBadge.style.background = isUserActive ? 'rgba(74, 222, 128, 0.2)' : 'rgba(148, 163, 184, 0.2)';
        }
    }

    function clampContainer() {
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const maxLeft = Math.max(0, win.innerWidth - container.offsetWidth);
        const maxTop = Math.max(0, win.innerHeight - container.offsetHeight);
        const newLeft = Math.max(0, Math.min(rect.left, maxLeft));
        const newTop = Math.max(0, Math.min(rect.top, maxTop));
        container.style.left = `${newLeft}px`;
        container.style.top = `${newTop}px`;
        win.localStorage.setItem('tm_panel_pos', JSON.stringify({ left: newLeft, top: newTop }));
    }

    function initPanel() {
        let savedPos = null;
        try {
            savedPos = JSON.parse(win.localStorage.getItem('tm_panel_pos'));
        } catch (_) {}

        let initLeft = savedPos && typeof savedPos.left === 'number' ? savedPos.left : Math.max(10, (win.innerWidth || 360) - 285);
        let initTop = savedPos && typeof savedPos.top === 'number' ? savedPos.top : 60;

        container = document.createElement('div');
        container.id = 'tm-fps-panel-container';
        Object.assign(container.style, {
            position: 'fixed',
            left: `${initLeft}px`,
            top: `${initTop}px`,
            zIndex: '2147483647',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            fontSize: '13px',
            color: '#e2e8f0',
            userSelect: 'none',
            webkitUserSelect: 'none',
            touchAction: 'none'
        });

        ballEl = document.createElement('div');
        ballEl.id = 'tm-fps-ball';
        Object.assign(ballEl.style, {
            width: '46px',
            height: '46px',
            borderRadius: '50%',
            background: 'rgba(15, 23, 42, 0.9)',
            border: '1.5px solid rgba(56, 189, 248, 0.6)',
            boxShadow: '0 4px 14px rgba(0, 0, 0, 0.5)',
            display: 'none',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'move',
            backdropFilter: 'blur(8px)',
            boxSizing: 'border-box'
        });
        ballEl.innerHTML = `
            <span id="tm-ball-icon" style="font-size:13px;line-height:1;">⚡</span>
            <span id="tm-ball-fps" style="font-size:11px;font-weight:bold;color:#4ade80;line-height:1;margin-top:2px;font-family:monospace;">${ACTIVE_FPS}</span>
        `;

        panelEl = document.createElement('div');
        panelEl.id = 'tm-fps-panel';
        Object.assign(panelEl.style, {
            width: '265px',
            maxWidth: 'calc(100vw - 20px)',
            background: 'rgba(15, 23, 42, 0.94)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '12px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(10px)',
            overflow: 'hidden',
            boxSizing: 'border-box',
            display: 'block'
        });

        panelEl.innerHTML = `
            <div id="tm-panel-header" style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(30,41,59,0.7);border-bottom:1px solid rgba(255,255,255,0.1);cursor:move;box-sizing:border-box;">
                <div style="display:flex;align-items:center;gap:6px;font-weight:bold;color:#38bdf8;">
                    <span>帧率与坐标</span>
                    <span id="tm-panel-fps-badge" style="font-size:11px;background:rgba(74,222,128,0.2);color:#4ade80;padding:1px 6px;border-radius:10px;font-family:monospace;">${ACTIVE_FPS} FPS</span>
                </div>
                <button id="tm-btn-min" style="background:transparent;border:none;color:#94a3b8;font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;outline:none;">−</button>
            </div>
            <div style="padding:12px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="font-size:12px;color:#cbd5e1;">最大帧率</span>
                    <input id="tm-input-fps" type="number" min="1" max="240" value="${ACTIVE_FPS}" style="width:68px;background:rgba(30,41,59,0.8);border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:#fff;padding:4px 6px;text-align:right;font-size:12px;box-sizing:border-box;touch-action:auto;outline:none;">
                </div>
                <div style="font-size:11px;color:#f59e0b;line-height:1.3;margin-top:-4px;">* 勾选下方关闭头像特效开关时，最大帧率限制才能真正生效。否则只有在静置超时后才能降低帧率</div>
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="font-size:12px;color:#cbd5e1;">超时挂机 (秒)</span>
                    <input id="tm-input-timeout" type="number" min="1" max="3600" value="${IDLE_TIMEOUT / 1000}" style="width:68px;background:rgba(30,41,59,0.8);border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:#fff;padding:4px 6px;text-align:right;font-size:12px;box-sizing:border-box;touch-action:auto;outline:none;">
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="font-size:12px;color:#cbd5e1;">始终关闭所有头像特效</span>
                    <input id="tm-toggle-gifs" type="checkbox" ${disableGifs ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer;accent-color:#0284c7;touch-action:auto;">
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.1);margin:2px 0;"></div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <span style="font-size:12px;color:#cbd5e1;">坐标传送 (智能提取4个数值)</span>
                    <input id="tm-input-coords" type="text" placeholder="例: 1224, 1425, 24, 5" style="width:100%;background:rgba(30,41,59,0.8);border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:#fff;padding:6px 8px;font-size:12px;box-sizing:border-box;touch-action:auto;outline:none;font-family:monospace;">
                    <button id="tm-btn-teleport" style="width:100%;background:#0284c7;color:#fff;border:none;border-radius:6px;padding:6px 0;font-size:12px;font-weight:bold;cursor:pointer;outline:none;touch-action:auto;">转换并跳转</button>
                    <div id="tm-coords-tip" style="font-size:11px;color:#ef4444;min-height:14px;word-break:break-all;"></div>
                </div>
            </div>
        `;

        container.appendChild(ballEl);
        container.appendChild(panelEl);
        (document.body || document.documentElement).appendChild(container);

        ballFpsEl = ballEl.querySelector('#tm-ball-fps');
        ballIconEl = ballEl.querySelector('#tm-ball-icon');
        panelFpsBadge = panelEl.querySelector('#tm-panel-fps-badge');

        const isMinimized = win.localStorage.getItem('tm_panel_minimized') === 'true';
        if (isMinimized) {
            panelEl.style.display = 'none';
            ballEl.style.display = 'flex';
        }

        clampContainer();

        const fpsInput = panelEl.querySelector('#tm-input-fps');
        const timeoutInput = panelEl.querySelector('#tm-input-timeout');
        const toggleGifsInput = panelEl.querySelector('#tm-toggle-gifs');
        const coordsInput = panelEl.querySelector('#tm-input-coords');
        const teleportBtn = panelEl.querySelector('#tm-btn-teleport');
        const tipEl = panelEl.querySelector('#tm-coords-tip');
        const minBtn = panelEl.querySelector('#tm-btn-min');

        const onFpsChange = () => {
            const val = parseInt(fpsInput.value, 10);
            if (!isNaN(val) && val >= 1) {
                ACTIVE_FPS = val;
                INTERVAL_ACTIVE = 1000 / ACTIVE_FPS;
                win.localStorage.setItem('tm_fps_active', ACTIVE_FPS);
                updatePanelFps();
            }
        };
        fpsInput.addEventListener('input', onFpsChange);
        fpsInput.addEventListener('change', onFpsChange);

        toggleGifsInput.addEventListener('change', () => {
            disableGifs = toggleGifsInput.checked;
            win.localStorage.setItem('tm_disable_gifs', disableGifs ? 'true' : 'false');
            applyGifToggle();
        });

        const onTimeoutChange = () => {
            const val = parseFloat(timeoutInput.value);
            if (!isNaN(val) && val > 0) {
                IDLE_TIMEOUT = Math.round(val * 1000);
                win.localStorage.setItem('tm_fps_timeout', IDLE_TIMEOUT);
            }
        };
        timeoutInput.addEventListener('input', onTimeoutChange);
        timeoutInput.addEventListener('change', onTimeoutChange);

        function handleTeleport() {
            const val = coordsInput.value.trim();
            if (!val) {
                tipEl.style.color = '#ef4444';
                tipEl.textContent = '请输入坐标内容';
                return;
            }
            const matches = val.match(/-?\d+(?:\.\d+)?/g);
            if (!matches || matches.length < 4) {
                tipEl.style.color = '#ef4444';
                tipEl.textContent = '未提取到4个有效数字';
                return;
            }
            const coords = matches.slice(0, 4).map(Number);
            const res = tileFourToLatLng(coords);
            if (!res || !Number.isFinite(res.lat) || !Number.isFinite(res.lng)) {
                tipEl.style.color = '#ef4444';
                tipEl.textContent = '坐标转换失败';
                return;
            }
            tipEl.style.color = '#4ade80';
            tipEl.textContent = '写入定位并跳转中...';

            const locData = {
                lat: res.lat,
                lng: res.lng,
                zoom: 12
            };
            win.localStorage.setItem('location', JSON.stringify(locData));

            if (win.location.href === 'https://wplace.live/' || win.location.href === 'https://wplace.live') {
                win.location.reload();
            } else {
                win.location.href = 'https://wplace.live/';
            }
        }

        teleportBtn.addEventListener('click', handleTeleport);
        coordsInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleTeleport();
            }
        });

        minBtn.addEventListener('click', () => {
            panelEl.style.display = 'none';
            ballEl.style.display = 'flex';
            win.localStorage.setItem('tm_panel_minimized', 'true');
            clampContainer();
        });

        let isDragging = false;
        let hasMoved = false;
        let dragStartX = 0, dragStartY = 0;
        let initialLeft = 0, initialTop = 0;

        container.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            if (e.target.closest('input, button, textarea')) return;

            isDragging = true;
            hasMoved = false;
            dragStartX = e.clientX;
            dragStartY = e.clientY;

            const rect = container.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

            try {
                container.setPointerCapture(e.pointerId);
            } catch (_) {}
        });

        container.addEventListener('pointermove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            if (Math.hypot(dx, dy) > 4) {
                hasMoved = true;
            }
            let newLeft = initialLeft + dx;
            let newTop = initialTop + dy;

            const maxLeft = Math.max(0, win.innerWidth - container.offsetWidth);
            const maxTop = Math.max(0, win.innerHeight - container.offsetHeight);

            newLeft = Math.max(0, Math.min(newLeft, maxLeft));
            newTop = Math.max(0, Math.min(newTop, maxTop));

            container.style.left = `${newLeft}px`;
            container.style.top = `${newTop}px`;
        });

        const stopDrag = (e) => {
            if (!isDragging) return;
            isDragging = false;
            try {
                container.releasePointerCapture(e.pointerId);
            } catch (_) {}

            clampContainer();

            if (!hasMoved && ballEl.style.display !== 'none') {
                ballEl.style.display = 'none';
                panelEl.style.display = 'block';
                win.localStorage.setItem('tm_panel_minimized', 'false');
                clampContainer();
            }
        };

        container.addEventListener('pointerup', stopDrag);
        container.addEventListener('pointercancel', stopDrag);

        win.addEventListener('resize', clampContainer);
    }

    function initAll() {
        injectStyles();
        initIndicator();
        initPanel();
        initGlobalObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAll);
    } else {
        initAll();
    }
})();