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

// --- 配置常量 ---
const TARGET_URL = 'https://www.doubao.com/chat/';
const TARGET_CREATE_IMAGE_URL = 'https://www.doubao.com/chat/create-image';
const DEFAULT_IMAGE_WAIT_TIMEOUT_MS = 300000;
const FALLBACK_PAGE_WAIT_TIMEOUT_MS = 25000;

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

    if (modelId === 'ai-cutout') {
        return await generateCutout(context, imgPaths, meta);
    }

    // 获取模型配置
    const modelConfig = manifest.models.find(m => m.id === modelId) || manifest.models[0];
    const { codeName } = modelConfig;

    try {
        logger.info('适配器', '开启新会话...', meta);
        await gotoWithCheck(page, TARGET_URL);

        // 1. 进入图片生成模式
        logger.debug('适配器', '进入图片生成模式...', meta);
        await enterImageMode(page, meta);

        // 2. 选择模型
        logger.debug('适配器', `选择模型: ${codeName}...`, meta);
        const modelBtn = page.locator('button[data-testid="image-creation-chat-input-picture-model-button"]');
        await modelBtn.waitFor({ state: 'visible', timeout: 10000 });
        await safeClick(page, modelBtn, { bias: 'button' });
        await sleep(300, 500);

        const modelOption = page.getByRole('menuitem', { name: new RegExp(codeName.replace('.', '\\.'), 'i') });
        await modelOption.waitFor({ state: 'visible', timeout: 5000 });
        await safeClick(page, modelOption, { bias: 'button' });

        // 3. 上传参考图片 (如果有)
        if (imgPaths && imgPaths.length > 0) {
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
        const inputLocator = page.locator('div[data-testid="chat_input_input"][role="textbox"], textarea[data-testid="chat_input_input"]');
        await waitForInput(page, inputLocator, { click: true });
        await humanType(page, inputLocator, prompt);

        // 5. 设置 SSE 监听
        logger.debug('适配器', '启动 SSE 监听...', meta);

        let imageUrl = null;
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

                    const contentType = response.headers()['content-type'] || '';
                    if (!contentType.includes('text/event-stream')) return;

                    const body = await response.text();
                    const extractedUrl = parseSSEForImage(body);

                    if (extractedUrl) {
                        imageUrl = extractedUrl;
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
        logger.info('适配器', '等待图片生成...', meta);
        try {
            await resultPromise;
        } catch (e) {
            if (!e?.message?.startsWith('API_TIMEOUT:')) throw e;

            logger.warn('适配器', 'SSE 等待超时，尝试页面结果兜底提取...', meta);
            const waitResult = await waitForDownloadOrNoBackground(page, FALLBACK_PAGE_WAIT_TIMEOUT_MS);
            if (waitResult.downloadBtn) {
                const extracted = await extractMainImage(page);
                if (extracted?.dataUrl) {
                    logger.info('适配器', '通过页面兜底提取到图片结果', meta);
                    return { image: extracted.dataUrl };
                }
                if (extracted?.url) {
                    imageUrl = extracted.url;
                    logger.info('适配器', '通过页面兜底提取到图片链接', meta);
                }
            }
            if (!imageUrl) throw e;
        }

        if (!imageUrl) {
            return { error: '未能从响应中提取图片链接' };
        }

        logger.info('适配器', '已获取图片链接，开始下载...', meta);

        // 8. 下载图片
        const imgDlCfg = config?.backend?.pool?.failover || {};
        const downloadResult = await useContextDownload(imageUrl, page, {
            retries: imgDlCfg.imgDlRetry ? (imgDlCfg.imgDlRetryMaxRetries || 2) : 0
        });
        if (downloadResult.error) {
            logger.error('适配器', downloadResult.error, meta);
            return downloadResult;
        }

        logger.info('适配器', '图片生成完成', meta);
        return { image: downloadResult.image };

    } catch (err) {
        const pageError = normalizePageError(err, meta);
        if (pageError) return pageError;

        logger.error('适配器', '生成任务失败', { ...meta, error: err.message });
        return { error: `生成任务失败: ${err.message}` };
    } finally { }
}

/**
 * 解析 SSE 响应，提取图片链接
 * @param {string} body - SSE 响应体
 * @returns {string|null} 图片 URL
 */
function parseSSEForImage(body) {
    const lines = body.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('data:')) {
            const dataLine = line.substring(5).trim();
            if (!dataLine || dataLine === '{}') continue;

            try {
                const data = JSON.parse(dataLine);
                const url = extractRawImage(data);
                if (url) return url;
            } catch (e) {
                // JSON 解析失败，跳过
            }
        }
    }

    return null;
}

/**
 * 从 SSE 消息数据中提取原图 Raw 链接
 * @param {Object} sseData - 解析后的 data JSON 对象
 * @returns {string|null} - 返回图片 URL 或 null
 */
function extractRawImage(sseData) {
    if (!sseData || !sseData.patch_op || !Array.isArray(sseData.patch_op)) {
        return null;
    }

    for (const op of sseData.patch_op) {
        const contentBlocks = op.patch_value?.content_block;

        if (Array.isArray(contentBlocks)) {
            for (const block of contentBlocks) {
                // block_type 2074 代表生成卡片
                if (block.block_type === 2074) {
                    const creations = block.content?.creation_block?.creations;

                    if (Array.isArray(creations)) {
                        for (const creation of creations) {
                            // 提取 image_ori_raw，只有图片生成完成时才会出现
                            const rawUrl = creation.image?.image_ori_raw?.url;
                            if (rawUrl) {
                                return rawUrl;
                            }
                        }
                    }
                }
            }
        }
    }

    return null;
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
        { id: 'seedream-4.5', codeName: 'Seedream 4.5', imagePolicy: 'optional' },
        { id: 'seedream-4.0', codeName: 'Seedream 4.0', imagePolicy: 'optional' },
        { id: 'seedream-3.0', codeName: 'Seedream 3.0', imagePolicy: 'optional' }
    ],

    navigationHandlers: [],

    generate
};
