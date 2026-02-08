// ==UserScript==
// @name         Wplace_Terminator_Config
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  修改浏览器指纹，导出/导入 LocalStorage 与 IndexedDB 配置，支持快捷键
// @author       linalg
// @match        https://wplace.live/*
// @updateURL    https://raw.githubusercontent.com/lin-alg/Wplace_Shortlink/main/Wplace_Terminator_Config.user.js
// @downloadURL  https://raw.githubusercontent.com/lin-alg/Wplace_Shortlink/main/Wplace_Terminator_Config.user.js
// @grant        unsafeWindow
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js
// ==/UserScript==

(function() {
    'use strict';

    // LocalStorage 键名列表
    const LS_KEYS = [
        "wplace_ruler_color_v1",
        "wplace_selected_palette_colors_v1",
        "wplace_ruler_purecolor_mode",
        "wplace_ruler_random_mode_v1",
        "wplace_ruler_reverse_mode",
        "wplace_ruler_peace_mode",
        "theme",
        "selected-color",
        "show-all-colors",
        "show-paint-more-than-one-pixel-msg",
        "PARAGLIDE_LOCALE",
        "location",
        "muted"
    ];

    const DB_NAME = "wplace_ruler_db_v1";

    // --- 1. 指纹核心逻辑 ---
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

    // --- 2. 数据库健壮性检查 ---
    async function ensureDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                const storeName = "wplace_ruler_persistent_v1";
                if (!db.objectStoreNames.contains(storeName)) {
                    db.createObjectStore(storeName);
                    console.log(`[IndexedDB] 已自动创建缺失的表: ${storeName}`);
                }
            };
            request.onsuccess = (e) => {
                e.target.result.close();
                resolve();
            };
            request.onerror = (e) => {
                console.error("[IndexedDB] 数据库初始化失败", e);
                reject(e);
            };
        });
    }

    // --- 3. IndexedDB 导出函数 ---
    async function exportIDB() {
        try {
            await ensureDB();
        } catch (e) {
            return {};
        }

        return new Promise((resolve) => {
            const request = indexedDB.open(DB_NAME);
            request.onerror = () => resolve({});
            request.onsuccess = async (event) => {
                const db = event.target.result;
                const result = {};
                const storeNames = Array.from(db.objectStoreNames);

                if (storeNames.length === 0) {
                    db.close();
                    resolve({});
                    return;
                }

                for (let storeName of storeNames) {
                    result[storeName] = await new Promise((res) => {
                        try {
                            const transaction = db.transaction(storeName, "readonly");
                            const store = transaction.objectStore(storeName);
                            const getAllRequest = store.getAll();
                            const getAllKeysRequest = store.getAllKeys();

                            getAllRequest.onsuccess = () => {
                                getAllKeysRequest.onsuccess = () => {
                                    const items = getAllRequest.result.map((val, i) => ({
                                        key: getAllKeysRequest.result[i],
                                        value: val
                                    }));
                                    res(items);
                                };
                            };
                            getAllRequest.onerror = () => res([]);
                        } catch (err) {
                            res([]);
                        }
                    });
                }
                db.close();
                resolve(result);
            };
        });
    }

    // --- 4. IndexedDB 导入函数 ---
    async function importIDB(data) {
        await ensureDB();
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME);
            request.onsuccess = (event) => {
                const db = event.target.result;
                const incomingStoreNames = Object.keys(data);

                const validStores = incomingStoreNames.filter(name => db.objectStoreNames.contains(name));

                if (validStores.length === 0) {
                    db.close();
                    resolve();
                    return;
                }

                const transaction = db.transaction(validStores, "readwrite");
                validStores.forEach(name => {
                    const store = transaction.objectStore(name);
                    store.clear(); // 清空当前旧数据
                    data[name].forEach(item => {
                        store.put(item.value, item.key);
                    });
                });

                transaction.oncomplete = () => {
                    db.close();
                    resolve();
                };
                transaction.onerror = (e) => {
                    db.close();
                    reject(e);
                };
            };
            request.onerror = (e) => reject(e);
        });
    }

    // --- 5. 主导出逻辑 (Ctrl + Alt + E) ---
    async function handleExport() {
        console.log("准备导出数据...");
        const backup = {
            localStorage: {},
            indexedDB: await exportIDB(),
            exportTime: new Date().toLocaleString()
        };

        LS_KEYS.forEach(key => {
            backup.localStorage[key] = localStorage.getItem(key);
        });

        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `wplace_backup_${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log("导出成功");
    }

    // --- 5. 主导入逻辑 (Ctrl + Alt + I) ---
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

                    // 恢复 LocalStorage
                    if (config.localStorage) {
                        Object.entries(config.localStorage).forEach(([k, v]) => {
                            if (v !== null) localStorage.setItem(k, v);
                        });
                    }

                    // 恢复 IndexedDB
                    if (config.indexedDB) {
                        await importIDB(config.indexedDB);
                    }

                    alert("导入成功！页面即将刷新应用新配置。");
                    const target = "https://wplace.live";

                    if (window.location.href !== target) {
                        window.location.href = target;
                    } else {
                        window.location.reload();
                    }
                } catch (err) {
                    console.error(err);
                    alert("导入失败，请检查 JSON 文件格式是否正确。");
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    // --- 初始化 ---
    let fpValue = getStoredFP();
    if (!fpValue) {
        fpValue = askForFP();
    }
    unsafeWindow.customFpValue = fpValue;

    // --- 快捷键监听 ---
    document.addEventListener("keydown", function(e) {
        // Ctrl + Alt + C: 改指纹
        if (e.ctrlKey && e.altKey && e.code === "KeyC") {
            if(askForFP()) location.reload();
        }
        // Ctrl + Alt + E: 导出
        if (e.ctrlKey && e.altKey && e.code === "KeyE") {
            handleExport();
        }
        // Ctrl + Alt + I: 导入
        if (e.ctrlKey && e.altKey && e.code === "KeyI") {
            handleImport();
        }
    });

})();