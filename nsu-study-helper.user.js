// ==UserScript==
// @name         NSU 智慧教育学习助手
// @namespace    nsu-study-helper.local
// @version      0.3.1
// @author       L1Xu4n
// @license      MIT
// @homepageURL  https://github.com/L1Xu4n/nsu-study-helper
// @supportURL   https://github.com/L1Xu4n/nsu-study-helper/issues
// @description  1-5 视频并发、自动接管、完成确认与自动续播；默认试运行。
// @match        https://study.nsu.edu.cn/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/* 构建可测试的模块；油猴中只在学校域名的顶层页面启动。 */
(function initialize(factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (window.top === window && location.hostname === 'study.nsu.edu.cn') api.createApp(window);
})(/* 定义页面解析、队列规则和运行控制器。 */ function buildModule() {
  'use strict';
  const PREFIX = 'nsu-study-helper:v1:';
  const KEYS = { config: PREFIX + 'config', job: PREFIX + 'job', jobs: PREFIX + 'jobs:v2:', commands: PREFIX + 'commands:v2:',
    control: PREFIX + 'control:v2', stop: PREFIX + 'stop:v2', resume: PREFIX + 'resume:v2' };
  const DEFAULTS = { dryRun: true, autoNext: true, muted: false, keyword: '', maxItems: 5, minutes: 90, concurrency: 1 };
  const RETRY_DELAYS = [15000, 30000, 60000];
  const RECOVERY_GRACE_MS = 90000;
  const VIDEO_EXTENSION = /\.(mp4|m4v|webm|mov|ogv)(?:\s*)$/i;

  /** 合并多余空白，便于比较页面文字。 */
  function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

  /** 限制设置范围；损坏的旧设置不会让脚本自动开始。 */
  function sanitizeConfig(value) {
    const raw = value && typeof value === 'object' ? value : {};
    return {
      dryRun: raw.dryRun !== false, autoNext: raw.autoNext !== false, muted: raw.muted === true,
      keyword: clean(raw.keyword).slice(0, 100),
      maxItems: Math.min(50, Math.max(1, Math.floor(Number(raw.maxItems) || DEFAULTS.maxItems))),
      minutes: Math.min(180, Math.max(5, Math.floor(Number(raw.minutes) || DEFAULTS.minutes))),
      concurrency: Math.min(5, Math.max(1, Math.floor(Number(raw.concurrency) || 1)))
    };
  }

  /** 只解析已观察到的两种页面路径，不调用平台内部接口。 */
  function parseRoute(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.slice(2).some(/* 路径标识只允许数字。 */ p => !/^\d+$/.test(p))) return null;
    if (parts[0] === 'courseStudy' && parts[1] === 'studentLearnCourse' && parts.length === 7)
      return { kind: 'course', scope: parts[2] + ':' + parts[5], path: pathname };
    if (parts[0] === 'resourcesLearning' && parts[1] === 'index' && parts.length === 6)
      return { kind: 'resource', scope: parts[2] + ':' + parts[3], path: pathname };
    return null;
  }

  /** 同时要求平台文字和百分比确认完成，不能只看视频播放进度。 */
  function isComplete(item) { return item.status === '已完成' && item.progress === 100; }

  /** 从真实资源卡片读取标题、状态、进度和原生学习按钮。 */
  function readResources(doc) {
    return Array.from(doc.querySelectorAll('.resItem'), /* 每张卡片独立解析。 */ (card, index) => {
      const title = clean(card.querySelector('.file-name__span')?.textContent);
      const progressText = card.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow');
      const statuses = Array.from(card.querySelectorAll('span'), /* 提取精确的状态文字。 */ el => clean(el.textContent))
        .filter(/* 不把文件名中的“已完成”当成状态。 */ text => ['已完成', '学习中', '未学习'].includes(text));
      const buttons = Array.from(card.querySelectorAll('button')).filter(/* 只认原生学习按钮。 */ el => clean(el.textContent) === '去学习');
      const button = buttons.length === 1 ? buttons[0] : null;
      return { index, title, progress: progressText === null || progressText === undefined ? null : Number(progressText),
        status: statuses.length === 1 ? statuses[0] : '未知',
        available: clean(card.querySelector('.stateLabel')?.textContent) === '进行中',
        isVideo: VIDEO_EXTENSION.test(title),
        enabled: Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'), button };
    });
  }

  /** 按页面顺序选取可学习的视频；重复标题或矛盾状态必须人工处理。 */
  function selectQueue(items, config) {
    const matching = items.filter(/* 筛选关键字、类型和开放状态。 */ item =>
      item.isVideo && item.available && item.enabled && item.title.includes(config.keyword));
    const names = new Set();
    for (const item of matching) {
      if (names.has(item.title)) throw new Error('存在同名视频，无法唯一匹配，请缩小筛选范围。');
      names.add(item.title);
      if (!['已完成', '学习中', '未学习'].includes(item.status) || !Number.isFinite(item.progress)
          || item.progress < 0 || item.progress > 100 || (item.status === '已完成' && item.progress !== 100))
        throw new Error('资源状态不明确，请等待平台恢复后重新检查。');
    }
    return matching.filter(/* 已确认完成的资源不重复播放。 */ item => !isComplete(item)).slice(0, config.maxItems);
  }

  /** 判定新资源页是否与原生按钮实际打开的完整路径一致。 */
  function canClaim(job, route, bootTime, now, token) {
    return Boolean(job && route?.kind === 'resource' && job.status === 'opening'
      && job.launchToken && token === job.launchToken
      && job.expectedPath === route.path && job.scope === route.scope
      && bootTime >= job.createdAt && now - job.createdAt < 120000 && now < job.deadline);
  }

  /** 读取本脚本的 URL 标识或专用窗口名，兼容平台路由清理 hash 的情况。 */
  function taskToken(win) {
    const token = new URLSearchParams(win.location.hash.slice(1)).get('nsu-study-helper');
    if (token && /^[a-zA-Z0-9-]{1,80}$/.test(token)) return token;
    return /^nsu_study_job_([a-zA-Z0-9-]{1,80})$/.exec(win.name || '')?.[1] || null;
  }

  /** 排除隐藏的错误/验证模板，避免页面尚未显示的弹窗触发误报。 */
  function visible(el, win) {
    if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }

  /** 只匹配平台明确表示视频学习状态已经更新的完整语句。 */
  function isCompletionText(text) {
    return /(?:你|您)已完成该视频学习[，,]?学习状态已更新[！!。.]?/.test(clean(text).replace(/\s/g, ''));
  }

  /** 查找可见完成弹窗及唯一的正常确认按钮，不点击其他确认窗口。 */
  function findCompletionPrompt(doc, win) {
    for (const node of doc.querySelectorAll('.el-message-box,.el-dialog,[role="dialog"],[role="alert"],.el-message')) {
      if (!visible(node, win) || !isCompletionText(node.textContent)) continue;
      const buttons = [...node.querySelectorAll('button')].filter(/* 只认这个成功弹窗中的确认/关闭按钮，不点击取消。 */ button =>
        visible(button, win) && !button.disabled && /^(确定|确认|关闭|知道了|好的|OK)$/.test(clean(button.textContent)));
      return { node, button: buttons.length === 1 ? buttons[0] : null };
    }
    return null;
  }

  /** 使用真实媒体末尾状态，防止把播放中出现的无关提示当作结束。 */
  function mediaFinished(media) {
    return Boolean(media && (media.ended || (Number.isFinite(media.duration) && media.duration > 0
      && media.currentTime >= media.duration - 1 && media.paused)));
  }

  /** 只检查可见提示；仍在播放时允许暂时保留服务错误，最终必须核对完成。 */
  function detectBlocker(doc, win, options = {}) {
    const selectors = 'input[type="password"], [class*="captcha"], [id*="captcha"], .el-message--error, .el-notification--error, [role="alert"], .el-message-box, .el-dialog';
    for (const el of doc.querySelectorAll(selectors)) {
      if (!visible(el, win)) continue;
      if (el.matches('input[type="password"]')) return '登录状态失效，请手动登录后重新开始。';
      const text = clean(el.textContent);
      if (/登录|重新登录/.test(text)) return '登录状态失效，请手动登录后重新开始。';
      if (/captcha/i.test(el.className + ' ' + el.id) || /验证码|人机验证|人脸|短信验证/.test(text))
        return '需要本人验证，已停止。请完成页面验证后重新开始。';
      if (isCompletionText(text)) continue;
      if (/请求错误|请求失败|网络|服务.*异常|系统.*繁忙|超时|失败|错误|出错|登录|重新登录/.test(text))
        { if (options.allowPlaybackError) continue; return '平台请求异常，已暂停。请等待服务恢复后重新开始。'; }
      if (el.matches('.el-message-box,.el-dialog') && text) return '页面出现确认窗口，请手动处理后重新开始。';
    }
    return '';
  }

  /** 将媒体秒数格式化成时分秒；未加载时显示占位符。 */
  function clock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const total = Math.floor(seconds);
    return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
      .map(/* 每一段补齐两位。 */ n => String(n).padStart(2, '0')).join(':');
  }

  /** 只读写脚本自己的 JSON 键；存储故障向上抛出，禁止静默继续。 */
  function makeStore(storage) {
    return {
      /** 读取单个脚本键，损坏的数据报告错误。 */
      get(key) { const value = storage.getItem(key); return value === null ? null : JSON.parse(value); },
      /** 写入脚本状态，不保存密码、Cookie、令牌或视频地址。 */
      set(key, value) { storage.setItem(key, JSON.stringify(value)); },
      /** 删除已结束的脚本状态。 */
      remove(key) { storage.removeItem(key); }
    };
  }

  /** 为每个视频返回独立存储键，避免多个标签页覆盖同一份 JSON。 */
  function jobKey(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('无效任务标识。');
    return KEYS.jobs + id;
  }

  /** 停止命令使用独立键，播放器迟到的心跳无法覆盖它。 */
  function commandKey(id) { jobKey(id); return KEYS.commands + id; }

  /** 读取任务及停止命令的有效状态，终止命令始终优先。 */
  function readJob(store, id) {
    const job = store.get(jobKey(id));
    const command = store.get(commandKey(id));
    return job && command?.action === 'stop' ? { ...job, status: 'stopped', message: command.message } : job;
  }

  /** 使用浏览器原子锁，保护同一队列或同一视频，不禁止不同视频并发。 */
  async function takeLock(win, name) {
    if (!win.navigator.locks) throw new Error('浏览器不支持 Web Locks，已停止以避免多标签页冲突。');
    return new Promise(/* 将锁是否取得和释放函数交给调用者。 */ (resolve, reject) => {
      win.navigator.locks.request(PREFIX + name, { ifAvailable: true }, /* 持锁直到显式释放。 */ async lock => {
        if (!lock) { resolve(null); return; }
        await new Promise(/* 保存释放锁的回调。 */ release => resolve(release));
      }).catch(reject);
    });
  }

  /** 同时取得资源独占锁和一个全站播放槽；不同视频最多并发五个。 */
  async function takePlayerLocks(win, path) {
    const releaseResource = await takeLock(win, 'resource:' + path);
    if (!releaseResource) throw new Error('这个视频已在另一个标签页运行。');
    try {
      for (let slot = 0; slot < 5; slot += 1) {
        const releaseSlot = await takeLock(win, 'player-slot:' + slot);
        if (releaseSlot) return /* 一次释放两个锁，浏览器关闭页面也会自动释放。 */ () => { releaseSlot(); releaseResource(); };
      }
      throw new Error('已达到 5 个同时播放的上限，请先停止一个视频。');
    } catch (error) { releaseResource(); throw error; }
  }

  /** 创建独立面板和有限状态控制器；options 仅用于离线测试注入。 */
  function createApp(win, options = {}) {
    const doc = win.document;
    if (doc.getElementById('nsu-study-helper')) return null;
    const now = options.now || Date.now;
    const bootTime = now();
    const tabId = win.crypto.randomUUID();
    const store = options.store || makeStore(win.localStorage);
    const session = options.session || makeStore(win.sessionStorage);
    const navigate = options.reload || (/* 只刷新当前课程目录以重新读取平台状态。 */ () => win.location.reload());
    let config = { ...DEFAULTS }, route = parseRoute(win.location.pathname), sequence = 0;
    let running = false, busy = false, plan = null, jobId = null, video = null, releaseSession = null, releasePlayer = null;
    let savedMuted = null, oldOpen = null, wrappedOpen = null, endAt = 0, lastTime = -1, lastAdvance = now();
    let loadingSince = now(), closed = false, timer = null, initialError = '', playSince = 0, pendingSignature = '', cancelledUntil = 0;
    let pendingOpen = null, needsReload = false, closeAttempted = false, restoreTimer = null;
    const closeWindow = options.closeWindow || (/* 仅在匹配的队列任务完成后使用。 */ () => win.close());
    try { config = sanitizeConfig(store.get(KEYS.config)); } catch { initialError = '脚本设置损坏或浏览器存储不可用。请清理脚本设置后刷新。'; }
    const host = doc.createElement('aside');
    host.id = 'nsu-study-helper';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>'
      + ':host{all:initial;position:fixed;top:16px;right:16px;z-index:2147483000;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#222;letter-spacing:0}'
      + '*{box-sizing:border-box}section{width:300px;max-width:calc(100vw - 32px);background:#fff;border:1px solid #a9b4b3;border-radius:6px;box-shadow:0 3px 16px #0002;overflow:hidden}'
      + 'header{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:#f0f5f4;border-bottom:1px solid #dce3e2}strong{font-size:14px}'
      + 'button,input{font:inherit}button{cursor:pointer;border:1px solid #a9b4b3;background:#fff;border-radius:4px;padding:5px 10px;color:#222;min-height:32px}'
      + 'button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #00796b;outline-offset:2px}'
      + '#collapse{width:28px;padding:0}main{padding:12px;max-height:calc(100vh - 90px);overflow:auto}label{display:flex;align-items:center;gap:6px;margin-bottom:8px}'
      + 'input[type=text]{width:100%;min-width:0;border:1px solid #a9b4b3;border-radius:3px;padding:5px}input[type=number]{width:62px;max-width:100%;padding:3px;border:1px solid #a9b4b3}'
      + '.row{display:flex;gap:12px;flex-wrap:wrap}.buttons{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}#start{background:#00796b;color:#fff;border-color:#00796b}#stop,#stopAll{color:#ab2734}'
      + 'output{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:#43524f}#status{margin-top:10px;color:#222}#media{font-variant-numeric:tabular-nums;margin-top:6px}'
      + '[hidden]{display:none!important}</style>'
      + '<section aria-label="NSU 学习助手"><header><strong>NSU 学习助手</strong><small>0.3.1</small><button id="collapse" title="收起面板" aria-label="收起面板" aria-expanded="true">-</button></header><main>'
      + '<label><input id="dryRun" type="checkbox">试运行</label><label><input id="autoNext" type="checkbox">自动续播下一视频</label><label><input id="muted" type="checkbox">静音播放</label>'
      + '<label for="keyword">视频名称筛选</label><input id="keyword" type="text" maxlength="100" placeholder="全部视频">'
      + '<div class="row"><label>最多 <input id="maxItems" type="number" min="1" max="50"> 项</label><label>限时 <input id="minutes" type="number" min="5" max="180"> 分钟</label></div>'
      + '<label>队列并发 <input id="concurrency" type="number" min="1" max="5"> 个视频</label>'
      + '<div class="buttons"><button id="inspect">检查</button><button id="start">开始</button><button id="stop" disabled>停止</button><button id="stopAll">全部停止</button></div>'
      + '<output id="summary"></output><output id="tasks"></output><div id="pending"></div><output id="media"></output><output id="status" role="status" aria-live="polite">尚未开始</output></main></section>';
    doc.documentElement.append(host);

    /** 在隔离样式的面板里定位一个控件。 */
    function field(id) { return shadow.getElementById(id); }
    /** 更新文字并同步运行期间的可操作控件。 */
    function status(message) {
      field('status').textContent = message;
      field('start').disabled = running || busy || Boolean(initialError) || needsReload;
      field('stop').disabled = !running && !busy;
      for (const key of Object.keys(DEFAULTS)) field(key).disabled = running || busy;
    }
    /** 从控件读取设置并保存；运行许可本身不会被永久保存。 */
    function saveConfig() {
      const next = {};
      for (const [key, value] of Object.entries(DEFAULTS)) next[key] = typeof value === 'boolean' ? field(key).checked : field(key).value;
      config = sanitizeConfig(next);
      store.set(KEYS.config, config);
      return config;
    }
    /** 获取且核对当前任务 ID，拒绝使用其他标签页的新任务。 */
    function currentJob() { return jobId ? readJob(store, jobId) : null; }
    /** 读取当前批次的独立任务，播放器之间不共用可变对象。 */
    function batchJobs() { return (plan?.jobs || []).map(/* 每项从自己的键读取。 */ id => readJob(store, id)); }
    /** 比较全局停止代号，避免旧停止命令影响以后显式新建的任务。 */
    function stopId() { return store.get(KEYS.stop)?.id || ''; }
    /** 保存当前目录的短期恢复快照，刷新不能抹掉已建立的视频任务。 */
    function checkpointPlan() {
      if (route?.kind !== 'course' || !plan) return false;
      const control = store.get(KEYS.control);
      if (control?.id !== plan.id || control.owner !== tabId || !['running', 'reloading'].includes(control.status)
          || plan.stopId !== stopId()) return false;
      session.set(KEYS.resume, { ...plan, savedAt: now() });
      return true;
    }
    /** 更新自己拥有的任务，防止过期标签页覆盖新任务。 */
    function updateJob(patch) {
      const job = currentJob();
      if (!job || (job.controllerOwner !== tabId && job.playerOwner !== tabId))
        throw new Error('任务不属于当前页面，已停止。');
      store.set(jobKey(jobId), { ...job, ...patch });
    }
    /** 恢复原生窗口打开函数和锁，不改变平台请求函数。 */
    function release() {
      if (pendingOpen) { needsReload = true; pendingOpen(false); }
      if (wrappedOpen && win.open === wrappedOpen) win.open = oldOpen;
      oldOpen = null; wrappedOpen = null;
      if (releasePlayer) releasePlayer();
      if (releaseSession) releaseSession();
      releasePlayer = null; releaseSession = null;
    }
    /** 立即停止脚本、暂停自己控制的视频并撤销后续任务。 */
    function stop(message = '已停止。', publish = true) {
      win.clearTimeout(restoreTimer); restoreTimer = null;
      if (!video && releasePlayer && route?.kind === 'resource') {
        const candidates = doc.querySelectorAll('video#dPlayerVideoMain');
        if (candidates.length === 1) video = candidates[0];
        else cancelledUntil = now() + 20000;
      }
      sequence += 1; running = false; busy = false;
      if (video) { video.pause(); if (savedMuted !== null) video.muted = savedMuted; }
      try {
        if (plan) {
          const control = store.get(KEYS.control);
          if (control?.id === plan.id && control.owner === tabId) {
            store.set(KEYS.control, { ...control, status: publish ? 'stopped' : 'finished', message, heartbeat: now() });
            if (publish) for (const job of batchJobs()) {
              if (job && !['verified', 'stopped'].includes(job.status))
                store.set(commandKey(job.id), { action: 'stop', message });
            }
            renderBatch();
          }
        }
        const job = currentJob();
        if (!plan && publish && job && (job.controllerOwner === tabId || job.playerOwner === tabId))
          updateJob({ status: 'stopped', message, heartbeat: now() });
        session.remove(KEYS.resume);
      } catch { message += '\n本地存储异常，请关闭相关学习标签页。'; }
      plan = null; endAt = 0; savedMuted = null; release(); field('pending').replaceChildren(); status(message);
    }
    /** 广播给所有本脚本视频，包括其他手动打开的独立视频。 */
    function stopAll() {
      try { store.set(KEYS.stop, { id: win.crypto.randomUUID(), at: now() }); stop('全部停止命令已发送。'); }
      catch { stop('无法广播停止，请手动关闭其他播放页面。'); }
    }
    /** 更新只读摘要；试运行绝不会点击课程按钮或启动播放器。 */
    function inspect() {
      try {
        if (!running) saveConfig();
        if (route?.kind === 'course') {
          const items = readResources(doc), queue = selectQueue(items, config);
          field('summary').textContent = '已读取 ' + items.length + ' 项；平台已完成 ' + items.filter(isComplete).length + ' 项。\n本次队列 ' + queue.length + ' 项，并发 ' + Math.min(config.concurrency, queue.length) + '：\n' + queue.map(/* 显示名称，不导出账户数据。 */ item => item.title).join('\n');
          return queue;
        }
        field('summary').textContent = route?.kind === 'resource' ? '当前资源：' + doc.querySelectorAll('video#dPlayerVideoMain').length + ' 个适配播放器' : '请进入课程详情或资源学习页。';
        return [];
      } catch (error) { status(error.message); return null; }
    }
    /** 逐项等待平台异步打开窗口，地址确定后再关联任务，避免并发串线。 */
    function waitForResourceOpen(item, job) {
      return new Promise(/* 开窗、超时或停止三条路径都要恢复原生函数。 */ resolve => {
        const originalOpen = win.open;
        let settled = false, timeout = null;
        /** 撤销临时观察，并且只完成一次等待。 */
        function finish(captured) {
          if (settled) return;
          settled = true; win.clearTimeout(timeout);
          if (win.open === wrappedOpen) win.open = originalOpen;
          oldOpen = null; wrappedOpen = null; pendingOpen = null;
          resolve(captured);
        }
        oldOpen = originalOpen; pendingOpen = finish;
        /** 只关联同一课程当前等待的原生开窗；保留其他开窗和原生安全参数。 */
        wrappedOpen = function observeOpen(url, ...args) {
          let matched = false;
          try {
            const target = new URL(String(url), win.location.href), parsed = parseRoute(target.pathname);
            const current = readJob(store, job.id);
            if (running && plan?.jobs.includes(job.id) && current?.status === 'opening' && !current.expectedPath
                && !target.hash && target.origin === win.location.origin && parsed?.kind === 'resource' && parsed.scope === route.scope) {
              target.hash = 'nsu-study-helper=' + job.launchToken;
              store.set(jobKey(job.id), { ...current, expectedPath: parsed.path, canReopen: !target.search,
                windowFeatures: args[1] || '', createdAt: now(), heartbeat: now() });
              url = target.href; matched = true;
              if ((!args[0] || args[0] === '_blank') && job.playerTarget) args[0] = job.playerTarget;
            }
          } catch { needsReload = true; finish(false); }
          const result = Reflect.apply(originalOpen, win, [url, ...args]);
          if (matched) finish(true);
          return result;
        };
        win.open = wrappedOpen;
        timeout = win.setTimeout(/* 未知迟到请求不能与下一次任务混用，要求刷新后重试。 */ () => {
          needsReload = true; finish(false);
        }, options.openWaitMs ?? 30000);
        try { item.button.click(); }
        catch { needsReload = true; finish(false); }
      });
    }
    /** 用户在等待期间自行点击其他学习按钮时，取消自动关联以免认错资源。 */
    function onManualResourceClick(event) {
      if (pendingOpen && event.isTrusted && event.target?.closest?.('.resItem button'))
        stop('检测到手动打开资源，已取消自动关联；请刷新目录后重试队列。');
    }
    /** 创建随机任务标识，限制当前队列的总运行时间。 */
    function newJob(source, title, expectedPath, slot = 0) {
      jobId = win.crypto.randomUUID();
      const job = { id: jobId, source, title, scope: route.scope, expectedPath,
        controllerOwner: tabId, playerOwner: null, groupId: plan?.id || null, stopId: stopId(),
        slot, playerTarget: plan ? 'nsu_study_job_' + jobId : null, launchToken: jobId, config,
        status: 'opening', createdAt: now(), heartbeat: now(), deadline: plan?.deadline || now() + config.minutes * 60000 };
      store.set(jobKey(job.id), job);
      return job;
    }
    /** 初次填充或补充已确认完成的播放槽，已有播放中的资源不会重新打开。 */
    async function launchBatch() {
      const stamp = sequence;
      const blocker = detectBlocker(doc, win);
      if (blocker) { stop(blocker); return; }
      const occupants = batchJobs().filter(/* 只有确认完成的资源才释放队列槽位。 */ job => job && job.status !== 'verified');
      plan.jobs = occupants.map(/* 保留其他窗口的任务。 */ job => job.id);
      const slots = Array.from({ length: config.concurrency }, (_, index) => index)
        .filter(/* 老版恢复记录没有 slot 时按原顺序兼容。 */ slot => !occupants.some((job, index) => (job.slot ?? index) === slot));
      if (!slots.length) return;
      const items = readResources(doc), chosen = [];
      for (const title of [...plan.remaining]) {
        if (occupants.some(/* 不重复打开已占槽的视频。 */ job => job.title === title)) continue;
        const matches = items.filter(/* 点击前重新核对名称。 */ item => item.title === title);
        if (matches.length !== 1 || !matches[0].enabled || !matches[0].available) { stop('资源消失、重名或已不可学习，请重新检查。'); return; }
        if (isComplete(matches[0])) { plan.remaining = plan.remaining.filter(/* 移除服务器已确认项。 */ name => name !== title); continue; }
        if (!selectQueue(matches, { ...config, keyword: '' }).length) { stop('资源不再符合视频队列条件。'); return; }
        chosen.push(matches[0]);
        if (chosen.length >= slots.length) break;
      }
      if (!chosen.length) { if (!occupants.length) stop('本次队列已核对完成。', false); return; }
      plan.phase = 'playing'; plan.retries = 0; pendingSignature = ''; busy = true;
      for (let index = 0; index < chosen.length && running && stamp === sequence; index += 1) {
        const job = newJob('queue', chosen[index].title, null, slots[index]); plan.jobs.push(job.id);
        renderBatch(); status('正在关联新视频：' + job.title);
        const captured = await waitForResourceOpen(chosen[index], job);
        if (stamp !== sequence || !running) return;
        if (!captured) {
          stop('未能关联平台打开的视频，请刷新目录后重试。不会猜测或接管其他资源。'); return;
        }
      }
      if (running && stamp === sequence) {
        busy = false; checkpointPlan(); renderBatch();
        status(config.autoNext ? '队列运行中；完成确认后自动补充下一视频。' : '自动续播未开启，本轮视频结束后停止。');
      }
    }
    /** 展示每项状态，等待中的资源保留独立的用户手动打开入口。 */
    function renderBatch() {
      const jobs = batchJobs().filter(Boolean);
      const labels = { opening: '等待打开', loading: '加载中', playing: '播放中', settling: '等待保存', ended: '待核对', verified: '已确认', stopped: '已停止' };
      field('tasks').textContent = jobs.map(/* 独立展示，不把本地结束标成完成。 */ job => job.title + '：' + (labels[job.status] || '未知')).join('\n');
      const pending = jobs.filter(/* 仅重开已观察到完整无查询参数路径的等待项。 */ job => job.status === 'opening' && job.expectedPath && job.canReopen);
      const signature = pending.map(/* ID 变化时才重建按钮，保持焦点稳定。 */ job => job.id).join(',');
      if (signature === pendingSignature) return;
      pendingSignature = signature; field('pending').replaceChildren();
      for (const [index, job] of pending.entries()) {
        const button = doc.createElement('button'); button.textContent = '打开待播 ' + (index + 1); button.title = job.title;
        button.addEventListener('click', /* 用户点击提供正常的浏览器打开动作。 */ () => openPending(job.id));
        field('pending').append(button);
      }
    }
    /** 用户显式重开被拦截的资源，保留原生安全特性，不更改浏览器权限。 */
    function openPending(id) {
      try {
        checkControl();
        if (!running || !plan?.jobs.includes(id)) return;
        const job = readJob(store, id);
        if (!job || job.status !== 'opening' || !job.canReopen || now() >= job.deadline) return;
        store.set(jobKey(id), { ...job, createdAt: now(), heartbeat: now() });
        win.open(win.location.origin + job.expectedPath + '#nsu-study-helper=' + job.launchToken, job.playerTarget, job.windowFeatures);
      } catch (error) { stop(error.message); }
    }
    /** 服务错误覆盖层不能否定正在正常推进的视频；真实暂停/媒体错误仍会停止。 */
    function resourceBlocker() {
      const candidate = video || doc.querySelector('video#dPlayerVideoMain');
      return detectBlocker(doc, win, { allowPlaybackError: Boolean(candidate && !candidate.error
        && (!candidate.paused || mediaFinished(candidate))) });
    }
    /** 完成后仅关闭本队列精确关联的资源窗口，不关闭手动打开的其他页面。 */
    function finishPlayback(job, prompt = null) {
      const blocker = detectBlocker(doc, win, { allowPlaybackError: true });
      if (blocker) { stop(blocker); return; }
      running = false; busy = false; release();
      if (savedMuted !== null && video) video.muted = savedMuted;
      status('平台已确认学习完成。');
      if (prompt?.button) prompt.button.click();
      const token = taskToken(win);
      if (!closeAttempted && job.source === 'queue' && token === job.launchToken && route?.path === job.expectedPath
          && job.playerTarget && win.name === job.playerTarget) {
        closeAttempted = true; closeWindow();
      }
    }
    /** 自然播放结束且出现精确成功提示时，先保存证据，再确认弹窗及关闭队列窗口。 */
    function confirmCompletion(candidate = video) {
      const blocker = detectBlocker(doc, win, { allowPlaybackError: true });
      if (blocker) { stop(blocker); return false; }
      const prompt = findCompletionPrompt(doc, win);
      if (!prompt || !mediaFinished(candidate)) return false;
      const job = currentJob();
      if (!job || job.status === 'stopped') return false;
      video = candidate;
      updateJob({ status: 'verified', completionSource: 'platform-message', completedAt: now(), heartbeat: now() });
      finishPlayback(currentJob(), prompt);
      return true;
    }
    /** 在原生视频上尝试正常播放；浏览器禁止自动播放时交由用户处理。 */
    async function playVideo() {
      const stamp = sequence;
      const blocker = resourceBlocker();
      if (blocker) { stop(blocker); return; }
      const videos = doc.querySelectorAll('video#dPlayerVideoMain');
      if (videos.length !== 1) throw new Error('未找到唯一的学校播放器。');
      const candidate = videos[0];
      if (confirmCompletion(candidate)) return;
      if (!releasePlayer) {
        const unlock = await takePlayerLocks(win, route.path);
        if (stamp !== sequence) { if (unlock) unlock(); return; }
        releasePlayer = unlock;
      }
      if (!currentJob() || currentJob().status === 'stopped') { stop('关联任务已停止。', false); return; }
      video = candidate; savedMuted = video.muted;
      field('summary').textContent = '当前资源：1 个适配播放器，已接管';
      if (mediaFinished(candidate)) {
        endAt = now();
        updateJob({ status: 'ended', playerOwner: tabId, heartbeat: now() });
        release();
        status('视频已结束，等待平台提示或目录确认；不会重复播放。');
        return;
      }
      if (config.muted) video.muted = true;
      video.loop = false;
      lastTime = video.currentTime; lastAdvance = now(); endAt = 0;
      updateJob({ status: 'playing', playerOwner: tabId, heartbeat: now() });
      playSince = now();
      try { await video.play(); }
      catch { throw new Error('浏览器阻止了播放。请手动点击播放器播放，再点击脚本开始。'); }
      finally { if (stamp === sequence) playSince = 0; }
      if (stamp !== sequence || !running || !currentJob() || currentJob().status === 'stopped') {
        if (!running) candidate.pause();
        return;
      }
      status('正常播放中；平台记录仍需在课程目录核对。');
    }
    /** 用户显式启动；试运行只显示候选，不产生学习动作。 */
    async function start() {
      if (running || busy || initialError || needsReload) return;
      cancelledUntil = 0;
      closeAttempted = false;
      const stamp = ++sequence;
      try {
        saveConfig(); route = parseRoute(win.location.pathname);
        if (!route) throw new Error('请在课程详情或资源学习页启动。');
        const queue = inspect();
        if (queue === null) return;
        if (config.dryRun) { status('试运行完成，未点击资源、未控制视频。'); return; }
        const blocker = route.kind === 'resource' ? resourceBlocker() : detectBlocker(doc, win);
        if (blocker) throw new Error(blocker);
        busy = true; status('正在取得运行锁……');
        const existing = store.get(KEYS.job);
        if (existing && ['opening', 'playing', 'settling'].includes(existing.status) && now() - existing.heartbeat < 60000)
          throw new Error('旧版脚本仍在运行，请先停止并刷新旧标签页。');
        if (route.kind === 'course') {
          const unlock = await takeLock(win, 'session');
          if (stamp !== sequence) { if (unlock) unlock(); return; }
          if (!unlock) throw new Error('另一个学习队列正在运行，请先停止它。');
          releaseSession = unlock;
        }
        running = true; busy = false;
        if (route.kind === 'course') {
          if (!queue.length) { stop('没有符合条件的未完成视频。'); return; }
          const id = win.crypto.randomUUID();
          plan = { id, path: route.path, stopId: stopId(), jobs: [],
            playerTargets: Array.from({ length: config.concurrency }, /* 每个并发槽有独立且可复用的窗口名。 */ (_, index) => 'nsu_study_' + id + '_' + index),
            remaining: queue.map(/* 只保存名称列表。 */ item => item.title), deadline: now() + config.minutes * 60000, config, phase: 'playing', retries: 0 };
          store.set(KEYS.control, { id, owner: tabId, status: 'running', heartbeat: now(), deadline: plan.deadline });
          await launchBatch();
        } else {
          newJob('single', '', route.path); busy = true; await playVideo();
          if (stamp === sequence) { busy = false; status(field('status').textContent); }
        }
      } catch (error) { if (stamp === sequence) stop(error.message); }
    }
    /** 只允许在当前导航新建且路径完全匹配的资源页认领队列任务。 */
    async function attach() {
      try {
        const token = taskToken(win);
        if (!token || !/^[a-zA-Z0-9-]{1,80}$/.test(token)) return;
        const job = readJob(store, token);
        if (job?.status === 'stopped' && job.launchToken === token && job.expectedPath === route?.path
            && bootTime >= job.createdAt && now() < job.deadline) {
          cancelledUntil = now() + 20000; status('此资源任务已取消，不会自动播放。'); return;
        }
        if (!canClaim(job, route, bootTime, now(), token)) return;
        const stamp = sequence;
        const unlock = await takePlayerLocks(win, route.path);
        if (stamp !== sequence || !canClaim(readJob(store, token), route, bootTime, now(), token)) { unlock(); return; }
        releasePlayer = unlock;
        store.set(jobKey(job.id), { ...job, playerOwner: tabId, status: 'loading', heartbeat: now() });
        jobId = job.id; running = true; loadingSince = now();
        config = sanitizeConfig(job.config);
        checkControl();
        if (!running) return;
        status('已关联课程队列，等待播放器加载。');
      } catch (error) { stop(error.message); }
    }
    /** 保存一次有期限的课程恢复记录，刷新后重新读取服务器渲染的状态。 */
    function reloadCourse(delay) {
      plan.phase = 'verify'; plan.verifyAt = now() + delay;
      checkpointPlan();
      status('等待平台记录更新，' + Math.ceil(delay / 1000) + ' 秒后核对。');
    }
    /** 只在短期宽限内恢复同一目录、同一队列；显式停止和过期记录不会恢复。 */
    async function restore() {
      if (running || busy) return;
      const stamp = sequence;
      try {
        const saved = session.get(KEYS.resume);
        if (!saved) return;
        if (route?.kind !== 'course' || saved.path !== route.path || !['playing', 'verify', 'checking'].includes(saved.phase)
            || !Number.isFinite(saved.deadline) || now() >= saved.deadline)
          return;
        if (!Array.isArray(saved.jobs) || saved.jobs.length < 1 || saved.jobs.length > 5) return;
        if (!Array.isArray(saved.remaining) || saved.remaining.some(title => typeof title !== 'string')) return;
        const control = store.get(KEYS.control);
        const savedAt = saved.savedAt ?? control?.heartbeat;
        if (!control || control.id !== saved.id || !['running', 'reloading'].includes(control.status) || saved.stopId !== stopId()
            || !Number.isFinite(savedAt) || now() - savedAt > RECOVERY_GRACE_MS
            || !Number.isFinite(control.heartbeat) || now() - control.heartbeat > RECOVERY_GRACE_MS) {
          session.remove(KEYS.resume); status('恢复记录已停止或过期，请重新检查后开始。'); return;
        }
        const jobs = saved.jobs.map(/* 恢复的每一项必须仍属于这个队列。 */ id => readJob(store, id));
        if (jobs.some(job => !job || job.groupId !== saved.id || !['opening', 'loading', 'playing', 'settling', 'ended', 'verified', 'stopped'].includes(job.status))) return;
        busy = true; status('正在恢复原队列……');
        const unlock = await takeLock(win, 'session');
        if (stamp !== sequence) { if (unlock) unlock(); return; }
        if (!unlock) {
          status('等待原目录释放控制权，恢复记录已保留。');
          restoreTimer = win.setTimeout(/* 锁交接可能晚一个事件循环，宽限期内再尝试。 */ () => {
            restoreTimer = null;
            if (closed || stamp !== sequence) return;
            busy = false; restore();
          }, options.restoreRetryMs ?? 250);
          return;
        }
        const fresh = store.get(KEYS.control);
        if (!fresh || fresh.id !== saved.id || !['running', 'reloading'].includes(fresh.status) || saved.stopId !== stopId()) {
          unlock(); session.remove(KEYS.resume); busy = false; status('原队列已经停止，未恢复。'); return;
        }
        plan = saved; config = sanitizeConfig(saved.config); needsReload = false;
        releaseSession = unlock; running = true; loadingSince = now();
        store.set(KEYS.control, { ...fresh, status: 'running', owner: tabId, heartbeat: now() });
        for (const job of jobs) {
          if (job.status === 'opening' && !job.expectedPath)
            store.set(commandKey(job.id), { action: 'stop', message: '目录刷新时该资源尚未完成关联，请稍后重新开始。' });
        }
        const hasActive = batchJobs().some(job => ['opening', 'loading', 'playing', 'settling'].includes(job.status));
        plan.phase = hasActive || saved.phase === 'playing' ? 'playing' : 'checking';
        for (const [key, value] of Object.entries(config)) {
          if (typeof value === 'boolean') field(key).checked = value; else field(key).value = value;
        }
        busy = false; renderBatch(); checkpointPlan(); status('已恢复原队列，继续等待或核对已有视频。');
      } catch (error) { stop(error.message); }
      finally {
        if (stamp === sequence && !running && restoreTimer === null) { busy = false; status(field('status').textContent); }
      }
    }
    /** 目录只写控制心跳；每个播放器只写自己的任务，避免并发丢失更新。 */
    async function courseTick() {
      const control = store.get(KEYS.control);
      if (!control || control.id !== plan.id || control.owner !== tabId) { stop('队列控制权已失效。', false); return; }
      store.set(KEYS.control, { ...control, heartbeat: now() });
      const jobs = batchJobs();
      if (jobs.some(/* 缺失任务不能被当作完成。 */ job => !job)) { stop('批次任务丢失，已停止。'); return; }
      renderBatch();
      const confirmed = jobs.filter(/* 平台完成提示或目录核对都是明确完成凭据。 */ job => job.status === 'verified');
      for (const job of confirmed) plan.remaining = plan.remaining.filter(/* 完成项永不重复播放。 */ title => title !== job.title);
      if (confirmed.length && !jobs.some(job => job.status === 'stopped')) {
        const waiting = plan.remaining.some(/* 还有未进入当前窗口的课程时才补槽。 */ title => !jobs.some(job => job.title === title && job.status !== 'verified'));
        if (config.autoNext && waiting) { await launchBatch(); return; }
        if (confirmed.length === jobs.length) { stop('平台已确认本轮完成；本次队列停止。', false); return; }
      }
      const blocker = detectBlocker(doc, win);
      if (/本人验证|手动登录|确认窗口/.test(blocker)) { stop(blocker); return; }
      if (jobs.some(/* 登录与验证会影响整个账户，立即停止本批。 */ job => /本人验证|手动登录/.test(job.message || ''))) {
        stop('本批需要登录或本人验证，已停止全部队列视频。'); return;
      }
      if (plan.phase === 'verify') {
        if (now() >= plan.verifyAt) { checkpointPlan(); running = false; release(); navigate(); }
        return;
      }
      if (plan.phase === 'checking') {
        const resources = readResources(doc);
        if (!resources.length && now() - loadingSince < 20000) return;
        let pending = 0;
        for (const job of jobs) {
          if (job.status === 'stopped' || job.status === 'verified') continue;
          const matches = resources.filter(/* 每个视频只核对自己的标题。 */ item => item.title === job.title);
          if (matches.length > 1) { stop('同名资源无法唯一核对，已停止。'); return; }
          if (!blocker && matches.length === 1 && isComplete(matches[0])) {
            store.set(jobKey(job.id), { ...job, status: 'verified' });
            plan.remaining = plan.remaining.filter(/* 只移除已经核对通过的视频。 */ title => title !== job.title);
          } else pending += 1;
        }
        renderBatch();
        if (!pending) {
          if (jobs.some(/* 失败项保留，用户稍后手动检查，不自动重播。 */ job => job.status === 'stopped')) {
            stop('本批存在失败项；其他视频已单独核对，队列不再继续。', false); return;
          }
          if (!config.autoNext || !plan.remaining.length) { stop('平台已确认本批完成；本次队列停止。', false); return; }
          await launchBatch(); return;
        }
        if (plan.retries >= RETRY_DELAYS.length) { stop('平台尚未确认本批全部完成，已停止。不会重复播放或跳过。'); return; }
        reloadCourse(RETRY_DELAYS[plan.retries++]); return;
      }
      for (const job of jobs) {
        let message = '';
        if (job.status === 'opening' && now() - job.createdAt >= 120000)
          message = '资源页未关联成功，请检查弹窗拦截或使用打开待播按钮。';
        if (['loading', 'playing', 'settling'].includes(job.status) && now() - job.heartbeat > 60000)
          message = '资源页长时间无响应，可能已关闭或网络中断。';
        if (message) store.set(commandKey(job.id), { action: 'stop', message });
      }
      const latest = batchJobs();
      if (latest.every(/* 只有整批没有活动播放时才能刷新课程目录。 */ job => ['ended', 'verified', 'stopped'].includes(job.status))) {
        if (latest.every(/* 全部失败时无需额外请求平台。 */ job => job.status === 'stopped')) {
          stop('本批资源页未关联成功或全部失败，请检查弹窗和网络。'); return;
        }
        reloadCourse(10000);
      }
    }
    /** 资源端检查自然结束、暂停、卡顿、错误和跨标签页停止命令。 */
    async function resourceTick() {
      const job = currentJob();
      if (!job || job.status === 'stopped' || now() >= job.deadline) { stop(job?.message || '任务已停止或超过时限。', false); return; }
      if (job.status === 'verified') { finishPlayback(job); return; }
      if (confirmCompletion()) return;
      const blocker = resourceBlocker();
      if (blocker) { stop(blocker); return; }
      if (!video) {
        if (doc.querySelectorAll('video#dPlayerVideoMain').length === 1) await playVideo();
        else if (now() - loadingSince > 20000) stop('播放器加载超时，请等待平台恢复。');
        return;
      }
      if (!video.isConnected || video.error) { stop('播放器已切换或发生媒体错误，请手动检查。'); return; }
      field('media').textContent = clock(video.currentTime) + ' / ' + clock(video.duration);
      if (mediaFinished(video)) {
        if (!endAt) { endAt = now(); updateJob({ status: 'settling', heartbeat: now() }); status('视频自然结束，等待平台保存记录。'); }
        if (now() - endAt >= 8000 && job.status !== 'ended') {
          updateJob({ status: 'ended', heartbeat: now() });
          release();
          if (savedMuted !== null) video.muted = savedMuted;
          status('播放已结束，继续等待平台完成提示或课程目录确认。');
        }
        updateJob({ heartbeat: now() });
        if (job.source === 'single' && now() - endAt > 120000) {
          status('平台确认延迟，仍在本次运行时限内等待；不会重新播放。');
        }
        return;
      }
      if (video.paused) { stop('视频已暂停，脚本不会强制恢复；请检查页面后重新开始。'); return; }
      if (Math.abs(video.currentTime - lastTime) > 0.1) { lastTime = video.currentTime; lastAdvance = now(); }
      if (now() - lastAdvance > 45000) { stop('视频超过 45 秒未前进，可能是网络或平台故障。'); return; }
      updateJob({ heartbeat: now() });
    }
    /** 即使播放 Promise 尚未返回，也处理跨标签停止、超时和页面错误。 */
    function checkControl() {
      if (!running) return;
      try {
        if (route?.kind === 'course') {
          const control = store.get(KEYS.control);
          if (!plan || control?.id !== plan.id || control.owner !== tabId || control.status !== 'running') { stop('队列已停止或失去控制权。', false); return; }
          if (plan.stopId !== stopId()) { stop('收到全部停止命令。'); return; }
          store.set(KEYS.control, { ...control, heartbeat: now() });
          if (now() >= plan.deadline) stop('任务超过运行时限。');
          return;
        }
        const job = currentJob();
        if (!job || job.status === 'stopped') { stop(job?.message || '关联任务已停止。', false); return; }
        if (job.stopId !== stopId()) { stop('收到全部停止命令。'); return; }
        if (now() >= job.deadline) { stop('任务超过运行时限。'); return; }
        if (job.status === 'verified') { finishPlayback(job); return; }
        if (route?.kind === 'resource') {
          if (job.source === 'queue') {
            const control = store.get(KEYS.control);
            if (control?.id !== job.groupId || !['running', 'reloading'].includes(control.status)
                || now() - control.heartbeat > RECOVERY_GRACE_MS) {
              stop('课程队列已停止或长时间无响应。'); return;
            }
          }
          const blocker = resourceBlocker();
          if (blocker) { stop(blocker); return; }
          if (playSince && now() - playSince > 15000) stop('播放启动超过 15 秒未响应，请等待平台恢复。');
        }
      } catch { stop('浏览器存储不可用，已停止。', false); }
    }
    /** 收到共享任务变更时立即检查停止信号，不等待异步播放返回。 */
    function onStorage(event) {
      if (event.key === null || event.key === KEYS.stop || event.key === KEYS.control
          || (jobId && (event.key === jobKey(jobId) || event.key === commandKey(jobId)))) checkControl();
    }
    /** 串行执行状态检查，同时始终保留紧急停止通道。 */
    async function tick() {
      if (closed) return;
      if (cancelledUntil && now() <= cancelledUntil) {
        const candidates = doc.querySelectorAll('video#dPlayerVideoMain');
        if (candidates.length === 1) candidates[0].pause();
        return;
      }
      checkControl();
      const nextRoute = parseRoute(win.location.pathname);
      if (nextRoute?.path !== route?.path) {
        if (running) stop('页面已切换，请在新页面重新开始。');
        route = nextRoute;
      }
      if (busy) return;
      if (!running) return;
      const stamp = sequence;
      busy = true;
      try { if (route?.kind === 'course') await courseTick(); else if (route?.kind === 'resource') await resourceTick(); }
      catch (error) { if (running && stamp === sequence) stop(error.message); }
      finally {
        if (stamp === sequence) {
          busy = false;
          if (running && route?.kind === 'course') {
            try { checkpointPlan(); } catch { stop('队列恢复记录无法保存，已停止。'); }
          }
          if (!closed) status(field('status').textContent);
        }
      }
    }
    /** 资源退出仍停止自身；目录离开则给短暂刷新保留恢复宽限，不广播停止。 */
    function unload() {
      sequence += 1;
      win.clearTimeout(restoreTimer); restoreTimer = null;
      busy = false;
      if (running && route?.kind === 'resource') stop('资源页被关闭或刷新。');
      else if (running && plan) {
        try {
          if (!checkpointPlan()) {
            session.remove(KEYS.resume); running = false; busy = false;
            status('队列控制权已变化，未保存恢复记录。'); release(); return;
          }
          const control = store.get(KEYS.control);
          if (control?.id === plan.id && control.owner === tabId)
            store.set(KEYS.control, { ...control, status: 'reloading', heartbeat: now() });
          running = false; busy = false;
        } catch { stop('无法保存目录恢复记录，已停止队列。'); }
      }
      release();
    }
    /** 浏览器从历史缓存恢复同一目录文档时，也要重新取得队列锁。 */
    function onPageShow(event) { if (event.persisted && !closed && route?.kind === 'course') restore(); }
    /** 移除监听器和面板，供离线测试或卸载使用。 */
    function destroy() {
      stop('助手已退出。'); closed = true; win.clearInterval(timer);
      win.removeEventListener('pagehide', unload); win.removeEventListener('storage', onStorage); host.remove();
      win.removeEventListener('pageshow', onPageShow);
      doc.removeEventListener('click', onManualResourceClick, true);
    }
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'boolean') field(key).checked = value; else field(key).value = value;
    }
    field('inspect').addEventListener('click', inspect);
    field('start').addEventListener('click', start);
    field('stop').addEventListener('click', /* 用户停止具有最高优先级。 */ () => stop());
    field('stopAll').addEventListener('click', stopAll);
    field('collapse').addEventListener('click', /* 收起面板不影响停止状态机。 */ () => {
      const main = shadow.querySelector('main'); main.hidden = !main.hidden;
      field('collapse').textContent = main.hidden ? '+' : '-';
      field('collapse').setAttribute('aria-expanded', String(!main.hidden));
      field('collapse').setAttribute('aria-label', main.hidden ? '展开面板' : '收起面板');
      field('collapse').title = main.hidden ? '展开面板' : '收起面板';
    });
    win.addEventListener('pagehide', unload);
    win.addEventListener('pageshow', onPageShow);
    doc.addEventListener('click', onManualResourceClick, true);
    win.addEventListener('storage', onStorage);
    timer = win.setInterval(tick, 1000);
    if (initialError) status(initialError);
    else {
      inspect();
      if (route?.kind === 'resource') attach();
      else if (route?.kind === 'course') restore();
    }
    return { start, stop, stopAll, tick, inspect, destroy, host, shadow };
  }
  return { DEFAULTS, KEYS, RETRY_DELAYS, clean, sanitizeConfig, parseRoute, isComplete, readResources, isCompletionText, findCompletionPrompt, mediaFinished,
    selectQueue, canClaim, taskToken, visible, detectBlocker, clock, makeStore, jobKey, commandKey, readJob, takeLock, takePlayerLocks, createApp };
});
