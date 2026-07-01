const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'deerinwild';
const GITHUB_REPO = process.env.GITHUB_REPO || 'biupc_data';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_API = 'https://api.github.com';

const MAX_EVENTS = Number(process.env.MAX_EVENTS || 5000);
const GITHUB_FLUSH_INTERVAL_MS = Number(process.env.GITHUB_FLUSH_INTERVAL_MS || 5 * 60 * 1000);
const GITHUB_RATE_LIMIT_COOLDOWN_MS = Number(process.env.GITHUB_RATE_LIMIT_COOLDOWN_MS || 20 * 60 * 1000);
const GITHUB_ERROR_COOLDOWN_MS = Number(process.env.GITHUB_ERROR_COOLDOWN_MS || 2 * 60 * 1000);
const MAX_DATES_PER_FLUSH = Number(process.env.MAX_DATES_PER_FLUSH || 20);
const FLUSH_ALL_MAX_DATES = Number(process.env.FLUSH_ALL_MAX_DATES || 200);
const STATS_CACHE_MS = Number(process.env.STATS_CACHE_MS || 60 * 1000);
const GITHUB_WRITE_RETRY = Number(process.env.GITHUB_WRITE_RETRY || 6);
const LATEST_INDEX_PATH = process.env.LATEST_INDEX_PATH || 'latest.json';
const LATEST_INDEX_MAX_DAYS = Number(process.env.LATEST_INDEX_MAX_DAYS || 60);
const SERVER_TIMEZONE = 'Asia/Shanghai';

const events = [];
const liveCounters = new Map();   // date -> counter file shape, used for immediate dashboard display.
const pendingCounters = new Map(); // date -> counter file shape, waiting to flush to GitHub.
const statsCache = new Map();      // date -> { at, stats }

let flushTimer = null;
let flushInProgress = false;
let lastGithubFlushAt = 0;
let githubCooldownUntil = 0;
let lastGithubError = '';
let lastGithubStatus = 'idle';
let lastGithubSavedAt = '';

function githubEnabled() {
  return Boolean(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO && GITHUB_BRANCH);
}

function nowIso() {
  return new Date().toISOString();
}

function beijingDayKey(dateLike) {
  const d = dateLike ? new Date(dateLike) : new Date();
  if (Number.isNaN(d.getTime())) return beijingDayKey(new Date());
  return d.toLocaleDateString('en-CA', { timeZone: SERVER_TIMEZONE });
}

function isDayKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function compareDayKey(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function beijingEndOfDayIso(dayKey) {
  if (!isDayKey(dayKey)) return nowIso();
  const [y, m, d] = dayKey.split('-').map(Number);
  // Beijing 23:59:59.999 = UTC next-day 15:59:59.999.
  return new Date(Date.UTC(y, m - 1, d + 1, 15, 59, 59, 999)).toISOString();
}

function normalizeReportDate(raw, receivedAtIso = nowIso()) {
  // 服务端以北京时间为准：客户端日期只作为“非未来日期”的补报提示。
  // 如果客户端传来未来日期，一律压回服务端当前北京时间日期，避免提前生成明天数据。
  const serverToday = beijingDayKey(receivedAtIso);
  const value = String(raw || '').trim();
  if (!isDayKey(value)) return serverToday;
  if (compareDayKey(value, serverToday) > 0) return serverToday;
  return value;
}

function normalizeDate(raw) {
  const value = String(raw || '').trim();
  if (isDayKey(value)) return value;
  return beijingDayKey();
}

function serverLastSeenAtForDate(receivedAtIso, reportDate) {
  const receivedDay = beijingDayKey(receivedAtIso);
  if (compareDayKey(receivedDay, reportDate) > 0) return beijingEndOfDayIso(reportDate);
  return receivedAtIso;
}

function formatBeijingTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: SERVER_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function monthInfo(date) {
  const [year, month] = date.split('-');
  return { year, month, monthKey: `${year}-${month}` };
}

function normalizeNickname(value) {
  const v = String(value || '').trim().replace(/\s+/g, ' ');
  return v ? v.slice(0, 64) : '未绑定昵称';
}

function normalizePlatform(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['tx', 'tencent', 'qq', 'vqq'].includes(v)) return 'tx';
  if (['iqy', 'iqiyi', 'qiyi'].includes(v)) return 'iqy';
  return v;
}

