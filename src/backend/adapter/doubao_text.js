/**
 * @fileoverview 豆包 (Doubao) 文本生成适配器
 */

import {
    sleep,
    humanType,
    safeClick,
    uploadFilesViaChooser
} from '../engine/utils.js';
import {
    normalizePageError,
    waitForInput,
    gotoWithCheck
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';
import { ADAPTER_ERRORS } from '../../server/errors.js';

// --- 配置常量 ---
const TARGET_URL = 'https://www.doubao.com/chat/';
const DEFAULT_SUPER_WAIT_TIMEOUT_MS = 900000;
const MODE_LABEL_MAP = {
    'seed': [/fast/i, /^快速$/i],
    'seed-thinking': [/think/i, /^思考$/i],
    'seed-pro': [/\bpro\b/i, /expert/i, /^专家$/i]
};
const FILE_LIKE_URL_RE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|txt|md|json|mp4|mov|webm|png|jpe?g|gif|webp)(\?|$)/i;
const LOGIN_LIMIT_TEXT_RE = /未登录时仅能发起\s*5\s*个新对话.*请登录以解锁该限制/i;
const DEFAULT_TEXT_CONVERSATION_MODE = 'always';
const FAST_CLICK_OPTIONS = { waitStable: false, cursorSpeed: 140, timeout: 9000 };

function resolveTextWaitTimeout(config, isSuperMode = false) {
    const poolWaitTimeout = Number(config?.backend?.pool?.waitTimeout);
    const adapterSuperTimeout = Number(config?.backend?.adapter?.doubao?.superTaskTimeoutMs)
        || Number(config?.backend?.adapter?.doubao_text?.superTaskTimeoutMs);
    const baseWaitTimeout = (Number.isFinite(poolWaitTimeout) && poolWaitTimeout > 0)
        ? Math.round(poolWaitTimeout)
        : 120000;

    if (!isSuperMode) {
        return baseWaitTimeout;
    }

    if (Number.isFinite(adapterSuperTimeout) && adapterSuperTimeout > 0) {
        return Math.round(adapterSuperTimeout);
    }

    return Math.max(baseWaitTimeout, DEFAULT_SUPER_WAIT_TIMEOUT_MS);
}

function clampProgress(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}

function createProgressTracker(meta = {}) {
    const state = {
        status: 'running',
        stage: 'init',
        progress: 0,
        situation: '任务初始化'
    };

    return {
        mark(stage, progress, situation) {
            state.stage = stage;
            state.progress = clampProgress(progress);
            state.situation = situation || state.situation;
            logger.info('适配器', `[超能进度] ${state.progress}% ${state.situation}`, meta);
        },
        snapshot(extra = {}) {
            return {
                status: state.status,
                stage: state.stage,
                progress: state.progress,
                situation: state.situation,
                ...extra
            };
        }
    };
}

function withProgress(result, tracker, extra = {}) {
    return {
        ...result,
        ...tracker.snapshot(extra)
    };
}

function buildProgressError(error, tracker, extra = {}) {
    return withProgress({ error }, tracker, { status: 'failed', ...extra });
}

function buildAuthRequiredError(tracker, source = 'unknown') {
    return buildProgressError('检测到豆包登录限制，请先登录后重试', tracker, {
        status: 'auth_required',
        code: ADAPTER_ERRORS.AUTH_REQUIRED,
        retryable: false,
        details: { authSource: source }
    });
}

async function detectLoginLimit(page) {
    try {
        const text = await page.locator('body').innerText({ timeout: 1500 });
        return LOGIN_LIMIT_TEXT_RE.test(text);
    } catch {
        return false;
    }
}

async function isVisible(locator, timeout = 1200) {
    try {
        await locator.first().waitFor({ state: 'visible', timeout });
        return true;
    } catch {
        return false;
    }
}

async function findFirstVisible(candidates, timeout = 2000) {
    const totalTimeout = Math.max(0, Number(timeout) || 0);
    const deadline = Date.now() + totalTimeout;
    for (const candidate of candidates) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const target = candidate.first ? candidate.first() : candidate;
        if (await isVisible(target, Math.max(200, remaining))) return target;
    }
    return null;
}

function resolveTextConversationMode(config) {
    const conv = config?.backend?.adapter?.doubao_text?.conversation || {};
    const raw = conv.mode ?? config?.backend?.adapter?.doubao_text?.newConversationMode ?? DEFAULT_TEXT_CONVERSATION_MODE;
    if (typeof raw === 'boolean') return raw ? 'always' : 'never';
    const mode = String(raw).trim().toLowerCase();
    return ['always', 'never'].includes(mode) ? mode : DEFAULT_TEXT_CONVERSATION_MODE;
}

