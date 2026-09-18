# 函数说明

所有主脚本命名函数均有源码注释。下面按职责说明，不需要初学者先理解全部实现。

## 启动与页面解析

| 函数 | 作用 |
| --- | --- |
| initialize | 区分 Node.js 测试和浏览器运行，并限制学校域名、顶层窗口。 |
| buildModule | 封装常量、解析规则和控制器，减少全局变量。 |
| clean | 去除文字首尾和重复空白。 |
| sanitizeConfig | 校正布尔设置和数值上下限，默认试运行。 |
| parseRoute | 根据已确认的路径格式识别课程页、资源页及其对应课程范围。 |
| isComplete | 同时检查“已完成”文字和 100% 进度。 |
| readResources | 读取当前 DOM 中每个资源卡片，保留其原生按钮引用。 |
| selectQueue | 根据类型、开放状态、关键字和上限生成队列，拒绝重名及不明确状态。 |
| canClaim | 核对资源路径、一次性关联片段、创建时间和截止时间。 |
| taskToken | 从本脚本的 hash 或专用窗口名读取任务标识，支持路由清理 hash。 |
| isCompletionText | 精确识别“视频学习完成、学习状态已更新”提示。 |
| findCompletionPrompt | 找到可见的成功提示及唯一正常确认/关闭按钮。 |
| mediaFinished | 根据真实媒体结束状态判断是否可以处理成功提示。 |
| visible | 判断提示控件及其祖先是否实际显示。 |
| detectBlocker | 识别可见登录、验证、错误和待确认弹窗，只返回通用提示。 |
| clock | 把视频时间格式化为时、分、秒。 |

## 存储与互斥

| 函数 | 作用 |
| --- | --- |
| makeStore | 给浏览器存储增加 JSON 读写；损坏数据不会被默默忽略。 |
| makeStore.get | 读取一个脚本键并解析 JSON。 |
| makeStore.set | 将脚本状态写成 JSON。 |
| makeStore.remove | 删除指定脚本键。 |
| takeLock | 取得 Web Locks 原子锁，并返回释放函数；不支持时停止。 |
| jobKey / commandKey | 分别为视频状态、控制停止命令生成独立存储键。 |
| readJob | 合并任务与停止命令，迟到的心跳不能撤销停止。 |
| takePlayerLocks | 取得当前资源独占锁和一个播放槽，最多 5 个不同视频并发。 |
| currentJob | 只读取任务 ID 与当前页面一致的任务。 |
| batchJobs | 读取当前批次所有独立任务的有效状态。 |
| stopId | 读取全局停止代号，新任务不会继承旧停止命令。 |
| checkpointPlan | 保存当前目录的短期队列快照，并明确返回是否成功；失去控制权时不伪造可恢复状态。 |
| updateJob | 核验控制者/播放器所有权后更新共享任务。 |
| release | 恢复临时包装的 window.open 并释放当前页面持有的锁。 |
| newJob | 创建一次任务 ID、关联片段、所有者、配置和总截止时间。 |

## 面板与运行控制

