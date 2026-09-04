// EdgeOne Pages 边缘函数：同域反向代理官方资源与 API 服务器。
// 官方服务器按 Origin 白名单放行 CORS，自建域名直连会被浏览器拦截；
// 通过本函数把请求转为同源请求，由边缘节点转发到上游。
//
// 路由：/proxy/<tag>/<任意层级路径>?<query>
//   gameres  -> https://werhd.k0s.cn        游戏资源/音乐/战役 CDN
//   gameres2 -> https://wyhjres2.bun.sh.cn  备用资源站
//   fullpack -> https://download.ra2web.com 完整资源包 / MOD 包
//   modbtfs  -> https://mod.btfs.cn         MOD 下载站
//   wol-bj1  -> https://wol.bj1.wangerhuoda.cn  CHN2 区 API（register/ladder/wgameres/map-transfer）
//   wol-flkf -> https://wol.flkf.k0s.cn         ENGGER 区 API
// 注意：WebSocket 联机（wss://wol.../wol）无法经边缘函数代理，保持直连。

const UPSTREAMS = {
  gameres: "https://werhd.k0s.cn",
  gameres2: "https://wyhjres2.bun.sh.cn",
  fullpack: "https://download.ra2web.com",
  modbtfs: "https://mod.btfs.cn",
  "wol-bj1": "https://wol.bj1.wangerhuoda.cn",
  "wol-flkf": "https://wol.flkf.k0s.cn",
};

// 上游按 Origin 白名单校验，转发浏览器的 Origin/Referer 可能被上游 403，一律剥掉。
const STRIP_REQUEST_HEADERS = ["host", "origin", "referer", "cookie", "accept-encoding"];

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, Range",
};

function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function buildUpstreamUrl(url) {
  const prefix = "/proxy/";
  if (!url.pathname.startsWith(prefix)) return null;
  const rest = url.pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  const tag = slash === -1 ? rest : rest.slice(0, slash);
  const upstreamBase = UPSTREAMS[tag];
  if (!upstreamBase) return null;
  const path = slash === -1 ? "/" : rest.slice(slash);
  return upstreamBase + path + url.search;
}

async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const upstreamUrl = buildUpstreamUrl(url);
  if (!upstreamUrl) {
    return new Response(JSON.stringify({ error: "Unknown proxy target" }), {
      status: 404,
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }
  if (request.method === "OPTIONS") return corsPreflight();

  const headers = new Headers(request.headers);
  for (const name of STRIP_REQUEST_HEADERS) headers.delete(name);

  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
      redirect: "follow",
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Upstream request failed", detail: String(err) }), {
      status: 502,
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  const responseHeaders = new Headers(upstream.headers);
  // 上游若返回压缩内容，fetch 已自动解压，长度/编码头随之失效，必须移除。
  if (responseHeaders.has("content-encoding")) {
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
  }
  responseHeaders.set("access-control-allow-origin", "*");
  responseHeaders.set(
    "access-control-expose-headers",
    "Content-Length, Content-Range, Accept-Ranges",
  );

  // body 以流式透传，不落盘缓存，支持 7z 完整包等大文件的 Range 分段下载。
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export { onRequest };
export default onRequest;