async function clickNewConversation(page, meta = {}) {
    const newChatBtn = await findFirstVisible([
        page.getByRole('button', { name: /^\s*新对话\s*$|^\s*new chat\s*$/i }),
        page.getByRole('link', { name: /^\s*新对话\s*$|^\s*new chat\s*$/i }),
        page.locator('button,a,[role="button"],[role="link"]').filter({ hasText: /^\s*新对话\s*$|^\s*new chat\s*$/i })
    ], 2500);

    if (!newChatBtn) {
        logger.warn('适配器', '[文本模式] 未找到左侧“新对话”按钮，继续当前会话', meta);
        return false;
    }

    const clicked = await clickWithFallback(page, newChatBtn, meta, '新对话按钮');
    if (clicked) {
        await sleep(180, 320);
        logger.info('适配器', '[文本模式] 已切换到新对话', meta);
    }
    return clicked;
}

async function switchTextMode(page, modelId, meta = {}) {
    const targetPatterns = MODE_LABEL_MAP[modelId] || MODE_LABEL_MAP['seed'];
    const modeDesc = modelId || 'seed';
    const modeOrder = { 'seed': 0, 'seed-thinking': 1, 'seed-pro': 2 };

    const modelSelectorBtn = await findFirstVisible([
        page.locator('button[aria-haspopup="menu"]:has(div[data-testid="deep-thinking-action-button"])'),
        page.locator('button[aria-haspopup="menu"]').filter({ hasText: /快速|思考|专家|Fast|Think|Pro|Expert/i }),
        page.getByRole('button', { name: /快速|思考|专家|Fast|Think|Pro|Expert/i })
    ], 2500);

    if (!modelSelectorBtn) {
        logger.warn('适配器', `[文本模式] 未找到模式切换按钮，继续使用页面当前模式`, { ...meta, modelId: modeDesc });
        return { skipped: true };
    }

    await safeClick(page, modelSelectorBtn, { bias: 'button', ...FAST_CLICK_OPTIONS });
    await sleep(80, 140);

    for (const pattern of targetPatterns) {
        const menuItem = await findFirstVisible([
            page.getByRole('menuitem', { name: pattern }),
            page.locator('div[role="menuitem"],li[role="menuitem"],button[role="menuitem"]').filter({ hasText: pattern }),
            page.getByText(pattern)
        ], 2500);

        if (!menuItem) continue;

        await safeClick(page, menuItem, { bias: 'button', ...FAST_CLICK_OPTIONS });
        await sleep(80, 140);
        logger.info('适配器', `[文本模式] 已切换到 ${modeDesc}`, meta);
        return { success: true };
    }

    // 兜底：使用键盘从菜单顶部按顺序选择（0=快速,1=思考,2=专家）
    const idx = modeOrder[modelId];
    if (Number.isInteger(idx) && idx > 0) {
        try {
            for (let i = 0; i < idx; i++) {
                await page.keyboard.press('ArrowDown');
                await sleep(80, 160);
            }
            await page.keyboard.press('Enter');
            await sleep(220, 360);
            logger.info('适配器', `[文本模式] 使用键盘兜底切换到 ${modeDesc}`, meta);
            return { success: true, fallback: 'keyboard' };
        } catch { }
    }

    logger.warn('适配器', `[文本模式] 未找到模式选项 ${modeDesc}，继续使用页面当前模式`, meta);
    return { skipped: true };
}

async function switchSuperMode(page, meta = {}) {
    const superBtn = await findFirstVisible([
        page.getByRole('button', { name: /超能模式|super mode|beta/i }),
        page.locator('button').filter({ hasText: /超能模式|super mode|beta/i }),
        page.locator('[role="tab"]').filter({ hasText: /超能模式|super mode|beta/i }),
        page.getByText(/超能模式|super mode|beta/i)
    ], 5000);

    if (!superBtn) {
        logger.warn('适配器', '[超能模式] 未找到超能模式按钮，继续使用当前模式', meta);
        return { skipped: true };
    }

    try {
        await safeClick(page, superBtn, { bias: 'button', ...FAST_CLICK_OPTIONS });
    } catch (e1) {
        logger.warn('适配器', `[超能模式] safeClick 失败，尝试原生点击: ${e1.message}`, meta);
        try {
            await superBtn.click({ timeout: 5000, force: true });
        } catch (e2) {
            logger.warn('适配器', `[超能模式] 点击失败，继续使用当前模式: ${e2.message}`, meta);
            return { skipped: true };
        }
    }
    await sleep(80, 140);
    logger.info('适配器', '[超能模式] 已尝试切换到超能模式', meta);
    return { success: true };
}

