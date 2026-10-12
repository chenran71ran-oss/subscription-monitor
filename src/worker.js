// 订阅监控面板 — Cloudflare Worker (v01)

import { connect } from 'cloudflare:sockets';

const TIMEOUT_MS = 10000;

const HISTORY_MS = 8 * 86400000;

const MAX_SUBS = 30;

const MAX_PUSH_BYTES = 1500000;

const MAX_PREVIEW_BYTES = 262144;

// 依次尝试的客户端 UA：不同机场对 UA 白名单要求不同，第一个失败就换下一个。

const UA_LIST = [

  // 良心云/部分面板会按客户端 UA 返回不同格式；优先使用常见桌面客户端。

  'clash-verge-rev/2.0.3',

  'clash-verge/2.0.4',

  'ClashforWindows/0.20.39',

  'mihomo/1.19.0',

  'ClashMetaForAndroid/2.11.12',

  'Quantumult%20X/1.0.30 (iPhone; iOS 17.4.1; Scale/3.00)',

  'Shadowrocket/2.2.65',

  'v2rayN/7.10',

  'sing-box/1.11.0',

  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',

];

const LEGACY_FIRST_UA = 'ClashforWindows/0.20.39';
const TRANSPORT_FAILURE_CAP = 2;
const QUOTA_RECHECK_MS = 30 * 60000;

function isPushSubscription(sub, record) {
  return sub.mode === 'push' || (sub.mode !== 'pull' && record?.source === 'windows');
}

function reply(data, status = 200) {

  return new Response(JSON.stringify(data), { status, headers: {

    'content-type': 'application/json; charset=utf-8',

    'cache-control': 'no-store',

    'x-content-type-options': 'nosniff',

  }});

}

function timingSafeEqual(a, b) {

  if (a.length !== b.length) return false;

  let diff = 0;

  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return diff === 0;

}

function authorized(request, env) {

  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

  const secret = env.ADMIN_TOKEN || '';

  if (!token || !secret) return false;

  return timingSafeEqual(token, secret);

}

// 只要求：HTTPS、有效域名（非 IP 字面量、非 localhost/内网型域名）、无用户名密码。

// 支持非标准 HTTPS 端口；Worker 需启用 allow_custom_ports（2024-09-02 起默认）。

// 锚点(#remark)允许存在，抓取前会去掉。

function stripFragment(value) {

  const i = value.indexOf('#');

  return i === -1 ? value : value.slice(0, i);

}

function allowedUrl(value) {

  try {

    const u = new URL(stripFragment(value));

    const host = u.hostname.toLowerCase().replace(/\.$/, '');

    if (u.protocol !== 'https:' || u.username || u.password) return false;

    if (!host.includes('.') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) return false;

    if (/(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) return false;

    return true;

  } catch { return false; }

}

const numberOrNull = (value) => {

  if (!/^\d+$/.test(String(value).trim())) return null;

  const n = Number(value);

  return Number.isSafeInteger(n) && n >= 0 ? n : null;

};

function parseUserInfo(header) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const fields = {};
  for (const piece of header.split(/[;,]/)) {
    const i = piece.indexOf('='); if (i < 0) continue;
    const key = piece.slice(0, i).trim().toLowerCase();
    if (['upload','download','total','expire','used','remaining'].includes(key)) fields[key] = numberOrNull(piece.slice(i + 1));
  }
  if (!Object.values(fields).some(Number.isSafeInteger)) return null;
  if(fields.download!==undefined&&fields.download!==null&&fields.upload===undefined)fields.upload=0;
  return { upload:fields.upload??null, download:fields.download??null, total:fields.total??null,
    used:fields.used??null, remaining:fields.remaining??null,
    expire:fields.expire && fields.expire<=Number.MAX_SAFE_INTEGER/1000 ? fields.expire*1000 : null,
    noExpiry:fields.expire===0 ? true : null, quotaSource:'headers' };
}
function metadataHeader(headers) {
  return headers.get('subscription-userinfo') || headers.get('x-subscription-userinfo') || headers.get('subscription-user-info') || headers.get('subscription_userinfo') || null;
}
function hasTrafficInfo(info) {
  return !!info && ['upload','download','total','used','remaining'].some(k=>Number.isSafeInteger(info[k])&&info[k]>=0);
}
function hasUsageCounters(info) {
  return !!info && (Number.isSafeInteger(info.used) || (Number.isSafeInteger(info.upload)&&Number.isSafeInteger(info.download)) || (Number.isSafeInteger(info.total)&&Number.isSafeInteger(info.remaining)));
}
function mergeUserInfo(primary, fallback) {
  if (!primary) return fallback; if (!fallback) return primary;
  const merged={...fallback,...primary};
  for (const k of ['upload','download','total','used','remaining','expire','noExpiry']) merged[k]=primary[k]??fallback[k]??null;
  if(primary.expire>0)merged.noExpiry=false;else if(primary.noExpiry===true)merged.expire=null;
  return merged;
}
function trafficBytes(value, unit) {
  const n=Number(String(value).replace(/,/g,''));
  const key=String(unit).toUpperCase(), index=['B','K','M','G','T','P'].indexOf(key[0]);
  if (!Number.isFinite(n)||n<0||index<0) return null;
  const bytes=Math.round(n*1024**index);
  return Number.isSafeInteger(bytes)?bytes:null;
}

async function bodyPreview(res, limit = MAX_PREVIEW_BYTES) {

  if (!res.body) return { text: '', truncated: false };

  const reader = res.body.getReader();

  const decoder = new TextDecoder();

  let length = 0;

  let text = '';

  let truncated = false;

  try {

    while (length < limit) {

      const { value, done } = await reader.read();

      if (done) return { text: text + decoder.decode(), truncated };

      const take = Math.min(value.length, limit - length);

      text += decoder.decode(value.subarray(0, take), { stream: true });

      length += take;

      if (take < value.length) { truncated = true; break; }

    }

    truncated = true;

    return { text, truncated };

  } finally { await reader.cancel().catch(() => {}); }

}

const NODE_CAP = 200; // 单条订阅最多解析/展示这么多个节点，避免单条记录过大

const PROTO_NAMES = { vless: 'VLess', trojan: 'Trojan', ss: 'Shadowsocks', ssr: 'ShadowsocksR', hysteria: 'Hysteria', hysteria2: 'Hysteria2', hy2: 'Hysteria2', tuic: 'TUIC' };

// 节点对象只在服务端保留 host/port（用于测速），从不下发给前端——前端只会看到协议/传输/加密/名称/在线状态/延迟。

function decodeBase64Text(value) {

  const compact = String(value || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');

  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;

  try { const binary=atob(compact+'='.repeat((4-compact.length%4)%4));return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0))); } catch { return null; }

}

function decodeVmess(raw) {

  try {

    const json = JSON.parse(decodeBase64Text(raw.slice(8)) || '');

    return {

      protocol: 'VMess',

      transport: (json.net || 'tcp').toUpperCase(),

      security: json.tls ? 'TLS' : null,

      name: json.ps ? String(json.ps) : '未命名节点',

      host: json.add ? String(json.add) : null,

      port: json.port ? Number(json.port) : null,

    };

  } catch { return { protocol: 'VMess', transport: null, security: null, name: '未命名节点', host: null, port: null }; }

}

function decodeGenericNode(raw, scheme) {

  try {

    const u = new URL(raw);

    const type = u.searchParams.get('type');

    const securityParam = u.searchParams.get('security');

    const security = securityParam && securityParam !== 'none' ? securityParam

      : (scheme === 'trojan' || scheme === 'hysteria2' || scheme === 'hy2' || scheme === 'tuic') ? 'tls' : null;

    const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : '未命名节点';

    let host = u.hostname || null;

    let port = u.port ? Number(u.port) : null;

    if (scheme === 'ss' && (!host || !port)) {

      // 兼容旧版 ss:// 全 Base64 格式：ss://base64(method:password@host:port)

      try {

        const decoded = atob(raw.slice(5).split('#')[0].replace(/-/g, '+').replace(/_/g, '/'));

        const m = decoded.match(/@([^:@]+):(\d+)$/);

        if (m) { host = m[1]; port = Number(m[2]); }

      } catch { /* 放弃地址提取，节点仍会展示但不参与测速 */ }

    }

    return {

      protocol: PROTO_NAMES[scheme] || scheme.toUpperCase(),

      transport: type ? type.toUpperCase() : (scheme === 'ss' || scheme === 'ssr' ? null : 'TCP'),

      security: security ? security.toUpperCase() : null,

      name: name || '未命名节点',

      host, port,

    };

  } catch { return { protocol: PROTO_NAMES[scheme] || scheme.toUpperCase(), transport: null, security: null, name: '未命名节点', host: null, port: null }; }

}

