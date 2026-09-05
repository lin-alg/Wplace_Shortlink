// ==UserScript==
// @name         wplace.live 帧率控制器
// @namespace    https://tampermonkey.net/
// @version      2.0
// @description  默认活动状态 60 FPS / 挂机 1 FPS
// @author       Assistant
// @match        *://wplace.live/*
// @match        *://*.wplace.live/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    // 获取真实的页面 window 环境
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // ================= 配置区域 =================
    const ACTIVE_FPS = 60;       // 操作时目标帧率 (60)
    const IDLE_FPS = 1;          // 挂机时目标帧率 (1)
    const IDLE_TIMEOUT = 10000;   // 静止多久后切入挂机 (毫秒)
    const SHOW_INDICATOR = true; // 是否在左下角显示实时帧率仪表
    // ===========================================

    const INTERVAL_ACTIVE = 1000 / ACTIVE_FPS; // 16.67ms
    const INTERVAL_IDLE = 1000 / IDLE_FPS;     // 1000ms

    let isUserActive = false;
    let lastActiveTime = performance.now();
    let lastRenderTime = 0;

    // ---------------- 1. 严格过滤鼠标噪点与真实操作 ----------------
    let lastMouseX = null;
    let lastMouseY = null;

    function markUserActive() {
        lastActiveTime = performance.now();
        isUserActive = true;
    }

    function onPointerMove(e) {
        // 过滤掉浏览器自动触发的合成事件
        if (!e.isTrusted) return;

        if (lastMouseX === null) {
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            return;
        }

        // 必须产生至少 2 像素的真实移动，防止高刷新率鼠标微颤
        const dist = Math.abs(e.clientX - lastMouseX) + Math.abs(e.clientY - lastMouseY);
        if (dist >= 2) {
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            markUserActive();
        }
    }

    // 基础键盘、点击、滚轮操作直接计入活跃
    ['mousedown', 'mouseup', 'wheel', 'touchstart', 'touchmove', 'keydown'].forEach(evt => {
        win.addEventListener(evt, (e) => {
            if (e.isTrusted) markUserActive();
        }, { passive: true, capture: true });
    });

    win.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
    win.addEventListener('mousemove', onPointerMove, { passive: true, capture: true });

    // ---------------- 2. 调度循环与帧率锁定 ----------------
    const originalRAF = win.requestAnimationFrame.bind(win);
    const originalCAF = win.cancelAnimationFrame.bind(win);

    const rafQueue = new Map();
    let nextId = 1;
    let isMasterLoopRunning = false;

    // 实时 FPS 计算器
    let renderedFramesCount = 0;
    let currentRealFPS = 0;
    let lastFpsCalcTime = performance.now();

    function customRAF(callback) {
        const id = nextId++;
        rafQueue.set(id, callback);

        if (!isMasterLoopRunning) {
            isMasterLoopRunning = true;
            originalRAF(masterTick);
        }
        return id;
    }

    function customCAF(id) {
        rafQueue.delete(id);
    }

    function masterTick(timestamp) {
        if (rafQueue.size === 0) {
            isMasterLoopRunning = false;
            return;
        }

        const now = performance.now();

        // 判定活跃状态超时
        if (isUserActive && (now - lastActiveTime > IDLE_TIMEOUT)) {
            isUserActive = false;
        }

        const targetInterval = isUserActive ? INTERVAL_ACTIVE : INTERVAL_IDLE;
        const timeSinceLastRender = now - lastRenderTime;

        // 容差 2.5ms：在 120Hz (8.33ms) 屏幕上平齐 VSync 脉冲，防止跳帧
        if (timeSinceLastRender >= targetInterval - 2.5) {
            // 硬性时间归位，彻底消除下一帧 8.3ms 极速连发的可能性
            lastRenderTime = now;
            renderedFramesCount++;

            // 拷贝本轮待执行队列
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

        // 统计实际放行帧率 (每秒统计一次)
        if (now - lastFpsCalcTime >= 1000) {
            currentRealFPS = renderedFramesCount;
            renderedFramesCount = 0;
            lastFpsCalcTime = now;
            updateIndicator();
        }

        if (rafQueue.size > 0) {
            originalRAF(masterTick);
        } else {
            isMasterLoopRunning = false;
        }
    }

    // ---------------- 3. 全局 API 深度覆盖 ----------------
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

    // ---------------- 4. 实时状态监控胶囊 ----------------
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

        document.documentElement.appendChild(indicatorEl);
        updateIndicator();
    }

    function updateIndicator() {
        if (!indicatorEl) return;
        if (isUserActive) {
            indicatorEl.innerHTML = `⚡ ${currentRealFPS} FPS <span style="font-weight:normal;opacity:0.8;">(操作中)</span>`;
            indicatorEl.style.color = '#4ade80'; // 绿色
            indicatorEl.style.borderColor = 'rgba(74, 222, 128, 0.3)';
        } else {
            indicatorEl.innerHTML = `💤 ${currentRealFPS} FPS <span style="font-weight:normal;opacity:0.8;">(挂机中)</span>`;
            indicatorEl.style.color = '#94a3b8'; // 灰色
            indicatorEl.style.borderColor = 'rgba(255, 255, 255, 0.1)';
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initIndicator);
    } else {
        initIndicator();
    }
})();