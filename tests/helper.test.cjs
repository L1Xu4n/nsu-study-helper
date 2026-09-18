'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const api = require('../nsu-study-helper.user.js');
const COURSE = '/courseStudy/studentLearnCourse/101/201/301/401/101';
const RESOURCE = '/resourcesLearning/index/101/401/501/601';

/** 构造不含真实学校资料的最小资源卡片。 */
function card(title = '示例视频.mp4', state = '未学习', progress = 0, extra = '') {
  return '<div class="resItem"><span class="file-name__span">' + title + '</span>'
    + '<div class="stateLabel">进行中</div><button>去学习</button>'
    + '<div role="progressbar" aria-valuenow="' + progress + '"></div><span>' + state + '</span>' + extra + '</div>';
}

/** 用共享 Map 模拟脚本命名空间，不接触真实浏览器存储。 */
function memoryStore() {
  const values = new Map();
  return {
    /** 模拟 JSON 深复制读取。 */
    get(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
    /** 模拟持久化写入。 */
    set(key, value) { values.set(key, structuredClone(value)); },
    /** 模拟删除。 */
    remove(key) { values.delete(key); },
    /** 仅枚举合成任务键，供测试断言相互隔离。 */
    jobs() { return [...values.keys()].filter(key => key.startsWith(api.KEYS.jobs)).map(key => api.readJob(this, key.slice(api.KEYS.jobs.length))); }
  };
}

/** 读取指定任务；未指定 ID 时读取测试中最新创建的任务。 */
function getJob(store, id) { return id ? api.readJob(store, id) : store.jobs().at(-1) || null; }

/** 写入一项合成任务，不覆盖同批其他视频。 */
function setJob(store, job) { store.set(api.jobKey(job.id), job); }

/** 构造已经播完、等待目录刷新核对的批次。 */
function seedVerification(store, session, retry = 0, jobs = [{ id: 'test', title: '示例视频.mp4', status: 'ended' }]) {
  for (const job of jobs) setJob(store, { ...job, source: 'queue', groupId: 'batch', deadline: 999999, stopId: '' });
  store.set(api.KEYS.control, { id: 'batch', owner: 'previous', status: 'running', heartbeat: 1000 });
  session.set(api.KEYS.resume, { id: 'batch', stopId: '', jobs: jobs.map(job => job.id), phase: 'verify', path: COURSE,
    deadline: 999999, playerTargets: ['fixture0', 'fixture1'], remaining: jobs.map(job => job.title), retries: retry,
    config: { ...api.DEFAULTS, dryRun: false } });
}

/** 模拟 Web Locks 的互斥语义，让两个页面共享同一锁管理器。 */
function locks() {
  const held = new Set();
  return {
    /** 在回调完成前持有锁，不可用时返回空锁。 */
    async request(name, options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); } finally { held.delete(name); }
    }
  };
}

/** 创建隔离页面和可控时钟，自动清理定时器。 */
function harness(t, { html = card(), path = COURSE, store = memoryStore(), session = memoryStore(), manager = locks(), time = 1000, openWaitMs = 100, windowName = '', restoreRetryMs = 5 } = {}) {
  const dom = new JSDOM(html, { url: 'https://study.nsu.edu.cn' + path, pretendToBeVisual: true });
  const win = dom.window;
  win.name = windowName;
  Object.defineProperty(win.navigator, 'locks', { value: manager });
  win.HTMLElement.prototype.getClientRects = /* jsdom 不计算布局，模拟可见节点。 */ function rects() { return [{ width: 100, height: 30 }]; };
  win.open = /* 模拟正常原生开窗，不启动外部浏览器。 */ () => null;
  win.document.querySelectorAll('.resItem button').forEach(/* 基础夹具提供真实按钮到资源地址的对应关系。 */ (button, index) => {
    button.onclick = () => win.open(RESOURCE.replace('501', String(501 + index)), '_blank');
  });
  let reloads = 0, closes = 0, current = time;
  const app = api.createApp(win, { store, session, openWaitMs, restoreRetryMs,
    closeWindow: /* 记录自动关闭，而不销毁测试断言所需的页面。 */ () => { closes += 1; },
    now: /* 使用可控时钟。 */ () => current, reload: /* 记录刷新次数。 */ () => { reloads += 1; } });
  t.after(/* 清理页面而不影响其他测试。 */ () => { app.destroy(); win.close(); });
  return { win, app, store, session, manager,
    /** 推进逻辑时间而不等待真实分钟。 */
    advance(ms) { current += ms; },
    /** 返回刷新统计。 */
    reloads() { return reloads; },
    /** 返回受控窗口关闭次数。 */
    closes() { return closes; },
    /** 关闭试运行并设置本次测试选项。 */
    live() { app.shadow.getElementById('dryRun').checked = false; },
    /** 读取面板当前状态。 */
    status() { return app.shadow.getElementById('status').textContent; }
  };
}

/** 模拟媒体属性和播放调用，不发送学习进度。 */
function media(win) {
  const video = win.document.querySelector('video');
  const state = { paused: true, ended: false, currentTime: 1, duration: 10, plays: 0, pauses: 0, error: null };
  for (const key of ['paused', 'ended', 'currentTime', 'duration', 'error'])
    Object.defineProperty(video, key, { configurable: true, get: /* 暴露测试状态。 */ () => state[key] });
  video.play = /* 模拟成功播放。 */ async function play() { state.plays += 1; state.paused = false; };
  video.pause = /* 模拟立即暂停。 */ function pause() { state.pauses += 1; state.paused = true; };
  return state;
}