// 把节点链接列表解析成结构化条目（协议/传输/加密/备注名 + host/port，host/port 仅用于测速，不下发）。

function parseNodeLinks(links) {

  const nodes = [];

  for (const raw of links.slice(0, NODE_CAP)) {

    const scheme = raw.slice(0, raw.indexOf(':')).toLowerCase();

    nodes.push(scheme === 'vmess' ? decodeVmess(raw) : decodeGenericNode(raw, scheme));

  }

  return { nodes, more: Math.max(0, links.length - NODE_CAP) };

}

function nodesFromClashProxiesArray(list) {

  return list.filter(p => p && (p.server || p.host)).slice(0, NODE_CAP).map(p => ({

    protocol: (p.type || '未知').toUpperCase(),

    transport: p.network ? String(p.network).toUpperCase() : null,

    security: (p.tls === true || p['reality-opts']) ? 'TLS' : null,

    name: p.name ? String(p.name) : '未命名节点',

    host: p.server || p.host || null,

    port: p.port ? Number(p.port) : null,

  }));

}

// Clash YAML 不做完整 YAML 解析（避免引入额外依赖），按每个列表项切块后用通用的 "key: value" 抓取，

// 块状写法（- name: xxx\n  type: ...）和单行紧凑写法（- {name: xxx, type: ..., server: ...}）都能认。

function parseYamlProxies(value) {

  const start = value.match(/^\s*proxies\s*:\s*$/m);

  if (!start) return { nodes: [], count: 0 };

  const rest = value.slice(start.index + start[0].length);

  const end = rest.match(/^\S[^\r\n]*:\s*$/m);

  const section = end ? rest.slice(0, end.index) : rest;

  // 只在缩进 ≤4 个空格处切分列表项，避免把节点内部的嵌套列表（如 alpn、ws-headers）误当成新节点。

  const chunks = section.split(/^[ \t]{0,4}-\s*/m).slice(1);

  const grab = (chunk, key) => (chunk.match(new RegExp('\\b' + key + '\\s*:\\s*([^,\\r\\n}]+)')) || [])[1]?.trim().replace(/^["']|["']$/g, '');

  const nodes = chunks.slice(0, NODE_CAP).map(chunk => {

    const type = grab(chunk, 'type') || '未知';

    const network = grab(chunk, 'network');

    const hasTls = /\btls\s*:\s*true\b/.test(chunk) || /\breality-opts\s*:/.test(chunk);

    const port = grab(chunk, 'port');

    return {

      protocol: type.toUpperCase(), transport: network ? network.toUpperCase() : null,

      security: hasTls ? 'TLS' : null, name: grab(chunk, 'name') || '未命名节点',

      host: grab(chunk, 'server') || null, port: port ? Number(port) : null,

    };

  });

  return { nodes, count: chunks.length };

}

function parseSingBoxOutbounds(list) {

  return list.slice(0, NODE_CAP).map(o => ({

    protocol: (o.type || '未知').toUpperCase(),

    transport: o.transport?.type ? String(o.transport.type).toUpperCase() : null,

    security: o.tls?.enabled ? 'TLS' : null,

    name: o.tag ? String(o.tag) : '未命名节点',

    host: o.server || null,

    port: o.server_port ? Number(o.server_port) : null,

  }));

}

// Quantumult X / Surge / Loon 共用的文本配置格式：[Proxy] 段下每行 "名称 = 类型, 地址, 端口, ..."。

function parseQuantumultConfig(value) {

  const start = value.match(/^\s*\[(?:Proxy|proxy)\]\s*$/m);

  if (!start) return [];

  const rest = value.slice(start.index + start[0].length);

  const end = rest.match(/^\s*\[[^\]]+\]\s*$/m);

  const section = end ? rest.slice(0, end.index) : rest;

  const nodes = [];

  for (const line of section.split(/\r?\n/)) {

    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed.startsWith('//')) continue;

    const eq = trimmed.indexOf('=');

    if (eq < 0) continue;

    const name = trimmed.slice(0, eq).trim();

    const parts = trimmed.slice(eq + 1).split(',').map(s => s.trim());

    const [type, host, portRaw] = parts;

    const port = Number(portRaw);

    if (!type || !host || !Number.isFinite(port)) continue;

    const tls = /(?:^|,)\s*(?:tls|over-tls)\s*=\s*true/i.test(trimmed);

    nodes.push({ protocol: type.toUpperCase(), transport: null, security: tls ? 'TLS' : null, name: name || '未命名节点', host, port });

    if (nodes.length >= NODE_CAP) break;

  }

  return nodes;

}

// 订阅内容解析器：识别常见的订阅资源格式（节点链接 / Clash YAML·JSON / Sing-box JSON / QX·Surge 文本配置），

// 在能确定完整内容时统计节点数，并尽量解析出逐条节点用于展示和测速。

function parseResource(text, truncated, type) {

  let value = text.trim();

  if (!value) return { format: '空响应', nodeCount: 0, nodes: [], nodesMore: 0 };

  // 以正文为准判断网页，不要因某些机场错误地返回 text/html 而丢弃有效订阅。

  const looksLikeHtml = /^\s*(?:<!doctype html|<html[\s>])/i.test(value) || /<body[\s>]/i.test(value);

  if (looksLikeHtml) return { format: '网页', nodeCount: null, nodes: [], nodesMore: 0 };

  // 兼容无补位、URL-safe、带换行的 Base64；不仅尝试节点链接，也尝试

  // Base64 编码的 Clash YAML/JSON（部分面板会这样返回）。

  if (/^[A-Za-z0-9+/_=\s-]+$/.test(value) && value.length > 32 && !truncated) {

    const decoded = decodeBase64Text(value);

    if (decoded && (/(?:^|\n)\s*(?:vmess|vless|trojan|ss|ssr|hysteria2?|hy2|tuic):\/\//im.test(decoded) ||

      /^\s*(?:\{|proxies\s*:|mixed-port\s*:|port\s*:)/i.test(decoded))) value = decoded.replace(/^\uFEFF/, '');

  }

  const links = value.match(/^(?:vmess|vless|trojan|ss|ssr|hysteria2?|hy2|tuic):\/\/\S+/gim);

  if (links?.length) {

    const { nodes, more } = parseNodeLinks(links);

    return { format: '节点链接订阅', nodeCount: truncated ? null : links.length, nodes, nodesMore: more };

  }

  if (/^\s*\{/.test(value)) {

    try {

      const obj = JSON.parse(value);

      if (Array.isArray(obj.proxies)) {

        const nodes = nodesFromClashProxiesArray(obj.proxies);

        return { format: 'Clash JSON', nodeCount: truncated ? null : obj.proxies.length, nodes, nodesMore: Math.max(0, obj.proxies.length - nodes.length) };

      }

      if (Array.isArray(obj.outbounds)) {

        const withServer = obj.outbounds.filter(o => o && o.server);

        const nodes = parseSingBoxOutbounds(withServer);

        return { format: 'Sing-box JSON', nodeCount: truncated ? null : withServer.length, nodes, nodesMore: Math.max(0, withServer.length - nodes.length) };

      }

      return { format: 'JSON 资源', nodeCount: null, nodes: [], nodesMore: 0 };

    } catch { return { format: 'JSON 资源', nodeCount: null, nodes: [], nodesMore: 0 }; }

  }

  if (/(?:^|\n)\s*proxies\s*:/i.test(value)) {

    const { nodes, count } = parseYamlProxies(value);

    return { format: 'Clash YAML', nodeCount: truncated ? null : count, nodes, nodesMore: Math.max(0, count - nodes.length) };

  }

  const qx = parseQuantumultConfig(value);

  if (qx.length) return { format: 'Quantumult X / Surge 配置', nodeCount: qx.length, nodes: qx, nodesMore: 0 };

  return { format: '未识别的资源', nodeCount: null, nodes: [], nodesMore: 0 };

}

// QX-compatible quota adapter, implemented for the Worker runtime.
// Reference behavior: KOP-XIAO/QuantumultX Scripts/resource-parser.js,
// SubFlow (response metadata), flowcheck (remarks), Rocket_flow (STATUS).
// No remote code execution, QX globals, hardcoded quota, or fabricated expiry.
function normalizeQuotaInfo(meta, source='body-metadata') {
  if (!meta || typeof meta!=='object' || Array.isArray(meta)) return null;
  const read=(...keys)=>{for(const k of keys){const n=numberOrNull(meta[k]);if(n!==null)return n;}return null;};
  const info={upload:read('upload'),download:read('download'),total:read('total','bytes_total'),
    used:read('used','bytes_used'),remaining:read('remaining','bytes_remaining'),
    expire:null,noExpiry:null,quotaSource:source};
  const expiry=read('expire','expire_date');
  if(expiry!==null){info.noExpiry=expiry===0?true:null;info.expire=expiry>0&&expiry<=Number.MAX_SAFE_INTEGER/1000?expiry*1000:null;}
  if(meta.noExpiry===true){info.noExpiry=true;info.expire=null;}
  if(info.upload!==null&&info.download!==null){const used=info.upload+info.download;if(Number.isSafeInteger(used))info.used=used;}
  if(info.total===null&&info.used!==null&&info.remaining!==null){const total=info.used+info.remaining;if(Number.isSafeInteger(total))info.total=total;}
  if(info.used===null&&info.total!==null&&info.remaining!==null&&info.remaining<=info.total)info.used=info.total-info.remaining;
  if(info.total!==null&&info.used!==null)info.remaining=Math.max(0,info.total-info.used);
  else if(info.total!==null&&info.remaining>info.total)info.remaining=null;
  return hasTrafficInfo(info)||info.expire||info.noExpiry===true?info:null;
}

function quotaDate(value) {
  const m=String(value||'').match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:$|[T\s])/);
  if(!m)return null;
  const [y,month,d]=m.slice(1).map(Number),utc=Date.UTC(y,month-1,d),check=new Date(utc);
  if(y<1970||check.getUTCFullYear()!==y||check.getUTCMonth()!==month-1||check.getUTCDate()!==d)return null;
  // Service dates are interpreted as midnight UTC+8, same as previous remarks.
  return utc-8*3600000;
}

