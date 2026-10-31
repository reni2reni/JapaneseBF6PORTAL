/* global BF2042Portal, _Blockly */
(function () {
    "use strict";

    const plugin = BF2042Portal.Plugins.getPlugin("Japanese");
    let observer = null;

    function getWorkspace() {
        try { return _Blockly?.getMainWorkspace?.() || null; } catch (_) { return null; }
    }

    function getBlockFromId(id) {
        if (!id) return null;
        try { return getWorkspace()?.getBlockById?.(String(id)) || null; } catch (_) { return null; }
    }

    function normalize(value) {
        if (value === null || value === undefined) return "";
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
        return "";
    }

    function yieldToUI() {
        return new Promise(resolve => setTimeout(resolve, 0));
    }

    function hasJapanese(text) {
        return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(String(text || ""));
    }

    function shouldKeepTranslationToken(token) {
        return /^[A-Za-z]$/.test(String(token || "").trim());
    }

    // ============================================================
    // 翻訳マスターキャッシュ（API規制対策：localStorageに永続保存）
    // ============================================================
    const MASTER_TRANSLATION_CACHE_KEY = "selection_list_master_translation_cache_v1";
    let masterTranslationCache = {};
    try {
        masterTranslationCache = JSON.parse(localStorage.getItem(MASTER_TRANSLATION_CACHE_KEY) || "{}");
    } catch (_) {
        masterTranslationCache = {};
    }

    let saveCacheTimer = null;
    function scheduleSaveMasterCache() {
        if (saveCacheTimer) clearTimeout(saveCacheTimer);
        saveCacheTimer = setTimeout(() => {
            try {
                localStorage.setItem(MASTER_TRANSLATION_CACHE_KEY, JSON.stringify(masterTranslationCache));
            } catch (_) { }
        }, 500);
    }

    async function translateTextBatch(text) {
        const key = String(text ?? "").trim();
        if (!key) return "";

        if (Object.prototype.hasOwnProperty.call(masterTranslationCache, key) && masterTranslationCache[key]) {
            return masterTranslationCache[key];
        }

        const endpoint = "https://translate.googleapis.com/translate_a/single";
        const url = endpoint + "?client=gtx&sl=auto&tl=ja&dt=t&q=" + encodeURIComponent(key);
        const response = await fetch(url, { method: "GET", credentials: "omit" });
        if (!response.ok) throw new Error(`Translation HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("Unexpected translation response");

        const translated = data[0].map(part => Array.isArray(part) ? String(part[0] || "") : "").join("");

        if (translated) {
            masterTranslationCache[key] = translated;
            scheduleSaveMasterCache();
        }
        return translated;
    }

    const TRANSLATION_CORRECTIONS = {
        "OnPlayerDeployed": "オンプレイヤーデプロイド",
    };

    function applyTranslationCorrection(original, translated) {
        const source = normalize(original);
        if (TRANSLATION_CORRECTIONS[source]) return TRANSLATION_CORRECTIONS[source];
        return normalize(translated) || source;
    }

    function splitCamelCaseForTranslation(value) {
        const text = normalize(value);
        if (!text) return "";
        return text
            .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/([A-Za-z])([0-9]+)/g, "$1 $2")
            .replace(/([0-9]+)([A-Za-z])/g, "$1 $2")
            .replace(/_+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    const flyoutTranslationCacheKey = "selectionListFlyoutBlockTranslationCache_v2";
    let flyoutTranslationCache = {};
    try { flyoutTranslationCache = JSON.parse(localStorage.getItem(flyoutTranslationCacheKey) || "{}"); } catch (_) { flyoutTranslationCache = {}; }

    async function getTranslatedBlockName(rawText) {
        const key = normalize(rawText);
        if (!key) return "";

        if (flyoutTranslationCache[key]) {
            return flyoutTranslationCache[key];
        }

        const spaced = splitCamelCaseForTranslation(key);
        let translated = applyTranslationCorrection(key, "");
        if (!translated || translated === key) {
            try {
                translated = await translateTextBatch(spaced);
                translated = applyTranslationCorrection(key, translated || spaced);
            } catch (_) {
                translated = spaced;
            }
        }

        if (translated) {
            flyoutTranslationCache[key] = translated;
            try { localStorage.setItem(flyoutTranslationCacheKey, JSON.stringify(flyoutTranslationCache)); } catch (_) { }
        }
        return translated || key;
    }

    // ============================================================
    // 配列名称の一括和訳（Selection_List連携用）
    // ============================================================
    async function translateNames(names, progressBar = null, updateStatusFn = null) {
        const unique = [...new Set(names.map(normalize).filter(Boolean))];
        const translated = new Map();

        const cacheKey = "selectionListTranslationCache_v2_parts";
        let cache = {};
        try { cache = JSON.parse(localStorage.getItem(cacheKey) || "{}"); } catch (_) { cache = {}; }

        const partsForName = name => String(name).split("_");
        const partKeys = new Set();
        for (const name of unique) {
            for (const part of partsForName(name)) {
                if (part && !shouldKeepTranslationToken(part)) partKeys.add(part);
            }
        }

        const pendingParts = [];
        for (const part of partKeys) {
            if (typeof cache[part] === "string" && hasJapanese(cache[part])) {
                continue;
            }
            pendingParts.push(part);
        }

        const progressTotal = pendingParts.length;
        let progressDone = 0;
        if (progressBar && updateStatusFn) {
            updateStatusFn(progressBar, 0, progressTotal);
            await yieldToUI();
        }

        const BATCH_CHARS = 1200;
        const batches = [];
        let batch = [];
        let length = 0;
        for (const part of pendingParts) {
            const extra = part.length + 1;
            if (batch.length && length + extra > BATCH_CHARS) {
                batches.push(batch);
                batch = [];
                length = 0;
            }
            batch.push(part);
            length += extra;
        }
        if (batch.length) batches.push(batch);

        const translateOneBatch = async sourceBatch => {
            try {
                const source = sourceBatch.join("\n");
                const result = await translateTextBatch(source);
                const parts = result.split(/\r?\n/);

                if (parts.length === sourceBatch.length) {
                    sourceBatch.forEach((part, i) => {
                        const value = String(parts[i] || part).trim();
                        const corrected = applyTranslationCorrection(part, value);
                        if (hasJapanese(corrected)) {
                            cache[part] = corrected;
                        }
                    });
                    progressDone += sourceBatch.length;
                    if (progressBar && updateStatusFn) {
                        updateStatusFn(progressBar, progressDone, progressTotal);
                        await yieldToUI();
                    }
                    return;
                }
            } catch (_) { }

            for (const part of sourceBatch) {
                try {
                    const value = String(await translateTextBatch(part)).trim();
                    const corrected = applyTranslationCorrection(part, value);
                    if (hasJapanese(corrected)) {
                        cache[part] = corrected;
                    }
                } catch (_) { }
                progressDone++;
                if (progressBar && updateStatusFn) {
                    updateStatusFn(progressBar, progressDone, progressTotal);
                    await yieldToUI();
                }
            }
        };

        for (let i = 0; i < batches.length; i += 3) {
            await Promise.all(batches.slice(i, i + 3).map(translateOneBatch));
        }

        for (const name of unique) {
            const translatedParts = partsForName(name).map(part => {
                if (!part) return "";
                if (shouldKeepTranslationToken(part)) return part;
                return applyTranslationCorrection(part, typeof cache[part] === "string" && cache[part] ? cache[part] : part);
            });
            translated.set(name, translatedParts.join("_"));
        }

        try { localStorage.setItem(cacheKey, JSON.stringify(cache)); } catch (_) { }
        return names.map(name => translated.get(normalize(name)) || normalize(name));
    }

    async function translateEventTypeNames(names, progressBar = null, updateStatusFn = null) {
        const unique = [...new Set(names.map(normalize).filter(Boolean))];
        const translated = new Map();
        for (const name of unique) {
            if (shouldKeepTranslationToken(name)) translated.set(name, name);
        }
        const cacheKey = "selectionListTranslationCache_v3_eventtype_camel";
        let cache = {};
        try { cache = JSON.parse(localStorage.getItem(cacheKey) || "{}"); } catch (_) { cache = {}; }

        const pending = unique.filter(name => !shouldKeepTranslationToken(name) && (!cache[name] || !hasJapanese(cache[name])));
        const total = pending.length;
        let done = 0;
        if (progressBar && updateStatusFn) {
            updateStatusFn(progressBar, 0, total);
            await yieldToUI();
        }

        const BATCH_CHARS = 1200;
        const batches = [];
        let batch = [];
        let length = 0;
        for (const name of pending) {
            const source = splitCamelCaseForTranslation(name);
            const extra = source.length + 1;
            if (batch.length && length + extra > BATCH_CHARS) {
                batches.push(batch);
                batch = [];
                length = 0;
            }
            batch.push({ name, source });
            length += extra;
        }
        if (batch.length) batches.push(batch);

        const translateBatch = async sourceBatch => {
            try {
                const source = sourceBatch.map(item => item.source).join("\n");
                const result = await translateTextBatch(source);
                const parts = result.split(/\r?\n/);
                if (parts.length === sourceBatch.length) {
                    sourceBatch.forEach((item, i) => {
                        const value = String(parts[i] || "").trim();
                        const corrected = applyTranslationCorrection(item.name, value);
                        if (hasJapanese(corrected)) {
                            cache[item.name] = corrected;
                        }
                    });
                    done += sourceBatch.length;
                    if (progressBar && updateStatusFn) {
                        updateStatusFn(progressBar, done, total);
                        await yieldToUI();
                    }
                    return;
                }
            } catch (_) { }

            for (const item of sourceBatch) {
                try {
                    const value = String(await translateTextBatch(item.source)).trim();
                    const corrected = applyTranslationCorrection(item.name, value);
                    if (hasJapanese(corrected)) {
                        cache[item.name] = corrected;
                    }
                } catch (_) { }
            }
        };

        for (let i = 0; i < batches.length; i += 3) {
            await Promise.all(batches.slice(i, i + 3).map(translateBatch));
        }

        for (const name of unique) {
            if (!translated.has(name)) translated.set(name, applyTranslationCorrection(name, cache[name] || name));
        }
        try { localStorage.setItem(cacheKey, JSON.stringify(cache)); } catch (_) { }
        return names.map(name => translated.get(normalize(name)) || normalize(name));
    }

    // ============================================================
    // 日本語化機能のON/OFF状態（localStorageで永続保持）
    // ============================================================
    let translationEnabled = localStorage.getItem("selection_list_translation_enabled") !== "false";

    function isEnabled() {
        return translationEnabled;
    }

    function addTranslationToggleMenu(submenu) {
        if (!submenu || submenu.querySelector('[data-japanese-plugin="toggle-translation"]')) return;

        const item = document.createElement("div");
        item.setAttribute("data-japanese-plugin", "toggle-translation");
        item.className = "selection-list-plugin-menu-item";
        Object.assign(item.style, {
            padding: "5px 18px",
            whiteSpace: "nowrap",
            background: "rgb(22, 29, 30)",
            color: translationEnabled ? "#61c3ff" : "#8e999b",
            cursor: "pointer",
            fontSize: "15px",
            lineHeight: "1.3",
            borderTop: "1px solid #3a4648",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
        });
        item.textContent = translationEnabled ? "日本語化: ON (無効化)" : "日本語化: OFF (有効化)";

        item.addEventListener("mouseenter", () => item.style.background = "rgb(48, 60, 62)");
        item.addEventListener("mouseleave", () => item.style.background = "rgb(22, 29, 30)");
        item.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            translationEnabled = !translationEnabled;
            localStorage.setItem("selection_list_translation_enabled", String(translationEnabled));
            item.textContent = translationEnabled ? "日本語化: ON (無効化)" : "日本語化: OFF (有効化)";
            item.style.color = translationEnabled ? "#61c3ff" : "#8e999b";
            if (!translationEnabled) hideFlyoutTooltip();
        }, true);

        submenu.appendChild(item);
    }

    function menuItem(label, onClick) {
        const item = document.createElement("div");
        item.className = "selection-list-plugin-menu-item";
        Object.assign(item.style, {
            padding: "5px 18px",
            whiteSpace: "nowrap",
            background: "rgb(22, 29, 30)",
            color: "#ffffff",
            cursor: "pointer",
            fontSize: "15px",
            lineHeight: "1.3",
            borderTop: "1px solid #3a4648"
        });
        const labelEl = document.createElement("span");
        labelEl.textContent = label;
        item.appendChild(labelEl);
        item.addEventListener("mouseenter", () => item.style.background = "rgb(48, 60, 62)");
        item.addEventListener("mouseleave", () => item.style.background = "rgb(22, 29, 30)");
        item.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            try { onClick(); } catch (e) { console.error("Japanese plugin action failed", e); }
        }, true);
        return item;
    }

    // ============================================================
    // 日本語キャッシュの保存 (エクスポート) & 読込 (インポート) & ブロック一覧
    // ============================================================
    function exportBlockCacheJson() {
        const sorted = {};
        Object.keys(flyoutTranslationCache).sort().forEach(k => {
            sorted[k] = flyoutTranslationCache[k];
        });
        const jsonText = JSON.stringify(sorted, null, 2);
        const blob = new Blob([jsonText], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "block_translation_cache.json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        alert(`ブロック名の日本語キャッシュ（${Object.keys(sorted).length}件）を保存しました。`);
    }

    function importBlockCacheJson() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.style.display = "none";
        input.onchange = e => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    const data = JSON.parse(ev.target.result);
                    if (!data || typeof data !== "object") throw new Error();
                    let count = 0;
                    for (const [k, v] of Object.entries(data)) {
                        if (typeof v === "string" && v.trim()) {
                            flyoutTranslationCache[normalize(k)] = v.trim();
                            count++;
                        }
                    }
                    localStorage.setItem(flyoutTranslationCacheKey, JSON.stringify(flyoutTranslationCache));
                    alert(`日本語キャッシュ（${count}件）を正常に読み込みました！即座に反映されます。`);
                } catch (_) {
                    alert("JSONファイルの形式が正しくありません。");
                }
            };
            reader.readAsText(file, "UTF-8");
            input.remove();
        };
        document.body.appendChild(input);
        input.click();
    }

    function extractToolboxCategoriesAndBlocks() {
        const ws = getWorkspace();
        const Blockly = _Blockly || window.Blockly;
        const categories = {};
        const recordedBlocks = new Set();

        function addBlockToCategory(catName, type) {
            const cleanType = normalize(type);
            if (!cleanType || cleanType === "null" || cleanType === "undefined") return;
            if (!categories[catName]) {
                categories[catName] = { count: 0, blocks: [] };
            }
            if (!categories[catName].blocks.includes(cleanType)) {
                categories[catName].blocks.push(cleanType);
                categories[catName].count = categories[catName].blocks.length;
                recordedBlocks.add(cleanType);
            }
        }

        function parseAnyBlockType(item) {
            if (!item) return null;
            if (typeof item === "string") {
                const m = item.match(/type=["']([^"']+)["']/i);
                return m ? m[1] : null;
            }
            if (item.getAttribute && item.getAttribute("type")) return item.getAttribute("type");
            if (typeof item.type === "string" && item.type) return item.type;
            if (item.blockxml) {
                if (typeof item.blockxml === "string") {
                    const m = item.blockxml.match(/type=["']([^"']+)["']/i);
                    if (m) return m[1];
                } else if (item.blockxml.getAttribute) {
                    return item.blockxml.getAttribute("type");
                }
            }
            return null;
        }

        try {
            const toolbox = ws?.getToolbox?.();
            if (toolbox) {
                const items = toolbox.getToolboxItems?.() || toolbox.contents_ || [];
                function inspectToolboxItem(item, parentPath = "") {
                    if (!item) return;
                    const name = item.getName?.() || item.name_ || item.toolboxItemDef_?.name || item.id_;
                    if (!name || name === "sep") return;

                    const currentPath = parentPath ? `${parentPath} > ${name}` : name;
                    let contents = [];
                    try {
                        if (typeof item.getContents === "function") contents = item.getContents() || [];
                    } catch (_) { }

                    const defContents = item.toolboxItemDef_?.contents || item.def_?.contents;
                    if (Array.isArray(defContents)) contents = contents.concat(defContents);

                    if (Array.isArray(contents) && contents.length > 0) {
                        contents.forEach(c => {
                            if (!c) return;
                            if (c.kind === "category" || (c.contents && !c.type && !c.blockxml)) {
                                inspectToolboxItem(c, currentPath);
                            } else {
                                const t = parseAnyBlockType(c);
                                if (t) addBlockToCategory(currentPath, t);
                            }
                        });
                    }

                    const subItems = item.getChildToolboxItems?.() || item.children_ || [];
                    if (Array.isArray(subItems)) {
                        subItems.forEach(sub => inspectToolboxItem(sub, currentPath));
                    }
                }
                items.forEach(it => inspectToolboxItem(it, ""));
            }
        } catch (_) { }

        try {
            const tree = ws?.options?.languageTree;
            if (tree) {
                if (typeof tree === "string" || tree.nodeType === 1) {
                    const doc = typeof tree === "string" ? new DOMParser().parseFromString(tree, "text/xml") : tree;
                    doc.querySelectorAll("category").forEach(cat => {
                        let catPath = cat.getAttribute("name") || "Unknown";
                        let p = cat.parentElement;
                        while (p && p.tagName?.toLowerCase() === "category") {
                            catPath = `${p.getAttribute("name") || "Category"} > ${catPath}`;
                            p = p.parentElement;
                        }
                        cat.querySelectorAll("block").forEach(b => {
                            const t = b.getAttribute("type");
                            if (t) addBlockToCategory(catPath, t);
                        });
                    });
                } else if (Array.isArray(tree.contents)) {
                    function walkTreeJson(node, pPath = "") {
                        if (!node) return;
                        const cName = node.name || node.kind;
                        const cur = pPath ? `${pPath} > ${cName}` : cName;
                        if (Array.isArray(node.contents)) {
                            node.contents.forEach(child => {
                                if (child.kind === "category" || (child.contents && !child.type)) {
                                    walkTreeJson(child, cur);
                                } else {
                                    const t = parseAnyBlockType(child);
                                    if (t) addBlockToCategory(cur, t);
                                }
                            });
                        }
                    }
                    tree.contents.forEach(n => walkTreeJson(n, ""));
                }
            }
        } catch (_) { }

        try {
            if (Blockly?.Blocks) {
                const allRegisteredTypes = Object.keys(Blockly.Blocks);
                const missingBlocks = allRegisteredTypes.filter(t => !recordedBlocks.has(t));
                if (missingBlocks.length > 0) {
                    missingBlocks.forEach(t => {
                        if (/^(placeholder|dummy|temp)/i.test(t)) return;
                        addBlockToCategory("Uncategorized Blocks", t);
                    });
                }
            }
        } catch (_) { }

        return categories;
    }

    function exportToolboxListJson() {
        const categories = extractToolboxCategoriesAndBlocks();
        let totalBlocks = 0;
        Object.values(categories).forEach(c => totalBlocks += (c.count || 0));

        const output = {
            _description: "Battlefield 2042 Portal Toolbox Block List",
            exportedAt: new Date().toISOString(),
            totalCategories: Object.keys(categories).length,
            totalBlocks: totalBlocks,
            categories: categories
        };

        const jsonText = JSON.stringify(output, null, 2);
        const blob = new Blob([jsonText], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        a.download = `portal_blocks_list_${dateStr}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        alert(`全${output.totalCategories}カテゴリ（合計${totalBlocks}個のブロック）の一覧をJSONに出力しました！`);
    }

    function removeCacheSubmenu() {
        document.querySelectorAll('[data-japanese-plugin="cache-submenu"]').forEach(el => el.remove());
    }

    function addCacheManagementMenu(submenu) {
        if (!submenu || submenu.querySelector('[data-japanese-plugin="cache-root"]')) return;

        const item = document.createElement("div");
        item.setAttribute("data-japanese-plugin", "cache-root");
        item.className = "selection-list-plugin-menu-item";
        Object.assign(item.style, {
            padding: "5px 18px",
            whiteSpace: "nowrap",
            background: "rgb(22, 29, 30)",
            color: "#ffffff",
            cursor: "pointer",
            fontSize: "15px",
            lineHeight: "1.3",
            borderTop: "1px solid #3a4648",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
        });
        item.textContent = "日本語キャッシュ ▶";

        item.addEventListener("mouseenter", () => {
            item.style.background = "rgb(48, 60, 62)";
            removeCacheSubmenu();

            const sub = document.createElement("div");
            sub.setAttribute("data-japanese-plugin", "cache-submenu");
            const rect = item.getBoundingClientRect();

            Object.assign(sub.style, {
                position: "fixed",
                left: `${rect.left + rect.width / 2}px`,
                top: `${rect.bottom}px`,
                transform: "translateX(0)",
                minWidth: "160px",
                background: "rgb(22, 29, 30)",
                color: "#fff",
                border: "1px solid #3a4648",
                boxShadow: "0 3px 14px rgba(0,0,0,.45)",
                zIndex: "2147483647",
                display: "flex",
                flexDirection: "column"
            });

            sub.appendChild(menuItem("キャッシュを保存 (.json)", () => {
                exportBlockCacheJson();
                removeCacheSubmenu();
            }));
            sub.appendChild(menuItem("キャッシュを読込 (.json)", () => {
                importBlockCacheJson();
                removeCacheSubmenu();
            }));
            sub.appendChild(menuItem("ブロック一覧 (.json)", () => {
                exportToolboxListJson();
                removeCacheSubmenu();
            }));

            item.appendChild(sub);
        });

        item.addEventListener("mouseleave", () => {
            item.style.background = "rgb(22, 29, 30)";
            setTimeout(() => {
                if (!item.matches(":hover")) removeCacheSubmenu();
            }, 200);
        });

        submenu.appendChild(item);
    }

    // ============================================================
    // Native Help Japanese translation
    // ============================================================
    let helpTranslationRunning = false;
    let helpTranslationTimer = null;

    function isVisibleHelpElement(el) {
        if (!el || !el.isConnected) return false;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 120 && r.height > 80;
    }

    function findNativeHelpDialogForTranslation() {
        const candidates = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="help" i], [class*="Help"], .modal, .dialog')]
            .filter(isVisibleHelpElement);
        if (!candidates.length) return null;
        const scored = candidates.map(el => {
            const text = normalize(el.innerText || el.textContent || "");
            let score = 0;
            if (/\bHelp\b|ヘルプ/i.test(text)) score += 10;
            if (/description|usage|example|input|output|説明|使用例|例/i.test(text)) score += 6;
            if (el.matches('[role="dialog"], [aria-modal="true"]')) score += 4;
            if (el.querySelector("svg")) score += 2;
            const r = el.getBoundingClientRect();
            return { el, score, area: r.width * r.height };
        });
        scored.sort((a, b) => b.score - a.score || b.area - a.area);
        return (scored[0] && scored[0].score >= 3) ? scored[0].el : null;
    }

    function collectHelpTextNodes(root) {
        const nodes = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const parent = node.parentElement;
            if (!parent) continue;
            if (/^(SCRIPT|STYLE|TEXTAREA|INPUT|BUTTON|OPTION)$/i.test(parent.tagName)) continue;
            if (parent.closest("textarea, input, button")) continue;
            if (parent.closest("svg, code, pre")) continue;

            const text = normalize(node.nodeValue);
            if (!text || /^[\d\s\-_/.:,()[\]{}]+$/.test(text)) continue;
            nodes.push(node);
        }
        return nodes;
    }

    async function translateNativeHelpDialog(dialog) {
        if (!dialog || helpTranslationRunning) return;
        helpTranslationRunning = true;
        try {
            const nodes = collectHelpTextNodes(dialog);
            const cacheKey = "selectionListNativeHelpTranslationCache_v3";
            let cache = {};
            try { cache = JSON.parse(localStorage.getItem(cacheKey) || "{}"); } catch (_) { cache = {}; }

            for (let i = 0; i < nodes.length; i += 10) {
                const batch = nodes.slice(i, i + 10);
                await Promise.all(batch.map(async node => {
                    const source = normalize(node.nodeValue);
                    if (!source) return;
                    let translated = applyTranslationCorrection(source, cache[source] || "");
                    if (!translated || translated === source) {
                        try {
                            const raw = await translateTextBatch(source);
                            translated = applyTranslationCorrection(source, raw);
                            cache[source] = translated || source;
                        } catch (_) {
                            translated = source;
                        }
                    }
                    if (translated && translated !== source && node.isConnected) {
                        node.nodeValue = translated;
                    }
                }));
            }
            try { localStorage.setItem(cacheKey, JSON.stringify(cache)); } catch (_) { }
        } finally {
            helpTranslationRunning = false;
        }
    }

    function scheduleNativeHelpTranslation() {
        if (!translationEnabled) return;
        if (helpTranslationTimer) clearTimeout(helpTranslationTimer);
        helpTranslationTimer = setTimeout(async () => {
            helpTranslationTimer = null;
            const dialog = findNativeHelpDialogForTranslation();
            if (!dialog) return;
            await translateNativeHelpDialog(dialog);
            setTimeout(() => {
                const current = findNativeHelpDialogForTranslation();
                if (current) translateNativeHelpDialog(current).catch(() => { });
            }, 400);
        }, 150);
    }

    function bindNativeHelpTranslation() {
        if (window.__japaneseNativeHelpTranslationBound) return;
        window.__japaneseNativeHelpTranslationBound = true;

        const helpObserver = new MutationObserver(() => {
            const dialog = findNativeHelpDialogForTranslation();
            if (dialog) scheduleNativeHelpTranslation();
        });
        helpObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });

        document.addEventListener("click", event => {
            const target = event.target?.closest?.('[role="menuitem"], button, [aria-label], li, div, span');
            if (!target) return;
            const text = normalize(target.innerText || target.textContent || target.getAttribute?.("aria-label") || "");
            if (text === "Help" || text === "ヘルプ" || /ヘルプ|Help/i.test(text)) {
                scheduleNativeHelpTranslation();
            }
        }, true);
    }

    // ============================================================
    // フライアウト＆ワークスペース用ホバー拡大ポップアップ
    // ============================================================
    let flyoutTooltipEl = null;
    let flyoutTooltipTarget = null;
    let flyoutTooltipLeaveTimer = null;

    function getOrCreateFlyoutTooltip() {
        if (flyoutTooltipEl) return flyoutTooltipEl;
        const tip = document.createElement("div");
        tip.setAttribute("data-japanese-plugin", "flyout-tooltip");
        Object.assign(tip.style, {
            position: "fixed",
            zIndex: "2147483647",
            pointerEvents: "none",
            background: "rgba(14, 20, 22, 0.96)",
            color: "#ffffff",
            border: "2px solid #4da3ff",
            borderRadius: "8px",
            padding: "10px 16px",
            boxShadow: "0 8px 30px rgba(0,0,0,.75)",
            backdropFilter: "blur(6px)",
            fontFamily: "'Segoe UI', Meiryo, sans-serif",
            maxWidth: "460px",
            minWidth: "200px",
            display: "none",
            flexDirection: "column",
            gap: "5px",
            transition: "opacity 0.12s ease-out, transform 0.12s ease-out",
            opacity: "0",
            transform: "translateY(4px)"
        });

        const jaTitle = document.createElement("div");
        jaTitle.className = "flyout-tip-ja";
        Object.assign(jaTitle.style, {
            fontSize: "20px",
            fontWeight: "bold",
            color: "#61c3ff",
            lineHeight: "1.3",
            letterSpacing: "0.5px",
            wordBreak: "break-word"
        });

        tip.appendChild(jaTitle);
        document.body.appendChild(tip);
        flyoutTooltipEl = tip;
        tip._jaTitle = jaTitle;
        return tip;
    }

    function positionFlyoutTooltip(targetRect) {
        if (!flyoutTooltipEl) return;
        const tipWidth = flyoutTooltipEl.offsetWidth;
        const tipHeight = flyoutTooltipEl.offsetHeight;
        let left = targetRect.left;
        let top = targetRect.top - tipHeight - 8;

        if (top < 8) top = targetRect.bottom + 8;
        left = Math.max(10, Math.min(window.innerWidth - tipWidth - 10, left));

        flyoutTooltipEl.style.left = `${Math.round(left)}px`;
        flyoutTooltipEl.style.top = `${Math.round(top)}px`;
    }

    async function showFlyoutTooltip(targetElement, rawName, isWorkspace = false) {
        const tip = getOrCreateFlyoutTooltip();
        flyoutTooltipTarget = targetElement;
        const targetRect = targetElement.getBoundingClientRect();

        tip.style.zoom = "1";
        if (isWorkspace) {
            tip.style.padding = "6px 11px";
            tip.style.minWidth = "130px";
            tip.style.borderRadius = "6px";
            tip.style.borderWidth = "1.5px";
            tip._jaTitle.style.fontSize = "14px";
        } else {
            tip.style.padding = "10px 16px";
            tip.style.minWidth = "200px";
            tip.style.borderRadius = "8px";
            tip.style.borderWidth = "2px";
            tip._jaTitle.style.fontSize = "20px";
        }

        tip._jaTitle.textContent = "翻訳中…";
        tip.style.display = "flex";
        positionFlyoutTooltip(targetRect);

        requestAnimationFrame(() => {
            tip.style.opacity = "1";
            tip.style.transform = "translateY(0)";
        });

        const ja = await getTranslatedBlockName(rawName);
        if (flyoutTooltipTarget === targetElement) {
            tip._jaTitle.textContent = ja || rawName;
            positionFlyoutTooltip(targetElement.getBoundingClientRect());
        }
    }

    function showDirectTooltip(targetElement, text, isWorkspace = false) {
        const tip = getOrCreateFlyoutTooltip();
        flyoutTooltipTarget = targetElement;
        const targetRect = targetElement.getBoundingClientRect();

        tip.style.zoom = "1";
        if (isWorkspace) {
            tip.style.padding = "6px 11px";
            tip.style.minWidth = "130px";
            tip.style.borderRadius = "6px";
            tip.style.borderWidth = "1.5px";
            tip._jaTitle.style.fontSize = "14px";
        } else {
            tip.style.padding = "10px 16px";
            tip.style.minWidth = "200px";
            tip.style.borderRadius = "8px";
            tip.style.borderWidth = "2px";
            tip._jaTitle.style.fontSize = "20px";
        }

        tip._jaTitle.textContent = text;
        tip.style.display = "flex";
        positionFlyoutTooltip(targetRect);

        requestAnimationFrame(() => {
            tip.style.opacity = "1";
            tip.style.transform = "translateY(0)";
        });
    }

    function hideFlyoutTooltip() {
        if (!flyoutTooltipEl) return;
        flyoutTooltipTarget = null;
        flyoutTooltipEl.style.opacity = "0";
        flyoutTooltipEl.style.transform = "translateY(4px)";
        clearTimeout(flyoutTooltipLeaveTimer);
        flyoutTooltipLeaveTimer = setTimeout(() => {
            if (!flyoutTooltipTarget && flyoutTooltipEl) {
                flyoutTooltipEl.style.display = "none";
            }
        }, 120);
    }

    function extractBlockLabelFromFlyoutElement(el) {
        if (!el) return "";
        const textNodes = [...el.querySelectorAll("text.blocklyText")];
        if (textNodes.length) {
            const combined = textNodes.map(t => normalize(t.textContent)).filter(Boolean).join(" ");
            if (combined) return combined;
        }
        const type = el.getAttribute?.("data-type") || el.dataset?.type;
        if (type) return type;
        const plain = normalize(el.innerText || el.textContent || "");
        return plain.split(/\r?\n/)[0]?.trim() || "";
    }

    function bindFlyoutHoverListener() {
        if (window.__japaneseFlyoutHoverBound) return;
        window.__japaneseFlyoutHoverBound = true;

        document.addEventListener("mouseover", event => {
            if (!translationEnabled) return;

            const target = event.target?.closest?.(
                '.blocklyFlyout g.blocklyDraggable, .blocklyFlyoutScrollbar ~ svg g.blocklyDraggable, [class*="flyout" i] g.blocklyDraggable, [class*="flyout" i] [class*="block" i]'
            );
            if (!target) {
                if (flyoutTooltipTarget && !event.target?.closest?.('[data-japanese-plugin="flyout-tooltip"]')) {
                    hideFlyoutTooltip();
                }
                return;
            }
            if (flyoutTooltipTarget === target) return;

            const label = extractBlockLabelFromFlyoutElement(target);
            if (!label || label.length < 2) return;
            showFlyoutTooltip(target, label);
        }, true);

        document.addEventListener("mouseout", event => {
            if (!flyoutTooltipTarget) return;
            const target = event.target?.closest?.(
                '.blocklyFlyout g.blocklyDraggable, .blocklyFlyoutScrollbar ~ svg g.blocklyDraggable, [class*="flyout" i] g.blocklyDraggable, [class*="flyout" i] [class*="block" i]'
            );
            if (target === flyoutTooltipTarget) {
                hideFlyoutTooltip();
            }
        }, true);
    }

    function bindNativeTooltipTranslation() {
        if (window.__japaneseTooltipTranslationBound) return;
        window.__japaneseTooltipTranslationBound = true;

        const hideNativeStyle = document.createElement("style");
        hideNativeStyle.setAttribute("data-japanese-plugin", "hide-native-tooltip");
        document.head.appendChild(hideNativeStyle);

        const updateTooltipVisibility = () => {
            hideNativeStyle.textContent = translationEnabled ? ".blocklyTooltipDiv { display: none !important; }" : "";
        };
        updateTooltipVisibility();

        document.addEventListener("click", () => setTimeout(updateTooltipVisibility, 50), true);

        document.addEventListener("mouseover", event => {
            if (!translationEnabled) return;
            const blockEl = event.target?.closest?.(".blocklyWorkspace g.blocklyDraggable");
            if (!blockEl || blockEl.closest(".blocklyFlyout")) return;
            if (flyoutTooltipTarget === blockEl) return;

            const id = blockEl.getAttribute?.("data-id") || blockEl.dataset?.id;
            const block = getBlockFromId(id);
            const rawName = block?.type || extractBlockLabelFromFlyoutElement(blockEl);
            if (!rawName || rawName.length < 2) return;

            showFlyoutTooltip(blockEl, rawName, true);
        }, true);

        document.addEventListener("mouseout", event => {
            if (!flyoutTooltipTarget) return;
            const blockEl = event.target?.closest?.(".blocklyWorkspace g.blocklyDraggable");
            if (blockEl === flyoutTooltipTarget) {
                hideFlyoutTooltip();
            }
        }, true);
    }

    // ============================================================
    // ドロップダウン辞書 & ホバー翻訳
    // ============================================================
    function getJListSelectCachedTranslation(rawText) {
        const key = normalize(rawText);
        if (!key) return null;

        if (TRANSLATION_CORRECTIONS[key] && hasJapanese(TRANSLATION_CORRECTIONS[key])) {
            return TRANSLATION_CORRECTIONS[key];
        }

        if (flyoutTranslationCache[key] && hasJapanese(flyoutTranslationCache[key])) {
            return flyoutTranslationCache[key];
        }

        try {
            const eventCache = JSON.parse(localStorage.getItem("selectionListTranslationCache_v3_eventtype_camel") || "{}");
            if (eventCache[key] && hasJapanese(eventCache[key])) {
                return eventCache[key];
            }
        } catch (_) { }

        try {
            const partsCache = JSON.parse(localStorage.getItem("selectionListTranslationCache_v2_parts") || "{}");
            if (partsCache[key] && hasJapanese(partsCache[key])) {
                return partsCache[key];
            }
            if (key.includes("_")) {
                const parts = key.split("_");
                const translatedParts = parts.map(p => (partsCache[p] && hasJapanese(partsCache[p])) ? partsCache[p] : p);
                const candidate = translatedParts.join("_");
                if (hasJapanese(candidate)) {
                    return candidate;
                }
            }
        } catch (_) { }

        if (masterTranslationCache[key] && hasJapanese(masterTranslationCache[key])) {
            return masterTranslationCache[key];
        }

        return null;
    }

    async function resolveDropdownTranslation(rawText) {
        const key = normalize(rawText);
        if (!key) return null;

        const cached = getJListSelectCachedTranslation(key);
        if (cached) return cached;

        let translated = "";
        try {
            if (key.includes("_")) {
                const parts = key.split("_");
                const translatedParts = await Promise.all(parts.map(async p => {
                    if (!p || shouldKeepTranslationToken(p)) return p;
                    const hit = getJListSelectCachedTranslation(p);
                    if (hit) return hit;
                    const res = await translateTextBatch(p);
                    return applyTranslationCorrection(p, res);
                }));
                translated = translatedParts.join("_");
            } else {
                const spaced = splitCamelCaseForTranslation(key);
                translated = await translateTextBatch(spaced);
                translated = applyTranslationCorrection(key, translated);
            }
        } catch (_) {
            return null;
        }

        if (translated && hasJapanese(translated)) {
            try {
                const eventCache = JSON.parse(localStorage.getItem("selectionListTranslationCache_v3_eventtype_camel") || "{}");
                eventCache[key] = translated;
                localStorage.setItem("selectionListTranslationCache_v3_eventtype_camel", JSON.stringify(eventCache));
            } catch (_) { }
            return translated;
        }

        return null;
    }

    function bindDropdownHoverListener() {
        if (window.__japaneseDropdownHoverBound) return;
        window.__japaneseDropdownHoverBound = true;

        document.addEventListener("mouseover", event => {
            if (!translationEnabled) return;

            const menuItemEl = event.target?.closest?.(
                '.blocklyDropdownMenu .blocklyMenuItem, .goog-menu .goog-menuitem, [role="menuitem"], .blocklyMenu .blocklyMenuItem'
            );
            if (menuItemEl) {
                if (flyoutTooltipTarget === menuItemEl) return;
                const rawText = normalize(menuItemEl.innerText || menuItemEl.textContent);
                if (!rawText || rawText.length < 2 || /^[\d\s.,+\-*/=()]+$/.test(rawText)) return;

                flyoutTooltipTarget = menuItemEl;
                const fastJa = getJListSelectCachedTranslation(rawText);
                if (fastJa) {
                    showDirectTooltip(menuItemEl, fastJa, true);
                } else {
                    resolveDropdownTranslation(rawText).then(ja => {
                        if (ja && flyoutTooltipTarget === menuItemEl) {
                            showDirectTooltip(menuItemEl, ja, true);
                        }
                    });
                }
                return;
            }

            const dropdownField = event.target?.closest?.(
                '.blocklyWorkspace g.blocklyEditableText, .blocklyFlyout g.blocklyEditableText'
            );
            if (dropdownField) {
                if (flyoutTooltipTarget === dropdownField) return;
                const rawText = normalize(dropdownField.textContent);
                if (!rawText || rawText.length < 2 || /^[\d\s.,+\-*/=()]+$/.test(rawText)) return;

                flyoutTooltipTarget = dropdownField;
                const fastJa = getJListSelectCachedTranslation(rawText);
                if (fastJa) {
                    showDirectTooltip(dropdownField, fastJa, true);
                } else {
                    resolveDropdownTranslation(rawText).then(ja => {
                        if (ja && flyoutTooltipTarget === dropdownField) {
                            showDirectTooltip(dropdownField, ja, true);
                        }
                    });
                }
            }
        }, true);

        document.addEventListener("mouseout", event => {
            if (!flyoutTooltipTarget) return;
            const target = event.target?.closest?.(
                '.blocklyDropdownMenu .blocklyMenuItem, .goog-menu .goog-menuitem, [role="menuitem"], .blocklyMenu .blocklyMenuItem, g.blocklyEditableText'
            );
            if (target === flyoutTooltipTarget) {
                hideFlyoutTooltip();
            }
        }, true);

        document.addEventListener("click", () => {
            hideFlyoutTooltip();
        }, true);
    }

    // ============================================================
    // Selection_List などの外部プラグイン向け連携インターフェース
    // ============================================================
    window.__BF2042Portal_JapanesePlugin = {
        isEnabled,
        translateNames,
        translateEventTypeNames,
        getTranslatedBlockName,
        getCachedTranslation: getJListSelectCachedTranslation
    };

    let isScanning = false;
    function scan() {
        if (isScanning) return;
        isScanning = true;
        try {
            const submenus = document.querySelectorAll(".bf6-experience-manager-options-submenu");
            for (const submenu of submenus) {
                addTranslationToggleMenu(submenu);
                addCacheManagementMenu(submenu);
            }
        } finally {
            isScanning = false;
        }
    }

    function startObserver() {
        if (observer) return;
        observer = new MutationObserver(scan);
        observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
        scan();
    }

    plugin.initializeWorkspace = async function () {
        bindNativeHelpTranslation();
        bindFlyoutHoverListener();
        bindNativeTooltipTranslation();
        bindDropdownHoverListener();
        startObserver();
        scan();
    };
})();