async function clickWithFallback(page, locator, meta = {}, label = '元素') {
    const target = locator.first ? locator.first() : locator;

    try {
        await safeClick(page, target, { bias: 'button', ...FAST_CLICK_OPTIONS });
        return true;
    } catch (e1) {
        logger.warn('适配器', `${label} safeClick 失败，尝试原生点击: ${e1.message}`, meta);
    }

    try {
        await target.click({ timeout: 5000 });
        return true;
    } catch (e2) {
        logger.warn('适配器', `${label} 原生点击失败，尝试 force 点击: ${e2.message}`, meta);
    }

    try {
        await target.click({ timeout: 5000, force: true });
        return true;
    } catch (e3) {
        logger.warn('适配器', `${label} force 点击失败: ${e3.message}`, meta);
    }

    return false;
}

async function fastSetPrompt(inputLocator, prompt, meta = {}) {
    try {
        const target = inputLocator.first ? inputLocator.first() : inputLocator;
        await target.evaluate((el, value) => {
            const text = String(value ?? '');
            const tag = (el.tagName || '').toUpperCase();
            const isEditable = el.isContentEditable || el.getAttribute?.('contenteditable') === 'true';

            if (tag === 'TEXTAREA' || tag === 'INPUT') {
                const proto = Object.getPrototypeOf(el);
                const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
                if (desc && typeof desc.set === 'function') desc.set.call(el, text);
                else el.value = text;
            } else if (isEditable) {
                el.textContent = text;
            } else {
                el.textContent = text;
            }

            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, prompt);
        return true;
    } catch (e) {
        logger.debug('适配器', `[文本模式] 快速填充提示词失败，回退拟人输入: ${e.message}`, meta);
        return false;
    }
}

async function clearPromptInput(inputLocator) {
    const target = inputLocator.first ? inputLocator.first() : inputLocator;
    await target.evaluate((el) => {
        const tag = (el.tagName || '').toUpperCase();
        const isEditable = el.isContentEditable || el.getAttribute?.('contenteditable') === 'true';

        if (tag === 'TEXTAREA' || tag === 'INPUT') {
            const proto = Object.getPrototypeOf(el);
            const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
            if (desc && typeof desc.set === 'function') desc.set.call(el, '');
            else el.value = '';
        } else if (isEditable) {
            el.textContent = '';
        } else {
            el.textContent = '';
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

async function isSendButtonEnabled(page) {
    try {
        const sendBtn = page.locator('button[data-testid="chat_input_send_button"]').first();
        await sendBtn.waitFor({ state: 'visible', timeout: 2000 });
        return await sendBtn.evaluate((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    } catch {
        return false;
    }
}

async function triggerSendButtonByHumanTouch(page, inputLocator, meta = {}) {
    try {
        await safeClick(page, inputLocator, { bias: 'input', ...FAST_CLICK_OPTIONS });
        await page.keyboard.type('x', { delay: 14 });
        await sleep(20, 40);
        await page.keyboard.press('Backspace', { delay: 10 });
        await sleep(20, 40);
        return true;
    } catch (e) {
        logger.debug('适配器', `[文本模式] 拟人触发发送按钮失败: ${e.message}`, meta);
        return false;
    }
}

function collectUrlsFromAny(node, urls, seen) {
    if (!node) return;
    if (typeof node === 'string') {
        const text = node.trim();
        if (!text) return;
        if (!/^https?:\/\//i.test(text)) return;
        if (seen.has(text)) return;
        seen.add(text);
        urls.push(text);
        return;
    }
    if (Array.isArray(node)) {
        for (const item of node) collectUrlsFromAny(item, urls, seen);
        return;
    }
    if (typeof node === 'object') {
        for (const value of Object.values(node)) {
            collectUrlsFromAny(value, urls, seen);
        }
    }
}

function buildSuperModeText(mainText, deliveries = []) {
    const cleanMain = (mainText || '').trim();
    if (!deliveries.length) return cleanMain;

    const deliveryLines = deliveries.map((item, idx) => {
        const marker = FILE_LIKE_URL_RE.test(item) ? 'file' : 'link';
        return `${idx + 1}. [${marker}] ${item}`;
    });

    const blocks = [];
    if (cleanMain) blocks.push(cleanMain);
    blocks.push('【任务交付】');
    blocks.push(...deliveryLines);
    return blocks.join('\n');
}

async function extractSuperModeResultFromPage(page) {
    return await page.evaluate(() => {
        const root = document.querySelector('main') || document.body;
        const composer = document.querySelector('textarea[data-testid="chat_input_input"], textarea, [data-testid="chat_input_input"]');
        const composerRect = composer?.getBoundingClientRect?.();
        const composerTop = Number.isFinite(composerRect?.top) ? composerRect.top : window.innerHeight;

        const isVisible = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 80 || r.height < 16) return false;
            if (r.bottom <= 0 || r.right <= 0) return false;
            if (r.top >= window.innerHeight || r.left >= window.innerWidth) return false;
            return true;
        };

        const textSelectors = [
            '[data-testid*="message-content"]',
            '[data-testid*="message_content"]',
            '[data-testid*="answer"]',
            '.markdown',
            '.prose',
            '[class*="markdown"]',
            'article',
            'section'
        ];

        const nodes = [];
        for (const sel of textSelectors) {
            for (const el of Array.from(root.querySelectorAll(sel))) {
                if (!isVisible(el)) continue;
                const rect = el.getBoundingClientRect();
                if (rect.bottom > composerTop - 8) continue; // 过滤掉被输入区遮挡区域
                const text = (el.innerText || '').trim();
                if (!text || text.length < 24) continue;
                nodes.push({ el, text, bottom: rect.bottom, area: rect.width * rect.height });
            }
            if (nodes.length > 0) break;
        }

        if (nodes.length === 0) {
            for (const el of Array.from(root.querySelectorAll('div'))) {
                if (!isVisible(el)) continue;
                const rect = el.getBoundingClientRect();
                if (rect.bottom > composerTop - 8 || rect.width < 260 || rect.height < 24) continue;
                const text = (el.innerText || '').trim();
                if (!text || text.length < 30 || text.length > 6000) continue;
                nodes.push({ el, text, bottom: rect.bottom, area: rect.width * rect.height });
            }
        }

        nodes.sort((a, b) => {
            if (Math.abs(a.bottom - b.bottom) > 40) return b.bottom - a.bottom;
            return b.area - a.area;
        });
        const chatText = nodes[0]?.text || '';

        // 识别左右分栏场景：右侧通常是已选中的结果文件正文
        const paneCandidates = [];
        for (const el of Array.from(root.querySelectorAll('div,article,section'))) {
            if (!isVisible(el)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < window.innerWidth * 0.28 || rect.height < window.innerHeight * 0.3) continue;
            const text = (el.innerText || '').trim();
            if (!text || text.length < 80 || text.length > 20000) continue;
            const centerX = rect.left + rect.width / 2;
            paneCandidates.push({
                text,
                len: text.length,
                centerX,
                rect
            });
        }

        let rightPaneText = '';
        if (paneCandidates.length > 0) {
            const rightSide = paneCandidates
                .filter(x => x.centerX > window.innerWidth * 0.58)
                .sort((a, b) => b.len - a.len);
            rightPaneText = rightSide[0]?.text || '';
        }

        const text = rightPaneText && rightPaneText.length >= Math.max(120, chatText.length + 40)
            ? rightPaneText
            : chatText;
        const layoutMode = rightPaneText ? 'split' : 'chat';

        const deliveries = [];
        const seen = new Set();
        const pushDelivery = (label, value) => {
            const normalized = String(value || '').trim();
            if (!normalized || seen.has(normalized)) return;
            seen.add(normalized);
            const safeLabel = String(label || '').trim();
            deliveries.push(safeLabel ? `${safeLabel}: ${normalized}` : normalized);
        };

        for (const a of Array.from(root.querySelectorAll('a[href]'))) {
            if (!isVisible(a)) continue;
            const href = (a.getAttribute('href') || '').trim();
            if (!href) continue;
            if (!/^https?:\/\//i.test(href) && !href.startsWith('/')) continue;
            const label = (a.innerText || a.textContent || '').trim();
            if (!label && !href) continue;
            if (!/下载|文件|附件|报告|导出|result|download|file|pdf|doc|ppt|xls|zip|csv|json|md/i.test(`${label} ${href}`)) continue;
            pushDelivery(label, href);
        }

        for (const el of Array.from(root.querySelectorAll('button,[role="button"],div'))) {
            if (!isVisible(el)) continue;
            const label = (el.innerText || el.textContent || '').trim();
            if (!label || label.length > 160) continue;
            if (!/下载|文件|附件|报告|导出|result|download|file|pdf|doc|ppt|xls|zip|csv|json|md/i.test(label)) continue;
            pushDelivery('item', label);
        }

        const bodyText = (root.innerText || '').slice(-5000);
        const statusHints = [];
        for (const hint of [
            '正在思考', '思考中', '正在分析', '分析中', '执行中', '处理中',
            '生成中', '请稍候', '排队', '任务进行中', '完成', '已完成'
        ]) {
            if (bodyText.includes(hint)) statusHints.push(hint);
        }

        const sendBtn = document.querySelector('button[data-testid="chat_input_send_button"]');
        const stopBtn = Array.from(document.querySelectorAll('button,[role="button"]'))
            .find(btn => /停止|stop/i.test((btn.innerText || btn.textContent || '').trim()));
        const sendDisabled = !!sendBtn && (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true');
        const busyByHint = /正在思考|思考中|正在分析|分析中|执行中|处理中|生成中|请稍候|排队|任务进行中/.test(bodyText);
        const isBusy = !!stopBtn || busyByHint || sendDisabled;

        return {
            text,
            chatText,
            rightPaneText,
            layoutMode,
            deliveries,
            isBusy,
            statusHints: statusHints.slice(0, 8)
        };
    });
}

async function tryCaptureRightPaneDownload(page, meta = {}) {
    const downloadBtn = await findFirstVisible([
        page.getByRole('button', { name: /下载|download/i }),
        page.getByText(/下载|download/i),
        page.locator('button,[role="button"]').filter({ hasText: /下载|download/i })
    ], 2500);

    if (!downloadBtn) return [];

    try {
        const responsePromise = page.waitForResponse((resp) => {
            if (resp.status() !== 200) return false;
            const method = resp.request().method();
            if (!['GET', 'POST'].includes(method)) return false;
            const headers = resp.headers?.() || {};
            const ct = String(headers['content-type'] || '').toLowerCase();
            const cd = String(headers['content-disposition'] || '').toLowerCase();
            if (cd.includes('attachment')) return true;
            if (/application\/pdf|application\/octet-stream|application\/msword|application\/vnd\.|text\/markdown|text\/plain/.test(ct)) return true;
            return false;
        }, { timeout: 12000 });

        const clicked = await clickWithFallback(page, downloadBtn, meta, '右侧下载按钮');
        if (!clicked) return [];

        const resp = await responsePromise;
        const url = resp?.url?.();
        if (!url) return [];
        return [`download: ${url}`];
    } catch (e) {
        logger.debug('适配器', `[超能模式] 右侧下载抓取失败: ${e.message}`, meta);
        return [];
    }
}

async function waitForSuperModeResult(page, timeoutMs, meta = {}, tracker = null) {
    const startedAt = Date.now();
    let lastSignature = '';
    let lastChangeAt = startedAt;
    let lastProgressLogAt = 0;
    let latest = { text: '', deliveries: [], isBusy: true, statusHints: [] };

    while (Date.now() - startedAt < timeoutMs) {
        latest = await extractSuperModeResultFromPage(page);

        const signature = JSON.stringify({
            text: (latest.text || '').slice(-800),
            chat: (latest.chatText || '').slice(-260),
            right: (latest.rightPaneText || '').slice(-260),
            layout: latest.layoutMode || 'chat',
            deliveries: latest.deliveries || [],
            busy: !!latest.isBusy,
            hints: latest.statusHints || []
        });

        if (signature !== lastSignature) {
            lastSignature = signature;
            lastChangeAt = Date.now();
            if (tracker) {
                const elapsedRatio = Math.min(0.92, (Date.now() - startedAt) / Math.max(timeoutMs, 1));
                const p = 55 + Math.round(elapsedRatio * 35);
                tracker.mark('wait_super_mode', p, latest.isBusy ? '超能任务执行中' : '检测到结果变化，整理交付内容');
            }
        }

        const now = Date.now();
        if (now - lastProgressLogAt >= 10000) {
            lastProgressLogAt = now;
            logger.info('适配器', `[超能模式] 等待中: elapsed=${Math.round((now - startedAt) / 1000)}s, busy=${latest.isBusy}, layout=${latest.layoutMode || 'chat'}, textLen=${(latest.text || '').length}, deliveries=${latest.deliveries?.length || 0}`, meta);
        }

        if (await detectLoginLimit(page)) {
            return { authRequired: true, latest };
        }

        const hasResult = (latest.text && latest.text.length >= 24) || (latest.deliveries && latest.deliveries.length > 0);
        const stableMs = now - lastChangeAt;
        const hasDoneHint = (latest.statusHints || []).some(h => /完成/.test(h));

        if (hasResult && !latest.isBusy && (stableMs >= 8000 || hasDoneHint)) {
            try {
                await page.evaluate(() => {
                    const composer = document.querySelector('textarea[data-testid="chat_input_input"], textarea, [data-testid="chat_input_input"]');
                    if (composer) {
                        const rect = composer.getBoundingClientRect();
                        const offset = Math.max(120, Math.min(260, window.innerHeight - rect.top + 40));
                        window.scrollBy({ top: -offset, behavior: 'instant' });
                    } else {
                        window.scrollBy({ top: -180, behavior: 'instant' });
                    }
                });
            } catch { }
            return { done: true, timeout: false, latest };
        }

        // 页面长期无变化时主动兜底，避免无限期等待
        if (stableMs >= 90000) {
            if (hasResult) {
                logger.warn('适配器', '[超能模式] 页面长时间无变化，返回当前可提取结果', meta);
                return { done: true, timeout: false, latest, staleFallback: true };
            }
            return { done: false, timeout: true, latest, staleTimeout: true };
        }

        await sleep(900, 1400);
    }

    return { done: false, timeout: true, latest };
}

/**
 * 执行文本生成任务
 * @param {object} context - 浏览器上下文 { page, config }
 * @param {string} prompt - 提示词
 * @param {string[]} imgPaths - 图片路径数组
 * @param {string} [modelId] - 模型 ID
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<{text?: string, reasoning?: string, error?: string}>}
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page, config } = context;
    const isSuperMode = modelId === 'seed-super' || modelId === 'seed-agent';
    const waitTimeout = resolveTextWaitTimeout(config, isSuperMode);
    const progress = createProgressTracker(meta);

    // 是否使用深度思考模式
    const useThinking = modelId === 'seed-thinking' || modelId === 'seed-pro';

    try {
        progress.mark('open_chat_page', 8, '进入豆包页面');
        logger.info('适配器', '开启新会话...', meta);
        await gotoWithCheck(page, TARGET_URL);

        progress.mark('check_auth_limit', 12, '检测账号可用性');
        if (await detectLoginLimit(page)) {
            return buildAuthRequiredError(progress, 'quota_limit_before_generate');
        }

        const textConversationMode = resolveTextConversationMode(config);
        if (textConversationMode === 'always') {
            progress.mark('reset_conversation', 15, '重置到新对话');
            await clickNewConversation(page, meta);
        }

        // 1. 等待输入框加载
        progress.mark('wait_input', 18, '等待输入框就绪');
        const inputLocator = page.locator('textarea[data-testid="chat_input_input"]');
        await waitForInput(page, inputLocator, { click: false });

        // 2. 上传图片 (如果有)
        if (imgPaths && imgPaths.length > 0) {
            progress.mark('upload_images', 28, `上传参考图 (${imgPaths.length} 张)`);
            logger.info('适配器', `开始上传 ${imgPaths.length} 张图片...`, meta);

            // 预先拦截 ApplyImageUpload 响应，动态收集实际上传路径
            const expectedUploadPaths = new Set();
            const applyUploadHandler = async (response) => {
                try {
                    const url = response.url();
                    if (!url.includes('Action=ApplyImageUpload') || response.status() !== 200) return;
                    const json = await response.json();
                    const storeUri = json.Result?.UploadAddress?.StoreInfos?.[0]?.StoreUri;
                    if (storeUri) {
                        expectedUploadPaths.add(storeUri);
                        logger.debug('适配器', `已获取上传路径: ${storeUri}`, meta);
                    }
                } catch { /* 忽略解析错误 */ }
            };
            page.on('response', applyUploadHandler);

            try {
                // 点击上传菜单按钮
                const uploadMenuBtn = page.locator('button[aria-haspopup="menu"]:not(:has(div[data-testid="deep-thinking-action-button"]))').first();
                await safeClick(page, uploadMenuBtn, { bias: 'button' });
                await sleep(300, 500);

                // 点击上传文件选项
                const uploadItem = page.locator('div[data-testid="upload_file_panel_upload_item"][role="menuitem"]');
                await uploadFilesViaChooser(page, uploadItem, imgPaths, {
                    uploadValidator: (response) => {
                        if (response.status() !== 200 || response.request().method() !== 'POST') return false;
                        const url = response.url();
                        for (const path of expectedUploadPaths) {
                            if (url.includes(path)) return true;
                        }
                        return false;
                    }
                }, meta);
            } finally {
                page.off('response', applyUploadHandler);
            }

            logger.info('适配器', '图片上传完成', meta);
        }

        // 3. 选择模型
        progress.mark('switch_mode', 38, isSuperMode ? '切换超能模式' : '切换文本模式');
        logger.debug('适配器', `尝试切换文本模式: ${modelId || 'seed'}`, meta);
        if (isSuperMode) {
            await switchSuperMode(page, meta);
        } else {
            await switchTextMode(page, modelId, meta);
        }

        // 4. 填写提示词
        progress.mark('input_prompt', 46, '填写提示词');
        let sendReady = false;
        const fastFilled = await fastSetPrompt(inputLocator, prompt, meta);
        if (fastFilled) {
            await triggerSendButtonByHumanTouch(page, inputLocator, meta);
            sendReady = await isSendButtonEnabled(page);
        }
        if (!sendReady) {
            await clearPromptInput(inputLocator);
            await safeClick(page, inputLocator, { bias: 'input', ...FAST_CLICK_OPTIONS });
            await humanType(page, inputLocator, prompt);
            sendReady = await isSendButtonEnabled(page);
        }
        if (!sendReady) {
            return buildProgressError('提示词已填写，但发送按钮未激活', progress, {
                stage: 'input_prompt',
                progress: 50,
                situation: '发送按钮未激活',
                retryable: true
            });
        }

        let resultText = '';
        let reasoningText = '';
        let deliveryUrls = [];

        // 6. 点击发送
        progress.mark('submit', 52, '发送请求');
        const sendBtn = page.locator('button[data-testid="chat_input_send_button"]');
        await sendBtn.waitFor({ state: 'visible', timeout: 10000 });
        logger.info('适配器', '点击发送...', meta);
        await safeClick(page, sendBtn, { bias: 'button', ...FAST_CLICK_OPTIONS });

        // 7. 等待响应
        if (isSuperMode) {
            progress.mark('wait_super_mode', 58, '等待超能任务执行');
            logger.info('适配器', `等待超能模式任务完成 (timeout=${Math.round(waitTimeout / 1000)}s)...`, meta);

            const superResult = await waitForSuperModeResult(page, waitTimeout, meta, progress);
            if (superResult.authRequired) {
                return buildAuthRequiredError(progress, 'quota_limit_super_mode');
            }

            const latest = superResult.latest || { text: '', deliveries: [], statusHints: [] };
            resultText = latest.text || '';
            deliveryUrls = Array.isArray(latest.deliveries) ? latest.deliveries : [];

            // 左右分栏场景下，尝试从右侧详情页抓取下载动作产生的交付线索
            if (superResult.done && latest.layoutMode === 'split') {
                progress.mark('collect_delivery', 94, '采集右侧结果文件交付信息');
                const rightDownloads = await tryCaptureRightPaneDownload(page, meta);
                if (rightDownloads.length > 0) {
                    deliveryUrls = Array.from(new Set([...deliveryUrls, ...rightDownloads]));
                }
            }

            if (!superResult.done && superResult.timeout) {
                if (resultText || deliveryUrls.length > 0) {
                    logger.warn('适配器', '超能模式等待超时，返回已获取的部分结果', meta);
                } else {
                    return buildProgressError(`超能模式等待超时 (${Math.round(waitTimeout / 1000)}秒)，未提取到可用结果`, progress, {
                        stage: 'wait_super_mode',
                        progress: 92,
                        situation: '等待超能任务超时',
                        retryable: true,
                        details: { statusHints: latest.statusHints || [] }
                    });
                }
            }
        } else {
            // 普通文本模式继续使用 SSE 解析
            logger.debug('适配器', '启动 SSE 监听...', meta);
            let isResolved = false;

            const resultPromise = new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    if (!isResolved) {
                        isResolved = true;
                        reject(new Error(`API_TIMEOUT: 响应超时 (${Math.round(waitTimeout / 1000)}秒)`));
                    }
                }, waitTimeout);

                const handleResponse = async (response) => {
                    try {
                        const url = response.url();
                        if (!url.includes('chat/completion')) return;

                        const contentType = response.headers()['content-type'] || '';
                        if (!contentType.includes('text/event-stream')) return;

                        const body = await response.text();
                        const result = parseSSEResponse(body, {
                            useThinking,
                            collectDelivery: false
                        });

                        if (result.text) {
                            resultText = result.text;
                            reasoningText = result.reasoning || '';

                            if (!isResolved) {
                                isResolved = true;
                                clearTimeout(timeoutId);
                                page.off('response', handleResponse);
                                resolve();
                            }
                        }
                    } catch {
                        // ignore
                    }
                };

                page.on('response', handleResponse);
            });

            logger.info('适配器', '等待生成结果...', meta);
            await resultPromise;
        }

        if (resultText || (isSuperMode && deliveryUrls.length > 0)) {
            if (isSuperMode) {
                progress.mark('assemble_result', 96, '整理任务结果与交付文件');
                resultText = buildSuperModeText(resultText, deliveryUrls);
            }
            logger.info('适配器', `生成完成，文本长度: ${resultText.length}`, meta);
            const result = { text: resultText };
            if (reasoningText) {
                result.reasoning = reasoningText;
            }
            return withProgress(result, progress, {
                status: 'success',
                stage: 'completed',
                progress: 100,
                situation: '任务完成'
            });
        } else {
            return buildProgressError('未能从响应中提取文本', progress, {
                stage: 'parse_response',
                progress: 92,
                situation: '未提取到结果文本',
                retryable: false
            });
        }

    } catch (err) {
        if (await detectLoginLimit(page)) {
            return buildAuthRequiredError(progress, 'quota_limit_error');
        }

        const pageError = normalizePageError(err, meta);
        if (pageError) {
            return withProgress(pageError, progress, {
                status: 'failed',
                stage: progress.snapshot().stage || 'failed',
                progress: progress.snapshot().progress,
                situation: progress.snapshot().situation
            });
        }

        logger.error('适配器', '生成任务失败', { ...meta, error: err.message });
        return buildProgressError(`生成任务失败: ${err.message}`, progress, {
            retryable: false
        });
    } finally { }
}

