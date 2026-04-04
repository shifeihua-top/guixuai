/**
 * @fileoverview 豆包 (Doubao) 图片生成适配器
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
    gotoWithCheck,
    useContextDownload
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';
import { ADAPTER_ERRORS } from '../../server/errors.js';

// --- 配置常量 ---
const TARGET_URL = 'https://www.doubao.com/chat/';
const TARGET_CREATE_IMAGE_URL = 'https://www.doubao.com/chat/create-image';
const DEFAULT_IMAGE_WAIT_TIMEOUT_MS = 300000;
const FALLBACK_PAGE_WAIT_TIMEOUT_MS = 25000;
const LOGIN_LIMIT_TEXT_RE = /未登录时仅能发起\s*5\s*个新对话.*请登录以解锁该限制/i;

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveModelConfig(modelId) {
    if (!modelId) {
        return { error: '缺少模型 ID' };
    }
    const model = manifest.models.find(m => m.id === modelId);
    if (!model) {
        return { error: `不支持的模型: ${modelId}` };
    }
    return { model };
}

function resolveImageWaitTimeoutMs(config) {
    const poolWaitTimeout = Number(config?.backend?.pool?.waitTimeout);
    const adapterWaitTimeout = Number(config?.backend?.adapter?.doubao?.imageTimeoutMs);

    if (Number.isFinite(adapterWaitTimeout) && adapterWaitTimeout > 0) {
        return Math.round(adapterWaitTimeout);
    }

    const baseWaitTimeout = (Number.isFinite(poolWaitTimeout) && poolWaitTimeout > 0)
        ? Math.round(poolWaitTimeout)
        : 120000;

    return Math.max(baseWaitTimeout, DEFAULT_IMAGE_WAIT_TIMEOUT_MS);
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
            logger.debug('适配器', `[进度] ${state.progress}% ${state.situation}`, meta);
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

async function isVisible(locator, timeout = 1500) {
    try {
        await locator.first().waitFor({ state: 'visible', timeout });
        return true;
    } catch {
        return false;
    }
}

async function findFirstVisible(candidates, timeout = 3000) {
    for (const candidate of candidates) {
        const target = candidate.first ? candidate.first() : candidate;
        if (await isVisible(target, timeout)) return target;
    }
    return null;
}

async function clickWithFallback(page, locator, meta = {}, label = '元素') {
    const target = locator.first ? locator.first() : locator;

    try {
        await safeClick(page, target, { bias: 'button' });
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

async function detectLoginLimit(page) {
    try {
        const text = await page.locator('body').innerText({ timeout: 1500 });
        return LOGIN_LIMIT_TEXT_RE.test(text);
    } catch {
        return false;
    }
}

async function detectNoCutoutBackground(page) {
    try {
        const text = await page.locator('body').innerText({ timeout: 1500 });
        if (/未识别到可去除|没有可去除|未检测到主体|无法抠图|未识别到主体|no removable background/i.test(text)) {
            return true;
        }
    } catch { }
    return false;
}

async function waitForDownloadOrNoBackground(page, timeoutMs = 180000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const downloadBtn = await findFirstVisible([
            page.getByRole('button', { name: /下载原图|download/i }),
            page.getByText(/下载原图|download/i)
        ], 1200);
        if (downloadBtn) return { downloadBtn };

        if (await detectNoCutoutBackground(page)) {
            return { noBackground: true };
        }

        await sleep(800, 1300);
    }
    return { timeout: true };
}

async function enterImageMode(page, meta = {}) {
    const modelBtn = page.locator('button[data-testid="image-creation-chat-input-picture-model-button"]');

    // 已在图片生成模式时直接返回
    if (await isVisible(modelBtn, 2000)) return;

    const skillCandidates = [
        page.locator('button[data-testid="skill_bar_button_3"]'),
        page.locator('button[data-testid^="skill_bar_button_"]').filter({ hasText: /图片|图像|生图|Image/i }),
        page.getByRole('button', { name: /图片|图像|生图|Image/i })
    ];

    for (const candidate of skillCandidates) {
        if (!(await isVisible(candidate, 3500))) continue;
        try {
            await safeClick(page, candidate.first(), { bias: 'button' });
            await sleep(200, 400);
            if (await isVisible(modelBtn, 3500)) return;
        } catch {
            // 尝试下一个候选入口
        }
    }

    logger.warn('适配器', '未找到稳定的图片模式入口，尝试继续执行', meta);
}

async function extractMainImage(page) {
    return await page.evaluate(async () => {
        const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width < 80 || rect.height < 80) return false;
            if (rect.bottom <= 0 || rect.right <= 0) return false;
            if (rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
            return true;
        };

        const imgs = Array.from(document.querySelectorAll('img')).filter(isVisible);
        if (!imgs.length) return null;

        imgs.sort((a, b) => {
            const aScore = (a.naturalWidth || 0) * (a.naturalHeight || 0);
            const bScore = (b.naturalWidth || 0) * (b.naturalHeight || 0);
            return bScore - aScore;
        });

        const src = imgs[0].currentSrc || imgs[0].src || '';
        if (!src) return null;

        if (src.startsWith('data:image/')) return { dataUrl: src };

        if (src.startsWith('blob:')) {
            try {
                const resp = await fetch(src);
                const blob = await resp.blob();
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error || new Error('读取 blob 失败'));
                    reader.readAsDataURL(blob);
                });
                if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
                    return { dataUrl };
                }
            } catch {
                return null;
            }
        }

        return { url: src };
    });
}

async function extractGeneratedImageCandidates(page) {
    return await page.evaluate(async () => {
        const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width < 100 || rect.height < 100) return false;
            if (rect.bottom <= 0 || rect.right <= 0) return false;
            if (rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
            return true;
        };

        const all = Array.from(document.querySelectorAll('img')).filter(isVisible);
        if (!all.length) return [];

        const enriched = all.map((img) => {
            const rect = img.getBoundingClientRect();
            const src = img.currentSrc || img.src || '';
            return {
                src,
                area: (img.naturalWidth || rect.width || 0) * (img.naturalHeight || rect.height || 0),
                width: img.naturalWidth || rect.width || 0,
                height: img.naturalHeight || rect.height || 0
            };
        }).filter(x => !!x.src);

        // 优先保留较大、疑似生成结果的图片
        enriched.sort((a, b) => b.area - a.area);

        const seen = new Set();
        const picked = [];

        for (const item of enriched) {
            if (seen.has(item.src)) continue;
            seen.add(item.src);
            picked.push(item);
            if (picked.length >= 8) break;
        }

        const converted = [];
        for (const item of picked) {
            let src = item.src;
            if (src.startsWith('blob:')) {
                try {
                    const resp = await fetch(src);
                    const blob = await resp.blob();
                    src = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = () => reject(reader.error || new Error('读取 blob 失败'));
                        reader.readAsDataURL(blob);
                    });
                } catch {
                    continue;
                }
            }
            converted.push(src);
        }

        return converted;
    });
}

async function waitForGeneratedImageCandidates(page, timeoutMs, meta = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const candidates = await extractGeneratedImageCandidates(page);
        if (Array.isArray(candidates) && candidates.length > 0) {
            logger.info('适配器', `页面兜底提取到 ${candidates.length} 个候选图片`, meta);
            return candidates;
        }
        await sleep(600, 900);
    }
    return [];
}

async function downloadImageCandidates(candidates, page, config, meta = {}) {
    const imgDlCfg = config?.backend?.pool?.failover || {};
    const downloaded = [];

    for (const candidate of candidates) {
        // data:image 直接收下
        if (typeof candidate === 'string' && candidate.startsWith('data:image/')) {
            downloaded.push({ image: candidate, imageUrl: null });
            continue;
        }

        const result = await useContextDownload(candidate, page, {
            retries: imgDlCfg.imgDlRetry ? (imgDlCfg.imgDlRetryMaxRetries || 2) : 0
        });
        if (result?.error) {
            logger.warn('适配器', `候选图片下载失败，继续尝试下一个: ${result.error}`, meta);
            continue;
        }
        downloaded.push({ image: result.image, imageUrl: result.imageUrl || candidate });
    }

    return downloaded;
}

async function generateCutout(context, imgPaths, meta = {}) {
    const { page, config } = context;
    if (!imgPaths || imgPaths.length === 0) {
        return { error: 'AI抠图需要至少 1 张参考图' };
    }

    try {
        logger.info('适配器', '进入 AI 创作页面 (抠图模式)...', meta);
        await gotoWithCheck(page, TARGET_CREATE_IMAGE_URL);

        const cutoutEntryCandidates = [
            page.getByRole('button', { name: /AI\s*抠图|AI\s*cutout/i }),
            page.locator('button:has-text("AI抠图"), div[role="button"]:has-text("AI抠图")'),
            page.getByText(/AI\s*抠图|AI\s*cutout/i)
        ];

        let cutoutEntry = await findFirstVisible(cutoutEntryCandidates, 5000);

        // 某些会话会先落在普通聊天页，尝试回到 AI 创作页再找入口
        if (!cutoutEntry) {
            await gotoWithCheck(page, TARGET_URL);
            const aiCreateEntry = await findFirstVisible([
                page.getByRole('link', { name: /AI创作|AI\s*创作/i }),
                page.getByText(/AI创作|AI\s*创作/i)
            ], 5000);
            if (aiCreateEntry) {
                await clickWithFallback(page, aiCreateEntry, meta, 'AI创作入口');
                await sleep(600, 1000);
            }
            cutoutEntry = await findFirstVisible(cutoutEntryCandidates, 6000);
        }

        // 兜底：走“参考图上传 + 抠图动作”
        let uploaded = false;
        if (cutoutEntry) {
            try {
                logger.info('适配器', '上传参考图并进入抠图编辑页...', meta);
                await uploadFilesViaChooser(page, cutoutEntry, [imgPaths[0]], {
                    fileChooserTimeout: 12000
                }, meta);
                uploaded = true;
            } catch (e) {
                const msg = e?.message || '';
                const isChooserTimeout = e?.code === 'UPLOAD_FILECHOOSER_TIMEOUT' || /filechooser|文件选择器|Timeout/i.test(msg);
                if (!isChooserTimeout) throw e;
                logger.warn('适配器', 'AI抠图入口未触发文件选择器，尝试参考图兜底流程', meta);
            }
        }

        if (!uploaded) {
            const refBtn = await findFirstVisible([
                page.getByRole('button', { name: /参考图|上传|upload|reference/i }),
                page.getByText(/参考图|上传|upload|reference/i)
            ], 6000);
            if (!refBtn) {
                return { error: '未找到 AI抠图 入口（也未找到参考图上传按钮）' };
            }
            logger.info('适配器', '通过参考图按钮上传图片...', meta);
            await uploadFilesViaChooser(page, refBtn, [imgPaths[0]], {
                fileChooserTimeout: 12000
            }, meta);
        }

        // 上传后可能直接进入结果页（已出现“下载原图”），无需再点“抠出主体”
        let downloadBtn = await findFirstVisible([
            page.getByRole('button', { name: /下载原图|download/i }),
            page.getByText(/下载原图|download/i)
        ], 5000);

        if (!downloadBtn) {
            // 只允许点击“抠出主体”明确按钮，避免误触画布进入“擦除”模式
            const cutoutBtn = await findFirstVisible([
                page.getByRole('button', { name: /抠出主体|extract/i }),
                page.locator('button:has-text("抠出主体"), div[role="button"]:has-text("抠出主体")')
            ], 120000);

            if (!cutoutBtn) {
                if (await detectNoCutoutBackground(page)) {
                    return { error: '未识别到可去除的背景，无法执行抠图' };
                }
                return { error: '上传成功，但未找到“抠出主体”按钮（且未检测到结果页下载按钮）' };
            }
            const clickedCutout = await clickWithFallback(page, cutoutBtn, meta, '抠出主体按钮');
            if (!clickedCutout) {
                return { error: '找到“抠出主体”按钮但无法点击' };
            }
        }

        logger.info('适配器', '等待抠图结果...', meta);
        const waitResult = await waitForDownloadOrNoBackground(page, 180000);
        if (waitResult.noBackground) {
            return { error: '未识别到可去除的背景，无法执行抠图' };
        }
        if (waitResult.timeout || !waitResult.downloadBtn) {
            return { error: '抠图完成等待超时：未找到“下载原图”按钮' };
        }
        downloadBtn = waitResult.downloadBtn;
        await sleep(500, 900);

        const extracted = await extractMainImage(page);
        if (!extracted) {
            return { error: '抠图完成，但未能提取结果图片' };
        }

        if (extracted.dataUrl) {
            return { image: extracted.dataUrl };
        }

        if (!extracted.url) {
            return { error: '抠图完成，但结果图片链接为空' };
        }

        const imgDlCfg = config?.backend?.pool?.failover || {};
        const downloadResult = await useContextDownload(extracted.url, page, {
            retries: imgDlCfg.imgDlRetry ? (imgDlCfg.imgDlRetryMaxRetries || 2) : 0
        });
        if (downloadResult.error) return downloadResult;
        return { image: downloadResult.image };
    } catch (err) {
        return { error: `AI抠图失败: ${err.message}` };
    }
}

/**
 * 执行图片生成任务
 * @param {object} context - 浏览器上下文 { page, config }
 * @param {string} prompt - 提示词
 * @param {string[]} imgPaths - 图片路径数组
 * @param {string} [modelId] - 模型 ID
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<{image?: string, error?: string}>}
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page, config } = context;
    const imageWaitTimeoutMs = resolveImageWaitTimeoutMs(config);
    const progress = createProgressTracker(meta);
    progress.mark('prepare', 2, '准备任务');

    if (modelId === 'ai-cutout') {
        return await generateCutout(context, imgPaths, meta);
    }

    // 获取模型配置
    const modelConfigResult = resolveModelConfig(modelId);
    if (modelConfigResult.error) {
        return buildProgressError(modelConfigResult.error, progress, {
            stage: 'validate_model',
            progress: 4,
            situation: '模型校验失败',
            retryable: false
        });
    }
    const { codeName } = modelConfigResult.model;

    try {
        progress.mark('open_chat_page', 10, '进入豆包页面');
        logger.info('适配器', '开启新会话...', meta);
        await gotoWithCheck(page, TARGET_URL);

        progress.mark('check_auth_limit', 16, '检测账号可用性');
        if (await detectLoginLimit(page)) {
            return buildAuthRequiredError(progress, 'quota_limit_before_generate');
        }

        // 1. 进入图片生成模式
        progress.mark('enter_image_mode', 28, '进入图片生成模式');
        logger.debug('适配器', '进入图片生成模式...', meta);
        await enterImageMode(page, meta);

        // 2. 选择模型
        progress.mark('select_model', 38, '选择模型');
        logger.debug('适配器', `选择模型: ${codeName}...`, meta);
        const modelBtn = page.locator('button[data-testid="image-creation-chat-input-picture-model-button"]');
        await modelBtn.waitFor({ state: 'visible', timeout: 10000 });
        await safeClick(page, modelBtn, { bias: 'button' });
        await sleep(300, 500);

        const modelPattern = new RegExp(escapeRegExp(codeName), 'i');
        const modelOption = page.getByRole('menuitem', { name: modelPattern });
        await modelOption.waitFor({ state: 'visible', timeout: 10000 });
        await safeClick(page, modelOption, { bias: 'button' });

        // 3. 上传参考图片 (如果有)
        if (imgPaths && imgPaths.length > 0) {
            progress.mark('upload_images', 48, `上传参考图 (${imgPaths.length} 张)`);
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
                const uploadBtn = page.locator('button[data-testid="image-creation-chat-input-picture-reference-button"]');
                await uploadBtn.waitFor({ state: 'visible', timeout: 10000 });

                await uploadFilesViaChooser(page, uploadBtn, imgPaths, {
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

        // 4. 填写提示词
        progress.mark('input_prompt', 60, '填写提示词');
        const inputLocator = page.locator('div[data-testid="chat_input_input"][role="textbox"], textarea[data-testid="chat_input_input"]');
        await waitForInput(page, inputLocator, { click: true });
        await humanType(page, inputLocator, prompt);

        // 5. 设置 SSE 监听
        progress.mark('listen_sse', 68, '等待生成响应');
        logger.debug('适配器', '启动 SSE 监听...', meta);

        let imageUrls = [];
        let isResolved = false;

        const resultPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    reject(new Error(`API_TIMEOUT: 响应超时 (${Math.round(imageWaitTimeoutMs / 1000)}秒)`));
                }
            }, imageWaitTimeoutMs);

            const handleResponse = async (response) => {
                try {
                    const url = response.url();
                    if (!url.includes('completion')) return;
                    const body = await response.text();
                    const extractedUrls = parseResponseForImageUrls(body);

                    if (extractedUrls.length > 0) {
                        imageUrls = Array.from(new Set([...imageUrls, ...extractedUrls]));
                        if (!isResolved) {
                            isResolved = true;
                            clearTimeout(timeout);
                            page.off('response', handleResponse);
                            resolve();
                        }
                    }
                } catch (e) {
                    // 忽略解析错误
                }
            };

            page.on('response', handleResponse);
        });

        // 6. 点击发送
        const sendBtn = page.locator('button[data-testid="chat_input_send_button"]');
        await sendBtn.waitFor({ state: 'visible', timeout: 10000 });
        logger.info('适配器', '点击发送...', meta);
        await safeClick(page, sendBtn, { bias: 'button' });

        // 7. 等待响应
        progress.mark('wait_generation', 78, '等待图片生成');
        logger.info('适配器', '等待图片生成...', meta);
        try {
            await resultPromise;
        } catch (e) {
            if (!e?.message?.startsWith('API_TIMEOUT:')) throw e;

            if (await detectLoginLimit(page)) {
                return buildAuthRequiredError(progress, 'quota_limit_after_send');
            }

            logger.warn('适配器', 'SSE 等待超时，尝试页面结果兜底提取...', meta);
            const fallbackCandidates = await waitForGeneratedImageCandidates(page, FALLBACK_PAGE_WAIT_TIMEOUT_MS, meta);
            if (fallbackCandidates.length > 0) {
                imageUrls = Array.from(new Set([...imageUrls, ...fallbackCandidates]));
            }
            if (imageUrls.length === 0) throw e;
        }

        if (imageUrls.length === 0) {
            return buildProgressError('未能从响应中提取图片链接', progress, {
                stage: 'parse_response',
                progress: 82,
                situation: '未提取到可用图片链接',
                retryable: false
            });
        }

        progress.mark('download_images', 90, `下载候选图片 (${imageUrls.length} 个)`);
        logger.info('适配器', `已获取 ${imageUrls.length} 个候选链接，开始下载...`, meta);

        // 8. 下载图片（支持多图）
        const downloaded = await downloadImageCandidates(imageUrls, page, config, meta);
        if (downloaded.length === 0) {
            return buildProgressError(`候选图片下载均失败（共 ${imageUrls.length} 个）`, progress, {
                stage: 'download_images',
                progress: 93,
                situation: '图片下载失败',
                retryable: true
            });
        }

        progress.mark('completed', 100, `图片生成完成（${downloaded.length} 张）`);
        logger.info('适配器', `图片生成完成，成功下载 ${downloaded.length} 张`, meta);
        if (downloaded.length === 1) {
            return withProgress({ image: downloaded[0].image, imageUrl: downloaded[0].imageUrl }, progress, {
                status: 'success'
            });
        }

        const markdown = downloaded
            .map((it, idx) => `![image_${idx + 1}](${it.image})`)
            .join('\n\n');

        return withProgress({
            text: markdown,
            image: downloaded[0].image, // 兼容旧客户端（默认第一张）
            imageUrl: downloaded[0].imageUrl,
            images: downloaded.map(it => it.image),
            imageUrls: downloaded.map(it => it.imageUrl).filter(Boolean)
        }, progress, { status: 'success' });

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
 * 解析响应体，提取图片链接（兼容 SSE/JSON）
 * @param {string} body - 响应体
 * @returns {string[]} 图片 URL 列表
 */
