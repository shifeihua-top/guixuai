/**
 * @fileoverview Watermark Remover 后处理集成
 * @description 可选调用外部 watermark-remover CLI 对返回图片进行修正
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import sharp from 'sharp';
import { logger } from '../../utils/logger.js';

const MIME_TO_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp'
};

const MIME_TO_SHARP_FORMAT = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpeg',
    'image/webp': 'webp'
};

function parseDataUrl(dataUrl) {
    const m = dataUrl?.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    return { mimeType: m[1].toLowerCase(), base64Data: m[2] };
}

function runCommand(command, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        let stdout = '';
        let killedByTimeout = false;

        const timer = setTimeout(() => {
            killedByTimeout = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout?.on('data', chunk => {
            stdout += chunk.toString();
        });
        child.stderr?.on('data', chunk => {
            stderr += chunk.toString();
        });

        child.on('error', reject);
        child.on('close', (code) => {
            clearTimeout(timer);
            if (killedByTimeout) {
                reject(new Error(`watermark-remover 执行超时 (${timeoutMs}ms)`));
                return;
            }
            if (code !== 0) {
                const errMsg = stderr?.trim() || stdout?.trim() || `exit code ${code}`;
                reject(new Error(`watermark-remover 执行失败: ${errMsg}`));
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

function buildArgs(inputPath, outputPath, cfg) {
    const args = [
        inputPath,
        '-o', outputPath,
        '--method', cfg.method || 'opencv',
        '--confidence', String(cfg.confidence ?? 0.5),
        '--padding', String(cfg.padding ?? 10),
        '--corner', cfg.corner || 'bottom-right',
        '--corner-width', String(cfg.cornerWidth ?? 0.12),
        '--corner-height', String(cfg.cornerHeight ?? 0.08)
    ];

    if (cfg.forceCorner) {
        args.push('--force-corner');
    } else if (cfg.fallbackCorner === false) {
        args.push('--no-fallback');
    }

    if (cfg.verbose) {
        args.push('--verbose');
    }

    return args;
}

function clampInt(v, min, max) {
    return Math.max(min, Math.min(max, Math.floor(v)));
}

function getCornerRect(width, height, cfg) {
    const corner = cfg.corner || 'bottom-right';
    const widthRatio = Number(cfg.cornerWidth ?? 0.12);
    const heightRatio = Number(cfg.cornerHeight ?? 0.08);
    const padding = Number(cfg.padding ?? 10);

    const maskWidth = clampInt(width * widthRatio, 1, width);
    const maskHeight = clampInt(height * heightRatio, 1, height);

    let x1, y1, x2, y2;
    if (corner === 'bottom-right') {
        x1 = width - maskWidth - padding;
        y1 = height - maskHeight - padding;
        x2 = width - padding;
        y2 = height - padding;
    } else if (corner === 'bottom-left') {
        x1 = padding;
        y1 = height - maskHeight - padding;
        x2 = maskWidth + padding;
        y2 = height - padding;
    } else if (corner === 'top-right') {
        x1 = width - maskWidth - padding;
        y1 = padding;
        x2 = width - padding;
        y2 = maskHeight + padding;
    } else {
        x1 = padding;
        y1 = padding;
        x2 = maskWidth + padding;
        y2 = maskHeight + padding;
    }

    return {
        x1: clampInt(x1, 0, width - 1),
        y1: clampInt(y1, 0, height - 1),
        x2: clampInt(x2, 1, width),
        y2: clampInt(y2, 1, height)
    };
}

async function softenCornerPatch(originalBuffer, processedBuffer, mimeType, cfg) {
    const blend = Number(cfg.cornerBlend ?? 1);
    if (!(blend > 0 && blend < 1)) return processedBuffer;

    const originalRaw = await sharp(originalBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const processedRaw = await sharp(processedBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    if (
        originalRaw.info.width !== processedRaw.info.width ||
        originalRaw.info.height !== processedRaw.info.height ||
        originalRaw.info.channels !== processedRaw.info.channels
    ) {
        return processedBuffer;
    }

    const { width, height, channels } = originalRaw.info;
    const rect = getCornerRect(width, height, cfg);

    const out = Buffer.from(processedRaw.data);
    const inv = 1 - blend;

    for (let y = rect.y1; y < rect.y2; y++) {
        for (let x = rect.x1; x < rect.x2; x++) {
            const idx = (y * width + x) * channels;
            out[idx] = Math.round(out[idx] * blend + originalRaw.data[idx] * inv);
            out[idx + 1] = Math.round(out[idx + 1] * blend + originalRaw.data[idx + 1] * inv);
            out[idx + 2] = Math.round(out[idx + 2] * blend + originalRaw.data[idx + 2] * inv);
            // alpha 不混合，保持不透明
        }
    }

    const fmt = MIME_TO_SHARP_FORMAT[mimeType] || 'jpeg';
    return await sharp(out, { raw: { width, height, channels } }).toFormat(fmt).toBuffer();
}

/**
 * 对 dataURL 图片执行 watermark-remover 后处理
 * @param {string} dataUrl - data:image/...;base64,...
 * @param {object} config - 全局配置
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<{image:string, applied:boolean, error?:string}>}
 */
export async function applyWatermarkRemover(dataUrl, config, meta = {}) {
    const wmCfg = config?.backend?.postprocess?.watermarkRemover || {};
    if (!wmCfg.enabled) {
        return { image: dataUrl, applied: false };
    }

    const parsed = parseDataUrl(dataUrl);
    if (!parsed) {
        return { image: dataUrl, applied: false, error: '非 dataURL 图片，跳过水印修正' };
    }

    const { mimeType, base64Data } = parsed;
    const originalBuffer = Buffer.from(base64Data, 'base64');
    const ext = MIME_TO_EXT[mimeType] || 'png';

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wmfix-'));
    const inputPath = path.join(tmpDir, `input.${ext}`);
    const outputPath = path.join(tmpDir, `output.${ext}`);

    const command = wmCfg.command || 'watermark-remover';
    const timeoutMs = wmCfg.timeoutMs || 120000;

    try {
        await fs.writeFile(inputPath, originalBuffer);

        const args = buildArgs(inputPath, outputPath, wmCfg);
        logger.info('后处理', `执行水印修正: ${command} ${args.join(' ')}`, meta);
        await runCommand(command, args, timeoutMs);

        let outBuf = await fs.readFile(outputPath);
        if (wmCfg.forceCorner) {
            outBuf = await softenCornerPatch(originalBuffer, outBuf, mimeType, wmCfg);
        }
        const fixedDataUrl = `data:${mimeType};base64,${outBuf.toString('base64')}`;
        return { image: fixedDataUrl, applied: true };
    } catch (err) {
        const msg = err?.message || String(err);
        logger.warn('后处理', `水印修正失败，回退原图: ${msg}`, meta);
        return { image: dataUrl, applied: false, error: msg };
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
}
