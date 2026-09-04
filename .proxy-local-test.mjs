// 本地验证 edge-functions/proxy/[[default]].js 的代理逻辑（不依赖 EdgeOne 环境）。
// 用法：node .proxy-local-test.mjs
import handler from "./edge-functions/proxy/[[default]].js";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

// 劫持全局 fetch，模拟上游服务器行为
const upstreamCalls = [];
globalThis.fetch = async (url, init) => {
  upstreamCalls.push({ url: String(url), init });
  const u = String(url);
  if (u === "https://werhd.k0s.cn/res/music.mp3?v=1") {
    return new Response("MUSICDATA", {
      status: 200,
      headers: { "content-type": "audio/mpeg", "content-length": "9" },
    });
  }
  if (u === "https://download.ra2web.com/full-pack.7z") {
    return new Response("PARTIAL", {
      status: 206,
      headers: {
        "content-type": "application/x-7z-compressed",
        "content-range": "bytes 0-5/999",
        "accept-ranges": "bytes",
      },
    });
  }
  if (u === "https://wol.bj1.wangerhuoda.cn/register") {
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": "5" },
    });
  }
  if (u === "https://wol.flkf.k0s.cn/wgameres/some.map") {
    return new Response("MAPDATA", { status: 200, headers: { "content-length": "7" } });
  }
  if (u === "https://mod.btfs.cn/mod/gonghui-20260220-3.zip") {
    return new Response("ZIPDATA", { status: 200, headers: { "content-type": "application/zip" } });
  }
  if (u === "https://mod.btfs.cn/mod/athse/athse-zh-cn-20260718-r5.zip?v=20260718-r5") {
    return new Response("ZIPDATA", { status: 200, headers: { "content-type": "application/zip" } });
  }
  return new Response("not found", { status: 404 });
};

async function call(path, method = "GET", headers = {}, body) {
  const req = new Request("https://mysite.edgeone.app" + path, { method, headers, body });
  return handler({ request: req, params: {}, env: {} });
}

// 1. 资源代理 + Origin 剥离 + query 透传
let r = await call("/proxy/gameres/res/music.mp3?v=1", "GET", { origin: "https://mysite.edgeone.app", cookie: "a=b" });
check("gameres: 状态 200", r.status === 200);
check("gameres: ACAO=*", r.headers.get("access-control-allow-origin") === "*");
check("gameres: body 透传", (await r.text()) === "MUSICDATA");
check("gameres: 上游 URL 正确", upstreamCalls.at(-1).url === "https://werhd.k0s.cn/res/music.mp3?v=1", upstreamCalls.at(-1).url);
check("gameres: Origin 已剥离", !upstreamCalls.at(-1).init.headers.get("origin"));
check("gameres: Cookie 已剥离", !upstreamCalls.at(-1).init.headers.get("cookie"));

// 2. Range 请求头转发（7z 分段下载）
r = await call("/proxy/fullpack/full-pack.7z", "GET", { range: "bytes=0-5" });
check("fullpack: 状态 206", r.status === 206);
check("fullpack: Range 头已转发", upstreamCalls.at(-1).init.headers.get("range") === "bytes=0-5");
check("fullpack: Content-Range 保留", r.headers.get("content-range") === "bytes 0-5/999");
check("fullpack: Accept-Ranges 保留", r.headers.get("accept-ranges") === "bytes");

// 3. POST JSON（register API）
r = await call("/proxy/wol-bj1/register", "POST", { "content-type": "application/json" }, '{"user":"a"}');
check("wol-bj1: POST 转发", r.status === 200);
check("wol-bj1: body 转发", upstreamCalls.at(-1).init.body instanceof ArrayBuffer && new TextDecoder().decode(upstreamCalls.at(-1).init.body) === '{"user":"a"}');

// 4. 上游 content-encoding 被移除（避免解压后长度不一致）
check("wol-bj1: content-encoding 已移除", !r.headers.get("content-encoding"));
check("wol-bj1: content-length 已移除", !r.headers.get("content-length"));

// 5. 多级路径 catch-all（wgameres 带文件名 + Authorization 头）
r = await call("/proxy/wol-flkf/wgameres/some.map", "GET", { authorization: "Bearer tok" });
check("wol-flkf: 多级路径可达", r.status === 200 && (await r.text()) === "MAPDATA");
check("wol-flkf: Authorization 已转发", upstreamCalls.at(-1).init.headers.get("authorization") === "Bearer tok");

// 6. OPTIONS 预检
r = await call("/proxy/wol-bj1/register", "OPTIONS");
check("preflight: 204 + ACAO", r.status === 204 && r.headers.get("access-control-allow-origin") === "*");

// 7. MOD 下载通道（modbtfs，带 query 版本参数）
r = await call("/proxy/modbtfs/mod/athse/athse-zh-cn-20260718-r5.zip?v=20260718-r5");
check("modbtfs: 多级路径+query 可达", r.status === 200 && (await r.text()) === "ZIPDATA");
check("modbtfs: 上游 URL 正确", upstreamCalls.at(-1).url === "https://mod.btfs.cn/mod/athse/athse-zh-cn-20260718-r5.zip?v=20260718-r5", upstreamCalls.at(-1).url);

// 8. 未知 tag / 非代理路径
r = await call("/proxy/unknown/x");
check("未知 tag: 404", r.status === 404);

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