// 以下各测试回调验证一个明确行为。
test('route parser rejects unrelated and malformed pages', () => {
  assert.deepEqual(api.parseRoute(COURSE), { kind: 'course', scope: '101:401', path: COURSE });
  assert.equal(api.parseRoute(RESOURCE).scope, '101:401');
  assert.equal(api.parseRoute('/login'), null);
  assert.equal(api.parseRoute(RESOURCE.replace('501', 'secret')), null);
});
test('config remains bounded and defaults to dry run', () => {
  assert.equal(api.sanitizeConfig(null).dryRun, true);
  assert.equal(api.sanitizeConfig({ maxItems: 999 }).maxItems, 50);
  assert.equal(api.sanitizeConfig({ minutes: -5 }).minutes, 5);
  assert.equal(api.clock(65), '00:01:05');
  assert.equal(api.clock(NaN), '--:--');
});
test('cards require exact completion text and percentage', t => {
  const h = harness(t, { html: card('已完成演示.mp4', '学习中', 100) + card('二.mp4', '已完成', 100) });
  const items = api.readResources(h.win.document);
  assert.equal(api.isComplete(items[0]), false);
  assert.equal(api.isComplete(items[1]), true);
  assert.deepEqual(api.selectQueue(items, api.DEFAULTS).map(x => x.title), ['已完成演示.mp4']);
});
test('queue filters documents, completed videos, closed resources and keyword', t => {
  const h = harness(t, { html: card('讲义.pdf') + card('第1项.mp4') + card('第2项.mp4', '已完成', 100) + card('不匹配.mp4') });
  assert.equal(api.selectQueue(api.readResources(h.win.document), { ...api.DEFAULTS, keyword: '第' }).length, 1);
});
test('duplicate names and contradictory completion fail closed', t => {
  const h = harness(t, { html: card() + card() });
  assert.throws(() => api.selectQueue(api.readResources(h.win.document), api.DEFAULTS), /同名/);
  h.win.document.body.innerHTML = card('一.mp4', '已完成', 10);
  assert.throws(() => api.selectQueue(api.readResources(h.win.document), api.DEFAULTS), /状态不明确/);
});
test('claim requires exact opened path, fresh navigation, scope and deadline', () => {
  const job = { status: 'opening', launchToken: 'once', expectedPath: RESOURCE, scope: '101:401', createdAt: 100, deadline: 50000 };
  assert.equal(api.canClaim(job, api.parseRoute(RESOURCE), 101, 102, 'once'), true);
  assert.equal(api.canClaim(job, api.parseRoute(RESOURCE), 99, 102, 'once'), false);
  assert.equal(api.canClaim(job, api.parseRoute(RESOURCE.replace('501', '502')), 101, 102, 'once'), false);
  assert.equal(api.canClaim(job, api.parseRoute(RESOURCE), 101, 130000, 'once'), false);
  assert.equal(api.canClaim(job, api.parseRoute(RESOURCE), 101, 102, 'wrong'), false);
});
test('hidden templates do not block, visible validation and service errors do', t => {
  const h = harness(t, { html: '<div class="captcha" hidden>验证码</div>' });
  assert.equal(api.detectBlocker(h.win.document, h.win), '');
  h.win.document.querySelector('.captcha').hidden = false;
  assert.match(api.detectBlocker(h.win.document, h.win), /本人验证/);
  h.win.document.body.innerHTML = '<div class="el-message--error">请求错误</div>';
  assert.match(api.detectBlocker(h.win.document, h.win), /平台请求异常/);
});
test('dry run performs no course clicks', async t => {
  const h = harness(t);
  let clicked = 0;
  h.win.document.querySelector('button').onclick = () => clicked++;
  await h.app.start();
  assert.equal(clicked, 0);
  assert.match(h.status(), /试运行完成/);
  assert.equal(getJob(h.store), null);
});
test('queue tags each player window and preserves native security features', async t => {
  const h = harness(t); h.live();
  const calls = [];
  const original = h.win.open = (...args) => { calls.push(args); return null; };
  h.win.document.querySelector('button').onclick = () => h.win.open(RESOURCE, '_blank', 'noopener');
  await h.app.start();
  assert.match(calls[0][1], /^nsu_study_/);
  assert.equal(calls[0][2], 'noopener');
  assert.equal(new URL(calls[0][0]).pathname, RESOURCE);
  assert.equal(new URL(calls[0][0]).hash, '#nsu-study-helper=' + getJob(h.store).launchToken);
  assert.equal(h.win.open, original);
  assert.equal(getJob(h.store).expectedPath, RESOURCE);
  h.app.stop();
  assert.equal(h.win.open, original);
  assert.equal(getJob(h.store).status, 'stopped');
});
test('a changed native opening mechanism stops after a finite handoff timeout', async t => {
  const h = harness(t); h.live();
  await h.app.start(); h.advance(121000); await h.app.tick();
  assert.match(h.status(), /未关联成功/);
});
test('second course tab cannot run while the first holds its lock', async t => {
  const store = memoryStore(), manager = locks();
  const a = harness(t, { store, manager }), b = harness(t, { store, manager });
  a.live(); b.live(); await a.app.start(); await b.app.start();
  assert.match(b.status(), /另一个学习队列/);
  assert.equal(getJob(store).status, 'opening');
});
test('video play, manual stop and native pause do not cause forced replay', async t => {
  const h = harness(t, { html: '<video id="dPlayerVideoMain"></video>', path: RESOURCE });
  const state = media(h.win); h.live(); await h.app.start();
  assert.equal(state.plays, 1);
  state.paused = true; await h.app.tick();
  assert.match(h.status(), /不会强制恢复/);
  assert.equal(state.plays, 1);
});
test('real media error pauses video and cancels the queue job', async t => {
  const h = harness(t, { html: '<video id="dPlayerVideoMain"></video>', path: RESOURCE });
  const state = media(h.win); h.live(); await h.app.start();
  h.win.document.body.insertAdjacentHTML('beforeend', '<div class="el-message--error">请求错误</div>');
  state.error = { code: 2 };
  await h.app.tick();
  assert.equal(state.paused, true);
  assert.equal(getJob(h.store).status, 'stopped');
});
test('natural end waits for saving and is never labeled platform completion', async t => {
  const h = harness(t, { html: '<video id="dPlayerVideoMain"></video>', path: RESOURCE });
  const state = media(h.win); h.live(); await h.app.start();
  state.ended = true; state.paused = true; state.currentTime = 10;
  await h.app.tick(); assert.equal(getJob(h.store).status, 'settling');
  h.advance(8001); await h.app.tick();
  assert.equal(getJob(h.store).status, 'ended');
  assert.match(h.status(), /等待平台完成提示/);
});
test('stalled playback and overall time limit both stop', async t => {
  const h = harness(t, { html: '<video id="dPlayerVideoMain"></video>', path: RESOURCE });
  const state = media(h.win); h.live(); await h.app.start();
  h.advance(46000); await h.app.tick(); assert.match(h.status(), /45 秒/);
  await h.app.start(); h.advance(91 * 60000); await h.app.tick();
  assert.equal(state.paused, true);
  assert.match(h.status(), /时限/);
});
test('a stop during pending play prevents eventual playback from continuing', async t => {
  const h = harness(t, { html: '<video id="dPlayerVideoMain"></video>', path: RESOURCE });
  const state = media(h.win); let finish;
  h.win.document.querySelector('video').play = () => new Promise(resolve => { finish = resolve; });
  h.live(); const pending = h.app.start();
  await new Promise(resolve => setImmediate(resolve));
  h.app.stop(); state.paused = false; finish(); await pending;
  assert.equal(state.paused, true);
  assert.equal(getJob(h.store).status, 'stopped');
});
test('course refresh is delayed and saves a bounded verification plan', async t => {
  const h = harness(t); h.live(); await h.app.start();
  const job = getJob(h.store); setJob(h.store, { ...job, status: 'ended' });
  await h.app.tick(); assert.equal(h.reloads(), 0);
  assert.equal(h.session.get(api.KEYS.resume).phase, 'verify');
  h.advance(10001); await h.app.tick(); assert.equal(h.reloads(), 1);
});
test('verification retries 15, 30, 60 seconds and then stops without advancing', async t => {
  for (let retry = 0; retry <= 3; retry++) {
    const store = memoryStore(), session = memoryStore();
    seedVerification(store, session, retry);
    const h = harness(t, { store, session });
    await new Promise(resolve => setImmediate(resolve));
    await h.app.tick();
    if (retry < 3) assert.equal(session.get(api.KEYS.resume).verifyAt, 1000 + api.RETRY_DELAYS[retry]);
    else assert.match(h.status(), /尚未确认.*完成/);
  }
});
test('verified completion does not replay the just-finished resource', async t => {
  const store = memoryStore(), session = memoryStore();
  seedVerification(store, session);
  const h = harness(t, { store, session, html: card('示例视频.mp4', '已完成', 100) });
  await new Promise(resolve => setImmediate(resolve)); await h.app.tick();
  assert.equal(getJob(store).status, 'verified');
  assert.match(h.status(), /平台已确认/);
});
test('JSON corruption is not silently overwritten', () => {
  const raw = new Map([['x', '{broken']]);
  const store = api.makeStore({ getItem: k => raw.get(k) ?? null, setItem: (k, v) => raw.set(k, v), removeItem: k => raw.delete(k) });
  assert.throws(() => store.get('x'));
  assert.equal(raw.get('x'), '{broken');
});

