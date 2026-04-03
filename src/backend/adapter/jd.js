/**
 * @fileoverview 京东商品详情采集适配器
 * @description 通过已登录浏览器会话采集商品详情字段（名称、价格、规格参数、主图、详情图）
 */

import { sleep, random } from '../engine/utils.js';
import {
    normalizePageError,
    gotoWithCheck
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';

const TARGET_URL = 'https://www.jd.com/';

// 集中模式串行队列（防止同进程内并发抓取触发风控）
let serialTail = Promise.resolve();
// 频率控制全局时间戳（同进程内生效）
let lastDispatchAt = 0;
// 保活状态（按 page 维度）
const keepAliveState = new WeakMap();

function runSerialized(taskFn) {
    const run = serialTail.then(() => taskFn());
    serialTail = run.catch(() => { });
    return run;
}

function toNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, min, max, fallback) {
    const n = Math.round(toNumber(value, fallback));
    return Math.max(min, Math.min(max, n));
}

function getAdapterConfig(config) {
    const cfg = config?.backend?.adapter?.jd || {};
    const rateLimit = cfg.rateLimit || {};
    const keepAlive = cfg.keepAlive || {};
    const concentratedMode = cfg.concentratedMode || {};
    const collect = cfg.collect || {};

    return {
        concentratedMode: {
            enabled: concentratedMode.enabled !== false
        },
        rateLimit: {
            minIntervalMs: clampInt(rateLimit.minIntervalMs, 0, 10 * 60 * 1000, 6000),
            jitterMs: clampInt(rateLimit.jitterMs, 0, 2 * 60 * 1000, 2000)
        },
        keepAlive: {
            enabled: keepAlive.enabled === true,
            intervalMs: clampInt(keepAlive.intervalMs, 60 * 1000, 24 * 60 * 60 * 1000, 15 * 60 * 1000),
            jitterMs: clampInt(keepAlive.jitterMs, 0, 10 * 60 * 1000, 60 * 1000),
            targetUrl: typeof keepAlive.targetUrl === 'string' && keepAlive.targetUrl
                ? keepAlive.targetUrl
                : TARGET_URL
        },
        collect: {
            detailScrollRounds: clampInt(collect.detailScrollRounds, 1, 40, 10),
            detailImageLimit: clampInt(collect.detailImageLimit, 1, 200, 80),
            mainImageLimit: clampInt(collect.mainImageLimit, 1, 30, 10)
        }
    };
}

