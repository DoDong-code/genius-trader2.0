/**
 * 凭证加密工具（AES-256-GCM）
 *
 * 密钥来源：环境变量 SOURCE_SECRET_KEY
 * - 未配置时使用开发默认密钥并输出警告（仅限本地开发，生产必须配置）
 *
 * 密文格式：base64(iv):base64(authTag):base64(ciphertext)
 */
const crypto = require('node:crypto');

const DEV_FALLBACK_KEY = 'genius-trader-dev-only-source-secret';

function getKey() {
  const secret = process.env.SOURCE_SECRET_KEY || DEV_FALLBACK_KEY;
  if (!process.env.SOURCE_SECRET_KEY) {
    console.warn('[source-credentials] 未设置环境变量 SOURCE_SECRET_KEY，正在使用开发默认密钥（生产环境请务必配置）');
  }
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * 加密明文
 * @param {string} plainText
 * @returns {string} base64(iv):base64(tag):base64(ciphertext)
 */
function encryptText(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * 解密密文；密钥不匹配或数据损坏时返回空字符串（调用方按未登录处理）
 * @param {string} payload
 * @returns {string}
 */
function decryptText(payload) {
  if (!payload) return '';
  try {
    const parts = String(payload).split(':');
    if (parts.length !== 3) return '';
    const [ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch (e) {
    return '';
  }
}

module.exports = { encryptText, decryptText };