function count(value, fallback = 0) {
  const n = Number(value == null ? fallback : value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function firstCount(obj, keys, fallback = 0) {
  for (const key of keys) {
    if (obj && obj[key] != null) return count(obj[key], fallback);
  }
  return fallback;
}

function hashDeviceId(deviceId) {
  return crypto.createHash('sha256').update(String(deviceId || 'unknown')).digest('hex');
}

function shortHash(value) {
  return String(value || '').slice(0, 12);
}

function getProp(body, key, fallback = '') {
  if (body && body[key] != null) return body[key];
  if (body && body.properties && body.properties[key] != null) return body.properties[key];
  return fallback;
}

function requireAdmin(req, res, next) {
  const token = String(req.query.token || req.headers['x-admin-token'] || '');
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'biupc-monitor',
  };
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function b64EncodeUtf8(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64DecodeUtf8(text) {
  return Buffer.from(text || '', 'base64').toString('utf8');
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

function parseGithubErrorBody(text) {
  try { return JSON.parse(text || '{}'); } catch { return { message: text || '' }; }
}

function setGithubCooldownFromResponse(res, text) {
  const lower = String(text || '').toLowerCase();
  const reset = Number(res.headers.get('x-ratelimit-reset') || 0);
  const now = Date.now();
  if (res.status === 403 && lower.includes('rate limit')) {
    githubCooldownUntil = reset ? Math.max(githubCooldownUntil, reset * 1000 + 5000) : Math.max(githubCooldownUntil, now + GITHUB_RATE_LIMIT_COOLDOWN_MS);
    lastGithubStatus = 'rate_limited';
    return;
  }
  if (res.status === 401 || res.status === 403) {
    githubCooldownUntil = Math.max(githubCooldownUntil, now + GITHUB_ERROR_COOLDOWN_MS);
    lastGithubStatus = res.status === 401 ? 'bad_credentials' : 'forbidden';
  }
}

function githubInCooldown() {
  return githubCooldownUntil && Date.now() < githubCooldownUntil;
}

async function ghGetJson(path) {
  if (!githubEnabled()) return { data: null, sha: null, exists: false };
  if (githubInCooldown()) throw new Error(`GitHub is in cooldown until ${new Date(githubCooldownUntil).toISOString()}: ${lastGithubError || lastGithubStatus}`);
  const url = `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  const text = await safeText(res);
  if (res.status === 404) return { data: null, sha: null, exists: false };
  if (!res.ok) {
    setGithubCooldownFromResponse(res, text);
    const info = parseGithubErrorBody(text);
    const err = new Error(`GitHub GET ${path} failed: ${res.status} ${info.message || text}`);
    err.status = res.status;
    err.githubBody = info;
    throw err;
  }
  const info = JSON.parse(text);
  const content = b64DecodeUtf8(info.content || '');
  try { return { data: JSON.parse(content), sha: info.sha, exists: true }; }
  catch (err) { throw new Error(`GitHub JSON parse failed for ${path}: ${err.message}`); }
}

async function ghPutJson(path, data, sha, message) {
  if (!githubEnabled()) return null;
  if (githubInCooldown()) throw new Error(`GitHub is in cooldown until ${new Date(githubCooldownUntil).toISOString()}: ${lastGithubError || lastGithubStatus}`);
  const url = `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}`;
  const body = { message, content: b64EncodeUtf8(`${JSON.stringify(data, null, 2)}\n`), branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  const res = await fetch(url, { method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await safeText(res);
  if (!res.ok) {
    setGithubCooldownFromResponse(res, text);
    const info = parseGithubErrorBody(text);
    const err = new Error(`GitHub PUT ${path} failed: ${res.status} ${info.message || text}`);
    err.status = res.status;
    err.githubBody = info;
    throw err;
  }
  return JSON.parse(text || '{}');
}

function emptyCounterFile(date) {
  return { date, updatedAt: '', users: {} };
}

function cloneJson(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

function ensureCounter(map, date) {
  if (!map.has(date)) map.set(date, emptyCounterFile(date));
  const data = map.get(date);
  data.date = date;
  data.users = data.users || {};
  return data;
}

function computeUserTotals(user) {
  const devices = user.devices || {};
  let danmuSent = 0;
  let discussionSent = 0;
  let danmuFailed = 0;
  let discussionFailed = 0;
  let danmuSkipped = 0;
  let lastSeenAt = '';
  for (const item of Object.values(devices)) {
    danmuSent += count(item.danmuSent, 0);
    discussionSent += count(item.discussionSent, 0);
    danmuFailed += count(item.danmuFailed, 0);
    discussionFailed += count(item.discussionFailed, 0);
    danmuSkipped += count(item.danmuSkipped, 0);
    if (item.lastSeenAt && item.lastSeenAt > lastSeenAt) lastSeenAt = item.lastSeenAt;
  }
  user.activeDevices = Object.keys(devices).length;
  user.danmuSent = danmuSent;
  user.discussionSent = discussionSent;
  user.danmuFailed = danmuFailed;
  user.discussionFailed = discussionFailed;
  user.danmuSkipped = danmuSkipped;
  user.lastSeenAt = lastSeenAt;
}

function mergeDeviceCounter(targetCounter, weiboNickname, deviceHash, counter) {
  targetCounter.users = targetCounter.users || {};

  // Same physical browser/profile may change nickname. Keep the newest nickname only.
  for (const [nickname, user] of Object.entries(targetCounter.users)) {
    if (nickname !== weiboNickname && user && user.devices && user.devices[deviceHash]) {
      delete user.devices[deviceHash];
      computeUserTotals(user);
      if (!Object.keys(user.devices || {}).length) delete targetCounter.users[nickname];
    }
  }

  const user = targetCounter.users[weiboNickname] || { weiboNickname, devices: {} };
  user.weiboNickname = weiboNickname;
  user.devices = user.devices || {};
  const old = user.devices[deviceHash] || {};
  user.devices[deviceHash] = {
    deviceHash: shortHash(deviceHash),
    danmuSent: Math.max(count(old.danmuSent, 0), count(counter.danmuSent, 0)),
    discussionSent: Math.max(count(old.discussionSent, 0), count(counter.discussionSent, 0)),
    danmuFailed: Math.max(count(old.danmuFailed, 0), count(counter.danmuFailed, 0)),
    discussionFailed: Math.max(count(old.discussionFailed, 0), count(counter.discussionFailed, 0)),
    danmuSkipped: Math.max(count(old.danmuSkipped, 0), count(counter.danmuSkipped, 0)),
    lastSeenAt: counter.lastSeenAt || old.lastSeenAt || nowIso(),
    appVersion: counter.appVersion || old.appVersion || '',
    clientTimestamp: counter.clientTimestamp || old.clientTimestamp || '',
  };
  computeUserTotals(user);
  targetCounter.users[weiboNickname] = user;
  targetCounter.updatedAt = nowIso();
}

function mergeCounterFile(target, source) {
  if (!source || !source.users) return target;
  target.date = target.date || source.date;
  target.users = target.users || {};
  for (const [nickname, user] of Object.entries(source.users || {})) {
    for (const [deviceHash, device] of Object.entries(user.devices || {})) {
      mergeDeviceCounter(target, nickname, deviceHash, {
        danmuSent: device.danmuSent,
        discussionSent: device.discussionSent,
        danmuFailed: device.danmuFailed,
        discussionFailed: device.discussionFailed,
        danmuSkipped: device.danmuSkipped,
        lastSeenAt: device.lastSeenAt,
        appVersion: device.appVersion,
        clientTimestamp: device.clientTimestamp,
      });
    }
  }
  target.updatedAt = nowIso();
  return target;
}

function summarizeCounter(counter) {
  const users = counter.users || {};
  let activeDevices = 0;
  let danmuSent = 0;
  let discussionSent = 0;
  let danmuFailed = 0;
  let discussionFailed = 0;
  let danmuSkipped = 0;
  let lastSeenAt = '';
  for (const user of Object.values(users)) {
    computeUserTotals(user);
    activeDevices += count(user.activeDevices, 0);
    danmuSent += count(user.danmuSent, 0);
    discussionSent += count(user.discussionSent, 0);
    danmuFailed += count(user.danmuFailed, 0);
    discussionFailed += count(user.discussionFailed, 0);
    danmuSkipped += count(user.danmuSkipped, 0);
    if (user.lastSeenAt && user.lastSeenAt > lastSeenAt) lastSeenAt = user.lastSeenAt;
  }
  return { date: counter.date, activeUsers: Object.keys(users).length, activeDevices, danmuSent, discussionSent, danmuFailed, discussionFailed, danmuSkipped, lastSeenAt, updatedAt: counter.updatedAt || nowIso() };
}

function acceptDailyCounters(body) {
  const receivedAt = nowIso();
  const deviceHash = hashDeviceId(body.deviceId);
  const weiboNickname = normalizeNickname(body.weiboNickname || body.weiboUid || getProp(body, 'weiboNickname'));
  const rawCounters = Array.isArray(body.counters) ? body.counters : [{
    date: body.date,
    danmuSentToday: body.danmuSentToday ?? body.danmuSent,
    discussionSentToday: body.discussionSentToday ?? body.discussionSent,
    danmuFailedToday: body.danmuFailedToday ?? body.danmuFailed,
    discussionFailedToday: body.discussionFailedToday ?? body.discussionFailed,
    danmuSkippedToday: body.danmuSkippedToday ?? body.danmuSkipped,
    lastEventAt: body.lastEventAt,
  }];

  const acceptedDates = [];
  for (const raw of rawCounters) {
    const rawDate = raw.date || body.date;
    const date = normalizeReportDate(rawDate, receivedAt);
    const item = {
      danmuSent: firstCount(raw, ['danmuSentToday', 'danmuSent'], 0),
      discussionSent: firstCount(raw, ['discussionSentToday', 'discussionSent'], 0),
      danmuFailed: firstCount(raw, ['danmuFailedToday', 'danmuFailed'], 0),
      discussionFailed: firstCount(raw, ['discussionFailedToday', 'discussionFailed'], 0),
      danmuSkipped: firstCount(raw, ['danmuSkippedToday', 'danmuSkipped'], 0),
      // lastSeenAt 统一使用 Render 服务端接收时间，并按北京时间日期截断，避免客户端时钟导致未来日期/未来时间。
      lastSeenAt: serverLastSeenAtForDate(receivedAt, date),
      clientTimestamp: raw.lastEventAt || body.timestamp || '',
      appVersion: body.version || body.appVersion || '',
    };
    mergeDeviceCounter(ensureCounter(liveCounters, date), weiboNickname, deviceHash, item);
    mergeDeviceCounter(ensureCounter(pendingCounters, date), weiboNickname, deviceHash, item);
    statsCache.delete(date);
    acceptedDates.push(date);
  }
  return [...new Set(acceptedDates)];
}

async function updateGithubJsonWithRetry(path, makeDefault, applyUpdate, message) {
  let lastErr = null;
  for (let attempt = 1; attempt <= Math.max(1, GITHUB_WRITE_RETRY); attempt++) {
    const current = await ghGetJson(path);
    const data = current.data || makeDefault();
    const nextData = applyUpdate(data) || data;
    try {
      await ghPutJson(path, nextData, current.sha, message);
      return nextData;
    } catch (err) {
      lastErr = err;
      // GitHub Contents API 用 sha 做并发保护。409 表示文件已被其他写入更新，重新 GET 最新 sha 后 merge 重试。
      if (err.status === 409 || /\b409\b/.test(err.message || '')) {
        await sleep(350 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error(`GitHub update failed for ${path}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeDateToGithub(date, pendingData) {
  const { year, month, monthKey } = monthInfo(date);
  const counterPath = `archive/counters/${year}/${month}/${date}.json`;
  const summaryPath = `archive/summary/${year}/${monthKey}.json`;

  const counterData = await updateGithubJsonWithRetry(
    counterPath,
    () => emptyCounterFile(date),
    data => {
      data.date = date;
      mergeCounterFile(data, pendingData);
      data.updatedAt = nowIso();
      return data;
    },
    `biupc counter ${date}`
  );

  const summaryData = await updateGithubJsonWithRetry(
    summaryPath,
    () => ({ month: monthKey, days: {} }),
    summary => {
      summary.month = monthKey;
      summary.days = summary.days || {};
      summary.days[date] = summarizeCounter(counterData);
      summary.updatedAt = nowIso();
      return summary;
    },
    `biupc summary ${monthKey}`
  );

  statsCache.delete(date);
  return {
    date,
    month: monthKey,
    counterPath,
    summaryPath,
    updatedAt: nowIso(),
    summary: summarizeCounter(counterData),
    monthUpdatedAt: summaryData.updatedAt || nowIso(),
  };
}

function normalizeLatestIndexEntry(entry) {
  const summary = entry.summary || {};
  return {
    date: entry.date,
    month: entry.month || monthInfo(entry.date).monthKey,
    counterPath: entry.counterPath,
    summaryPath: entry.summaryPath,
    updatedAt: entry.updatedAt || summary.updatedAt || nowIso(),
    activeUsers: count(summary.activeUsers, 0),
    activeDevices: count(summary.activeDevices, 0),
    danmuSent: count(summary.danmuSent, 0),
    discussionSent: count(summary.discussionSent, 0),
    danmuFailed: count(summary.danmuFailed, 0),
    discussionFailed: count(summary.discussionFailed, 0),
    danmuSkipped: count(summary.danmuSkipped, 0),
    lastSeenAt: summary.lastSeenAt || '',
  };
}

async function writeLatestIndexToGithub(entries) {
  const validEntries = (entries || []).filter(entry => entry && isDayKey(entry.date) && entry.counterPath && entry.summaryPath);
  if (!validEntries.length) return null;

  return updateGithubJsonWithRetry(
    LATEST_INDEX_PATH,
    () => ({
      version: 1,
      updatedAt: '',
      latestDate: '',
      latestMonth: '',
      latestCounterPath: '',
      latestSummaryPath: '',
      days: [],
    }),
    index => {
      const merged = new Map();
      for (const item of Array.isArray(index.days) ? index.days : []) {
        if (item && isDayKey(item.date)) merged.set(item.date, item);
      }
      for (const entry of validEntries) merged.set(entry.date, normalizeLatestIndexEntry(entry));

      const days = [...merged.values()]
        .filter(item => item && isDayKey(item.date))
        .sort((a, b) => compareDayKey(b.date, a.date))
        .slice(0, Math.max(1, LATEST_INDEX_MAX_DAYS));
      const latest = days[0] || {};

      index.version = 1;
      index.updatedAt = nowIso();
      index.latestDate = latest.date || '';
      index.latestMonth = latest.month || '';
      index.latestCounterPath = latest.counterPath || '';
      index.latestSummaryPath = latest.summaryPath || '';
      index.days = days;
      return index;
    },
    'biupc latest index'
  );
}

function scheduleFlush(delayMs = GITHUB_FLUSH_INTERVAL_MS) {
  if (!githubEnabled()) return;
  if (flushTimer) return;
  const delay = Math.max(1000, delayMs);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPendingToGithub().catch(err => console.error('[github-write]', err));
  }, delay);
}

function selectFlushDates(limit = MAX_DATES_PER_FLUSH) {
  const dates = [...pendingCounters.keys()].filter(isDayKey);
  if (!dates.length) return [];

  // 优先写最近日期，避免大量历史补报把今天数据长期压住。
  return dates
    .sort((a, b) => compareDayKey(b, a))
    .slice(0, Math.max(1, Number(limit) || MAX_DATES_PER_FLUSH));
}

async function flushPendingToGithub(force = false, options = {}) {
  const maxDates = Math.max(1, Number(options.maxDates || MAX_DATES_PER_FLUSH));
  if (!githubEnabled()) return { ok: false, reason: 'github_disabled' };
  if (flushInProgress) return { ok: false, reason: 'flush_in_progress' };
  if (githubInCooldown()) {
    scheduleFlush(Math.max(1000, githubCooldownUntil - Date.now() + 5000));
    return { ok: false, reason: 'cooldown', cooldownUntil: new Date(githubCooldownUntil).toISOString(), error: lastGithubError };
  }
  if (!pendingCounters.size) return { ok: true, reason: 'no_pending' };
  if (!force && Date.now() - lastGithubFlushAt < GITHUB_FLUSH_INTERVAL_MS) {
    scheduleFlush(GITHUB_FLUSH_INTERVAL_MS - (Date.now() - lastGithubFlushAt));
    return { ok: false, reason: 'waiting_interval' };
  }

  flushInProgress = true;
  const dates = selectFlushDates(maxDates);
  const latestEntries = [];
  try {
    for (const date of dates) {
      const pendingData = cloneJson(pendingCounters.get(date));
      const entry = await writeDateToGithub(date, pendingData);
      latestEntries.push(entry);
      pendingCounters.delete(date);
    }
    if (latestEntries.length) await writeLatestIndexToGithub(latestEntries);
    lastGithubFlushAt = Date.now();
    lastGithubSavedAt = nowIso();
    lastGithubStatus = 'saved';
    lastGithubError = '';
    if (pendingCounters.size) scheduleFlush(GITHUB_FLUSH_INTERVAL_MS);
    return { ok: true, savedDates: dates, pendingDates: pendingCounters.size };
  } catch (err) {
    lastGithubError = err.message || String(err);
    if (!githubInCooldown()) githubCooldownUntil = Date.now() + GITHUB_ERROR_COOLDOWN_MS;
    lastGithubStatus = lastGithubStatus === 'idle' || lastGithubStatus === 'saved' ? 'error' : lastGithubStatus;
    console.error('[github-write]', err);
    scheduleFlush(Math.max(1000, githubCooldownUntil - Date.now() + 5000));
    return { ok: false, error: lastGithubError, cooldownUntil: new Date(githubCooldownUntil).toISOString() };
  } finally {
    flushInProgress = false;
  }
}

function pushMemoryEvent(body) {
  const event = String(body.event || 'unknown');
  const deviceHash = hashDeviceId(body.deviceId);
  const item = {
    event,
    count: count(getProp(body, 'count', 1), 1),
    deviceHash: shortHash(deviceHash),
    weiboNickname: normalizeNickname(body.weiboNickname || getProp(body, 'weiboNickname')),
    taskId: String(getProp(body, 'taskId', '') || ''),
    taskName: String(getProp(body, 'taskName', '') || ''),
    platform: normalizePlatform(getProp(body, 'platform', '') || ''),
    appVersion: String(body.version || body.appVersion || ''),
    timestamp: nowIso(),
    clientTimestamp: body.timestamp || '',
  };
  events.push(item);
  while (events.length > MAX_EVENTS) events.shift();
}

function counterToStats(counter, source = 'memory') {
  const data = counter || emptyCounterFile(beijingDayKey());
  const rows = Object.values(data.users || {}).map(u => {
    computeUserTotals(u);
    return {
      weiboNickname: u.weiboNickname,
      activeDevices: count(u.activeDevices, 0),
      danmuSent: count(u.danmuSent, 0),
      discussionSent: count(u.discussionSent, 0),
      danmuFailed: count(u.danmuFailed, 0),
      discussionFailed: count(u.discussionFailed, 0),
      danmuSkipped: count(u.danmuSkipped, 0),
      totalSent: count(u.danmuSent, 0) + count(u.discussionSent, 0),
      lastSeenAt: u.lastSeenAt || '',
    };
  }).sort((a, b) => b.totalSent - a.totalSent);
  const summary = summarizeCounter(data);
  return { ...summary, users: rows, source, githubEnabled: githubEnabled() };
}

function buildMemoryStats(date = beijingDayKey()) {
  return counterToStats(liveCounters.get(date) || emptyCounterFile(date), 'memory');
}

async function buildStatsFromGithub(date = beijingDayKey()) {
  const cached = statsCache.get(date);
  if (cached && Date.now() - cached.at < STATS_CACHE_MS) return cached.stats;
  if (!githubEnabled() || githubInCooldown()) return buildMemoryStats(date);

  const { year, month } = monthInfo(date);
  const path = `archive/counters/${year}/${month}/${date}.json`;
  try {
    const current = await ghGetJson(path);
    const data = current.data || emptyCounterFile(date);
    // Overlay live memory counters so dashboard can show latest accepted data before the next GitHub flush.
    mergeCounterFile(data, liveCounters.get(date));
    const stats = counterToStats(data, 'github+memory');
    statsCache.set(date, { at: Date.now(), stats });
    return stats;
  } catch (err) {
    lastGithubError = err.message || String(err);
    console.error('[github-read]', err);
    return buildMemoryStats(date);
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderDashboard(stats) {
  const rows = (stats.users || []).map((u, i) => `<tr><td>${i + 1}</td><td>${esc(u.weiboNickname)}</td><td>${u.activeDevices || 0}</td><td>${u.danmuSent || 0}</td><td>${u.discussionSent || 0}</td><td><b>${u.totalSent || 0}</b></td><td>${esc(formatBeijingTime(u.lastSeenAt) || '')}</td></tr>`).join('');
  const githubLine = `GitHub：${stats.githubEnabled ? '已启用' : '未启用/内存模式'}　状态：${esc(lastGithubStatus)}${githubInCooldown() ? `　冷却至：${esc(new Date(githubCooldownUntil).toISOString())}` : ''}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>biupc dashboard</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f6f7fb;color:#111827}.wrap{max-width:1120px;margin:0 auto;padding:24px}h1{font-size:24px;margin:0 0 6px}.muted{color:#6b7280;font-size:13px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}.card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:16px}.num{font-size:28px;font-weight:800;margin-top:8px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eef0f4;font-size:14px}th{background:#f9fafb;color:#374151}tr:last-child td{border-bottom:0}.warn{margin-top:12px;color:#9a3412;background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:10px 12px;font-size:13px;word-break:break-all}@media(max-width:760px){.cards{grid-template-columns:1fr 1fr}.wrap{padding:14px}table{font-size:12px}}</style></head><body><div class="wrap"><h1>biupc 统计面板</h1><div class="muted">日期：${esc(stats.date)}（北京时间）　来源：${esc(stats.source)}　${githubLine}</div>${lastGithubError ? `<div class="warn">最近 GitHub 错误：${esc(lastGithubError)}</div>` : ''}<div class="cards"><div class="card"><div>今日活跃用户</div><div class="num">${stats.activeUsers || 0}</div></div><div class="card"><div>今日活跃设备</div><div class="num">${stats.activeDevices || 0}</div></div><div class="card"><div>弹幕发送</div><div class="num">${stats.danmuSent || 0}</div></div><div class="card"><div>讨论发送</div><div class="num">${stats.discussionSent || 0}</div></div></div><table><thead><tr><th>#</th><th>微博昵称</th><th>设备数</th><th>弹幕发送</th><th>讨论发送</th><th>总发送</th><th>最后上报</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">暂无数据</td></tr>'}</tbody></table></div></body></html>`;
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'biupc_monitor',
    timezone: SERVER_TIMEZONE,
    serverBeijingDate: beijingDayKey(),
    githubEnabled: githubEnabled(),
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    branch: GITHUB_BRANCH,
    pendingDates: pendingCounters.size,
    liveDates: liveCounters.size,
    lastGithubStatus,
    lastGithubSavedAt,
    githubCooldownUntil: githubInCooldown() ? new Date(githubCooldownUntil).toISOString() : '',
    lastGithubError,
    flushIntervalMs: GITHUB_FLUSH_INTERVAL_MS,
    maxDatesPerFlush: MAX_DATES_PER_FLUSH,
    flushAllMaxDates: FLUSH_ALL_MAX_DATES,
    githubWriteRetry: GITHUB_WRITE_RETRY,
    latestIndexPath: LATEST_INDEX_PATH,
    latestIndexMaxDays: LATEST_INDEX_MAX_DAYS,
  });
});

app.post('/api/ping', async (req, res) => {
  try {
    const body = req.body || {};
    pushMemoryEvent(body);
    let acceptedDates = [];
    if (body.event === 'daily_counter_batch' || Array.isArray(body.counters)) {
      acceptedDates = acceptDailyCounters(body);
      scheduleFlush(GITHUB_FLUSH_INTERVAL_MS);
    }
    res.json({
      ok: true,
      accepted: true,
      githubEnabled: githubEnabled(),
      serverBeijingDate: beijingDayKey(),
      githubSaved: false,
      githubStatus: lastGithubStatus,
      pendingDates: pendingCounters.size,
      acceptedDates,
      githubCooldownUntil: githubInCooldown() ? new Date(githubCooldownUntil).toISOString() : '',
      note: 'Data accepted into Render memory. GitHub writes are batched to avoid API rate limits.',
    });
  } catch (err) {
    console.error('[api/ping]', err);
    res.status(500).json({ ok: false, accepted: false, error: err.message || String(err) });
  }
});

app.post('/api/flush', requireAdmin, async (req, res) => {
  const maxDates = Number(req.query.maxDates || MAX_DATES_PER_FLUSH);
  const result = await flushPendingToGithub(true, { maxDates });
  res.json({ ok: result.ok !== false, result, pendingDates: pendingCounters.size, lastGithubStatus, lastGithubError });
});

app.post('/api/flush-all', requireAdmin, async (req, res) => {
  const maxDates = Number(req.query.maxDates || FLUSH_ALL_MAX_DATES);
  const result = await flushPendingToGithub(true, { maxDates });
  res.json({ ok: result.ok !== false, result, pendingDates: pendingCounters.size, lastGithubStatus, lastGithubError });
});

app.get('/api/stats', requireAdmin, async (req, res) => {
  const date = normalizeDate(req.query.date);
  try { res.json({ ok: true, stats: await buildStatsFromGithub(date) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message || String(err), fallback: buildMemoryStats(date) }); }
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send('<!doctype html><meta charset="utf-8"><title>biupc monitor</title><body style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:40px;background:#f5f7fb;color:#111827"><h1>biupc monitor 已启动</h1><p>请打开 <code>/dashboard?token=你的ADMIN_TOKEN</code> 查看统计面板。</p><p>插件统计上报接口：<code>/api/ping</code></p><p>健康检查：<a href="/health">/health</a></p></body>');
});

app.get('/dashboard', async (req, res) => {
  const token = String(req.query.token || '');
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    res.status(401).send('<h1>401 Unauthorized</h1><p>请在地址后添加 ?token=你的 ADMIN_TOKEN。</p>');
    return;
  }
  const date = normalizeDate(req.query.date);
  const stats = await buildStatsFromGithub(date).catch(() => buildMemoryStats(date));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDashboard(stats));
});

app.listen(PORT, () => {
  console.log(`biupc monitor running on port ${PORT}, github=${githubEnabled() ? 'on' : 'off'}, flushIntervalMs=${GITHUB_FLUSH_INTERVAL_MS}`);
});
