// ==UserScript==
// @name         Wplace_Terminator_Config
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  Wplace优化插件
// @author       linalg
// @match        https://wplace.live/*
// @updateURL    https://raw.githubusercontent.com/lin-alg/Wplace_Shortlink/main/Wplace_Terminator_Config.user.js
// @downloadURL  https://raw.githubusercontent.com/lin-alg/Wplace_Shortlink/main/Wplace_Terminator_Config.user.js
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      *
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // --- 后端 API 地址 ---
    const API_BASE_URL = "https://wplace-gallery.linalg.tech";

    const LS_KEYS = [
        "wplace_ruler_color_v1", "wplace_selected_palette_colors_v1", "wplace_ruler_purecolor_mode",
        "wplace_ruler_random_mode_v1", "wplace_ruler_reverse_mode", "wplace_ruler_peace_mode",
        "wplace_ruler_advanced_mode_v1", "theme", "selected-color", "show-all-colors",
        "show-paint-more-than-one-pixel-msg", "PARAGLIDE_LOCALE", "location", "muted"
    ];
    const DB_NAME = "wplace_ruler_db_v1";

    // --- 标签数据缓存/限流（排行榜会批量请求，避免刷爆 API） ---
    const blacklistCache = new Map();      // userId -> data|null
    const blacklistInFlight = new Map();   // userId -> Promise
    const BLACKLIST_MAX_CONCURRENCY = 6;
    let blacklistActive = 0;
    const blacklistQueue = [];

    function enqueueBlacklistRequest(task) {
        return new Promise((resolve, reject) => {
            blacklistQueue.push({ task, resolve, reject });

            const pump = () => {
                while (blacklistActive < BLACKLIST_MAX_CONCURRENCY && blacklistQueue.length > 0) {
                    const job = blacklistQueue.shift();
                    blacklistActive += 1;
                    Promise.resolve()
                        .then(job.task)
                        .then(job.resolve, job.reject)
                        .finally(() => {
                            blacklistActive -= 1;
                            pump();
                        });
                }
            };

            pump();
        });
    }

    function fetchBlacklistData(userId) {
        const key = String(userId);
        if (blacklistCache.has(key)) return Promise.resolve(blacklistCache.get(key));
        if (blacklistInFlight.has(key)) return blacklistInFlight.get(key);

        const promise = enqueueBlacklistRequest(() => apiRequest('/api/blacklist', { user_id: key }))
            .then((res) => {
                const data = (res && res.status === 'success' && res.data) ? res.data : null;
                blacklistCache.set(key, data);
                blacklistInFlight.delete(key);
                return data;
            })
            .catch(() => {
                blacklistCache.set(key, null);
                blacklistInFlight.delete(key);
                return null;
            });

        blacklistInFlight.set(key, promise);
        return promise;
    }


    // --- 0. API 请求 ---
    function apiRequest(endpoint, data) {
        return new Promise((resolve, reject) => {
            const passkey = GM_getValue('wplace_api_passkey', null);
            if (!passkey && endpoint !== '/api/passkey') return reject('No passkey');
            if (passkey) data.passkey = passkey;

            const formData = new URLSearchParams();
            for (let key in data) formData.append(key, data[key]);

            GM_xmlhttpRequest({
                method: "POST",
                url: API_BASE_URL + endpoint,
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                data: formData.toString(),
                onload: function(res) {
                    try {
                        resolve(JSON.parse(res.responseText));
                    } catch(e) {
                        console.error("[TM API Error]", res.responseText);
                        reject(e);
                    }
                },
                onerror: reject
            });
        });
    }

    // --- 1. 原生 UI 级：登录 / 申诉弹窗引擎 ---
    function createDaisyModal(id, contentHTML) {
        if (document.getElementById(id)) return null;
        const dialog = document.createElement('dialog');
        dialog.id = id;
        dialog.className = 'modal modal-open bg-black/80';
        dialog.style.zIndex = '999999';
        dialog.innerHTML = `
            <div class="modal-box relative">
                <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" onclick="this.closest('dialog').remove()">✕</button>
                ${contentHTML}
            </div>
        `;
        document.body.appendChild(dialog);
        return dialog;
    }

    function promptLogin() {
        const dialog = createDaisyModal('wt-login-modal', `
            <h3 class="text-lg font-bold mb-1">🔐 系统功能授权</h3>
            <p class="text-xs text-base-content/60 mb-4">登录获取沙箱密钥，以启用标签查询、举报、申诉等功能。</p>
            <div class="form-control mb-2">
                <input type="text" id="wt-user" placeholder="用户名" class="input input-bordered input-sm w-full" />
            </div>
            <div class="form-control mb-4">
                <input type="password" id="wt-pwd" placeholder="密码" class="input input-bordered input-sm w-full" />
            </div>
            <button id="wt-submit-login" class="btn btn-primary btn-sm w-full">登录授权</button>
        `);
        if (!dialog) return;

        document.getElementById('wt-submit-login').onclick = async () => {
            const u = document.getElementById('wt-user').value.trim();
            const p = document.getElementById('wt-pwd').value.trim();
            if (!u || !p) return alert('请输入账号和密码');

            const btn = document.getElementById('wt-submit-login');
            btn.innerHTML = '<span class="loading loading-spinner loading-xs"></span> 验证中...';
            btn.disabled = true;

            try {
                const res = await apiRequest('/api/passkey', { username: u, password: p });
                if (res.status === 'success') {
                    GM_setValue('wplace_api_passkey', res.passkey);
                    alert('授权成功！高级功能已启用。');
                    dialog.remove();
                    // 立即刷新一次注入（登录前因为无 passkey 可能没打上标签）
                    setTimeout(injectUI, 0);
                } else alert('认证失败: ' + (res.msg || '未知错误'));
            } catch (e) { alert('网络错误，无法连接验证服务器。'); }

            btn.innerHTML = '登录授权';
            btn.disabled = false;
        };
    }

    function openAppealModal(prefilledId = '') {
        const dialog = createDaisyModal('wt-appeal-modal', `
            <h3 class="text-lg font-bold mb-4">⚖️ 违规申诉中心</h3>
            <div class="form-control mb-3">
                <label class="label py-1"><span class="label-text font-semibold">目标玩家 ID</span></label>
                <input type="number" id="wt-appeal-id" placeholder="输入纯数字 ID (不要带#)" value="${prefilledId}" class="input input-bordered input-sm w-full font-mono" />
            </div>
            <div class="form-control mb-3">
                <label class="label py-1"><span class="label-text font-semibold">申诉类别 (可多选)</span></label>
                <div class="flex gap-4 px-1">
                    <label class="cursor-pointer flex items-center gap-2">
                        <input type="checkbox" id="wt-cat-0" value="0" class="checkbox checkbox-sm checkbox-warning" />
                        <span class="label-text text-orange-400 font-medium">Politics</span>
                    </label>
                    <label class="cursor-pointer flex items-center gap-2">
                        <input type="checkbox" id="wt-cat-1" value="1" class="checkbox checkbox-sm checkbox-error" />
                        <span class="label-text text-red-400 font-medium">Griefing</span>
                    </label>
                </div>
            </div>
            <div class="form-control mb-4">
                <label class="label py-1"><span class="label-text font-semibold">申诉理由</span></label>
                <textarea id="wt-appeal-reason" class="textarea textarea-bordered w-full h-24" placeholder="请简要描述情况并提供联系方式 (可更快通过审核)..." maxlength="100"></textarea>
            </div>
            <button id="wt-submit-appeal" class="btn btn-primary w-full">提交申诉</button>
        `);
        if (!dialog) return;

        document.getElementById('wt-submit-appeal').onclick = async () => {
            const uidRaw = document.getElementById('wt-appeal-id').value.trim();
            const reason = document.getElementById('wt-appeal-reason').value.trim();
            const isPol = document.getElementById('wt-cat-0').checked;
            const isGri = document.getElementById('wt-cat-1').checked;

            const uid = parseInt(uidRaw, 10);
            if (isNaN(uid)) return alert('玩家 ID 必须是纯数字！');
            if (!isPol && !isGri) return alert('请至少勾选一种申诉类别！');

            let cats = [];
            if (isPol) cats.push(0);
            if (isGri) cats.push(1);

            const btn = document.getElementById('wt-submit-appeal');
            btn.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 提交中...';
            btn.disabled = true;

            try {
                const res = await apiRequest('/api/appeal', { user_id: uid, categories: cats.join(','), text: reason });
                if (res.status === 'success') {
                    alert('✅ 申诉已提交，等待管理员处理。');
                    dialog.remove();
                } else alert('申诉失败: ' + res.msg);
            } catch(e) { alert('申诉请求出错，请检查网络或是否已授权。'); }

            btn.innerHTML = '提交申诉';
            btn.disabled = false;
        };
    }

    // --- 2. 界面动态挂载工具 ---
    function getColorStyle(count) {
        if (count >= 1 && count <= 5) return 'background-color: rgba(234,179,8,0.1); color: #eab308;';
        if (count >= 6 && count <= 10) return 'background-color: rgba(249,115,22,0.1); color: #f97316;';
        if (count > 10) return 'background-color: rgba(239,68,68,0.1); color: #ef4444;';
        return '';
    }

    async function fetchAndInjectTags(userId, container, options = {}) {
        const tagClassName = options.tagClassName || 'btn btn-xs gap-0.5 border-0 px-1.5';
        const extraClassName = options.extraClassName || '';
        let insertAfterEl = options.insertAfterEl || null;

        if (!container) return;

        try {
            const data = await fetchBlacklistData(userId);
            if (!data) return;
            if (!container.isConnected) return;

            [
                { lbl: '见证蛆', cnt: Number(data["0"] || 0) },
                { lbl: '毁画狗', cnt: Number(data["1"] || 0) }
            ].forEach(tag => {
                if (tag.cnt > 0) {
                    const span = document.createElement('span');
                    span.className = `${tagClassName} wt-custom-tag${extraClassName ? ' ' + extraClassName : ''}`;
                    span.style.cssText = getColorStyle(tag.cnt);
                    span.textContent = `${tag.lbl}: ${tag.cnt}`;

                    if (insertAfterEl && insertAfterEl.insertAdjacentElement) {
                        insertAfterEl.insertAdjacentElement('afterend', span);
                        insertAfterEl = span;
                    } else {
                        container.appendChild(span);
                    }
                }
            });
        } catch(e) {}
    }

    function injectReportMenuItems(ul, userId) {
        const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" class="size-5"><path d="M480-280q17 0 28.5-11.5T520-320q0-17-11.5-28.5T480-360q-17 0-28.5 11.5T440-320q0 17 11.5 28.5T480-280Zm-40-160h80v-240h-80v240ZM330-120 120-330v-300l210-210h300l210 210v300L630-120H330Zm34-80h232l164-164v-232L596-760H364L200-596v232l164 164Zm116-280Z"></path></svg>`;

        const createItem = (label, catId) => {
            const li = document.createElement('li');
            li.className = 'wt-custom-report';
            li.innerHTML = `<button class="py-2 font-medium" style="color: #f97316;">${svgIcon} ${label}</button>`;
            li.onclick = async () => {
                if (!confirm(`确定要以 ${label} 理由举报用户 #${userId} 吗？`)) return;
                try {
                    const res = await apiRequest('/api/report', { user_id: userId, categories: catId });
                    if (res.status === 'success') alert('举报已提交！');
                    else alert('举报失败: ' + res.msg);
                } catch(e) { alert('请求出错，请检查是否已授权。'); }
            };
            return li;
        };
        ul.appendChild(createItem('举报 Politics', 0));
        ul.appendChild(createItem('举报 Griefing', 1));
    }


    // --- 3. 智能防抖注入引擎 (告别卡顿) ---
    function injectUI() {
        // 3.1 注入全局侧边栏：申诉按钮
        const sidebar = document.querySelector('.flex.flex-col.items-center.gap-3');
        if (sidebar && !sidebar.querySelector('.wt-sidebar-appeal')) {
            const appealBtn = document.createElement('button');
            appealBtn.className = "btn btn-square shadow-md wt-sidebar-appeal";
            appealBtn.title = "申诉中心";
            // 盾牌警示图标
            appealBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" class="size-5">
    <path d="M480-80q-139-35-229.5-159.5T160-516v-244l320-120 320 120v244q0 152-90.5 276.5T480-80Zm0-84q104-33 172-132t68-220v-189l-240-90-240 90v189q0 121 68 220t172 132Z"/>
</svg>`;
            appealBtn.onclick = () => openAppealModal();
            sidebar.appendChild(appealBtn);
        }

        // 3.2 注入点按像素弹出的玩家卡片
        const infoContainers = document.querySelectorAll('.flex.grow.flex-col');
        infoContainers.forEach(container => {
            const spans = container.querySelectorAll('span');
            let userId = null;
            for (let s of spans) {
                const match = s.textContent.trim().match(/^#(\d+)$/);
                if (match) { userId = match[1]; break; }
            }

            if (!userId || container.dataset.wtProcessed === userId) return;
            container.dataset.wtProcessed = userId;

            container.querySelectorAll('.wt-custom-tag').forEach(e => e.remove());
            container.querySelectorAll('.wt-custom-report').forEach(e => e.remove());

            const tagsWrapper = container.querySelector('.mt-0\\.5.flex.flex-wrap');
            if (tagsWrapper && GM_getValue('wplace_api_passkey')) {
                fetchAndInjectTags(userId, tagsWrapper);
            }

            const dropdownMenu = container.querySelector('ul.dropdown-content.menu');
            if (dropdownMenu) {
                injectReportMenuItems(dropdownMenu, userId);
            }
        });

        // 3.3 注入排行榜（table 行）：在 badge 后面追加标签
        const passkey = GM_getValue('wplace_api_passkey', null);
        if (passkey) {
            document.querySelectorAll('tr').forEach((row) => {
                const tds = row.querySelectorAll('td');
                if (tds.length < 3) return;
                const rankText = (tds[0].textContent || '').trim();
                if (!/^\d+$/.test(rankText)) return;

                const idSpan = Array.from(row.querySelectorAll('span')).find(s => /^#\d+$/.test((s.textContent || '').trim()));
                if (!idSpan) return;
                const userId = (idSpan.textContent || '').trim().slice(1);
                if (!userId) return;

                if (row.dataset.wtLeaderboardProcessed === userId) return;

                // 目标容器：包含用户名/#id/国旗/badge 的那一行
                const lineContainer = idSpan.closest('div') || tds[1];
                if (!lineContainer) return;

                // 清理旧标签（只清理排行榜注入的，避免影响别处）
                row.querySelectorAll('.wt-leaderboard-tag').forEach(e => e.remove());

                const badges = Array.from(lineContainer.querySelectorAll('span.badge'));
                const insertAfterEl = (badges.length > 0 ? badges[badges.length - 1] : null);

                row.dataset.wtLeaderboardProcessed = userId;
                fetchAndInjectTags(userId, lineContainer, {
                    tagClassName: 'badge badge-sm ml-0.5 border-0',
                    extraClassName: 'wt-leaderboard-tag',
                    insertAfterEl
                });
            });
        }
    }

    function initSmartScanner() {
        // 先手动跑一次
        injectUI();

        let injectTimer = null;
        // 只有 DOM 发生真实结构变化时，才触发节流更新
        const observer = new MutationObserver((mutations) => {
            let hasNewElements = false;
            for (let m of mutations) {
                if (m.addedNodes.length > 0) {
                    for (let node of m.addedNodes) {
                        // Node.ELEMENT_NODE === 1
                        if (node.nodeType === 1) {
                            hasNewElements = true;
                            break;
                        }
                    }
                }
                if (hasNewElements) break;
            }

            if (hasNewElements) {
                clearTimeout(injectTimer);
                // 150ms 的防抖窗口：批量合并频繁的 DOM 操作
                injectTimer = setTimeout(injectUI, 150);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // --- 4. 配置数据库系统 (无缝保留) ---
    function getStoredFP() { return localStorage.getItem("custom_fp"); }
    function setStoredFP(val) { localStorage.setItem("custom_fp", val); }

    function askForFP() {
        let seq = prompt("请输入自定义序列（用于生成新指纹）：");
        if (seq) {
            let combined = seq + Date.now();
            let md5twice = CryptoJS.MD5(CryptoJS.MD5(combined).toString()).toString();
            setStoredFP(md5twice);
            return md5twice;
        }
        return null;
    }

    async function ensureDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains("persisted_data")) {
                    db.createObjectStore("persisted_data");
                }
            };
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e);
        });
    }

    async function exportIDB() {
        try { await ensureDB(); } catch (e) { return {}; }
        return new Promise((resolve) => {
            const request = indexedDB.open(DB_NAME);
            request.onerror = () => resolve({});
            request.onsuccess = async (event) => {
                const db = event.target.result;
                const result = {};
                const storeNames = Array.from(db.objectStoreNames);
                if (storeNames.length === 0) { db.close(); return resolve({}); }

                for (let storeName of storeNames) {
                    result[storeName] = await new Promise((res) => {
                        try {
                            const transaction = db.transaction(storeName, "readonly");
                            const store = transaction.objectStore(storeName);
                            const getAllReq = store.getAll();
                            const getAllKeysReq = store.getAllKeys();
                            getAllReq.onsuccess = () => {
                                getAllKeysReq.onsuccess = () => {
                                    res(getAllReq.result.map((val, i) => ({ key: getAllKeysReq.result[i], value: val })));
                                };
                            };
                            getAllReq.onerror = () => res([]);
                        } catch (err) { res([]); }
                    });
                }
                db.close();
                resolve(result);
            };
        });
    }

    async function importIDB(data) {
        await ensureDB();
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME);
            request.onsuccess = (event) => {
                const db = event.target.result;
                const incomingStoreNames = Object.keys(data);
                const validStores = incomingStoreNames.filter(name => db.objectStoreNames.contains(name));

                if (validStores.length === 0) { db.close(); return resolve(); }

                const transaction = db.transaction(validStores, "readwrite");
                validStores.forEach(name => {
                    const store = transaction.objectStore(name);
                    store.clear();
                    data[name].forEach(item => store.put(item.value, item.key));
                });
                transaction.oncomplete = () => { db.close(); resolve(); };
                transaction.onerror = (e) => { db.close(); reject(e); };
            };
            request.onerror = (e) => reject(e);
        });
    }

    async function handleExport() {
        const backup = { localStorage: {}, indexedDB: await exportIDB(), exportTime: new Date().toLocaleString() };
        LS_KEYS.forEach(key => backup.localStorage[key] = localStorage.getItem(key));
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `wplace_backup_${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        console.log("导出成功");
    }

    function handleImport() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = e => {
            const file = e.target.files[0];
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const config = JSON.parse(event.target.result);
                    if (config.localStorage) {
                        Object.entries(config.localStorage).forEach(([k, v]) => { if (v !== null) localStorage.setItem(k, v); });
                    }
                    if (config.indexedDB) await importIDB(config.indexedDB);
                    alert("导入成功！页面即将刷新应用新配置。");
                    window.location.reload();
                } catch (err) { alert("导入失败，请检查 JSON 文件格式。"); }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    // --- 5. 脚本初始化 ---
    let fpValue = getStoredFP();
    if (!fpValue) fpValue = askForFP();
    unsafeWindow.customFpValue = fpValue;

    function runScript() {
        if (!GM_getValue('wplace_api_passkey', null)) promptLogin();
        initSmartScanner();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runScript);
    } else {
        runScript();
    }

    document.addEventListener("keydown", function(e) {
        if (e.ctrlKey && e.altKey && e.code === "KeyC") { if(askForFP()) location.reload(); }
        if (e.ctrlKey && e.altKey && e.code === "KeyE") { handleExport(); }
        if (e.ctrlKey && e.altKey && e.code === "KeyI") { handleImport(); }
    });

})();