function shadowrocketQuota(corpus) {
  const line=String(corpus).split(/\r?\n/).find(s=>/(?:^|[\s"'])STATUS\s*=/i.test(s)&&/(?:TOT|TOTAL)\s*:/i.test(s));
  if(!line)return null;
  const amount=label=>{
    const m=line.match(new RegExp('(?:'+label+')[：:=\\s]*([0-9]+(?:\\.[0-9]+)?)\\s*(KiB|MiB|GiB|TiB|PiB|KB|MB|GB|TB|PB|[KMGT]B?|B)(?![a-z])','i'));
    return m?trafficBytes(m[1],m[2]):null;
  };
  const total=amount('\\bTOT(?:AL)?'),upload=amount('↑|\\bUPLOAD'),download=amount('↓|\\bDOWNLOAD');
  // Require actual download and total; never invent the parser's fallback 1 byte.
  if(total===null||download===null)return null;
  const expires=line.match(/\bExpires?\s*[:=]\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/i);
  return {
    ...normalizeQuotaInfo({total,upload:upload??0,download},'remarks'),
    expire:expires?quotaDate(expires[1]):null
  };
}

function bodyUserInfo(text) {
  if(typeof text!=='string'||!text.trim())return null;
  let raw=text.trim().replace(/^\uFEFF/,'');
  const decoded=raw.length<=MAX_PUSH_BYTES?decodeBase64Text(raw):null;
  if(decoded&&/(?:\b(?:ss|ssr|vmess|vless|trojan|hysteria2?|hy2|tuic):\/\/|(?:^|\n)\s*(?:proxies\s*:|STATUS\s*=|subscription-userinfo\s*:|(?:shadowsocks|vmess|vless|trojan|http|socks5|anytls)\s*=)|^\s*\{)/im.test(decoded))raw=decoded;
  const match=raw.match(/^\s*(?:#|\/\/|;)?\s*(?:subscription-userinfo|x-subscription-userinfo)\s*:\s*([^\r\n]{1,512})/im);
  let header=match?parseUserInfo(match[1]):null;
  if(header)header.quotaSource='body-header';
  let textMetadata=null;
  if(/^\s*\{/.test(raw)){
    try{
      const json=JSON.parse(raw),userinfo=json['subscription-userinfo']||json.subscription_userinfo;
      if(typeof userinfo==='string'){textMetadata=parseUserInfo(userinfo);if(textMetadata)textMetadata.quotaSource='body-metadata';}
      const meta=json.subscriptionInfo||json.subscription_info||json.info;
      textMetadata=mergeUserInfo(normalizeQuotaInfo(meta),textMetadata);
      if(!textMetadata&&(Object.hasOwn(json,'bytes_remaining')||Object.hasOwn(json,'bytes_used')))textMetadata=normalizeQuotaInfo(json,'body-metadata');
    }catch{}
  }
  // Read names BEFORE QX-style out/regex filters and display metadata removal.
  // Node credentials/endpoints stay inside the existing server-only parser.
  const names=(parseResource(raw,false,'').nodes||[]).map(n=>n.name).join('\n');
  const commentLines=raw.split(/\r?\n/).filter(s=>/^\s*(?:#|\/\/|;|STATUS\s*=)/i.test(s)).join('\n');
  const corpus=names+'\n'+commentLines+'\n'+raw;
  const amount=labels=>{
    const m=corpus.match(new RegExp('(?:'+labels+')[：:=\\s]*([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?)\\s*(KiB|MiB|GiB|TiB|PiB|KB|MB|GB|TB|PB|[KMGT]B?|B)(?![a-z])','i'));
    return m?trafficBytes(m[1],m[2]):null;
  };
  const remaining=amount('剩[余餘](?:可用)?(?:流量|[额額]度)|剩[余餘]流量[余餘][额額]|[余餘]下流量|remaining(?:[ _-]*traffic)?|traffic[ _-]*left');
  const total=amount('[总總](?:流量|[额額]度)|套餐(?:[总總])?流量|total(?:[ _-]*traffic)?');
  const used=amount('已用(?:流量)?|已使用(?:流量)?|使用流量|used(?:[ _-]*traffic)?');
  const date=corpus.match(/(?:到期[时時][间間]|到期日期|有效期至|[过過]期[时時][间間]|expire(?:[ _-]*date)?)[：:=\s]*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/i);
  const expire=date?quotaDate(date[1]):null;
  const noExpiry=/(?:永久有效|永久套餐|[长長]期有效|永不[过過]期|到期(?:[时時][间間])?[：:=\s]*(?:永久|[长長]期|不限))/i.test(corpus)?true:null;
  const remarks=normalizeQuotaInfo({remaining,total,used,noExpiry:noExpiry===true},'remarks');
  if(remarks){remarks.expire=noExpiry?null:expire;remarks.noExpiry=noExpiry;}
  const datesOnly=!remarks&&(expire||noExpiry)?{expire,noExpiry,quotaSource:'remarks'}:null;
  return mergeUserInfo(header,mergeUserInfo(textMetadata,mergeUserInfo(shadowrocketQuota(corpus),remarks||datesOnly)));
}

function applyQuota(record, info, now) {
  if (!info) return;
  if (info.expire!==null&&info.expire!==undefined) record.expire=info.expire;
  if (info.noExpiry===true) {record.noExpiry=true;record.expire=null;}
  else if (info.expire>0) record.noExpiry=false;
  if (!hasTrafficInfo(info)) return;
  const source=info.quotaSource||'headers';
  if (record.quotaSource && record.quotaSource!==source) record.history=[];
  for (const k of ['upload','download','total','used','remaining']) record[k]=Number.isSafeInteger(info[k])&&info[k]>=0?info[k]:null;
  if (record.upload!==null&&record.download!==null) record.used=record.upload+record.download;
  else if (record.used===null&&record.total!==null&&record.remaining!==null&&record.remaining<=record.total) record.used=record.total-record.remaining;
  if (!Number.isSafeInteger(record.used)) record.used=null;
  if (record.total!==null&&record.used!==null) record.remaining=Math.max(0,record.total-record.used);
  else if (record.total!==null&&record.remaining>record.total) record.remaining=null;
  record.expire=info.expire??null;record.noExpiry=info.noExpiry===true;
  record.quotaSource=source;record.quotaUpdatedAt=now;
  if (record.used!==null) {record.history.push({at:now,used:record.used});record.history=record.history.slice(-400);}
}

async function getList(env) {

  const raw = await env.SUB_KV.get('list');

  return raw ? JSON.parse(raw) : [];

}

async function getData(env, id) {

  const raw = await env.SUB_KV.get('data:' + id);

  return raw ? recoverStoredMetadata(JSON.parse(raw)) : null;

}

// Migrate old snapshots from their saved remarks, using the original resource time.
// Reading old data never turns it into a fresh measurement or writes to KV.
function recoverStoredMetadata(record) {
  if (!record || !Array.isArray(record.nodes)) return record;
  const names = record.nodes.map(n => n.name || '').join('\n');
  const info = bodyUserInfo(names);
  if (!hasTrafficInfo(record) && record.quotaSource !== 'manual' && hasTrafficInfo(info)) {
    const at = record.resourceUpdatedAt || record.pushedAt || record.lastCheck;
    if (Number.isFinite(at) && at > 0) {
      record.history = Array.isArray(record.history) ? record.history : [];
      applyQuota(record, info, at);
    }
  }
  if (info?.noExpiry === true && !record.expire) record.noExpiry = true;
  return record;
}

// This measures CF -> endpoint TCP establishment, never client/proxy URL latency.
const NETWORK_OPERATION_CAP=40;
function networkBudget(limit=NETWORK_OPERATION_CAP){let used=0;return {remaining:()=>Math.max(0,limit-used),take(){if(used>=limit){const e=new Error('Network operation budget exhausted');e.code='MONITOR_NETWORK_BUDGET';throw e;}used++;}};}
function safeDiagnostic(error){
  const parts=[error?.name,error?.code,error?.message,error?.cause?.code,error?.cause?.message].filter(Boolean);
  return parts.join(' · ').replace(/(?:https?|vmess|vless|trojan|ss|ssr|hysteria2?|hy2|tuic):\/\/[^\s<>"']+/gi,'[地址已隐藏]')
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi,'[凭证已隐藏]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[地址已隐藏]')
    .replace(/\[[0-9a-f:]{3,}\]/gi,'[地址已隐藏]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi,'[域名已隐藏]')
    .replace(/((?:password|passwd|uuid|token|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隐藏]')
    .replace(/[a-z0-9+/_=-]{40,}/gi,'[长值已隐藏]').replace(/[\r\n\t]+/g,' ').slice(0,280)||'未提供底层异常';
}
function platformLimit(error){const msg=String(error?.message||'');if(error?.code==='MONITOR_NETWORK_BUDGET')return {code:'operation_budget',message:'本次检测操作预算已用完，未作节点离线判断'};if(/too many subrequests|subrequest.*limit|subrequest.*exceed/i.test(msg))return {code:'request_limit',message:'Worker 子请求数量达到平台限制'};if(/too many.*connections|connection.*limit|too many.*sockets/i.test(msg))return {code:'connection_limit',message:'Worker 并发连接达到平台限制'};return null;}
const LATENCY_TEST_CAP=60;
const LATENCY_TIMEOUT_MS=5500;
const LATENCY_CONCURRENCY=4;
function workPool(limit) {
  let active=0;const waiting=[];
  function pump(){while(active<limit&&waiting.length){const job=waiting.shift();active++;Promise.resolve().then(job.fn).then(job.resolve,job.reject).finally(()=>{active--;pump();});}}
  return {run(fn){return new Promise((resolve,reject)=>{waiting.push({fn,resolve,reject});pump();});}};
}
function probeContext(){return {pool:workPool(LATENCY_CONCURRENCY),deadline:Date.now()+35000,budget:networkBudget()};}
function probeFailure(state, reason, testable=true) {
  return {online:['timeout','refused','failed'].includes(state)?false:null,latencyMs:null,testable,probeState:state,probeReason:reason};
}
function classifyProbeError(error) {
  const msg=String(error?.message||error||''),limit=platformLimit(error);
  if(limit)return probeFailure('resource_limit',limit.message,false);
  if (/cloudflare|disallowed|prohibited|not allowed|blocked|loop detected|proxy request failed.*403|cannot connect to the specified address/i.test(msg)) return probeFailure('restricted','Worker 平台限制此地址的 TCP 连接',false);
  if (/dns|resolve|ENOTFOUND|EAI_AGAIN|hostname/i.test(msg)) return probeFailure('dns','Worker 侧域名解析失败',false);
  if (/refused|ECONNREFUSED/i.test(msg)) return probeFailure('refused','节点拒绝 Cloudflare 发起的 TCP 连接');
  return probeFailure('failed','Cloudflare 到节点的 TCP 连接失败 · '+safeDiagnostic(error));
}
async function tcpProbe(host, port, budget) {
  const numericPort=Number(port);
  if(typeof host!=='string'||!host.trim()||!Number.isInteger(numericPort)||numericPort<1||numericPort>65535)return probeFailure('invalid','缺少有效服务器地址或端口',false);
  const started=Date.now();let socket,timer;
  try {
    budget?.take();
    socket=connect({hostname:host.trim().replace(/^\[|\]$/g,''),port:numericPort});
    socket.closed?.catch(()=>{});
    const opened=await Promise.race([socket.opened.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),LATENCY_TIMEOUT_MS);})]);
    return opened?{online:true,latencyMs:Date.now()-started,testable:true,probeState:'reachable',probeReason:null}:probeFailure('timeout','Cloudflare 到节点的 TCP 连接超时（5.5 秒）');
  } catch(error) {return classifyProbeError(error);}
  finally {if(timer)clearTimeout(timer);try{await socket?.close();}catch{}}
}
function isMetadataNode(n){if(/^\s*STATUS\s*=/i.test(n.name||'')&&shadowrocketQuota(n.name))return true;return /^(?:[\s📢📣⚠️🔔🔗👉⭐★☆]*)(?:剩余(?:流量|额度)|总流量|已用流量|套餐(?:流量|到期)|到期时间|到期日期|流量重置|更新订阅|官网[:：]|公告[:：]|请选择节点|防失联|售前\s*[\/／]\s*售后)/u.test(n.name||'');}
function tcpUnsupported(n){return /^(?:hysteria2?|hy2|tuic)$/i.test(n.protocol||'')||/^(?:quic|udp)$/i.test(n.transport||'');}
async function probeNodes(nodes,context=probeContext()) {
  let eligible=0;
  return Promise.all(nodes.map(n=>{
    if(isMetadataNode(n))return {...n,...probeFailure('metadata','订阅说明条目，无需连接检测',false)};
    if(tcpUnsupported(n))return {...n,...probeFailure('unsupported','UDP / QUIC 协议不适用 Worker TCP 检测',false)};
    if(eligible++>=LATENCY_TEST_CAP)return {...n,...probeFailure('budget','超过本次 TCP 探测数量上限',false)};
    return context.pool.run(async()=>{
      if(Date.now()>=context.deadline)return {...n,...probeFailure('budget','本次检测时间预算已用完，未作离线判断',false)};
      let result=await tcpProbe(n.host,n.port,context.budget);
      if(['timeout','failed'].includes(result.probeState)&&Date.now()+LATENCY_TIMEOUT_MS<context.deadline){result=await tcpProbe(n.host,n.port,context.budget);result.probeAttempts=2;}else result.probeAttempts=1;
      return {...n,...result};
    });
  }));
}

function usageChange(history, current, interval) {

  if (!Number.isSafeInteger(current) || !Array.isArray(history)) return null;

  const threshold = Date.now() - interval;

  const baseline = history.filter(p => p && Number.isFinite(p.at) &&

    p.at <= threshold && p.at >= threshold - 90 * 60000 &&

    Number.isSafeInteger(p.used)).at(-1);

  return baseline && current >= baseline.used ? current - baseline.used : null;

}

// Calendar usage in Asia/Shanghai. Incomplete history is reported explicitly.
function usagePeriod(history, current, sampleAt, period, now = Date.now()) {
  if (!Number.isSafeInteger(current) || !Number.isFinite(sampleAt)) return null;
  const day = 86400000, offset = 8 * 3600000;
  const local = new Date(now + offset);
  let start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset;
  if (period === 'week') start -= ((local.getUTCDay() + 6) % 7) * day;
  if (sampleAt < start) return null;
  const points = (Array.isArray(history) ? history : []).filter(p => p && Number.isFinite(p.at) && Number.isSafeInteger(p.used) && p.used >= 0 && p.at <= sampleAt).sort((a,b) => a.at-b.at);
  const before = points.filter(p => p.at <= start && p.at >= start - 90 * 60000).at(-1);
  const baseline = before || points.find(p => p.at >= start);
  if (!baseline) return null;
  let previous = baseline.used, bytes = 0, reset = false;
  for (const p of points.filter(p => p.at > baseline.at)) {
    if (p.used < previous) { reset = true; bytes += p.used; }
    else bytes += p.used - previous;
    previous = p.used;
  }
  if (current < previous) { reset = true; bytes += current; }
  else bytes += current - previous;
  return { bytes, since: before ? start : baseline.at, until: sampleAt, partial: !before, reset };
}

function publicRecord(sub, record) {

  const r = record || {};

  const upload = Number.isSafeInteger(r.upload) ? r.upload : null;

  const download = Number.isSafeInteger(r.download) ? r.download : null;

  const total = Number.isSafeInteger(r.total) && r.total > 0 ? r.total : null;

  const used = upload !== null && download !== null && Number.isSafeInteger(upload+download) ? upload+download : Number.isSafeInteger(r.used)&&r.used>=0 ? r.used : null;

  const remaining = total !== null && used !== null ? Math.max(0,total-used) : Number.isSafeInteger(r.remaining)&&r.remaining>=0 ? r.remaining : null;

  const percent = total !== null && used !== null ? used / total * 100 : null;

  const expire = Number.isFinite(r.expire) && r.expire > 0 ? r.expire : null;

  const now = Date.now();

  let state = 'pending';

  if (r.lastCheck) {

    if (!r.online) state = 'unreachable';

    else if (r.quotaUpdatedAt !== r.lastCheck && r.quotaSource!=='manual') state='no_quota_header';

    else if (expire && expire <= now) state = 'expired';

    else if (remaining === 0) state = 'exhausted';

    else if ((percent !== null && percent >= 90) || (expire && expire - now < 3 * 86400000)) state = 'warning';

    else state = r.quotaSource==='manual'?'manual_quota':'active';

  }

  return {

    id: sub.id, name: sub.name, source: sub.source || null, mode: isPushSubscription(sub,r) ? 'push' : 'pull', pushedAt: r.pushedAt || (r.source === 'windows' ? r.lastCheck : null),

    online: r.online ?? null, state,

    upload, download, total, used, remaining, percent, expire, noExpiry:r.noExpiry===true, quotaSource:r.quotaSource||null, quotaNote:r.quotaNote||null, quotaAttempts:r.quotaAttempts||[], nodeProbeUpdatedAt:r.nodeProbeUpdatedAt||null,

    resourceFormat: r.resourceFormat || null, nodeCount: r.nodeCount ?? null,

    nodes: Array.isArray(r.nodes) ? r.nodes.filter(n => !isMetadataNode(n)).map(n => ({

      name: n.name, protocol: n.protocol, transport: n.transport, security: n.security,

      online:n.online??null,latencyMs:n.latencyMs??null,testable:n.testable!==false,probeState:n.probeState||null,probeReason:n.probeReason||null,probeAttempts:n.probeAttempts||null,

    })) : [],

    nodesMore: r.nodesMore || 0,

    resourceUpdatedAt: r.resourceUpdatedAt || null,

    lastCheck: r.lastCheck || null, lastOnline: r.lastOnline || null,

    quotaUpdatedAt: r.quotaUpdatedAt || null,

    httpStatus: r.httpStatus ?? null, latencyMs: r.latencyMs ?? null,

    triedUA: r.triedUA || null,

    attempts: Array.isArray(r.attempts) ? r.attempts : [],

    errorSnippet: r.errorSnippet || null, finalHost: r.finalHost || null,

    error: r.error || null, errorCode:r.errorCode||null,

    usageToday: r.online && r.quotaSource!=='manual' && r.quotaUpdatedAt === r.lastCheck ? usagePeriod(r.history, used, r.quotaUpdatedAt, 'day') : null,
    delta24h: r.online && r.quotaSource!=='manual' && r.quotaUpdatedAt === r.lastCheck ? usageChange(r.history, used, 86400000) : null,


  };

}

// 单次抓取尝试（固定 UA，跟随跳转）。

async function fetchOnce(rawUrl, ua, signal, budget) {

  let target = stripFragment(rawUrl);

  let res;

  for (let hop = 0; hop <= 3; hop++) {

    if (!allowedUrl(target)) throw new Error('订阅或跳转地址不是允许的 HTTPS 域名');

    budget?.take();
    res = await fetch(target, {

      method: 'GET', redirect: 'manual', signal,

      // Match the original working request; format selection stays with the UA.
      headers: { 'User-Agent': ua },

      cf: { cacheTtl: 0 },

    });

    if (![301, 302, 303, 307, 308].includes(res.status)) break;

    const next = res.headers.get('location');

    await res.body?.cancel().catch(() => {});

    if (!next || hop === 3) throw new Error('订阅跳转次数过多');

    target = stripFragment(new URL(next, target).href);

  }

  return { res, host: new URL(target).hostname };

}

// 失败响应的诊断片段：去掉标签/脚本、压缩空白后截 160 字，用来判断是 WAF 挑战页还是对方自己的错误提示。

function cleanSnippet(text) {

  const clean = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')

    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  return clean ? safeDiagnostic({message:clean}).slice(0, 160) : null;

}

async function errorSnippet(res) {

  try { return cleanSnippet((await bodyPreview(res, 2048)).text); } catch { return null; }

}

// 每次检测/推送都从"上一次的记录"派生出新记录：保留用量与节点作为兜底，清空本次诊断信息。

function baseRecord(previous, now) {

  return {

    online: false, upload: previous.upload ?? null, download: previous.download ?? null,

    total:previous.total??null,expire:previous.expire??null,used:previous.used??null,remaining:previous.remaining??null,noExpiry:previous.noExpiry===true,quotaSource:previous.quotaSource||null,quotaNote:previous.quotaNote||null,quotaAttempts:[],nodeProbeUpdatedAt:previous.nodeProbeUpdatedAt||null,

    lastCheck: now, lastOnline: previous.lastOnline || null,

    quotaUpdatedAt: previous.quotaUpdatedAt || null, pushedAt: previous.pushedAt || null,

    httpStatus: null, latencyMs: null, error: null, triedUA: null,

    attempts: [], errorSnippet: null, finalHost: null,
    quotaProbeAt: previous.quotaProbeAt || null,
    source: previous.source || null,

    resourceFormat: previous.resourceFormat || null,

    nodeCount: previous.nodeCount ?? null,

    nodes: Array.isArray(previous.nodes) ? previous.nodes : [],

    nodesMore: previous.nodesMore || 0,

    resourceUpdatedAt: previous.resourceUpdatedAt || null,

    history: Array.isArray(previous.history) ? previous.history.filter(p =>

      p && Number.isFinite(p.at) && p.at >= now - HISTORY_MS &&

      Number.isSafeInteger(p.used) && p.used >= 0).slice(-400) : [],

  };

}

async function applyResult(record, resource, info, now, context=probeContext()) {
  record.online=true;record.error=null;record.lastOnline=now;
  if(['未识别的资源','JSON 资源'].includes(resource.format)){
    applyQuota(record,info,now);
    if(!context.deferProbes&&record.nodes.length){record.nodes=await probeNodes(record.nodes,context);record.nodeProbeUpdatedAt=Date.now();}
    return;
  }
  record.resourceFormat=resource.format;record.nodeCount=resource.nodeCount;
  record.nodes=resource.nodes?.length?(context.deferProbes?resource.nodes:await probeNodes(resource.nodes,context)):[];
  record.nodesMore=resource.nodesMore||0;record.resourceUpdatedAt=now;record.nodeProbeUpdatedAt=context.deferProbes?null:Date.now();
  applyQuota(record,info,now);
}
async function alternateQuota(url, firstUA, signal, record, budget) {
  // Keep a valid node snapshot even when the metadata-only alternatives fail.
  const choices=[UA_LIST.find(u=>u.startsWith('Quantumult')),UA_LIST.find(u=>u.startsWith('Shadowrocket')),UA_LIST.find(u=>u.startsWith('mihomo'))].filter(u=>u&&u!==firstUA).slice(0,1);
  for(const ua of choices){
    if(signal.aborted)break;
    try {
      const {res}=await fetchOnce(url,ua,signal,budget);
      record.quotaAttempts.push({ua:ua.split('/')[0].split('%')[0],status:res.status});
      if(!res.ok){await res.body?.cancel().catch(()=>{});continue;}
      const header=parseUserInfo(metadataHeader(res.headers));
      if(hasUsageCounters(header)){await res.body?.cancel().catch(()=>{});return header;}
      const preview=await bodyPreview(res),resource=parseResource(preview.text,preview.truncated,res.headers.get('content-type')||'');
      if(['网页','空响应'].includes(resource.format))continue;
      const info=mergeUserInfo(header,bodyUserInfo(preview.text));
      if(hasTrafficInfo(info))return info;
    }catch(error){const failure=subscriptionError(error);record.quotaAttempts.push({ua:ua.split('/')[0].split('%')[0],status:null,error:failure.message+' · '+safeDiagnostic(error),code:failure.code});if(platformLimit(error))break;}
  }
  return null;
}
// Attempts have their own timeout, inside a separate total fetch budget.
const SUB_FETCH_BUDGET_MS=24000;
async function subscriptionAttempt(deadline, fn, maxMs=TIMEOUT_MS) {
  const left=deadline-Date.now();
  if(left<=0){const error=new Error('budget');error.name='AbortError';throw error;}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(maxMs,left));
  try{return await fn(controller.signal);}finally{clearTimeout(timer);}
}
function validSubscription(resource, info){
  if(['网页','空响应'].includes(resource.format))return false;
  return !['未识别的资源','JSON 资源'].includes(resource.format)||hasTrafficInfo(info);
}
function subscriptionError(error){
  const msg=String(error?.message||''),limit=platformLimit(error);
  if(limit)return limit;
  if(/Network connection lost|ECONNRESET|connection.*reset|socket hang up/i.test(msg))return {code:'connection_reset',message:'CF 到订阅服务器的连接被中断或重置'};
  if(/invalid.*url|地址不是允许/i.test(msg))return {code:'url',message:'订阅或跳转地址不符合 HTTPS 域名要求'};
  if(error?.name==='AbortError')return {code:'timeout',message:'CF 获取订阅超时，已按剩余预算尝试其他客户端'};
  if(/证书|certificate|SSL|TLS|ERR_CERT/i.test(msg))return {code:'tls',message:'CF 到订阅服务器的 TLS / 证书验证失败'};
  if(/DNS|ENOTFOUND|EAI_AGAIN|resolve|hostname/i.test(msg))return {code:'dns',message:'CF 无法解析订阅服务器域名'};
  if(/not.*allow|disallow|prohibit|blocked|cannot connect to the specified address|loop detected/i.test(msg))return {code:'restricted',message:'Worker 平台限制了到订阅服务器的连接'};
  return {code:'network',message:'CF 到订阅服务器的网络请求失败（运行时未提供更具体原因）'};
}
async function checkOne(env,sub,sharedPool,options={}) {
  const previous=await getData(env,sub.id)||{};
  const context={pool:sharedPool||workPool(LATENCY_CONCURRENCY),deadline:Date.now()+35000,budget:options.budget||networkBudget(),deferProbes:options.deferProbes===true};
  if(isPushSubscription(sub,previous)){
    if(!context.deferProbes&&Array.isArray(previous.nodes)&&previous.nodes.length){previous.nodes=await probeNodes(previous.nodes,context);previous.nodeProbeUpdatedAt=Date.now();await env.SUB_KV.put('data:'+sub.id,JSON.stringify(previous));}
    return publicRecord(sub,previous);
  }
  const now=Date.now(),record=baseRecord(previous,now),deadline=now+SUB_FETCH_BUDGET_MS;
  const preferred=previous.preferredUA||previous.triedUA;
  const first=UA_LIST.includes(preferred)?preferred:LEGACY_FIRST_UA;
  const uas=[first,...UA_LIST.filter(ua=>ua!==first)];
  record.preferredUA=preferred||null;record.errorCode=null;let lastError=null,candidate=null,transportFailures=0;
  for(const ua of uas){
    if(Date.now()>=deadline||context.budget.remaining()===0)break;
    const started=Date.now();
    try {
      const result=await subscriptionAttempt(deadline,async signal=>{
        const {res,host}=await fetchOnce(sub.url,ua,signal,context.budget);
        transportFailures=0;
        record.httpStatus=res.status;record.latencyMs=Date.now()-started;record.finalHost=host;
        record.attempts.push({ua:ua.split('/')[0].split('%')[0],status:res.status});
        if(!res.ok){record.errorSnippet=await errorSnippet(res);record.errorCode='http_'+res.status;lastError='订阅服务器返回 HTTP '+res.status;return null;}
        const header=parseUserInfo(metadataHeader(res.headers));
        let preview;
        try { preview=await bodyPreview(res); }
        catch(error){
          if(!hasTrafficInfo(header))throw error;
          return {resource:{format:'JSON 资源',nodes:[],nodeCount:null},info:header,bodyIssue:'已读取流量响应头，但订阅正文读取中断；保留原节点。'+safeDiagnostic(error)};
        }
        const resource=parseResource(preview.text,preview.truncated,res.headers.get('content-type')||'');
        const info=mergeUserInfo(header,bodyUserInfo(preview.text));
        if(!validSubscription(resource,info)){
          record.errorSnippet=cleanSnippet(preview.text.slice(0,4096));record.errorCode=resource.format==='网页'?'html':'format';
          lastError=resource.format==='网页'?'订阅返回网页，可能需要登录或验证':'响应不是可识别的节点订阅或流量数据';return null;
        }
        return {resource,info};
      });
      if(!result){if([429,503].includes(record.httpStatus))break;continue;}
      record.triedUA=ua;record.preferredUA=ua;candidate=result;
      if(!hasUsageCounters(candidate.info)&&Date.now()<deadline&&(!record.quotaProbeAt||now-record.quotaProbeAt>=QUOTA_RECHECK_MS)){
        record.quotaProbeAt=now;
        try{candidate.info=mergeUserInfo(await subscriptionAttempt(deadline,signal=>alternateQuota(sub.url,ua,signal,record,context.budget),6000),candidate.info);}catch{}
      }
      break;
    }catch(error){
      const failure=subscriptionError(error);lastError=failure.message;record.errorCode=failure.code;
      record.attempts.push({ua:ua.split('/')[0].split('%')[0],status:null,error:lastError+' · '+safeDiagnostic(error),code:failure.code});
      if(platformLimit(error)||['url','tls','dns','restricted'].includes(failure.code))break;
      if(++transportFailures>=TRANSPORT_FAILURE_CAP)break;
    }
  }
  // Fetch retries do not consume the node probe time budget.
  context.deadline=Date.now()+35000;
  if(candidate){
    if(['未识别的资源','JSON 资源'].includes(candidate.resource.format)){
      record.online=true;record.lastOnline=now;record.error=null;applyQuota(record,candidate.info,now);
      if(!context.deferProbes&&record.nodes.length)record.nodes=await probeNodes(record.nodes,context);
    }else await applyResult(record,candidate.resource,candidate.info,now,context);
    if(!context.deferProbes)record.nodeProbeUpdatedAt=Date.now();record.errorCode=null;
    record.errorSnippet=candidate.bodyIssue||null;
    record.quotaNote=hasTrafficInfo(candidate.info)?null:'当前响应未包含可识别的流量字段；可在详情校准流量，或从原订阅推送响应头。';
  }else{
    record.error=(lastError||'所有客户端均未获取有效订阅内容')+(transportFailures>=TRANSPORT_FAILURE_CAP?'；连续两次连接失败，已停止重复请求':'');
    if(!context.deferProbes&&record.nodes.length){record.nodes=await probeNodes(record.nodes,context);record.nodeProbeUpdatedAt=Date.now();}
  }
  await env.SUB_KV.put('data:'+sub.id,JSON.stringify(record));
  return publicRecord(sub,record);
}
async function checkAll(env) {
  const list=await getList(env),checks=workPool(2),probes=workPool(LATENCY_CONCURRENCY),budget=networkBudget();
  const ages=new Map(await Promise.all(list.map(async sub=>[sub.id,(await getData(env,sub.id))?.lastCheck||0])));
  list.sort((a,b)=>ages.get(a.id)-ages.get(b.id));
  // Subscription retrieval completes before any node probes consume the shared budget.
  const entries=await Promise.all(list.map(sub=>checks.run(async()=>{
    try {
      if(!budget.remaining()){const previous=await getData(env,sub.id);return {sub,result:{...publicRecord(sub,previous),checkDeferred:true,checkNote:'批量请求预算已用完，本次未刷新该订阅'}};}
      return {sub,result:await checkOne(env,sub,probes,{budget,deferProbes:true})};
    }catch(error){return {sub,result:{id:sub.id,name:sub.name,state:'unreachable',error:subscriptionError(error).message,errorCode:subscriptionError(error).code},failed:true};}
  })));
  await Promise.all(entries.map(entry=>checks.run(async()=>{
    if(entry.failed||entry.result.checkDeferred)return;
    try{const record=await getData(env,entry.sub.id);if(record?.nodes?.length){record.nodes=await probeNodes(record.nodes,{pool:probes,deadline:Date.now()+35000,budget});record.nodeProbeUpdatedAt=Date.now();await env.SUB_KV.put('data:'+entry.sub.id,JSON.stringify(record));entry.result=publicRecord(entry.sub,record);}}
    catch(error){entry.result.nodeCheckError=subscriptionError(error).message;}
  })));
  return entries.map(entry=>entry.result);
}

async function manualQuota(request,env,url){
  if(request.method!=='POST')return reply({error:'Method not allowed'},405);
  const raw=await request.text();if(raw.length>4096)return reply({error:'请求过大'},413);
  let body;try{body=JSON.parse(raw);}catch{return reply({error:'JSON 格式错误'},400);}
  const total=body.total,remaining=body.remaining;
  if(!Number.isSafeInteger(total)||total<=0||!Number.isSafeInteger(remaining)||remaining<0||remaining>total||typeof body.noExpiry!=='boolean')return reply({error:'总量必须大于零，剩余流量须在零与总量之间'},400);
  const list=await getList(env),sub=list.find(s=>s.id===url.searchParams.get('id'));
  if(!sub)return reply({error:'订阅不存在'},404);
  const now=Date.now(),record=await getData(env,sub.id)||baseRecord({},now);
  applyQuota(record,{upload:null,download:null,total,remaining,used:total-remaining,expire:body.noExpiry?null:record.expire??null,noExpiry:body.noExpiry,quotaSource:'manual'},now);
  record.quotaNote='手动流量快照，不会随节点连接检测自动扣减。';
  await env.SUB_KV.put('data:'+sub.id,JSON.stringify(record));
  return reply({ok:true,sub:publicRecord(sub,record)});
}

// Compatibility endpoint for the original Windows push script.
async function ingestLegacyPush(request, env) {
  if (!env.INGEST_TOKEN) return reply({error:'缺少 INGEST_TOKEN 配置'},503);
  if (!authorized(request,{ADMIN_TOKEN:env.INGEST_TOKEN})) return reply({error:'推送口令不正确'},401);
  if (Number(request.headers.get('content-length')||0)>MAX_PUSH_BYTES) return reply({error:'推送数据过大'},413);
  const raw=await request.text();
  if (new TextEncoder().encode(raw).byteLength>MAX_PUSH_BYTES) return reply({error:'推送数据过大'},413);
  let body;try {body=JSON.parse(raw);}catch {return reply({error:'JSON 格式错误'},400);}
  const id=typeof body.id==='string'?body.id.trim():'',status=Number(body.status);
  const content=typeof body.content==='string'?body.content:'';
  if(!/^[a-f0-9]{8}$/i.test(id)||!Number.isInteger(status)||status<0||status>599)return reply({error:'推送参数无效'},400);
  if(new TextEncoder().encode(content).byteLength>MAX_PREVIEW_BYTES)return reply({error:'订阅内容超过 256 KiB 限制'},413);
  const sub=(await getList(env)).find(s=>s.id===id);
  if(!sub)return reply({error:'订阅不存在，请核对面板中的 ID'},404);
  if(sub.source==='file')return reply({error:'文件订阅请使用重新导入'},409);
  const now=Date.now(),previous=await getData(env,id)||{},record=baseRecord(previous,now);
  const resource=parseResource(content,body.truncated===true,typeof body.contentType==='string'?body.contentType.slice(0,120):'');
  const info=mergeUserInfo(parseUserInfo(typeof body.userInfo==='string'?body.userInfo.slice(0,512):null),bodyUserInfo(content));
  record.source='windows';record.pushedAt=now;record.httpStatus=status||null;
  record.triedUA='Windows';record.attempts=[{ua:'Windows',status:status||null}];
  if(status>=200&&status<300&&validSubscription(resource,info)) {
    await applyResult(record,resource,info,now);
    record.latencyMs=Number.isFinite(body.fetchMs)&&body.fetchMs>=0&&body.fetchMs<=120000?Math.round(body.fetchMs):null;
    record.quotaNote=hasTrafficInfo(info)?null:'推送内容未包含可识别的流量字段；保留此前快照。';
  }else{
    record.error=status>=200&&status<300?'Windows 推送内容不是有效节点订阅或流量数据':status?'Windows 本地拉取返回 HTTP '+status:cleanSnippet(typeof body.error==='string'?body.error:'')||'Windows 本地请求失败';
    record.errorSnippet=cleanSnippet(content);
  }
  await env.SUB_KV.put('data:'+id,JSON.stringify(record));
  return reply({ok:record.online,state:publicRecord(sub,record).state,httpStatus:record.httpStatus});
}

async function api(request, env, url) {

  if (!env.SUB_KV) return reply({ error: '缺少 SUB_KV 绑定' }, 503);

  if(url.pathname==='/api/ingest'&&request.method==='POST')return ingestLegacyPush(request,env);

  if (!authorized(request, env)) return reply({ error: '口令不正确' }, 401);

  const path = url.pathname;
  if(path==='/api/import')return importSubscriptionFile(request,env,url);
  if(path==='/api/quota')return manualQuota(request,env,url);

  if (path === '/api/status' && request.method === 'GET') {

    const list = await getList(env);

    return reply({ subs: await Promise.all(list.map(async s => publicRecord(s, await getData(env, s.id)))) });

  }

  if(path==='/api/check'&&request.method==='POST'){
    const id=url.searchParams.get('id');
    if(id){const list=await getList(env),sub=list.find(s=>s.id===id);if(!sub)return reply({error:'订阅不存在'},404);return reply({sub:await checkOne(env,sub)});}
    return reply({subs:await checkAll(env)});
  }

  if (path === '/api/subs' && request.method === 'POST') {

    if (Number(request.headers.get('content-length') || 0) > 4096) return reply({ error: '请求过大' }, 413);

    const raw = await request.text();

    if (raw.length > 4096) return reply({ error: '请求过大' }, 413);

    let body;

    try { body = JSON.parse(raw); } catch { return reply({ error: 'JSON 格式错误' }, 400); }

    const name = typeof body.name === 'string' ? body.name.trim() : '';

    const push = body.mode === 'push';

    const cleanUrl = typeof body.url === 'string' ? stripFragment(body.url.trim()) : '';

    if (!name || name.length > 80) return reply({ error: '请填写名称' }, 400);

    if (!push && (!cleanUrl || cleanUrl.length > 2048 || !allowedUrl(cleanUrl))) {

      return reply({ error: '请填写 HTTPS 订阅链接' }, 400);

    }

    const list = await getList(env);

    if (list.length >= MAX_SUBS) return reply({ error: '最多添加 30 个订阅' }, 400);

    if (!push && list.some(s => s.url === cleanUrl)) return reply({ error: '该链接已添加' }, 409);

    // 推送模式不在 Worker 里保存订阅链接：链接只留在你自己电脑上的脚本里。

    const sub = push ? { id: crypto.randomUUID().slice(0, 8), name, mode: 'push' }

                     : { id: crypto.randomUUID().slice(0, 8), name, url: cleanUrl };

    await env.SUB_KV.put('list', JSON.stringify([...list, sub]));

    return reply({ sub: push ? publicRecord(sub, null) : await checkOne(env, sub) });

  }

  if (path === '/api/push' && request.method === 'POST') {

    const list = await getList(env);

    const sub = list.find(s => s.id === url.searchParams.get('id'));

    if (!sub || !isPushSubscription(sub,await getData(env,sub.id))) return reply({ error: '订阅不存在，或不是推送模式' }, 404);

    if (Number(request.headers.get('content-length') || 0) > MAX_PUSH_BYTES) return reply({ error: '内容过大' }, 413);

    const raw = await request.text();

    if (raw.length > MAX_PUSH_BYTES) return reply({ error: '内容过大' }, 413);

    let body;

    try { body = JSON.parse(raw); } catch { return reply({ error: 'JSON 格式错误' }, 400); }

    const text = typeof body.body === 'string' ? body.body : '';

    if (!text) return reply({ error: '缺少订阅内容' }, 400);

    const contentType = typeof body.contentType === 'string' ? body.contentType.slice(0, 120) : '';

    const userinfo = typeof body.userinfo === 'string' ? body.userinfo.slice(0, 512) : null;

    const now = Date.now();

    const record = baseRecord(await getData(env, sub.id) || {}, now);

    const resource = parseResource(text, false, contentType);
    const info=mergeUserInfo(parseUserInfo(userinfo),bodyUserInfo(text));

    if (!validSubscription(resource,info)) {

      record.error = resource.format === '网页' ? '推送的内容是网页，可能被验证页拦截' : '推送的内容不是有效节点订阅或流量数据';

      record.errorSnippet = cleanSnippet(text.slice(0, 4096));

      await env.SUB_KV.put('data:' + sub.id, JSON.stringify(record));

      return reply({ ok: false, error: record.error }, 422);

    }

    await applyResult(record, resource, info, now);

    record.httpStatus = 200;

    record.pushedAt = now;

    await env.SUB_KV.put('data:' + sub.id, JSON.stringify(record));

    return reply({ ok: true, format: resource.format, nodes: record.nodes.length, hasUsage: record.quotaUpdatedAt === now });

  }

  if (path === '/api/subs' && request.method === 'DELETE') {

    const id = url.searchParams.get('id');

    const list = await getList(env);

    if (!id || !list.some(s => s.id === id)) return reply({ error: '订阅不存在' }, 404);

    await env.SUB_KV.put('list', JSON.stringify(list.filter(s => s.id !== id)));

    await env.SUB_KV.delete('data:' + id);

    return reply({ ok: true });

  }

  return reply({ error: '未找到接口' }, 404);

}

// 页面（由 page.html 构建时嵌入）

async function importSubscriptionFile(request, env, url) {
  if(request.method!=='POST')return reply({error:'Method not allowed'},405);
  const reader=request.body?.getReader();if(!reader)return reply({error:'缺少文件内容'},400);
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_PUSH_BYTES){await reader.cancel();return reply({error:'文件请求过大，最多 1 MB 文件'},413);}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return reply({error:'请求格式错误，请选择 UTF-8 文本文件'},400);}
  const name=typeof body.name==='string'?body.name.trim():'';
  const content=typeof body.content==='string'?body.content.replace(/^\uFEFF/,''):'';
  if(!name||name.length>80)return reply({error:'请填写名称（最多80字）'},400);
  if(!content.trim()||new TextEncoder().encode(content).length>1000000)return reply({error:'请选择非空的文件，大小最多 1 MB'},400);
  const resource=parseResource(content,false,'');
  const usable=(resource.nodes||[]).filter(n=>typeof n.host==='string'&&n.host.trim()&&Number.isInteger(n.port)&&n.port>0&&n.port<=65535);
  if(!usable.length)return reply({error:'未解析到含服务器地址和端口的节点。请选择完整 Clash YAML、节点 JSON 或节点链接文本；仅含 proxy-providers 的配置需先下载其节点文件。原数据未修改。'},422);
  const list=await getList(env);const id=url.searchParams.get('id');const old=id?list.find(s=>s.id===id):null;
  if(id&&(!old||old.source!=='file'))return reply({error:'文件订阅不存在，无法覆盖'},404);
  if(!old&&list.length>=MAX_SUBS)return reply({error:'最多添加 30 个订阅'},400);
  const sub=old?{...old,name}:{id:crypto.randomUUID().slice(0,8),name,mode:'push',source:'file'};
  // New files replace automatic quota snapshots; explicitly calibrated manual quotas retain their original timestamp.
  const previous=old?await getData(env,sub.id)||{}:{};
  const now=Date.now(),record=baseRecord(previous.quotaSource==='manual'?previous:{},now);
  await applyResult(record,resource,mergeUserInfo(parseUserInfo(body.userinfo),bodyUserInfo(content)),now);record.httpStatus=null;record.pushedAt=now;
  await env.SUB_KV.put('data:'+sub.id,JSON.stringify(record));
  if(!old)await env.SUB_KV.put('list',JSON.stringify([...list,sub]));
  else if(old.name!==name)await env.SUB_KV.put('list',JSON.stringify(list.map(s=>s.id===id?sub:s)));
  return reply({sub:publicRecord(sub,record),format:resource.format,nodes:record.nodes.length,hasUsage:record.quotaUpdatedAt===now});
}

/* __EMBED_DASHBOARD__ */
export default {

  async fetch(request, env) {

    const url = new URL(request.url);

    if(url.pathname === '/favicon.svg') return new Response("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><defs><linearGradient id=\"a\" x2=\"1\" y2=\"1\"><stop stop-color=\"#42d9c5\"/><stop offset=\"1\" stop-color=\"#5087ff\"/></linearGradient></defs><rect x=\"2\" y=\"2\" width=\"60\" height=\"60\" rx=\"18\" fill=\"url(#a)\"/><rect x=\"14\" y=\"17\" width=\"15\" height=\"30\" rx=\"5\" fill=\"white\"/><rect x=\"34\" y=\"17\" width=\"16\" height=\"13\" rx=\"4\" fill=\"white\"/><rect x=\"34\" y=\"35\" width=\"16\" height=\"12\" rx=\"4\" fill=\"white\" opacity=\".7\"/></svg>",{headers:{'content-type':'image/svg+xml','cache-control':'public,max-age=86400'}});
    
    if (url.pathname.startsWith('/api/')) return api(request, env, url);

    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /', { headers: { 'content-type': 'text/plain' } });

    if (url.pathname === '/' || url.pathname === '/index.html') return new Response(page(), { headers: {

      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',

      'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow',

      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'",

    }});

    return new Response('Not found', { status: 404 });

  },

  async scheduled(_event, env, ctx) { ctx.waitUntil(checkAll(env)); },

};