/**
 * 解析 SSE 响应体，提取最终文本
 * @param {string} body - SSE 响应体
 * @param {{useThinking?: boolean, collectDelivery?: boolean}} [options]
 * @returns {{text: string, reasoning?: string, deliveries?: string[]}}
 */
function parseSSEResponse(body, options = {}) {
    const useThinking = !!options.useThinking;
    const collectDelivery = !!options.collectDelivery;
    const lines = body.split('\n');
    let resultText = '';
    let reasoningText = '';
    let inThinkingBlock = false;
    let thinkingBlockId = null;
    const deliveries = [];
    const seenDelivery = new Set();

    const collectDeliveries = (data) => {
        if (!collectDelivery) return;
        const urls = [];
        collectUrlsFromAny(data, urls, seenDelivery);
        for (const u of urls) deliveries.push(u);
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // 解析事件类型
        if (line.startsWith('event:')) {
            const eventType = line.substring(6).trim();

            // 找到对应的 data 行
            if (i + 1 < lines.length && lines[i + 1].startsWith('data:')) {
                const dataLine = lines[i + 1].substring(5).trim();
                if (!dataLine || dataLine === '{}') continue;

                try {
                    const data = JSON.parse(dataLine);
                    collectDeliveries(data);

                    // SSE_REPLY_END with end_type: 1 的 brief 仅作兜底
                    if (eventType === 'SSE_REPLY_END' && data.end_type === 1) {
                        const brief = data.msg_finish_attr?.brief || '';
                        if (!resultText && brief) {
                            resultText = brief;
                        }
                    }

                    // STREAM_MSG_NOTIFY 检测深度思考块
                    if (eventType === 'STREAM_MSG_NOTIFY') {
                        const blocks = data.content?.content_block || [];
                        for (const block of blocks) {
                            if (block.block_type === 10040 && block.content?.thinking_block) {
                                inThinkingBlock = true;
                                thinkingBlockId = block.block_id;
                            }
                        }
                    }

                    // STREAM_CHUNK 处理内容块
                    if (eventType === 'STREAM_CHUNK' && data.patch_op) {
                        for (const op of data.patch_op) {
                            if (op.patch_object === 1 && op.patch_value?.content_block) {
                                for (const block of op.patch_value.content_block) {
                                    // 思考块结束标记
                                    if (block.block_type === 10040 && block.is_finish) {
                                        inThinkingBlock = false;
                                    }
                                    // 思考内容 (parent_id 指向 thinking_block)
                                    if (useThinking && block.parent_id === thinkingBlockId) {
                                        const text = block.content?.text_block?.text || '';
                                        if (text) reasoningText += text;
                                    }
                                    // 正文内容 (block_type 10000，非思考子块)
                                    else if (block.block_type === 10000 && block.parent_id !== thinkingBlockId) {
                                        const text = block.content?.text_block?.text || '';
                                        if (text) resultText += text;
                                    }
                                }
                            }
                        }
                    }

                    // CHUNK_DELTA 增量文本
                    if (eventType === 'CHUNK_DELTA') {
                        const text = data.text || '';
                        if (text) {
                            if (useThinking && inThinkingBlock) {
                                reasoningText += text;
                            } else {
                                resultText += text;
                            }
                        }
                    }

                } catch (e) {
                    // JSON 解析失败，跳过
                }
            }
        }
    }

    return { text: resultText, reasoning: reasoningText, deliveries };
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'doubao_text',
    displayName: '豆包 (文本生成)',
    description: '使用字节跳动豆包生成文本，支持快速/思考/专家/超能模式和图片上传。需要已登录的豆包账户。',

    getTargetUrl(config, workerConfig) {
        return TARGET_URL;
    },

    models: [
        { id: 'seed', imagePolicy: 'optional', type: 'text' },
        { id: 'seed-thinking', imagePolicy: 'optional', type: 'text' },
        { id: 'seed-pro', imagePolicy: 'optional', type: 'text' },
        { id: 'seed-super', imagePolicy: 'optional', type: 'text' },
        { id: 'seed-agent', imagePolicy: 'optional', type: 'text' }
    ],

    navigationHandlers: [],

    generate
};