// 并发认领回归：只有赢得原子播放器锁的页面有共享停止权限。
test('duplicate child cannot claim or stop the actual player', async t => {
  const store = memoryStore(), manager = locks();
  store.set(api.KEYS.control, { id: 'batch', owner: 'course', status: 'running', heartbeat: 1000 });
  setJob(store, { id: 'once', source: 'queue', groupId: 'batch', stopId: '', status: 'opening', launchToken: 'once', expectedPath: RESOURCE,
    scope: '101:401', createdAt: 1000, heartbeat: 1000, deadline: 999999, controllerOwner: 'course', config: api.DEFAULTS });
  const first = harness(t, { store, manager, path: RESOURCE + '#nsu-study-helper=once', html: '<video id="dPlayerVideoMain"></video>' });
  const second = harness(t, { store, manager, path: RESOURCE + '#nsu-study-helper=once', html: '<video id="dPlayerVideoMain"></video>' });
  media(first.win); media(second.win);
  await new Promise(resolve => setImmediate(resolve));
  await first.app.tick();
  second.app.stop();
  assert.equal(getJob(store).status, 'playing');
});

// 远端停止回归：play Promise 未返回时也必须立刻暂停。
test('remote stop interrupts a pending play through the storage listener', async t => {
  const h = harness(t, { html: '<video id="dPlayerVideoMain"></video>', path: RESOURCE });
  const state = media(h.win); let finish;
  h.win.document.querySelector('video').play = () => new Promise(resolve => { finish = resolve; });
  h.live(); const pending = h.app.start();
  await new Promise(resolve => setImmediate(resolve));
  setJob(h.store, { ...getJob(h.store), status: 'stopped', message: '远端停止' });
  h.win.dispatchEvent(new h.win.StorageEvent('storage', { key: api.jobKey(getJob(h.store).id) }));
  assert.equal(state.paused, true);
  assert.match(h.status(), /远端停止/);
  finish(); await pending;
});


/** 生成与学校真实页面一致的成功提示，OK 是隐藏按钮，关闭是可见按钮。 */
function completionDialog() {
  return '<div class="el-message-box"><div class="el-message-box__message">你已完成该视频学习,学习状态已更新！  </div>'
    + '<button>关闭</button><button style="display:none">OK</button></div>';
}

/** 创建能自动关联的队列子窗口，不调用资源页开始按钮。 */
async function queueChild(t, course, index = 0, stripHash = false) {
  const target = new URL(course.calls[index][0]);
  const child = harness(t, { store: course.store, manager: course.manager,
    path: target.pathname + (stripHash ? '' : target.hash), windowName: course.calls[index][1],
    html: '<video id="dPlayerVideoMain"></video>' });
  child.media = media(child.win);
  await new Promise(resolve => setImmediate(resolve));
  await child.app.tick();
  return child;
}

// 原生窗口稍后才打开，任务标识也必须可靠注入。
test('async native window opening is captured before advancing to another resource', async t => {
  const h = harness(t); h.live(); const calls = [];
  const original = h.win.open = (...args) => { calls.push(args); return null; };
  h.win.document.querySelector('.resItem button').onclick = () => h.win.setTimeout(() => h.win.open(RESOURCE, '_blank'), 10);
  await h.app.start();
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0][0]).hash, '#nsu-study-helper=' + getJob(h.store).id);
  assert.equal(h.win.open, original);
});

