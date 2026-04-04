/**
 * @fileoverview 鉴权中间件
 * @description 提取自 routes.js 的鉴权逻辑
 */

import { sendApiError } from '../respond.js';
import { ERROR_CODES } from '../errors.js';

function parseBearerToken(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') return '';
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    return m ? m[1].trim() : '';
}

function maskToken(token) {
    if (!token || token.length < 8) return '***';
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

/**
 * 鉴权检查
 * @param {import('http').IncomingMessage} req - HTTP 请求
 * @param {Array<{id: string, name: string, token: string, enabled: boolean}>} entries - token 列表
 * @returns {{ok: boolean, matched?: object}}
 */
export function checkAuth(req, entries) {
    const enabled = (entries || []).filter(e => e && e.enabled !== false && e.token);
    if (enabled.length === 0) {
        return { ok: true };
    }

    const token = parseBearerToken(req);
    if (!token) {
        return { ok: false };
    }

    const matched = enabled.find(e => e.token === token);
    if (!matched) {
        return { ok: false };
    }

    return { ok: true, matched };
}

/**
 * 创建鉴权中间件
 * @param {object} options
 * @param {string} [options.authToken] - 主认证令牌（兼容）
 * @param {Function} [options.getAuthEntries] - 动态获取 token 列表
 * @returns {Function} 中间件函数
 */
export function createAuthMiddleware(options = {}) {
    const {
        authToken = '',
        getAuthEntries
    } = options;

    function resolveEntries() {
        if (typeof getAuthEntries === 'function') {
            const list = getAuthEntries();
            if (Array.isArray(list)) return list;
        }
        if (!authToken) return [];
        return [{ id: 'primary', name: 'primary', token: authToken, enabled: true }];
    }

    /**
     * 鉴权中间件
     * @param {import('http').IncomingMessage} req
     * @param {import('http').ServerResponse} res
     * @returns {boolean} 是否通过鉴权
     */
    return function authMiddleware(req, res) {
        const result = checkAuth(req, resolveEntries());
        if (!result.ok) {
            sendApiError(res, { code: ERROR_CODES.UNAUTHORIZED });
            return false;
        }
        if (result.matched) {
            req.authInfo = {
                tokenId: result.matched.id || 'unknown',
                tokenName: result.matched.name || 'token',
                tokenMasked: maskToken(result.matched.token || '')
            };
        } else {
            req.authInfo = null;
        }
        return true;
    };
}
