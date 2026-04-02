/**
 * EventStore 用户 profile / 注册：由 eventstoreUI 同源 `esclient.cjs` 实现（见 lib/eventstore-vendor）。
 * 运行前需 `write-eventstore-config.js` 根据 Sync 生成 `config.cjs`。
 */
const path = require('path');

const esclientPath = path.join(__dirname, 'eventstore-vendor', 'esclient.cjs');
const configPath = path.join(__dirname, 'eventstore-vendor', 'config.cjs');

function invalidateEsclientModule() {
  try {
    delete require.cache[require.resolve(esclientPath)];
    delete require.cache[require.resolve(configPath)];
  } catch (_) {
    /* 首次加载前可能无缓存 */
  }
}

function loadEsclient() {
  return require(esclientPath);
}

const profileInflight = new Map();

function parseProfileData(data) {
  if (!data) return null;
  if (typeof data === 'object') return data;
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * 从服务器拉取当前用户的 profile（只读，不需要私钥）。
 * esserver 由 lib/eventstore-vendor/config.cjs 决定（与当前 Sync 活跃服务器一致）。
 */
async function fetchProfile(_esserver, pubkey) {
  if (!pubkey) return { ok: false, message: '缺少 pubkey' };
  const inflightKey = `${String(_esserver || '')}::${String(pubkey || '')}`;
  if (profileInflight.has(inflightKey)) return profileInflight.get(inflightKey);
  const task = (async () => {
    try {
      const mod = loadEsclient();
      return await new Promise((resolve) => {
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve({ ok: false, message: '获取用户信息超时（12s）' });
          }
        }, 12000);
        mod.get_user_profile(pubkey, (msg) => {
          if (resolved) return;
          try {
            if (!msg || typeof msg !== 'object') return;
            if (msg.code != null) {
              const c = Number(msg.code);
              if (c === 200) {
                clearTimeout(timeout);
                resolved = true;
                resolve({ ok: true, profile: parseProfileData(msg.data) });
                return;
              }
              if (c >= 400) {
                clearTimeout(timeout);
                resolved = true;
                resolve({ ok: false, message: msg.message || `服务器错误 (${c})` });
              }
            }
          } catch (e) {
            clearTimeout(timeout);
            resolved = true;
            resolve({ ok: false, message: e && e.message ? e.message : String(e) });
          }
        });
      });
    } catch (e) {
      return { ok: false, message: e && e.message ? e.message : String(e) };
    }
  })();
  profileInflight.set(inflightKey, task);
  return task.finally(() => {
    if (profileInflight.get(inflightKey) === task) profileInflight.delete(inflightKey);
  });
}

/**
 * 将 profile 保存到服务器（需要私钥签名）。
 */
async function saveProfile(_esserver, pubkey, privkeyEsec, profile) {
  if (!pubkey || !privkeyEsec) return { ok: false, message: '缺少 pubkey 或私钥' };
  let keyLib;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    keyLib = require('eventstore-tools/src/key');
  } catch (e) {
    return { ok: false, message: `无法加载 eventstore-tools：${e && e.message ? e.message : String(e)}` };
  }
  const { esecDecode } = keyLib;
  let privkeyBytes;
  try {
    const decoded = esecDecode(privkeyEsec.trim());
    privkeyBytes = (decoded && (decoded.data || decoded)) || decoded;
  } catch (e) {
    return { ok: false, message: 'ESEC 密钥解析失败' };
  }
  if (!privkeyBytes) return { ok: false, message: 'ESEC 密钥解析失败' };

  try {
    const mod = loadEsclient();
    return await new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ ok: true });
      }, 8000);
      mod.save_user_profile(profile || {}, pubkey, privkeyBytes, (msg) => {
        if (done) return;
        clearTimeout(t);
        done = true;
        if (msg && typeof msg === 'object' && msg.code != null && Number(msg.code) >= 400) {
          resolve({ ok: false, message: msg.message || `服务器错误 (${msg.code})` });
          return;
        }
        resolve({ ok: true });
      });
    });
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
}

/**
 * 在 EventStore 服务器注册用户（与 eventstoreUI create_user 一致：ops C, code 100）。
 */
async function registerUserOnServer(_esserver, email, pubkeyHex, privkeyEsec) {
  if (!pubkeyHex || !privkeyEsec) {
    return { ok: false, message: '缺少 pubkey 或私钥' };
  }
  let keyLib;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    keyLib = require('eventstore-tools/src/key');
  } catch (e) {
    return { ok: false, message: `无法加载 eventstore-tools：${e && e.message ? e.message : String(e)}` };
  }
  const { esecDecode } = keyLib;
  let privkeyBytes;
  try {
    const decoded = esecDecode(privkeyEsec.trim());
    privkeyBytes = (decoded && (decoded.data || decoded)) || decoded;
  } catch (e) {
    return { ok: false, message: 'ESEC 密钥解析失败' };
  }
  if (!privkeyBytes) return { ok: false, message: 'ESEC 密钥解析失败' };

  try {
    const mod = loadEsclient();
    return await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = (ok, msg) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ ok, message: msg });
      };
      timer = setTimeout(() => done(true), 8000);
      mod.create_user(
        typeof email === 'string' ? email.trim() : '',
        pubkeyHex,
        privkeyBytes,
        (message) => {
          try {
            if (!message || message[2] === 'EOSE') return;
            const m = message[2];
            if (m && typeof m === 'object' && m.code != null) {
              const c = Number(m.code);
              if (c >= 400) {
                done(false, m.message || `服务器错误 (${c})`);
                return;
              }
            }
          } catch (_) {}
          done(true);
        },
      );
    });
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  fetchProfile,
  saveProfile,
  registerUserOnServer,
  invalidateEsclientModule,
  /** 供后续 IPC 直接调用 create_book / create_blog 等（与 eventstoreUI 同源） */
  loadEsclient,
};
