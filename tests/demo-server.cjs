'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const COURSE = '/courseStudy/studentLearnCourse/101/201/301/401/101';
const PORT = Number(process.env.PORT) || 8765;
const files = new Map([
  ['/nsu-study-helper.user.js', [path.join(root, 'nsu-study-helper.user.js'), 'text/javascript; charset=utf-8']],
  ['/fixture.js', [path.join(__dirname, 'fixture.js'), 'text/javascript; charset=utf-8']]
]);

/** 只提供固定测试文件和合成页面，不暴露工作区或读取真实账号数据。 */
function serve(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Cache-Control', 'no-store');
  if (files.has(url.pathname)) {
    const [file, type] = files.get(url.pathname);
    res.writeHead(200, { 'Content-Type': type }); res.end(fs.readFileSync(file)); return;
  }
  if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (url.pathname === '/') { res.writeHead(302, { Location: COURSE }); res.end(); return; }
  if (!url.pathname.startsWith('/courseStudy/') && !url.pathname.startsWith('/resourcesLearning/')) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>NSU 助手 · 本地隔离测试</title><style>body{font:16px/1.6 system-ui;margin:0;color:#24312e;background:#f6f8f7;padding:28px}h1{font-size:24px;margin:0 0 24px}'
    + 'main{max-width:760px}.resItem{border-bottom:1px solid #ccd6d2;padding:18px 0}.file-name__span{font-weight:600}.stateLabel{color:#527269}button{font:inherit;cursor:pointer;margin:8px 12px 8px 0;padding:5px 12px}'
    + 'video{display:block;width:100%;height:300px;background:#343a38}#simulation{color:#00796b}progress{width:180px;max-width:100%}@media(max-width:600px){body{padding:16px;padding-top:500px}}</style>'
    + '<body><main><h1>本地隔离测试</h1><div id="content"></div><output id="simulation"></output></main>'
    + '<script>window.module={exports:{}};</script><script src="/nsu-study-helper.user.js"></script><script src="/fixture.js"></script></body></html>');
}
const server = http.createServer(serve);
server.on('error', /** 明确报告端口占用，避免误用其他服务。 */ error => { console.error(error.message); process.exitCode = 1; });
server.listen(PORT, '127.0.0.1', /** 输出固定的本地测试入口。 */ () => console.log('Fixture: http://127.0.0.1:' + PORT + COURSE));