function parseResponseForImageUrls(body) {
    if (!body || typeof body !== 'string') return [];

    const urls = new Set();

    // 优先按 SSE 行解析
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('data:')) {
            const dataLine = line.substring(5).trim();
            if (!dataLine || dataLine === '{}') continue;
            try {
                const data = JSON.parse(dataLine);
                for (const url of extractRawImages(data)) {
                    urls.add(url);
                }
            } catch {
                // ignore
            }
        }
    }

    // 回退：直接按 JSON 解析
    if (urls.size === 0) {
        try {
            const data = JSON.parse(body);
            for (const url of extractRawImages(data)) {
                urls.add(url);
            }
        } catch {
            // ignore
        }
    }

    return Array.from(urls);
}

/**
 * 从响应数据中提取原图 Raw 链接（支持多图）
 * @param {Object} payload - 解析后的 JSON 对象
 * @returns {string[]} - 图片 URL 列表
 */
function extractRawImages(payload) {
    if (!payload || !Array.isArray(payload.patch_op)) {
        return [];
    }

    const urls = [];
    const seen = new Set();

    for (const op of payload.patch_op) {
        const contentBlocks = op.patch_value?.content_block;

        if (Array.isArray(contentBlocks)) {
            for (const block of contentBlocks) {
                // block_type 2074 代表生成卡片
                if (block.block_type === 2074) {
                    const creations = block.content?.creation_block?.creations;

                    if (Array.isArray(creations)) {
                        for (const creation of creations) {
                            const candidates = [
                                // 优先顺序：原图 raw > 其他降级链接
                                creation.image?.image_ori_raw?.url,
                                creation.image?.image_raw?.url,
                                creation.image?.image_ori?.url,
                                creation.image?.url,
                                creation.image_url,
                                creation?.url
                            ];

                            const validCandidates = candidates.filter(u => {
                                if (typeof u !== 'string') return false;
                                return /^https?:\/\//i.test(u);
                            });

                            if (validCandidates.length === 0) continue;

                            // 避免同一张图同时返回「原图+带水印图」
                            const nonWatermark = validCandidates.find(u => !/(watermark|water_mark|add_logo|wm=|logo=)/i.test(u));
                            const picked = nonWatermark || validCandidates[0];

                            if (!picked || seen.has(picked)) continue;
                            seen.add(picked);
                            urls.push(picked);
                        }
                    }
                }
            }
        }
    }

    return urls;
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'doubao',
    displayName: '豆包 (图片生成)',
    description: '使用字节跳动豆包生成图片，支持多种模型和参考图片上传。需要已登录的豆包账户。',

    getTargetUrl(config, workerConfig) {
        return TARGET_URL;
    },

    models: [
        { id: 'ai-cutout', codeName: 'AI抠图', imagePolicy: 'required' },
        { id: 'seedream5.0Lite', codeName: 'Seedream 5.0 Lite', imagePolicy: 'optional' },
        { id: 'seedream-5.0-lite', codeName: 'Seedream 5.0 Lite', imagePolicy: 'optional' },
        { id: 'seedream-4.5', codeName: 'Seedream 4.5', imagePolicy: 'optional' },
        { id: 'seedream-4.0', codeName: 'Seedream 4.0', imagePolicy: 'optional' },
        { id: 'seedream-3.0', codeName: 'Seedream 3.0', imagePolicy: 'optional' }
    ],

    navigationHandlers: [],

    generate
};