// 未打开的未知请求不应被当作另一个资源继续关联。
test('missing async open stops with a reload requirement and restores the native opener', async t => {
  const h = harness(t, { openWaitMs: 5 }); h.live(); const original = h.win.open;
  h.win.document.querySelector('.resItem button').onclick = () => {};
  await h.app.start();
  assert.match(h.status(), /未能关联/);
  assert.equal(h.app.shadow.getElementById('start').disabled, true);
  assert.equal(h.win.open, original);
});

// 停止正在等待的异步开窗时，启动调用必须能结束且不能继续下一项。
test('stop cancels pending async opening without leaving a wrapper installed', async t => {
  const h = harness(t); h.live(); const original = h.win.open;
  h.win.document.querySelector('.resItem button').onclick = () => {};
  const pending = h.app.start(); await new Promise(resolve => setImmediate(resolve));
  h.app.stop(); await pending;
  assert.equal(h.win.open, original);
  assert.equal(getJob(h.store).status, 'stopped');
});

// 新窗口应自动接管，开始按钮禁用且原生视频已经播放。
test('a newly associated resource starts automatically without a manual start click', async t => {
  const course = parallelCourse(t); await course.app.start(); const child = await queueChild(t, course);
  assert.equal(child.media.plays, 1); assert.equal(child.media.paused, false);
  assert.equal(child.app.shadow.getElementById('start').disabled, true);
  assert.match(child.status(), /正常播放/);
});

// 可见服务错误文字不等于真实播放失败；时间仍推进时继续，卡住后停止。
test('stale request-error overlay does not stop a moving video but stalled media still stops', async t => {
  const h = harness(t, { path: RESOURCE, html: '<video id="dPlayerVideoMain"></video>' });
  const state = media(h.win); h.live(); await h.app.start();
  h.win.document.body.insertAdjacentHTML('beforeend', '<div class="d-loading">播放错误</div><div class="el-message--error">请求出错，请稍候重试504</div>');
  state.currentTime += 1; await h.app.tick();
  assert.equal(state.paused, false); assert.equal(getJob(h.store).status, 'playing');
  h.advance(46000); await h.app.tick(); assert.equal(state.paused, true);
});

// 先持久化平台确认，再点击真实可见的关闭按钮，最后关闭本队列窗口。
test('exact platform completion is acknowledged and closes only the associated queue window', async t => {
  const course = parallelCourse(t); await course.app.start(); const child = await queueChild(t, course);
  const id = new URL(course.calls[0][0]).hash.split('=')[1];
  child.media.currentTime = 10; child.media.ended = true; child.media.paused = true;
  child.win.document.body.insertAdjacentHTML('beforeend', completionDialog());
  let acknowledged = 0, stateAtAck;
  child.win.document.querySelector('.el-message-box button').onclick = () => { acknowledged++; stateAtAck = getJob(course.store, id).status; };
  await child.app.tick();
  assert.equal(acknowledged, 1); assert.equal(stateAtAck, 'verified'); assert.equal(child.closes(), 1);
  assert.equal(getJob(course.store, id).completionSource, 'platform-message');
});

// 完成提示可能晚于自然结束八秒出现，旧实现此时已经停止监听。
test('completion prompt arriving after natural end is still acknowledged', async t => {
  const course = parallelCourse(t); await course.app.start(); const child = await queueChild(t, course);
  child.media.currentTime = 10; child.media.ended = true; child.media.paused = true;
  await child.app.tick(); child.advance(9000); await child.app.tick();
  assert.equal(child.closes(), 0);
  child.win.document.body.insertAdjacentHTML('beforeend', completionDialog()); await child.app.tick();
  assert.equal(child.closes(), 1);
});

// 平台完成一项后补充一个空槽，另一项仍在播放时不刷新、不重开它。
test('a confirmed resource frees its slot and automatically opens the next video', async t => {
  const course = parallelCourse(t); await course.app.start(); const [first, sibling] = course.store.jobs();
  setJob(course.store, { ...first, status: 'verified', completionSource: 'platform-message' });
  setJob(course.store, { ...sibling, status: 'playing' });
  await course.app.tick();
  assert.equal(course.calls.length, 3); assert.equal(course.reloads(), 0);
  assert.equal(getJob(course.store, sibling.id).status, 'playing');
  assert.notEqual(course.calls[2][1], course.calls[0][1]);
  assert.equal(getJob(course.store).title, '视频2.mp4');
});

// 尊重用户关闭自动续播的选择，并给出明确状态。
test('disabled auto-next does not silently open a replacement video', async t => {
  const course = parallelCourse(t); course.app.shadow.getElementById('autoNext').checked = false;
  await course.app.start();
  for (const job of course.store.jobs()) setJob(course.store, { ...job, status: 'verified' });
  await course.app.tick(); assert.equal(course.calls.length, 2);
  assert.match(course.status(), /停止/);
});

// 手动打开的资源不具备队列来源，完成提示只能确认，不能擅自关闭。
test('manual single-video completion is acknowledged without closing a user-owned tab', async t => {
  const h = harness(t, { path: RESOURCE, html: '<video id="dPlayerVideoMain"></video>' });
  const state = media(h.win); h.live(); await h.app.start();
  state.currentTime = 10; state.ended = true; state.paused = true;
  h.win.document.body.insertAdjacentHTML('beforeend', completionDialog()); await h.app.tick();
  assert.equal(getJob(h.store).status, 'verified'); assert.equal(h.closes(), 0);
});

// 完成提示必须与真实媒体结束同时成立，普通确认框不能自动点击。
test('completion-like text before the actual end is never acknowledged', async t => {
  const h = harness(t, { path: RESOURCE, html: '<video id="dPlayerVideoMain"></video>' });
  media(h.win); h.live(); await h.app.start();
  h.win.document.body.insertAdjacentHTML('beforeend', completionDialog()); let clicks = 0;
  h.win.document.querySelector('.el-message-box button').onclick = () => clicks++;
  await h.app.tick(); assert.equal(clicks, 0); assert.equal(getJob(h.store).status, 'playing');
});


