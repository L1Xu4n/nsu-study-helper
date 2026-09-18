/* 本文件只供本地隔离测试，使用合成媒体状态，不连接学校平台。 */
(function setupFixture() {
  'use strict';
  const api = window.module.exports;
  const content = document.getElementById('content');
  const output = document.getElementById('simulation');
  const resources = [
    { id: '501', title: '01 示例课程.mp4' },
    { id: '502', title: '02 已有记录.mp4' },
    { id: '503', title: '03 下一节.mp4' },
    { id: '504', title: '04 自动续播.mp4' }
  ];
  /** 读取各合成媒体的独立时间区间，用时间交集证明并发而非先后完成。 */
  function showOverlap() {
    const runs = resources.map(/* 仅访问本地夹具自己的键。 */ item => JSON.parse(localStorage.getItem('fixture:run:' + item.id) || 'null')).filter(Boolean);
    let overlap = 0;
    for (let left = 0; left < runs.length; left++) for (let right = left + 1; right < runs.length; right++) {
      overlap = Math.max(overlap, Math.min(runs[left].stopAt || runs[left].seenAt, runs[right].stopAt || runs[right].seenAt)
        - Math.max(runs[left].startAt, runs[right].startAt));
    }
    const acknowledged = resources.filter(/* 只有确认按钮真的被点击才计数。 */ item => localStorage.getItem('fixture:ack:' + item.id) === 'yes');
    const jobs = Object.keys(localStorage).filter(/* 只显示本地合成任务，不读取其他站点或账户。 */ key => key.startsWith(api.KEYS.jobs))
      .map(key => JSON.parse(localStorage.getItem(key))).sort((a, b) => a.createdAt - b.createdAt);
    return '已观测重叠播放：' + (overlap > 0 ? 2 : 0) + ' 个；重叠 ' + (overlap / 1000).toFixed(1) + ' 秒\n完成弹窗已确认：' + acknowledged.length + ' 项\n'
      + jobs.map(/* 任务标题、来源和合成编号用于发现错配或另一次启动。 */ job => job.title + ' -> ' + (job.expectedPath?.split('/')[5] || '等待') + ' [' + job.status + ', ' + job.source + ', ' + (job.groupId || 'single').slice(0, 8) + ']').join('\n');
  }
  const route = api.parseRoute(location.pathname);
  if (route.kind === 'course') {
    for (const item of resources) {
      const completed = item.id === '502' || localStorage.getItem('fixture:done:' + item.id) === 'yes';
      const card = document.createElement('div'); card.className = 'resItem';
      card.innerHTML = '<span class="file-name__span">' + item.title + '</span><div class="stateLabel">进行中</div><button>去学习</button>'
        + '<div role="progressbar" aria-valuenow="' + (completed ? 100 : 0) + '"><progress max="100" value="' + (completed ? 100 : 0) + '"></progress></div><span>' + (completed ? '已完成' : '未学习') + '</span>';
      card.querySelector('button').addEventListener('click', /** 模拟先请求平台、随后异步打开资源页。 */ () => {
        window.setTimeout(/** 实际开窗被刻意延迟，用于回归旧版同步关联缺口。 */ () => {
          window.open('/resourcesLearning/index/101/401/' + item.id + '/601', '_blank');
        }, 200);
      });
      content.append(card);
    }
    window.setInterval(/** 将合成时间交集显示在页面上供浏览器核验。 */ () => { output.textContent = showOverlap(); }, 1000);
  } else {
    history.replaceState(null, '', location.pathname);
    const id = location.pathname.split('/')[5];
    content.innerHTML = '<video id="dPlayerVideoMain"></video><button id="error">模拟请求错误</button><button id="pause">模拟平台暂停</button><button id="complete">完成合成视频</button>';
    const video = document.querySelector('video');
    const state = { paused: true, ended: false, currentTime: 0, duration: 120, error: null };
    let startAt = 0;
    /** 每个播放器只写自己的观测记录，不互相覆盖并发证据。 */
    function recordRun() {
      if (startAt) localStorage.setItem('fixture:run:' + id, JSON.stringify({ startAt, seenAt: Date.now(), stopAt: state.paused ? Date.now() : 0 }));
    }
    for (const key of Object.keys(state)) Object.defineProperty(video, key, { get: /** 提供合成状态，不发送学习请求。 */ () => state[key] });
    video.play = /** 合成播放器启动并记录真实墙钟时间。 */ async function play() { state.paused = false; startAt = Date.now(); recordRun(); };
    video.pause = /** 合成播放器暂停并关闭时间区间。 */ function pause() { state.paused = true; recordRun(); };
    document.getElementById('error').onclick = /** 产生错误文字，但不改变媒体状态以复现平台假错误。 */ function showError() {
      const message = document.createElement('div'); message.className = 'el-message--error'; message.textContent = '请求错误'; content.append(message);
    };
    document.getElementById('pause').onclick = /** 模拟用户或平台原生暂停。 */ function pauseNative() { video.pause(); };
    /** 模拟平台完成提示，确认动作必须由正在测试的助手执行。 */
    function showCompletion() {
      const dialog = document.createElement('div'); dialog.className = 'el-message-box';
      dialog.innerHTML = '<p>你已完成该视频学习,学习状态已更新！  </p><button>关闭</button><button style="display:none">OK</button>';
      dialog.querySelector('button').onclick = /** 记录确认行为，不能由媒体结束直接代替。 */ () => {
        localStorage.setItem('fixture:ack:' + id, 'yes'); dialog.remove();
      };
      content.append(dialog);
    }
    /** 仅结束本地合成媒体，便于在目录刷新后主动触发完成流程。 */
    function completeSyntheticMedia() {
      if (state.ended) return;
      state.currentTime = state.duration; state.ended = true; state.paused = true;
      localStorage.setItem('fixture:done:' + id, 'yes'); recordRun(); showCompletion();
    }
    document.getElementById('complete').onclick = completeSyntheticMedia;
    window.setInterval(/** 推进合成媒体并写入本地测试完成状态。 */ function advanceMedia() {
      if (!state.paused && !state.ended) {
        state.currentTime += 1;
        if (state.currentTime === 2) document.getElementById('error').click();
        if (state.currentTime >= state.duration) {
          completeSyntheticMedia();
        }
        recordRun();
      }
      output.textContent = '合成媒体：' + state.currentTime + ' / ' + state.duration + ' 秒；' + (state.paused ? '暂停' : '播放') + '\n' + showOverlap();
    }, 1000);
  }
  api.createApp(window);
  if (route.kind === 'course') output.textContent = showOverlap();
})();
