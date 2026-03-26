/**
 * EventStore 用户 profile 拉取/保存（依赖 eventstore-tools）。
 * 供 main 进程 IPC 调用，用于「老用户查 profile / 新用户完善 profile」流程。
 */

let keyLib = null;
let WebSocketClient = null;

function loadEventstoreTools() {
  if (keyLib && WebSocketClient) return null;
  try {
    // eslint-disable-next-line global-require
    keyLib = require('eventstore-tools/src/key');
    // eslint-disable-next-line global-require
    const wsModule = require('eventstore-tools/src/WebSocketClient');
    // 兼容 CJS / ESM 导出形式
    WebSocketClient = wsModule.WebSocketClient || wsModule.default || wsModule;
    return null;
  } catch (e) {
    return e && e.message ? e.message : String(e);
  }
}

/**
 * 从服务器拉取当前用户的 profile（只读，不需要私钥）。
 * @param {string} esserver - WebSocket 地址，如 ws://127.0.0.1:8080/
 * @param {string} pubkey - 公钥 hex
 * @returns {Promise<{ ok: boolean, profile?: object|null, message?: string }>}
 */
function fetchProfile(esserver, pubkey) {
  const err = loadEventstoreTools();
  if (err) return Promise.resolve({ ok: false, message: `无法加载 eventstore-tools：${err}` });
  if (!esserver || !pubkey) return Promise.resolve({ ok: false, message: '缺少 esserver 或 pubkey' });

  return new Promise((resolve) => {
    const client = new WebSocketClient(esserver);
    const timeout = setTimeout(() => {
      try { client.unsubscribe && client.unsubscribe(subId); } catch (_) {}
      resolve({ ok: true, profile: null });
    }, 12000);

    client.connect().then(() => {
      const event = {
        ops: 'R',
        code: 203,
        eventuser: pubkey,
        tags: [['d', 'profile']],
      };
      let resolved = false;
      const done = (profile) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve({ ok: true, profile });
      };
      client.subscribe(event, (message) => {
        if (message[2] === 'EOSE') {
          try { client.unsubscribe(message[1]); } catch (_) {}
          done(null);
          return;
        }
        try {
          const ev = message[2];
          const data = ev && (typeof ev.data === 'string' ? ev.data : (ev.data && typeof ev.data === 'object' ? JSON.stringify(ev.data) : ''));
          if (data) {
            const profile = typeof data === 'string' ? JSON.parse(data) : data;
            try { client.unsubscribe(message[1]); } catch (_) {}
            done(profile);
          }
        } catch (_) {
          done(null);
        }
      });
    }).catch((e) => {
      clearTimeout(timeout);
      resolve({ ok: false, message: e && e.message ? e.message : String(e) });
    });
  });
}

/**
 * 将 profile 保存到服务器（需要私钥签名）。
 * @param {string} esserver - WebSocket 地址
 * @param {string} pubkey - 公钥 hex
 * @param {string} privkeyEsec - ESEC 私钥字符串
 * @param {object} profile - 要保存的对象，如 { name, avatar, ... }
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
function saveProfile(esserver, pubkey, privkeyEsec, profile) {
  const err = loadEventstoreTools();
  if (err) return Promise.resolve({ ok: false, message: `无法加载 eventstore-tools：${err}` });
  if (!esserver || !pubkey || !privkeyEsec) return Promise.resolve({ ok: false, message: '缺少 esserver、pubkey 或私钥' });

  const { esecDecode, secureEvent } = keyLib;
  let privkeyBytes;
  try {
    const decoded = esecDecode(privkeyEsec.trim());
    privkeyBytes = (decoded && (decoded.data || decoded)) || decoded;
  } catch (e) {
    return Promise.resolve({ ok: false, message: 'ESEC 密钥解析失败' });
  }
  if (!privkeyBytes) return Promise.resolve({ ok: false, message: 'ESEC 密钥解析失败' });

  return new Promise((resolve) => {
    const client = new WebSocketClient(esserver);
    const event = {
      ops: 'C',
      code: 200,
      user: pubkey,
      data: JSON.stringify(profile || {}),
      tags: [['d', 'profile']],
    };
    const sevent = secureEvent(event, privkeyBytes);
    client.connect().then(() => {
      client.publish(sevent, (message) => {
        if (message[2] !== 'EOSE') resolve({ ok: true });
      });
      // 若服务器不返回或只返回 EOSE，3 秒后也视为成功
      setTimeout(() => resolve({ ok: true }), 3000);
    }).catch((e) => {
      resolve({ ok: false, message: e && e.message ? e.message : String(e) });
    });
  });
}

/**
 * 在 EventStore 服务器注册用户（与 eventstoreUI esclient.create_user 一致：ops C, code 100）。
 * @param {string} esserver - WebSocket 地址
 * @param {string} email - 邮箱（可与服务端绑定；纯粘贴 ESEC 可为空串）
 * @param {string} pubkeyHex - 公钥 hex
 * @param {string} privkeyEsec - ESEC 私钥
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
function registerUserOnServer(esserver, email, pubkeyHex, privkeyEsec) {
  const err = loadEventstoreTools();
  if (err) return Promise.resolve({ ok: false, message: `无法加载 eventstore-tools：${err}` });
  if (!esserver || !pubkeyHex || !privkeyEsec) {
    return Promise.resolve({ ok: false, message: '缺少 esserver、pubkey 或私钥' });
  }

  const { esecDecode, secureEvent } = keyLib;
  let privkeyBytes;
  try {
    const decoded = esecDecode(privkeyEsec.trim());
    privkeyBytes = (decoded && (decoded.data || decoded)) || decoded;
  } catch (e) {
    return Promise.resolve({ ok: false, message: 'ESEC 密钥解析失败' });
  }
  if (!privkeyBytes) return Promise.resolve({ ok: false, message: 'ESEC 密钥解析失败' });

  return new Promise((resolve) => {
    const client = new WebSocketClient(esserver);
    const event = {
      ops: 'C',
      code: 100,
      user: pubkeyHex,
      data: {
        email: typeof email === 'string' ? email.trim() : '',
      },
    };
    const sevent = secureEvent(event, privkeyBytes);
    let settled = false;
    let timer = null;
    const done = (ok, msg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok, message: msg });
    };

    client.connect().then(() => {
      client.publish(sevent, (message) => {
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
      });
      timer = setTimeout(() => done(true), 8000);
    }).catch((e) => {
      done(false, e && e.message ? e.message : String(e));
    });
  });
}

module.exports = { fetchProfile, saveProfile, registerUserOnServer };