function extractFirstUrl(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.match(/https?:\/\/[^\s"'<>]+/i);
    return match ? match[0] : null;
}

function tryParseJsonPayload(prompt) {
    if (!prompt || typeof prompt !== 'string') return null;
    const trimmed = prompt.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

function normalizeJdUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    let url;
    try {
        url = new URL(rawUrl.trim());
    } catch {
        return null;
    }

    const host = url.hostname.toLowerCase();
    const allow =
        host.endsWith('jd.com') ||
        host.endsWith('3.cn');

    if (!allow) return null;

    if (host === 'item.m.jd.com') {
        const skuMatch = url.pathname.match(/\/product\/(\d+)\.html/i);
        if (skuMatch) {
            return `https://item.jd.com/${skuMatch[1]}.html`;
        }
    }

    return url.toString();
}

function buildTaskInput(prompt, adapterCfg) {
    const obj = tryParseJsonPayload(prompt);

    let url = null;
    let detailImageLimit = adapterCfg.collect.detailImageLimit;
    let mainImageLimit = adapterCfg.collect.mainImageLimit;
    let detailScrollRounds = adapterCfg.collect.detailScrollRounds;

    if (obj && typeof obj === 'object') {
        if (typeof obj.url === 'string') {
            url = obj.url;
        }
        if (obj.detailImageLimit !== undefined) {
            detailImageLimit = clampInt(obj.detailImageLimit, 1, 200, detailImageLimit);
        }
        if (obj.mainImageLimit !== undefined) {
            mainImageLimit = clampInt(obj.mainImageLimit, 1, 30, mainImageLimit);
        }
        if (obj.detailScrollRounds !== undefined) {
            detailScrollRounds = clampInt(obj.detailScrollRounds, 1, 40, detailScrollRounds);
        }
    }

    if (!url) {
        url = extractFirstUrl(prompt);
    }

    const normalized = normalizeJdUrl(url);
    if (!normalized) {
        return { error: '未检测到有效京东商品链接（需 jd.com / 3.cn 链接）' };
    }

    return {
        url: normalized,
        detailImageLimit,
        mainImageLimit,
        detailScrollRounds
    };
}

async function applyRateLimit(adapterCfg, meta = {}) {
    const now = Date.now();
    const minInterval = adapterCfg.rateLimit.minIntervalMs;
    const jitterMs = adapterCfg.rateLimit.jitterMs;

    const elapsed = now - lastDispatchAt;
    if (elapsed < minInterval) {
        const waitBase = minInterval - elapsed;
        const waitJitter = jitterMs > 0 ? Math.floor(random(0, jitterMs)) : 0;
        const waitMs = waitBase + waitJitter;
        logger.info('适配器', `京东采集频率控制生效，等待 ${waitMs}ms`, meta);
        await sleep(waitMs, waitMs + 80);
    }

    lastDispatchAt = Date.now();
}

async function maybeClickTab(page, patterns, timeout = 3500) {
    for (const pattern of patterns) {
        const byRole = page.getByRole('link', { name: pattern }).first();
        try {
            await byRole.waitFor({ state: 'visible', timeout });
            await byRole.click({ timeout: 2000, force: true });
            return true;
        } catch { }

        const byButton = page.getByRole('button', { name: pattern }).first();
        try {
            await byButton.waitFor({ state: 'visible', timeout });
            await byButton.click({ timeout: 2000, force: true });
            return true;
        } catch { }

        const byText = page.getByText(pattern).first();
        try {
            await byText.waitFor({ state: 'visible', timeout });
            await byText.click({ timeout: 2000, force: true });
            return true;
        } catch { }
    }
    return false;
}

async function humanLikeScroll(page, rounds) {
    for (let i = 0; i < rounds; i++) {
        const delta = Math.floor(random(650, 1500));
        await page.mouse.wheel(0, delta);
        await sleep(280, 760);
    }
}

function buildResponseText(payload) {
    return JSON.stringify(payload, null, 2);
}

async function extractProductData(page, options) {
    return await page.evaluate((opts) => {
        const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();
        const toAbs = (raw) => {
            if (!raw || typeof raw !== 'string') return null;
            const v = raw.trim();
            if (!v || v.startsWith('data:') || v.startsWith('javascript:')) return null;
            if (v.startsWith('//')) return `https:${v}`;
            try {
                return new URL(v, location.href).toString();
            } catch {
                return null;
            }
        };

        const getNodeText = (selectors) => {
            for (const selector of selectors) {
                const node = document.querySelector(selector);
                if (!node) continue;
                const text = clean(node.textContent || '');
                if (text) return text;
            }
            return '';
        };

        const imageUrlFromNode = (node) => {
            if (!node) return null;
            const attrs = [
                'src',
                'data-src',
                'data-lazy-img',
                'data-lazyload',
                'source-data-lazy-img',
                'origin',
                'data-url'
            ];
            for (const attr of attrs) {
                const value = node.getAttribute?.(attr);
                const abs = toAbs(value);
                if (abs) return abs;
            }
            return null;
        };

        const pushUnique = (arr, seen, value, limit) => {
            if (!value || seen.has(value)) return;
            seen.add(value);
            if (arr.length < limit) arr.push(value);
        };

        const mainImages = [];
        const detailImages = [];
        const mainSeen = new Set();
        const detailSeen = new Set();

        const mainSelectors = [
            '#spec-n1 img',
            '#preview img',
            '#spec-list img',
            '.spec-list img',
            '.lh img',
            '.spec-items img',
            '.preview-wrap img',
            '.sku-main img'
        ];
        for (const selector of mainSelectors) {
            const nodes = Array.from(document.querySelectorAll(selector));
            for (const node of nodes) {
                const url = imageUrlFromNode(node);
                pushUnique(mainImages, mainSeen, url, opts.mainImageLimit);
            }
        }

        const detailSelectors = [
            '#J-detail-content img',
            '#detail img',
            '.detail-content img',
            '.J-detail-content img',
            '.ssd-module-wrap img',
            '.detail-item img',
            '.parameter2 img'
        ];
        for (const selector of detailSelectors) {
            const nodes = Array.from(document.querySelectorAll(selector));
            for (const node of nodes) {
                const url = imageUrlFromNode(node);
                pushUnique(detailImages, detailSeen, url, opts.detailImageLimit);
            }
        }

        const specMap = {};
        const pushSpec = (k, v) => {
            const key = clean(k);
            const value = clean(v);
            if (!key || !value) return;
            if (!specMap[key]) specMap[key] = value;
        };

        const tableRows = document.querySelectorAll(
            '#detail .Ptable tr, .Ptable tr, #specifications tr, .parameter2 p, .parameter2 li'
        );
        tableRows.forEach((row) => {
            const th = row.querySelector('th');
            const tds = row.querySelectorAll('td');

            if (th && tds.length > 0) {
                pushSpec(th.textContent, tds[tds.length - 1].textContent);
                return;
            }

            if (tds.length >= 2) {
                pushSpec(tds[0].textContent, tds[1].textContent);
                return;
            }

            const text = clean(row.textContent || '');
            if (!text) return;
            const idx = text.indexOf('：');
            if (idx > 0) {
                pushSpec(text.slice(0, idx), text.slice(idx + 1));
            }
        });

        const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        let ldName = '';
        for (const script of ldScripts) {
            try {
                const json = JSON.parse(script.textContent || '{}');
                const product = Array.isArray(json) ? json.find(i => i?.['@type'] === 'Product') : json;
                if (product?.name && !ldName) ldName = clean(product.name);
                const images = Array.isArray(product?.image) ? product.image : (product?.image ? [product.image] : []);
                for (const item of images) {
                    const url = toAbs(String(item));
                    pushUnique(mainImages, mainSeen, url, opts.mainImageLimit);
                }
            } catch { }
        }

        const name = getNodeText([
            '#name h1',
            '.sku-name',
            '#detail .sku-name',
            '.itemInfo-wrap .sku-name',
            'meta[property="og:title"]'
        ]) || ldName || clean(document.title || '').replace(/【.*?】/g, '');

        let price = getNodeText([
            '.summary-price .price',
            '.summary-price .p-price .price',
            '.p-price .price',
            '#jd-price',
            '[data-sku] .price'
        ]);

        if (!price) {
            const bodyText = clean(document.body?.innerText || '');
            const m = bodyText.match(/¥\s*([0-9]+(?:\.[0-9]{1,2})?)/);
            if (m) price = `¥${m[1]}`;
        } else if (!/¥/.test(price)) {
            const number = price.match(/[0-9]+(?:\.[0-9]{1,2})?/);
            if (number) price = `¥${number[0]}`;
        }

        const specificationList = Object.entries(specMap).map(([key, value]) => ({ key, value }));

        return {
            productName: name || '',
            productPrice: price || '',
            specifications: specificationList,
            specificationsMap: specMap,
            mainImages,
            detailImages,
            currentUrl: location.href
        };
    }, options);
}

async function detectRiskOrBlock(page) {
    try {
        const text = await page.locator('body').innerText({ timeout: 1500 });
        if (/请先登录|账号登录|扫码登录|京东验证|验证中心|安全验证|滑块|验证码/i.test(text)) {
            return true;
        }
    } catch { }
    return false;
}

async function scrapeProduct(context, input, meta = {}) {
    const { page } = context;

    logger.info('适配器', `京东采集开始: ${input.url}`, meta);

    await page.bringToFront().catch(() => { });
    await sleep(300, 780);

    await gotoWithCheck(page, input.url);
    await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => { });
    await sleep(1000, 1800);

    if (await detectRiskOrBlock(page)) {
        return { error: '页面触发登录/风控验证，请先完成京东登录或人工过验证后重试' };
    }

    // 触发一次详情/规格区块激活，帮助懒加载图片和参数
    await maybeClickTab(page, [/商品详情|详情/], 2800).catch(() => { });
    await sleep(280, 600);
    await humanLikeScroll(page, input.detailScrollRounds);
    await maybeClickTab(page, [/规格与包装|规格参数|参数/], 2200).catch(() => { });
    await sleep(400, 900);

    const extracted = await extractProductData(page, {
        detailImageLimit: input.detailImageLimit,
        mainImageLimit: input.mainImageLimit
    });

    // 部分页面第一次滚动后仍未拉起详情图，再尝试少量补采
    if (!extracted.detailImages || extracted.detailImages.length === 0) {
        await maybeClickTab(page, [/商品详情|详情/], 2200).catch(() => { });
        await humanLikeScroll(page, Math.max(3, Math.floor(input.detailScrollRounds / 2)));
        const second = await extractProductData(page, {
            detailImageLimit: input.detailImageLimit,
            mainImageLimit: input.mainImageLimit
        });
        if (second.detailImages?.length > 0) {
            extracted.detailImages = second.detailImages;
        }
        if ((!extracted.specifications || extracted.specifications.length === 0) && second.specifications?.length > 0) {
            extracted.specifications = second.specifications;
            extracted.specificationsMap = second.specificationsMap;
        }
    }

    return {
        text: buildResponseText({
            source: 'jd',
            fetchedAt: new Date().toISOString(),
            productUrl: extracted.currentUrl || input.url,
            productName: extracted.productName || '',
            productPrice: extracted.productPrice || '',
            specifications: extracted.specifications || [],
            mainImages: extracted.mainImages || [],
            detailImages: extracted.detailImages || []
        })
    };
}

async function runGenerate(context, prompt, modelId, meta = {}) {
    const adapterCfg = getAdapterConfig(context?.config);
    const input = buildTaskInput(prompt, adapterCfg);
    if (input.error) {
        return { error: input.error };
    }

    await applyRateLimit(adapterCfg, meta);
    return await scrapeProduct(context, input, meta);
}

/**
 * 执行采集任务
 * @returns {Promise<{text?: string, error?: string}>}
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    try {
        const adapterCfg = getAdapterConfig(context?.config);
        if (adapterCfg.concentratedMode.enabled) {
            return await runSerialized(() => runGenerate(context, prompt, modelId, meta));
        }
        return await runGenerate(context, prompt, modelId, meta);
    } catch (err) {
        const pageError = normalizePageError(err, meta);
        if (pageError) return pageError;
        logger.error('适配器', '京东采集失败', { ...meta, error: err.message });
        return { error: `京东采集失败: ${err.message}` };
    }
}

/**
 * 定时保活（由 Worker 周期调度）
 */
async function keepAlive(context, meta = {}) {
    const { page, config } = context;
    if (!page || page.isClosed?.()) return { skipped: true };

    const adapterCfg = getAdapterConfig(config);
    if (!adapterCfg.keepAlive.enabled) return { skipped: true };

    const state = keepAliveState.get(page) || { lastAt: 0 };
    const now = Date.now();
    const jitter = adapterCfg.keepAlive.jitterMs > 0
        ? Math.floor(random(0, adapterCfg.keepAlive.jitterMs))
        : 0;
    const dueAt = state.lastAt + adapterCfg.keepAlive.intervalMs + jitter;
    if (state.lastAt > 0 && now < dueAt) return { skipped: true };

    keepAliveState.set(page, { lastAt: now });

    try {
        await page.bringToFront().catch(() => { });
        await gotoWithCheck(page, adapterCfg.keepAlive.targetUrl);
        await page.waitForLoadState('domcontentloaded', { timeout: 18000 }).catch(() => { });
        await sleep(800, 1600);
        logger.info('适配器', '京东会话保活完成', meta);
        return { ok: true };
    } catch (err) {
        logger.warn('适配器', `京东会话保活失败: ${err.message}`, meta);
        return { error: err.message };
    }
}

export const manifest = {
    id: 'jd',
    displayName: '京东商品采集',
    description: '登录京东后，按商品链接采集名称、价格、规格参数、主图和详情图。支持定时保活、集中模式和频率控制。',

    getTargetUrl(config, workerConfig) {
        return TARGET_URL;
    },

    models: [
        { id: 'jd-product-detail', codeName: '京东商品详情采集', imagePolicy: 'forbidden', type: 'text' }
    ],

    navigationHandlers: [],
    generate,
    keepAlive
};