// 平台路由去掉 hash 后，专用窗口名仍能提供精确身份并自动开始。
test('window-name identity survives hash removal and permits owned completion close', async t => {
  const course = parallelCourse(t); await course.app.start(); const child = await queueChild(t, course, 0, true);
  assert.equal(child.media.plays, 1); assert.equal(child.win.location.hash, '');
  child.media.ended = true; child.media.paused = true; child.media.currentTime = 10;
  child.win.document.body.insertAdjacentHTML('beforeend', completionDialog()); await child.app.tick();
  assert.equal(child.closes(), 1);
});

// 普通用户窗口名和无效链接标识不能触发自动任务认领。
test('task identity ignores unrelated window names and malformed fragments', () => {
  assert.equal(api.taskToken({ location: { hash: '#nsu-study-helper=bad/value' }, name: 'ordinary-window' }), null);
  assert.equal(api.taskToken({ location: { hash: '' }, name: 'nsu_study_job_task-123' }), 'task-123');
});


// 目录刷新不是点击停止，不应取消仍在播放的资源。
test('catalog pagehide checkpoints the queue without stopping active video', async t => {
  const course = parallelCourse(t); await course.app.start(); const child = await queueChild(t, course);
  course.win.dispatchEvent(new course.win.Event('pagehide'));
  assert.equal(course.store.get(api.KEYS.control).status, 'reloading');
  assert.equal(course.session.get(api.KEYS.resume).phase, 'playing');
  await child.app.tick(); assert.equal(child.media.paused, false);
});

// 同一目录刷新后接回原队列，不重新打开或重播已有窗口。
test('catalog reload restores active jobs and continues after a child completes', async t => {
  const course = parallelCourse(t); await course.app.start(); const child = await queueChild(t, course);
  const originalIds = course.store.jobs().map(job => job.id);
  course.win.dispatchEvent(new course.win.Event('pagehide'));
  await new Promise(resolve => setImmediate(resolve));
  const restored = harness(t, { store: course.store, session: course.session, manager: course.manager, time: 1100,
    html: card('视频0.mp4') + card('视频1.mp4') + card('视频2.mp4') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored.app.shadow.getElementById('start').disabled, true);
  assert.deepEqual(course.store.jobs().map(job => job.id), originalIds);
  await child.app.tick(); assert.equal(child.media.paused, false);
  child.media.currentTime = 10; child.media.ended = true; child.media.paused = true;
  child.win.document.body.insertAdjacentHTML('beforeend', completionDialog()); await child.app.tick();
  assert.equal(child.closes(), 1);
  await restored.app.tick(); assert.equal(getJob(course.store).title, '视频2.mp4');
});

// 新接管的视频可能已经处于结尾，应等待平台核对而不是尝试重播后停止。
test('an already-ended associated video waits for catalog verification without replay', async t => {
  const course = parallelCourse(t, 1); await course.app.start();
  const target = new URL(course.calls[0][0]);
  const child = harness(t, { store: course.store, manager: course.manager,
    path: target.pathname + target.hash, windowName: course.calls[0][1], html: '<video id="dPlayerVideoMain"></video>' });
  const state = media(child.win); state.currentTime = 10; state.ended = true; state.paused = true;
  await new Promise(resolve => setImmediate(resolve)); await child.app.tick();
  const id = target.hash.split('=')[1];
  assert.equal(state.plays, 0); assert.equal(getJob(course.store, id).status, 'ended');
  assert.equal(child.app.shadow.getElementById('start').disabled, true);
  setJob(course.store, { ...getJob(course.store, id), status: 'verified', completionSource: 'catalog' });
  await child.app.tick(); assert.equal(child.closes(), 1);
});

// 明确点击停止必须清除恢复许可，不能被页面刷新撤销。
test('explicit stop followed by catalog reload never resumes the queue', async t => {
  const course = parallelCourse(t); await course.app.start(); course.app.stop();
  course.win.dispatchEvent(new course.win.Event('pagehide'));
  assert.equal(course.session.get(api.KEYS.resume), null);
  await new Promise(resolve => setImmediate(resolve));
  const restored = harness(t, { store: course.store, session: course.session, manager: course.manager });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored.app.shadow.getElementById('start').disabled, false);
  assert.equal(course.store.get(api.KEYS.control).status, 'stopped');
});

