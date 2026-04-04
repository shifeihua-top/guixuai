/**
 * @fileoverview WebUI 账号密码鉴权工具
 * @description 提供密码哈希、校验与 API Token 生成能力
 */

import crypto from 'crypto';

const DEFAULT_ITERATIONS = 120000;
const DEFAULT_KEY_LENGTH = 64;
const DEFAULT_DIGEST = 'sha256';

/**
 * 生成 API Token
 * @returns {string}
 */
export function generateApiToken() {
    return `sk-${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * 生成随机盐值
 * @returns {string}
 */
function generateSalt() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * 构造密码哈希配置
 * @param {object} [options={}]
 * @returns {{iterations: number, keyLength: number, digest: string}}
 */
function resolveHashOptions(options = {}) {
    const iterations = Number.isFinite(Number(options.iterations)) && Number(options.iterations) > 0
        ? Number(options.iterations)
        : DEFAULT_ITERATIONS;
    const keyLength = Number.isFinite(Number(options.keyLength)) && Number(options.keyLength) > 0
        ? Number(options.keyLength)
        : DEFAULT_KEY_LENGTH;
    const digest = typeof options.digest === 'string' && options.digest.trim()
        ? options.digest.trim()
        : DEFAULT_DIGEST;
    return { iterations, keyLength, digest };
}

/**
 * 哈希密码
 * @param {string} password
 * @param {string} [salt]
 * @param {object} [options]
 * @returns {{passwordHash: string, passwordSalt: string, passwordScheme: string}}
 */
export function hashAdminPassword(password, salt, options) {
    const finalPassword = typeof password === 'string' ? password : '';
    const finalSalt = typeof salt === 'string' && salt.trim() ? salt.trim() : generateSalt();
    const { iterations, keyLength, digest } = resolveHashOptions(options);

    const hashed = crypto.pbkdf2Sync(finalPassword, finalSalt, iterations, keyLength, digest).toString('hex');
    const passwordScheme = `pbkdf2:${digest}:${iterations}:${keyLength}`;

    return {
        passwordHash: hashed,
        passwordSalt: finalSalt,
        passwordScheme
    };
}

/**
 * 校验密码是否正确
 * @param {string} password
 * @param {string} passwordHash
 * @param {string} passwordSalt
 * @param {string} [passwordScheme]
 * @returns {boolean}
 */
export function verifyAdminPassword(password, passwordHash, passwordSalt, passwordScheme) {
    if (!passwordHash || !passwordSalt) return false;

    let digest = DEFAULT_DIGEST;
    let iterations = DEFAULT_ITERATIONS;
    let keyLength = DEFAULT_KEY_LENGTH;

    if (typeof passwordScheme === 'string' && passwordScheme.startsWith('pbkdf2:')) {
        const parts = passwordScheme.split(':');
        if (parts.length === 4) {
            digest = parts[1] || digest;
            iterations = Number(parts[2]) || iterations;
            keyLength = Number(parts[3]) || keyLength;
        }
    }

    const candidate = crypto.pbkdf2Sync(
        typeof password === 'string' ? password : '',
        passwordSalt,
        iterations,
        keyLength,
        digest
    );

    const expected = Buffer.from(passwordHash, 'hex');
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
}