| 函数 | 作用 |
| --- | --- |
| createApp | 创建隔离样式面板、页面状态、事件监听器和一秒检查循环。 |
| field | 获取面板内部指定控件。 |
| status | 更新提示文字及按钮、设置控件的可操作状态。 |
| saveConfig | 读取并保存面板设置，不自动授予运行许可。 |
| inspect | 列出视频候选和已完成数量，不点击、不播放。 |
| start | 响应用户开始操作；先试运行或取锁，再启动队列/当前视频。 |
| stop | 使旧异步操作失效、暂停受控视频、取消恢复记录并停止共享任务。 |
| stopAll | 向所有脚本标签页广播停止，再停止当前页面。 |
| waitForResourceOpen | 逐项等待同步或异步的实际开窗地址，超时/取消后恢复原函数。 |
| waitForResourceOpen.finish | 清理临时包装和定时器，只完成一次异步等待。 |
| onManualResourceClick | 等待期间遇到用户手动打开其他资源就取消自动关联，避免串线。 |
| observeOpen | 为正确资源增加一次性片段及队列窗口名，保留其他窗口安全参数。 |
| launchBatch | 初次填满并发槽或为已确认完成的槽补充下一项，不重开其他活动视频。 |
| renderBatch | 显示各视频状态，给被拦截的等待项提供手动打开按钮。 |
| openPending | 通过正常用户点击重开已观察到的资源路径，不修改浏览器弹窗权限。 |
| attach | 新资源页持有独占播放器锁后才能认领，重复标签页不能抢占。 |
| playVideo | 未结束时正常播放；已经结束时直接进入平台核对，不重播、不把结束当成启动错误。 |
| resourceBlocker | 区分仍正常播放时的错误文字与必须停止的登录、验证、真实故障。 |
| confirmCompletion | 在媒体结束且出现精确成功提示后记录完成凭据，触发确认与关闭。 |
| finishPlayback | 释放播放锁、确认成功弹窗，仅关闭路径和专用窗口名都匹配的队列窗口。 |
| reloadCourse | 保存一次有截止时间的恢复计划，安排目录状态核对。 |
| restore | 在 90 秒内恢复同一目录的活跃队列或核对阶段，等待锁交接；显式停止、过期或不同队列不会恢复。 |
| courseTick | 明确完成后立即补槽；缺少成功提示时等活动视频结束后刷新核对。 |
| resourceTick | 检查自然结束、原生暂停、播放器异常、卡顿和任务停止。 |
| checkControl | 在异步播放尚未返回时继续处理停止、错误、时限和失联。 |
| onStorage | 跨标签存储变更发生时立即执行控制检查。 |
| tick | 状态检查入口；先检查紧急停止，再串行推进当前页。 |
| unload | 资源退出时停止自身；目录离开时保存快照并释放锁，给刷新保留 90 秒恢复宽限。 |
| onPageShow | 浏览器从历史缓存恢复目录时，重新取得锁并接回原队列。 |
| destroy | 测试清理入口，停止运行并删除面板、定时器和事件监听器。 |

## 测试辅助函数

| 文件及函数 | 作用 |
| --- | --- |
| helper.test.cjs: card | 生成没有真实课程信息的资源卡片。 |
| memoryStore / get / set / remove | 用 Map 模拟两个页面共享的 JSON 存储。 |
| memoryStore.jobs / getJob / setJob | 独立读写合成视频任务，断言互不覆盖。 |
| seedVerification | 构造已播完、待批次核对的测试状态。 |
| parallelCourse | 创建多视频原生打开按钮，记录独立窗口和任务。 |
| completionDialog | 生成与真实平台一致的成功提示、可见关闭按钮和隐藏 OK 按钮。 |
| queueChild | 生成自动接管的资源子页面，测试不点击资源页开始按钮。 |
| locks / request | 模拟浏览器锁在异步回调期间的互斥行为。 |
| harness | 创建 jsdom 页面、可控时钟、状态检查器，并注册清理。 |
| harness.advance / reloads / closes / live / status | 推进时间、统计刷新/关闭、取消试运行、读取状态。 |
| media | 为媒体对象提供合成播放状态，不请求学校服务。 |
| rects / play / pause | 分别模拟可见布局、播放、暂停。 |
| demo-server.cjs: serve | 只在本机提供三个白名单文件/页面，不暴露目录。 |
| fixture.js: setupFixture | 生成合成课程目录或资源页，并启动测试用助手。 |
| fixture.js: play / pause | 改变合成媒体的播放/暂停状态。 |
| showError / pauseNative | 模拟请求错误和平台暂停，用于验证停止保护。 |
| advanceMedia | 推进合成时间并记录本地测试完成状态。 |
| recordRun / showOverlap | 分别记录独立媒体时间区间、计算时间交集，证明同时播放而非仅先后结束。 |
| fixture.js: showCompletion | 模拟成功弹窗，只有助手真的点击确认后才记录确认计数。 |
| fixture.js: completeSyntheticMedia | 只结束本地合成媒体，用于目录刷新后确认与关闭流程的浏览器测试。 |

匿名数组回调负责筛选/格式化；事件回调负责对应控件；每个测试回调的名称说明所验证的行为。