// 只允许短暂刷新恢复，不能重启几分钟前遗留的后台队列。
test('an expired catalog recovery snapshot is not resumed', async t => {
  const course = parallelCourse(t); await course.app.start();
  course.win.dispatchEvent(new course.win.Event('pagehide'));
  await new Promise(resolve => setImmediate(resolve));
  const restored = harness(t, { store: course.store, session: course.session, manager: course.manager, time: 100000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored.app.shadow.getElementById('start').disabled, false);
});

// 目录真的关闭后，资源页仍应在心跳宽限期到期时停止。
test('resource stops when a reloading catalog fails to return within grace period', async t => {
  const course = parallelCourse(t); await course.app.start(); const child = await queueChild(t, course);
  course.win.dispatchEvent(new course.win.Event('pagehide'));
  child.advance(91000); await child.app.tick();
  assert.equal(child.media.paused, true); assert.match(child.status(), /长时间无响应|目录.*未恢复/);
});


// 目录暂时离开期间收到全部停止，返回时不能撤销停止命令。
test('global stop during catalog reload invalidates the saved active queue', async t => {
  const course = parallelCourse(t); await course.app.start();
  course.win.dispatchEvent(new course.win.Event('pagehide'));
  course.store.set(api.KEYS.stop, { id: 'stop-during-reload', at: 1050 });
  await new Promise(resolve => setImmediate(resolve));
  const restored = harness(t, { store: course.store, session: course.session, manager: course.manager, time: 1100 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored.app.shadow.getElementById('start').disabled, false);
  assert.equal(restored.session.get(api.KEYS.resume), null);
});

// 未知资源地址不能在刷新后被猜测重开，但其他已关联窗口可以继续。
test('reload cancels only an unresolved opening while restoring an active sibling', async t => {
  const course = parallelCourse(t);
  course.win.document.querySelectorAll('.resItem button')[1].onclick = () => {};
  const starting = course.app.start(); await new Promise(resolve => setImmediate(resolve));
  const child = await queueChild(t, course);
  const unresolved = course.store.jobs().find(job => !job.expectedPath);
  course.win.dispatchEvent(new course.win.Event('pagehide')); await starting;
  await new Promise(resolve => setImmediate(resolve));
  const restored = harness(t, { store: course.store, session: course.session, manager: course.manager, time: 1100 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getJob(course.store, unresolved.id).status, 'stopped');
  await child.app.tick(); assert.equal(child.media.paused, false);
  assert.equal(course.store.jobs().length, 2);
  assert.match(restored.status(), /已恢复/);
});

// 浏览器返回历史缓存页面时也要重新取得锁，而不是留下失效的运行状态。
test('a persisted pageshow restores the same catalog without duplicate jobs', async t => {
  const course = parallelCourse(t); await course.app.start();
  const ids = course.store.jobs().map(job => job.id);
  course.win.dispatchEvent(new course.win.Event('pagehide'));
  await new Promise(resolve => setImmediate(resolve));
  course.win.dispatchEvent(new course.win.PageTransitionEvent('pageshow', { persisted: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(course.store.get(api.KEYS.control).status, 'running');
  assert.deepEqual(course.store.jobs().map(job => job.id), ids);
  assert.equal(course.app.shadow.getElementById('start').disabled, true);
});


// 锁释放稍迟时保留快照并有限重试，不能把一次暂时失败变成永久取消。
test('restore retains its snapshot while the old session lock is temporarily busy', async t => {
  const course = parallelCourse(t); await course.app.start(); course.win.dispatchEvent(new course.win.Event('pagehide'));
  await new Promise(resolve => setImmediate(resolve));
  const unlock = await api.takeLock(course.win, 'session');
  const restored = harness(t, { store: course.store, session: course.session, manager: course.manager, time: 1100 });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(course.session.get(api.KEYS.resume)); assert.match(restored.status(), /已保留/);
  unlock(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(course.store.get(api.KEYS.control).status, 'running'); assert.match(restored.status(), /已恢复/);
});

// 在等待锁时点击停止，重试定时器也必须失效，不能稍后偷偷启动。
test('explicit stop cancels a pending restore retry', async t => {
  const course = parallelCourse(t); await course.app.start(); course.win.dispatchEvent(new course.win.Event('pagehide'));
  await new Promise(resolve => setImmediate(resolve));
  const unlock = await api.takeLock(course.win, 'session');
  const restored = harness(t, { store: course.store, session: course.session, manager: course.manager, time: 1100 });
  await new Promise(resolve => setImmediate(resolve)); restored.app.stop(); unlock();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(restored.session.get(api.KEYS.resume), null);
  assert.equal(restored.app.shadow.getElementById('start').disabled, false);
  assert.match(restored.status(), /已停止/);
});


// 重试过程中超过恢复宽限期后，恢复按钮必须重新可用，不能留下假忙碌状态。
test('expired retry releases the disabled-start UI and discards only its recovery snapshot', async t => {
  const course = parallelCourse(t); await course.app.start(); course.win.dispatchEvent(new course.win.Event('pagehide'));
  await new Promise(resolve => setImmediate(resolve)); const unlock = await api.takeLock(course.win, 'session');
  const restored = harness(t, { store: course.store, session: course.session, manager: course.manager, time: 1100 });
  await new Promise(resolve => setImmediate(resolve)); restored.advance(91000);
  await new Promise(resolve => setTimeout(resolve, 20)); unlock();
  assert.equal(restored.app.shadow.getElementById('start').disabled, false);
  assert.equal(restored.session.get(api.KEYS.resume), null);
});

// 等待锁时进入历史缓存，回来后应重新尝试，而非被旧 busy 标志永久挡住。
test('persisted pageshow can resume a restore that was waiting for a lock', async t => {
  const course = parallelCourse(t); await course.app.start(); course.win.dispatchEvent(new course.win.Event('pagehide'));
  await new Promise(resolve => setImmediate(resolve)); const unlock = await api.takeLock(course.win, 'session');
  const restored = harness(t, { store: course.store, session: course.session, manager: course.manager, time: 1100 });
  await new Promise(resolve => setImmediate(resolve));
  restored.win.dispatchEvent(new restored.win.Event('pagehide')); unlock();
  await new Promise(resolve => setImmediate(resolve));
  restored.win.dispatchEvent(new restored.win.PageTransitionEvent('pageshow', { persisted: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(restored.status(), /已恢复/); assert.equal(restored.app.shadow.getElementById('start').disabled, true);
});






// 登录/本人验证的优先级高于成功提示，不可为自动续播跳过验证。
test('authentication or captcha blocks completion acknowledgement even when success text exists', async t => {
  const course = parallelCourse(t); await course.app.start(); const child = await queueChild(t, course);
  child.media.currentTime = 10; child.media.ended = true; child.media.paused = true;
  child.win.document.body.insertAdjacentHTML('beforeend', completionDialog() + '<div class="captcha">本人验证</div>');
  let clicks = 0; child.win.document.querySelector('.el-message-box button').onclick = () => clicks++;
  await child.app.tick(); assert.equal(clicks, 0); assert.equal(child.closes(), 0);
  assert.match(child.status(), /本人验证/);
});

// 手动单视频的延迟确认监听受总时限约束，但不应两分钟后悄悄退出。
test('single-video mode still handles a completion prompt more than two minutes late', async t => {
  const h = harness(t, { path: RESOURCE, html: '<video id="dPlayerVideoMain"></video>' });
  const state = media(h.win); h.live(); await h.app.start();
  state.currentTime = 10; state.ended = true; state.paused = true; await h.app.tick();
  h.advance(121000); await h.app.tick(); h.win.document.body.insertAdjacentHTML('beforeend', completionDialog());
  await h.app.tick(); assert.equal(getJob(h.store).status, 'verified'); assert.equal(h.closes(), 0);
});

// 复制了任务链接但没有专用窗口名的用户页面不能被自动关闭。
test('an associated URL without the assigned window name is not automatically closed', async t => {
  const course = parallelCourse(t); await course.app.start(); const child = await queueChild(t, course);
  child.win.name = '';
  child.media.currentTime = 10; child.media.ended = true; child.media.paused = true;
  child.win.document.body.insertAdjacentHTML('beforeend', completionDialog()); await child.app.tick();
  assert.equal(child.closes(), 0);
});


// 完整跑完三项，确认已移除的名称不会因目录 DOM 尚未刷新而再次入队。
test('three confirmed videos advance in order without replaying stale directory entries', async t => {
  const h = harness(t, { html: card('一.mp4') + card('二.mp4') + card('三.mp4') }); h.live();
  const opened = []; h.win.open = (url) => { opened.push(new URL(url).pathname); return null; };
  await h.app.start();
  for (const title of ['一.mp4', '二.mp4', '三.mp4']) {
    const job = getJob(h.store); assert.equal(job.title, title);
    setJob(h.store, { ...job, status: 'verified', completionSource: 'platform-message' }); await h.app.tick();
  }
  assert.deepEqual(opened.map(path => path.split('/')[5]), ['501', '502', '503']);
  assert.equal(h.store.get(api.KEYS.control).status, 'finished');
});





// 启动超时回归：视频请求未返回也不能永久占用运行锁。
test('watchdog stops a pending media play after fifteen seconds', async t => {
  const h = harness(t, { html: '<video id="dPlayerVideoMain"></video>', path: RESOURCE });
  const state = media(h.win); let finish;
  h.win.document.querySelector('video').play = () => new Promise(resolve => { finish = resolve; });
  h.live(); const pending = h.app.start();
  await new Promise(resolve => setImmediate(resolve));
  h.advance(16000); await h.app.tick();
  assert.equal(state.paused, true);
  assert.match(h.status(), /15 秒/);
  finish(); await pending;
});

// 验证界面回归：恢复阶段遇到验证不应自动刷新验证码。
test('verification dialog stops instead of entering service backoff', async t => {
  const store = memoryStore(), session = memoryStore();
  seedVerification(store, session);
  const h = harness(t, { store, session, html: card() + '<div class="captcha">验证码</div>' });
  await new Promise(resolve => setImmediate(resolve)); await h.app.tick();
  assert.match(h.status(), /本人验证/);
  assert.equal(h.session.get(api.KEYS.resume), null);
});


/** 创建含多项原生打开按钮的队列夹具，记录而不真正打开浏览器。 */
function parallelCourse(t, count = 2) {
  const html = Array.from({ length: count + 1 }, (_, index) => card('视频' + index + '.mp4')).join('');
  const h = harness(t, { html }); h.calls = [];
  h.win.open = /* 模拟原生打开成功，保留关联 URL。 */ (...args) => { h.calls.push(args); return {}; };
  h.win.document.querySelectorAll('.resItem button').forEach(/* 每个按钮指向不同资源。 */ (button, index) => {
    button.onclick = () => h.win.open(RESOURCE.replace('501', String(501 + index)), '_blank');
  });
  h.live(); h.app.shadow.getElementById('concurrency').value = count;
  return h;
}

// 并发参数在旧设置里缺失时仍按单视频运行。
test('concurrency defaults to one and is clamped to five', () => {
  assert.equal(api.sanitizeConfig({}).concurrency, 1);
  assert.equal(api.sanitizeConfig({ concurrency: 999 }).concurrency, 5);
  assert.equal(api.sanitizeConfig({ concurrency: -1 }).concurrency, 1);
});

// 两项任务同时打开，窗口目标和关联键不能相同。
test('a batch creates independent records and different player window targets', async t => {
  const h = parallelCourse(t); await h.app.start();
  assert.equal(h.calls.length, 2);
  assert.notEqual(h.calls[0][1], h.calls[1][1]);
  const jobs = h.store.jobs(); assert.equal(jobs.length, 2);
  assert.notEqual(jobs[0].id, jobs[1].id);
  assert.equal(jobs[0].groupId, jobs[1].groupId);
  assert.notEqual(jobs[0].expectedPath, jobs[1].expectedPath);
  assert.equal(h.app.shadow.querySelectorAll('#pending button').length, 2);
});

// 已结束的短视频不能让课程目录在长视频播放时刷新。
test('the course never reloads while any video in the batch is playing', async t => {
  const h = parallelCourse(t); await h.app.start();
  const [a, b] = h.store.jobs();
  setJob(h.store, { ...a, status: 'ended' }); setJob(h.store, { ...b, status: 'playing' });
  await h.app.tick(); assert.equal(h.session.get(api.KEYS.resume).phase, 'playing');
  h.advance(10000); await h.app.tick(); assert.equal(h.reloads(), 0);
  setJob(h.store, { ...b, status: 'ended' }); await h.app.tick();
  assert.equal(h.session.get(api.KEYS.resume).jobs.length, 2);
  h.advance(10001); await h.app.tick(); assert.equal(h.reloads(), 1);
});

// 两个手动资源页的播放和暂停不应互相覆盖。
test('different videos play concurrently and a local pause affects only its own task', async t => {
  const store = memoryStore(), manager = locks();
  const a = harness(t, { store, manager, path: RESOURCE, html: '<video id="dPlayerVideoMain"></video>' });
  const b = harness(t, { store, manager, path: RESOURCE.replace('501', '503'), html: '<video id="dPlayerVideoMain"></video>' });
  const av = media(a.win), bv = media(b.win); a.live(); b.live();
  await a.app.start(); await b.app.start();
  assert.equal(av.paused, false); assert.equal(bv.paused, false);
  assert.equal(store.jobs().filter(job => job.status === 'playing').length, 2);
  a.app.stop(); await b.app.tick();
  assert.equal(av.paused, true); assert.equal(bv.paused, false);
  assert.equal(store.jobs().filter(job => job.status === 'playing').length, 1);
});

// 全站播放槽有固定上限，失败的第六页不能关闭已有视频。
test('five unique videos can run but a sixth is rejected without stealing a slot', async t => {
  const store = memoryStore(), manager = locks(), players = [];
  for (let index = 0; index < 6; index++) {
    const h = harness(t, { store, manager, path: RESOURCE.replace('501', String(501 + index)), html: '<video id="dPlayerVideoMain"></video>' });
    const state = media(h.win); h.live(); await h.app.start(); players.push({ h, state });
  }
  assert.equal(players.slice(0, 5).every(player => !player.state.paused), true);
  assert.equal(players[5].state.plays, 0);
  assert.match(players[5].h.status(), /5 个/);
  assert.equal(store.jobs().filter(job => job.status === 'playing').length, 5);
});

// 所有页面收到同一个广播后立即暂停，后续显式开始允许新任务。
test('stop all interrupts every standalone player and a later explicit start is allowed', async t => {
  const store = memoryStore(), manager = locks();
  const a = harness(t, { store, manager, path: RESOURCE, html: '<video id="dPlayerVideoMain"></video>' });
  const b = harness(t, { store, manager, path: RESOURCE.replace('501', '503'), html: '<video id="dPlayerVideoMain"></video>' });
  const av = media(a.win), bv = media(b.win); a.live(); b.live(); await a.app.start(); await b.app.start();
  a.app.stopAll(); b.win.dispatchEvent(new b.win.StorageEvent('storage', { key: api.KEYS.stop }));
  assert.equal(av.paused, true); assert.equal(bv.paused, true);
  assert.equal(store.jobs().every(job => job.status === 'stopped'), true);
  await new Promise(resolve => setImmediate(resolve));
  await b.app.start(); assert.equal(bv.paused, false);
});

// 一项失败后允许另一项播完，但不会启动新的批次。
test('one failed queue item does not interrupt its playing sibling', async t => {
  const h = parallelCourse(t); await h.app.start();
  const [a, b] = h.store.jobs();
  setJob(h.store, { ...a, status: 'stopped', message: '平台请求异常' });
  setJob(h.store, { ...b, status: 'playing' }); await h.app.tick();
  assert.equal(getJob(h.store, b.id).status, 'playing');
  assert.equal(h.store.get(api.KEYS.control).status, 'running');
  assert.equal(h.calls.length, 2);
});

// 每个视频独立确认；一项未入账时不得重复播放已完成项。
test('batch verification preserves confirmed items while another waits for recording', async t => {
  const store = memoryStore(), session = memoryStore();
  seedVerification(store, session, 0, [{ id: 'a', title: '一.mp4', status: 'ended' }, { id: 'b', title: '二.mp4', status: 'ended' }]);
  const h = harness(t, { store, session, html: card('一.mp4', '已完成', 100) + card('二.mp4') });
  await new Promise(resolve => setImmediate(resolve)); await h.app.tick();
  assert.equal(getJob(store, 'a').status, 'verified'); assert.equal(getJob(store, 'b').status, 'ended');
  assert.deepEqual(session.get(api.KEYS.resume).remaining, ['二.mp4']);
  assert.equal(session.get(api.KEYS.resume).verifyAt, 16000);
});

// 课程停止要覆盖整个当前批次，而不是仅修改最后创建的任务。
test('course stop marks every child job stopped', async t => {
  const h = parallelCourse(t); await h.app.start(); h.app.stop();
  assert.equal(h.store.jobs().every(job => job.status === 'stopped'), true);
  assert.equal(h.store.get(api.KEYS.control).status, 'stopped');
  assert.equal(h.app.shadow.getElementById('tasks').textContent.includes('播放中'), false);
  assert.match(h.app.shadow.getElementById('tasks').textContent, /已停止/);
});

// 全局停止先于浏览器刷新恢复时，旧的恢复记录不能重新运行。
test('a global stop invalidates a pending verification restore', async t => {
  const store = memoryStore(), session = memoryStore(); seedVerification(store, session);
  store.set(api.KEYS.stop, { id: 'stop', at: 1000 });
  const h = harness(t, { store, session });
  await new Promise(resolve => setImmediate(resolve)); await h.app.tick();
  assert.equal(h.reloads(), 0); assert.equal(session.get(api.KEYS.resume), null);
  assert.equal(h.app.shadow.getElementById('start').disabled, false);
});


// 停止命令与心跳分开保存，迟到媒体写入不能撤销目录的停止。
test('late player heartbeat cannot overwrite a controller stop command', async t => {
  const h = parallelCourse(t); await h.app.start(); const stale = h.store.jobs()[0];
  h.app.stop(); setJob(h.store, { ...stale, status: 'playing', heartbeat: 2000 });
  assert.equal(getJob(h.store, stale.id).status, 'stopped');
  assert.equal(h.store.get(api.commandKey(stale.id)).action, 'stop');
});

// 已取消窗口迟到加载时，只暂停它自己的视频，不能自动接管任务。
test('a cancelled child arriving late is paused and never calls play', async t => {
  const store = memoryStore();
  setJob(store, { id: 'late', source: 'queue', stopId: '', status: 'opening', launchToken: 'late', expectedPath: RESOURCE,
    scope: '101:401', createdAt: 1000, heartbeat: 1000, deadline: 999999 });
  store.set(api.commandKey('late'), { action: 'stop', message: '用户取消' });
  const h = harness(t, { store, time: 40000, path: RESOURCE + '#nsu-study-helper=late', html: '<video id="dPlayerVideoMain"></video>' });
  const state = media(h.win); state.paused = false; await h.app.tick();
  assert.equal(state.paused, true); assert.equal(state.plays, 0);
});

// 全部停止不依赖各个异步播放 Promise 已经返回。
test('stop all pauses both a pending play and a playing sibling', async t => {
  const store = memoryStore(), manager = locks();
  const a = harness(t, { store, manager, path: RESOURCE, html: '<video id="dPlayerVideoMain"></video>' });
  const b = harness(t, { store, manager, path: RESOURCE.replace('501', '503'), html: '<video id="dPlayerVideoMain"></video>' });
  const av = media(a.win), bv = media(b.win); let finish;
  a.win.document.querySelector('video').play = () => new Promise(resolve => { finish = resolve; });
  a.live(); b.live(); const pending = a.app.start();
  await new Promise(resolve => setImmediate(resolve)); await b.app.start();
  b.app.stopAll(); a.win.dispatchEvent(new a.win.StorageEvent('storage', { key: api.KEYS.stop }));
  assert.equal(av.paused, true); assert.equal(bv.paused, true);
  finish(); await pending;
});
