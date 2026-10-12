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

function page(){return "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"color-scheme\" content=\"dark light\">\n<meta name=\"theme-color\" content=\"#1c2028\" media=\"(prefers-color-scheme: dark)\">\n<meta name=\"theme-color\" content=\"#f3f4f6\" media=\"(prefers-color-scheme: light)\">\n<link rel=\"icon\" href=\"/favicon.svg?design=bright\" type=\"image/svg+xml\"><title>订阅监控面板</title>\n<style>\n/* v10 · reference palette; layout and motion stay identical to v05. */\n:root{color-scheme:light;--bg0:#f4f1f5;--bg1:#f4f1f5;--text:#18171b;--muted:#52515b;--faint:#716f7a;--glass:#fffcff;--glass-2:#fbf7fb;--card-hover:#fbf7fb;--line:#e9e6ec;--field:#e5e2e5;--chip-text:#3f3e46;--segment-empty:#edeaef;--quota-empty:#e4e1e7;--ok:#0e7944;--success-bar:#33c776;--tcp:#007e58;--accent:#2c69dc;--blue:#377dff;--purple:#8d5cf6;--orange:#ea7c39;--pink:#ed499b;--traffic:#9f6206;--traffic-accent:#da972c;--warn:#8b640c;--warn-bar:#e4ac36;--bad:#c52028;--bad-bar:#df3033;--info:#2b65b5;--quota-green:#46be6c;--quota-lime:#8dce4b;--quota-yellowgreen:#c8d729;--quota-yellow:#eac000;--quota-amber:#ec9d06;--quota-alert:#d94c44;--liquid:rgba(255,255,255,.76);--liquid-rim:rgba(255,255,255,.98);font-family:-apple-system,BlinkMacSystemFont,\"SF Pro Text\",\"PingFang SC\",\"Microsoft YaHei UI\",\"Segoe UI\",system-ui,sans-serif}\n:root[data-theme=dark]{color-scheme:dark;--bg0:#1c2028;--bg1:#1c2028;--text:#f0edf5;--muted:#c2bdcb;--faint:#a39cac;--glass:#242832;--glass-2:#2b2e3a;--card-hover:#2b2e3a;--line:#3c3b4a;--field:#383844;--chip-text:#ddd7e5;--segment-empty:#393743;--quota-empty:#423f4b;--ok:#52d48c;--success-bar:#43d884;--tcp:#31d998;--accent:#2f70d2;--blue:#6ba0ff;--purple:#af85ff;--orange:#f19c64;--pink:#f875b6;--traffic:#efb750;--traffic-accent:#efb750;--warn:#e6bc57;--warn-bar:#e6bc57;--bad:#f78a8b;--bad-bar:#ed6468;--info:#85b5ff;--quota-green:#48cc7e;--quota-lime:#9bd75a;--quota-yellowgreen:#d0dc42;--quota-yellow:#edc934;--quota-amber:#eda532;--quota-alert:#ed7770;--liquid:rgba(122,117,146,.22);--liquid-rim:rgba(242,233,255,.19)}\n*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}[hidden]{display:none!important}html,body{min-height:100%;background:var(--bg0);transition:none}body{margin:0;padding:18px 18px 28px;color:var(--text);font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased}button,input,select{font:inherit;color:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--muted);outline-offset:3px}button:disabled{opacity:.5;cursor:wait}svg{display:block}.wall,.orb{display:none}.shell{max-width:1600px;margin:0 auto;width:100%;min-width:0}.glass{position:relative;background:var(--glass);border:1px solid var(--line);border-radius:20px;box-shadow:none}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}\n.bar{display:flex;justify-content:space-between;align-items:center;gap:16px;background:transparent;border:0;border-radius:0;margin:0 0 18px;padding:0}.bar h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.03em}.sum{color:var(--faint);font-size:10px;margin-top:3px}.reference-tools{display:flex;align-items:center;gap:9px;flex:none}.theme-switch{position:relative;display:flex;align-items:center;gap:9px;isolation:isolate}.icon-button{display:grid;place-items:center;position:relative;flex:none;z-index:1;width:40px;height:40px;min-width:40px;min-height:40px;border:1px solid var(--line);border-radius:50%;padding:10px;background:transparent;color:var(--muted);transition:background .18s,color .18s,border-color .18s;overflow:hidden}.icon-button svg{width:20px;height:20px}.icon-button:hover{background:var(--glass-2);color:var(--text)}.icon-button[aria-pressed=true]{color:var(--text);border-color:color-mix(in srgb,var(--muted) 55%,var(--line));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--muted) 18%,transparent)}.display-button{border-color:var(--line);box-shadow:none}#overviewToggle svg{transition:transform .3s}#overviewToggle[data-collapsed=true] svg{transform:rotate(90deg)}\n.utility-row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 16px}.acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.btn{cursor:pointer;border:1px solid var(--line);background:var(--glass);color:var(--text);padding:7px 13px;min-height:32px;border-radius:12px;font-size:12px;font-weight:600;transition:background .16s,color .16s}.btn:hover{background:var(--glass-2)}.btn.primary{background:var(--accent);border-color:var(--accent);color:white}.btn.ghost{border-color:transparent;background:transparent;color:var(--muted);font-weight:500}.btn.ghost:hover{color:var(--text);background:var(--field)}.btn.danger:hover{color:var(--bad)}.btn.sm{font-size:10px;padding:4px 6px;min-height:26px}.dock{display:flex;position:relative;isolation:isolate;padding:4px;gap:4px;border-radius:15px;background:var(--glass);width:fit-content;max-width:100%}.dock button{display:flex;min-width:130px;align-items:center;justify-content:center;gap:7px;position:relative;z-index:1;border:0;border-radius:11px;background:transparent;color:var(--muted);padding:10px 18px;min-height:44px;font-size:13px;font-weight:600;white-space:nowrap}.dock button svg{width:18px;height:18px}.dock button[aria-selected=true]{color:var(--text)}.dock button:hover{color:var(--text)}\n/* The glass selection follows real clicks; no floating cursor or constant animation. */\n.liquid-thumb{display:block;position:absolute;left:0;top:0;z-index:0;pointer-events:none;border:0;background:none;transition:transform .27s cubic-bezier(.2,.85,.3,1)}.liquid-thumb>b{position:absolute;inset:0;display:block;border-radius:11px;border:1px solid color-mix(in srgb,var(--muted) 22%,transparent);background:linear-gradient(165deg,var(--liquid),color-mix(in srgb,var(--field) 65%,transparent));box-shadow:inset 0 1px 0 var(--liquid-rim),inset 0 -1px 0 color-mix(in srgb,var(--muted) 10%,transparent),0 2px 4px rgba(0,0,0,.04);backdrop-filter:blur(8px) saturate(130%);-webkit-backdrop-filter:blur(8px) saturate(130%)}.theme-switch .liquid-thumb>b{border-radius:50%;background:linear-gradient(145deg,var(--liquid),transparent);border-color:transparent;box-shadow:inset 0 1px 0 var(--liquid-rim)}\n.msg{color:var(--bad);font-size:12px;margin:10px 0}.msg:empty{display:none}.dashboard{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:0 0 20px}.metric{padding:17px 20px;min-height:128px;min-width:0}.metric small{display:block;font-size:12px;color:var(--muted);font-weight:600}.metric strong{display:block;font-size:31px;line-height:1.35;letter-spacing:-.035em;font-variant-numeric:tabular-nums;margin:10px 0}.metric>span{display:block;color:var(--muted);font-size:10px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metric:nth-child(2) strong{color:var(--traffic)}.metric:nth-child(4) strong{color:var(--text)}.metric .segment-meter{height:9px;margin:10px 0}.status-strip{display:flex;gap:3px;height:10px;margin:10px 0}.status-strip i{flex:1;min-width:0;border-radius:2px}\n.toolbar2{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 16px}.toolbar2 h2{margin:0;font-size:17px}.toolbar2 .screen-note{margin:0}.toolbar2 input,.toolbar2 select{padding:9px 12px;border:1px solid var(--line);border-radius:12px;background:var(--glass);max-width:100%}.subscription-toolbar{flex-wrap:nowrap;margin:0 0 18px}.filter{position:relative;display:flex;isolation:isolate;gap:4px;padding:5px;border:1px solid color-mix(in srgb,var(--muted) 22%,var(--line));border-radius:19px;background:var(--glass)}.filter .btn{position:relative;z-index:1;border:0;background:transparent;border-radius:13px;min-width:88px;min-height:33px;padding:5px 20px;color:var(--muted)}.filter .btn.on{color:var(--text)}.filter .liquid-thumb>b{border-radius:13px}.sort-name{display:flex;align-items:center;gap:8px;min-height:42px;border-radius:17px;background:var(--glass);color:var(--muted);padding:8px 13px}.sort-name svg{width:17px;height:17px}#sortName[data-direction=name-desc] svg{transform:scaleY(-1)}\n.subscription-regions{display:flex;align-items:center;flex-wrap:wrap;gap:22px;background:var(--glass);border:1px solid color-mix(in srgb,var(--muted) 22%,var(--line));border-radius:20px;padding:15px 23px;margin:0 0 20px;min-height:58px}.country-chip{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.country-chip small{background:var(--field);padding:1px 6px;border-radius:6px;font-size:11px}.country-chip b{font-weight:600}\n#items{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:auto;gap:16px;align-items:start;min-width:0}#items>.card{display:flex;flex-direction:column;min-width:0;grid-column:auto;grid-row:auto;height:auto;min-height:0;max-height:none;padding:20px 21px 12px;border-radius:20px;overflow:hidden;transition:border-color .18s}.card-scroll{display:block;min-width:0;height:auto;overflow:visible;margin:0;padding:0}.chead{cursor:grab;touch-action:none;user-select:none;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:27px}.title{display:flex;align-items:center;gap:9px;min-width:0;flex:1}.title h2{margin:0;font-size:17px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4}.card-flag{font-size:15px;flex:none}.pill{flex:none;font-size:10px;font-weight:600;white-space:nowrap;border-radius:7px;padding:3px 7px;color:var(--muted);background:var(--field);border:1px solid transparent}.chead .pill{max-width:36%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pill.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 11%,transparent);border-color:color-mix(in srgb,var(--ok) 18%,transparent)}.pill.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 11%,transparent)}.pill.bad{color:var(--bad);background:color-mix(in srgb,var(--bad) 10%,transparent)}.pill.info{color:var(--info);background:color-mix(in srgb,var(--info) 10%,transparent)}.card-tags{display:flex;gap:5px;align-items:center;min-width:0;height:25px;margin:7px 0 13px;overflow:hidden;white-space:nowrap}.chip{display:inline-block;white-space:nowrap;font-size:10px;font-weight:600;line-height:1.5;border:1px solid color-mix(in srgb,var(--muted) 12%,transparent);border-radius:7px;background:var(--field);padding:2px 7px;color:var(--chip-text)}.history-chip{color:var(--warn)}\n.stat-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 18px}.stat-tile{min-width:0}.stat-row{display:flex;justify-content:space-between;align-items:baseline;gap:6px;min-height:20px}.stat-row small{color:var(--muted);font-size:11px;white-space:nowrap}.stat-row b{font-size:14px;font-weight:650;white-space:nowrap;font-variant-numeric:tabular-nums}.stat-note{display:block;color:var(--faint);font-size:10px;line-height:16px;height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.segment-meter{display:flex;width:100%;height:8px;gap:3px;overflow:hidden;margin-top:6px}.segment-meter i{display:block;flex:1;min-width:0;border-radius:2px;background:var(--segment-empty)}.traffic-block{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:16px 0 0;padding:14px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.traffic-cell{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}.traffic-label{display:flex;align-items:center;gap:6px;white-space:nowrap;color:var(--muted)}.traffic-label i{font-style:normal;font-size:18px;font-weight:650;color:var(--blue)}.download .traffic-label i{color:var(--ok)}.traffic-label small{font-size:10px}.traffic-cell b{color:var(--traffic);font-size:18px;letter-spacing:-.025em;font-variant-numeric:tabular-nums;white-space:nowrap}.balance-block{padding:12px 0;margin:0;border-bottom:1px solid var(--line)}.balance-head{display:flex;justify-content:space-between;align-items:baseline;gap:7px;white-space:nowrap;min-width:0}.balance-head small{font-size:11px;color:var(--muted);font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0}.quota-total{font-size:10px;color:var(--faint);white-space:nowrap}.balance-block .segment-meter{height:9px;margin-top:7px}.balance-block .segment-meter i{background:var(--quota-empty)}\n.subscription-facts{display:grid;grid-template-columns:1.15fr .85fr;gap:14px;border-bottom:1px solid var(--line);padding:11px 0;height:65px}.fact{min-width:0}.fact small{display:block;color:var(--muted);font-size:10px;line-height:16px}.fact b{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;line-height:17px;font-size:11px;font-weight:600;overflow-wrap:anywhere;max-height:34px}.mini-nodes{display:grid;gap:11px;padding:13px 0;border-bottom:1px solid var(--line)}.mini-node{min-width:0;height:35px}.node-preview-top,.node-preview-rails{display:grid;grid-template-columns:1fr 1fr;gap:18px}.node-preview-cell{display:flex;align-items:center;justify-content:space-between;gap:5px;min-width:0;font-size:10px;line-height:18px}.node-preview-cell span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}.node-preview-cell small{white-space:nowrap;flex:none;font-size:10px;color:var(--warn)}.node-preview-cell small.reachable{color:var(--tcp)}.node-preview-cell small.unreachable{color:var(--bad)}.node-preview-cell small.off{color:var(--faint)}.node-preview-rails .segment-meter{margin-top:4px;height:7px;gap:2px}\n.status-ribbon{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:center;padding:11px 0 3px;min-height:34px;color:var(--muted);font-size:10px}.status-ribbon>span{display:flex;align-items:center;gap:5px;min-width:0}.status-ribbon svg{width:12px;height:12px;flex:none;color:var(--faint)}.status-ribbon small{font-size:10px;white-space:nowrap}.status-ribbon b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:10px;color:var(--muted);margin-left:auto}.status-ribbon .expiry-meta b{color:var(--muted)}.foot{display:flex;justify-content:space-between;align-items:center;gap:5px;border:0;min-height:30px;padding:6px 0 0;margin:0}.foot .r{display:flex;gap:1px;flex-wrap:nowrap;min-width:0}.widget-tools{position:static;display:flex;flex:none}.widget-drag{display:grid;place-items:center;position:static;inset:auto;width:30px;height:30px;min-width:30px;border:0;border-radius:7px;padding:0;color:var(--faint);background:transparent;cursor:grab;touch-action:none}.widget-drag svg{width:16px;height:16px;fill:currentColor}.widget-drag:hover{color:var(--text);background:var(--field)}.widget-drag:active,.chead:active{cursor:grabbing}.widget-placeholder{opacity:.28;outline:1px dashed var(--accent);outline-offset:-2px}.widget-placeholder>*{visibility:hidden}.widget-preview{display:flex;flex-direction:column;min-height:0;position:fixed!important;z-index:1000!important;pointer-events:none!important;opacity:.97!important;will-change:transform;transition:none!important;padding:20px 21px 12px;overflow:hidden;background:var(--glass)!important;box-shadow:0 15px 45px rgba(0,0,0,.2)!important}.widget-preview .widget-tools{visibility:hidden}.empty{grid-column:1/-1;padding:30px;text-align:center;color:var(--muted);background:var(--glass);border:1px solid var(--line);border-radius:20px}\n/* Same slots and dimensions for every card, selected globally. */\n:root[data-display=compact] .stat-note,:root[data-display=tiles] .stat-note{display:none}:root[data-display=compact] .subscription-facts{display:none}:root[data-display=compact] .card-tags{margin-bottom:11px}:root[data-display=compact] .stat-tiles{gap:12px 17px}:root[data-display=compact] .traffic-block{padding:11px 12px;margin:14px 0 0;border:1px solid var(--line);border-radius:13px;background:var(--glass-2)}:root[data-display=compact] .traffic-cell b{font-size:14px}:root[data-display=compact] .mini-nodes{gap:9px;padding:12px 0}:root[data-display=compact] .status-ribbon{padding-top:9px}\n:root[data-display=tiles] #items{grid-template-columns:repeat(4,minmax(0,1fr));gap:15px}:root[data-display=tiles] #items>.card{padding:17px 17px 10px}:root[data-display=tiles] .title h2{font-size:15px}:root[data-display=tiles] .stat-tiles{gap:12px 14px}:root[data-display=tiles] .stat-row small{font-size:10px}:root[data-display=tiles] .stat-row b{font-size:12px}:root[data-display=tiles] .traffic-block{display:block;padding:10px 0;margin-top:13px}:root[data-display=tiles] .traffic-cell{line-height:25px}:root[data-display=tiles] .traffic-cell b{font-size:15px}:root[data-display=tiles] .subscription-facts,:root[data-display=tiles] .mini-nodes{display:none}:root[data-display=tiles] .balance-head{display:block}:root[data-display=tiles] .quota-total{display:block;margin-top:3px}:root[data-display=tiles] .status-ribbon{gap:7px}:root[data-display=tiles] .status-ribbon small{display:none}:root[data-display=tiles] .status-ribbon b{margin-left:0}:root[data-display=tiles] .card-tags{margin-bottom:10px}:root[data-display=tiles] .foot .btn{padding-left:4px;padding-right:4px}\n:root[data-display=table] #items{display:block}.subscription-table-wrap{overflow:auto;max-width:100%;border-radius:20px}.subscription-table{width:100%;min-width:1170px;border-collapse:collapse;table-layout:fixed;font-variant-numeric:tabular-nums}.subscription-table th{font-size:11px;font-weight:600;text-align:left;color:var(--muted);background:var(--glass-2);padding:13px 12px;white-space:nowrap}.subscription-table th:first-child{width:210px}.subscription-table th:last-child{width:172px}.subscription-table th:nth-child(5){width:138px}.subscription-table td{padding:14px 12px;border-top:1px solid var(--line);vertical-align:middle;overflow:hidden}.subscription-table tr:hover td{background:color-mix(in srgb,var(--field) 28%,transparent)}.table-name-button{display:flex;align-items:center;gap:8px;max-width:100%;background:transparent;border:0;padding:0;color:var(--text);text-align:left;font-size:13px}.table-name-button b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.table-name-button span{flex:none}.table-name .card-tags{margin:7px 0 0;height:20px}.table-metric>b{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.table-metric>small{display:block;font-size:9px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}.table-metric .segment-meter{height:7px;gap:2px}.table-traffic span{display:block;font-size:11px;line-height:22px;white-space:nowrap}.table-traffic span:first-child{color:var(--blue)}.table-traffic span:last-child{color:var(--ok)}.table-dates b{display:block;font-size:11px;font-weight:500;color:var(--muted)}.table-dates small{display:block;font-size:10px;color:var(--faint);margin-top:5px}.table-actions .r{display:flex;flex-wrap:wrap;gap:2px}\n.panel{padding:20px;min-width:0}.node-insights{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);align-items:start;gap:16px;margin-bottom:20px}.node-insights h2{font-size:18px;margin:0}.node-insights canvas{display:block;width:100%;max-width:440px;height:auto;margin:auto;touch-action:none;cursor:grab}.node-insights canvas:active{cursor:grabbing}.node-insights canvas:focus-visible{outline:2px solid var(--accent);border-radius:20px}.globe-actions{display:flex;justify-content:center;gap:8px}.globe-icon{display:grid;place-items:center;width:34px;height:34px;padding:8px;border-radius:50%}.globe-icon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.region-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.region-chip{border:1px solid var(--line);border-radius:10px;background:var(--field);padding:7px 10px;font-size:11px}.protocol-row{display:grid;grid-template-columns:1fr auto;gap:6px;margin-top:18px}.protocol-row>.segment-meter{grid-column:1/-1}.protocol-row>span{color:var(--muted)}.screen-note{color:var(--muted);font-size:11px;line-height:1.7;margin:10px 0}.node-fold{padding:0}.node-fold>summary{padding:16px 20px;cursor:pointer;font-weight:600}.node-fold>.toolbar2{padding:0 20px}.node-fold>.panel{padding-top:0;border:0;background:transparent}.table-scroll{overflow:auto;max-height:420px}.node-table{width:100%;border-collapse:collapse}.node-table th,.node-table td{border-bottom:1px solid var(--line);padding:11px;text-align:left;font-size:12px}.node-table th{position:sticky;top:0;background:var(--glass);color:var(--muted);white-space:nowrap}.node-table td:first-child{min-width:150px;max-width:320px;overflow-wrap:anywhere}\n.control-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:160px 260px auto;gap:16px;align-items:stretch;min-width:0}.control-grid>.panel{display:flex;flex-direction:column;overflow-wrap:anywhere}.control-grid h3{font-size:15px;margin:0 0 12px}.control-grid p{color:var(--muted);font-size:12px;line-height:1.65;margin:0 0 12px}.control-grid .btn{align-self:flex-start;margin-top:auto}.switch-row{display:flex;align-items:center;gap:10px;padding:8px 0;font-size:12px}.switch-row input{width:17px;height:17px;accent-color:var(--accent)}.control-content{min-height:0;overflow:auto;scrollbar-width:thin;padding-right:3px}.activity-row{display:flex;flex-wrap:wrap;gap:7px 12px;border-bottom:1px solid var(--line);padding:10px 0;font-size:12px;overflow-wrap:anywhere}.activity-row small{color:var(--faint);margin-left:auto}.control-versions{grid-column:1/-1}.version-heading{display:flex;justify-content:space-between;gap:12px}.release-current{display:flex;gap:8px 16px;flex-wrap:wrap;font-size:12px}.release-current span{color:var(--muted)}.release-history{font-size:12px;margin-top:12px}.release-history summary{cursor:pointer;color:var(--muted)}.release-history ul{padding-left:20px;margin:10px 0 0;line-height:1.9}\n/* Dialogs stay in the top layer; content scrolls within the dialog. */\ndialog{padding:0;background:var(--glass);color:var(--text);border:1px solid var(--line);border-radius:20px;width:min(440px,calc(100vw - 28px));max-width:none;max-height:90dvh;overflow:auto}dialog::backdrop{background:rgba(12,18,29,.4);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}.dlg{padding:24px;border:0}.dlg h2{margin:0 0 6px;font-size:18px}.dlg p{margin:0 0 4px;color:var(--muted);font-size:12px;line-height:1.6}.dlg label{display:block;margin:14px 0 6px;color:var(--muted);font-size:12px}.dlg input[type=text],.dlg input[type=password],.dlg input[type=url]{width:100%;padding:11px 14px;border:1px solid var(--line);border-radius:12px;background:var(--field);outline:none}.dlg input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 15%,transparent)}.dlg .row{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.err{color:var(--bad);font-size:12px;margin-top:10px}.err:empty{display:none}.seg{display:inline-flex;flex-wrap:wrap;border:1px solid var(--line);border-radius:12px;background:var(--field);padding:3px}.seg button{background:transparent;border:0;border-radius:9px;padding:5px 10px;font-size:11px;color:var(--muted)}.seg button.on{background:var(--glass);color:var(--text)}#fileRow input{width:100%;font-size:11px}.kv{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:var(--field);margin-top:6px}.kv code{flex:1;min-width:0;font:11px ui-monospace,Consolas,monospace;overflow-wrap:anywhere}.steps{font-size:12px;color:var(--muted);line-height:1.8;padding-left:18px}.detail-dialog{width:min(720px,94vw);padding:22px;max-height:85dvh}.detail-dialog header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.detail-dialog header h2{margin:0;font-size:18px;overflow-wrap:anywhere}.detail-content{overflow-wrap:anywhere}.detail-content .stat-note{display:block!important}.detail-content .subscription-facts{display:grid!important;height:auto;min-height:65px}.detail-content .traffic-block{display:grid!important}.note,.alert{padding:10px 12px;border:1px solid var(--line);border-radius:12px;font-size:12px;color:var(--muted);background:var(--field);margin-top:12px}.alert{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 28%,var(--line));background:color-mix(in srgb,var(--bad) 8%,transparent)}.nodes{border-top:1px solid var(--line);padding-top:14px;margin-top:14px}.nh{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:8px}.nh b{font-size:13px}.ns{color:var(--muted);font-size:11px;margin-left:8px}.node{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line)}.node>div{min-width:0}.ndot{width:7px;height:7px;border-radius:50%;background:var(--faint)}.ndot.up{background:var(--ok)}.ndot.down{background:var(--bad)}.nname{font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.ntags{font-size:10px;color:var(--muted)}.lat{white-space:nowrap;font-size:11px;border-radius:7px;padding:3px 7px;background:var(--field)}.lat.fast{color:var(--ok)}.lat.mid{color:var(--warn)}.lat.slow{color:var(--bad)}.lat.off{color:var(--muted)}.more{margin-top:10px}.screen{width:min(1400px,96vw);padding:22px;max-height:92dvh}.screen:fullscreen{width:100vw;max-height:100vh;border-radius:0}.screen-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px}.screen-head h2{margin:0;font-size:20px}.screen-list{display:grid;gap:8px}.screen-row{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:10px;align-items:center;border-radius:12px;background:var(--field);padding:12px}.screen-row small{color:var(--muted)}.screen-row b{overflow-wrap:anywhere}.fine{max-width:1600px;margin:18px auto 0;color:var(--faint);font-size:10px;line-height:1.7}\n[data-motion=\"0\"],[data-motion=\"0\"] body,[data-motion=\"0\"] .liquid-thumb,[data-motion=\"0\"] .icon-button,[data-motion=\"0\"] #overviewToggle svg{transition:none!important}\n@media(max-width:1180px){#items,:root[data-display=tiles] #items{grid-template-columns:repeat(2,minmax(0,1fr))}.metric{padding:15px}.metric strong{font-size:27px}.node-insights{grid-template-columns:1fr 1fr}.traffic-cell b{font-size:16px}}\n@media(max-width:760px){body{padding:14px 12px 24px}.bar{gap:8px;align-items:flex-start}.bar h1{font-size:18px}.sum{font-size:9px;max-width:170px}.reference-tools,.theme-switch{gap:5px}.icon-button{width:32px;height:32px;min-width:32px;min-height:32px;padding:8px}.icon-button svg{width:16px;height:16px}.utility-row{gap:9px}.dock{width:100%}.dock button{flex:1;padding:7px 5px;gap:5px}.acts{justify-content:flex-end;width:100%}.acts .btn{font-size:11px;padding:6px 10px}.dashboard{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-bottom:16px}.metric{padding:12px 14px;min-height:117px;border-radius:17px}.metric strong{font-size:25px;margin:9px 0}.metric small{font-size:10px}.metric>span{font-size:9px}.filter .btn{min-width:66px;padding:5px 10px;font-size:11px}.filter{border-radius:16px}.sort-name{padding:8px 10px;font-size:11px;gap:5px;min-height:42px}.subscription-regions{gap:13px;padding:12px 15px;min-height:50px;border-radius:17px;margin-bottom:15px}#items,:root[data-display=tiles] #items{grid-template-columns:minmax(0,1fr);gap:13px}#items>.card{padding:18px 18px 10px}.title h2{font-size:16px}.traffic-cell b{font-size:17px}.node-insights{grid-template-columns:1fr}.control-grid{grid-template-columns:minmax(0,1fr);grid-template-rows:auto;gap:12px}.control-grid>.panel{padding:16px}.control-export{min-height:140px}.control-data,.control-issues{max-height:264px}.control-versions{grid-column:auto}.control-grid .btn{margin-top:10px}.screen-row{grid-template-columns:1fr 1fr}.screen,.detail-dialog{padding:16px}.detail-content .traffic-cell{display:block}.toolbar2 input{width:100%}.fine{font-size:9px}}\n@media(max-width:420px){.bar{flex-wrap:wrap}.reference-tools{margin-left:auto}.bar .sum{max-width:none}.stat-tiles{gap:13px}.traffic-cell b{font-size:15px}.traffic-label small{font-size:9px}.balance-head{gap:4px}.quota-total{font-size:9px}.status-ribbon{gap:8px}}\n@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}\n\n/* Preview stays on the compositor; real cards only commit their order on drop. */\n#items>.card.drag-shift{transition:transform .15s cubic-bezier(.2,.85,.3,1)}\n.widget-preview{contain:layout paint style;will-change:transform;backface-visibility:hidden}\n[data-motion=\"0\"] #items>.card.drag-shift{transition:none}\n.control-grid{grid-template-areas:\"export export\" \"data issues\" \"versions versions\";grid-template-rows:135px 260px auto}\n.control-export{grid-area:export;display:grid!important;grid-template-columns:minmax(0,1fr) auto;column-gap:18px;align-content:center}\n.control-export h3,.control-export p{grid-column:1;max-width:760px}.control-export p{margin-bottom:0}\n.control-export .btn{grid-column:2;grid-row:1/3;align-self:center;margin:0}\n.control-data{grid-area:data}.control-issues{grid-area:issues}.control-versions{grid-area:versions}\n@media(max-width:760px){.dock button{min-width:0;min-height:42px;padding:9px 8px;font-size:12px}.dock button svg{width:17px;height:17px}.control-grid{grid-template-areas:\"export\" \"data\" \"issues\" \"versions\";grid-template-rows:auto}.control-export{display:flex!important;min-height:140px}.control-export .btn{margin-top:12px;align-self:flex-start}}\n\n/* Reference hover tint; no geometry, blur or extra animation changes. */\n#items>.card:hover{background:var(--card-hover)}\n\n/* Local SVG flags stay visible on Windows; no additional card space. */\n.card-flag{display:inline-flex;align-items:center}.card-flag svg{width:20px;height:13px;flex:none}.region-flag{display:inline-flex;align-items:center;vertical-align:middle}.region-flag svg{width:20px;height:13px;flex:none}\n.quota-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.quota-fields>div{min-width:0}.dlg input[type=number],.dlg select{width:100%;padding:11px 14px;border:1px solid var(--line);border-radius:12px;background:var(--field)}.dlg .quota-lifetime{display:flex;align-items:center;gap:8px;margin-top:14px}.quota-lifetime input{accent-color:var(--accent)}\n\n/* Compact overview only: subscription dimensions and control screen stay intact. */\n#overview{max-width:1240px;gap:12px;margin-bottom:16px}\n#overview>.metric{padding:11px 16px;min-height:112px;border-radius:17px}\n#overview>.metric small{font-size:11px;line-height:1.3}\n#overview>.metric strong{font-size:26px;line-height:1.2;margin:6px 0}\n#overview>.metric .segment-meter,#overview>.metric .status-strip{height:8px;margin:6px 0}\n#overview>.metric>span{font-size:10px;line-height:1.3}\n.subscription-regions{gap:9px 16px;padding:12px 18px;min-height:50px;margin-bottom:16px}\n.country-chip{max-width:100%;gap:7px;min-width:0}\n.country-name{display:inline-flex;align-items:baseline;gap:5px;min-width:0;flex-wrap:wrap}\n.country-name b{font-weight:600;font-size:12px}\n.country-en{color:var(--faint);font-size:11px;overflow-wrap:anywhere}\n.country-chip>small{flex:none;font-variant-numeric:tabular-nums}\n.region-flag{flex:none}\n.region-chip{display:inline-flex;align-items:center;gap:7px;max-width:100%;min-width:0;text-align:left}\n.country-count{flex:none;color:var(--muted);font-variant-numeric:tabular-nums}\n.node-country{display:inline-flex;align-items:center;gap:7px;min-width:160px}\n.fact .region-flag{display:inline-block;vertical-align:-2px}\n.fact .region-flag svg{width:16px;height:11px}\n@media(max-width:760px){#overview{gap:9px}#overview>.metric{padding:10px 12px;min-height:104px}#overview>.metric strong{font-size:22px}#overview>.metric small{font-size:10px}#overview>.metric>span{font-size:9px}.subscription-regions{padding:11px 14px;gap:9px 13px}}\n\n/* Remove the filter row; tighten the page header without resizing cards. */\n.bar{align-items:center;gap:12px;margin-bottom:10px}\n.bar h1{font-size:20px;line-height:1.25}\n.reference-tools,.theme-switch{gap:7px}\n.icon-button{width:36px;height:36px;min-width:36px;min-height:36px;padding:8px}\n.utility-row{margin-bottom:12px}\n.acts .sort-name{min-height:32px;border-radius:12px;padding:6px 10px;font-size:12px}\n@media(max-width:760px){.bar h1{font-size:18px}.reference-tools,.theme-switch{gap:5px}.icon-button{width:32px;height:32px;min-width:32px;min-height:32px}.bar{margin-bottom:9px}.acts .sort-name{font-size:11px}}\n\n/* v12: safe-area header, bottom navigation and aligned country groups. */\nhtml{scroll-padding-top:100px;scroll-padding-bottom:110px}\nbody{padding:calc(14px + env(safe-area-inset-top,0px)) max(18px,env(safe-area-inset-right,0px)) calc(112px + env(safe-area-inset-bottom,0px)) max(18px,env(safe-area-inset-left,0px))}\n.app-header.bar{position:sticky;top:env(safe-area-inset-top,0px);z-index:60;display:flex;flex-wrap:nowrap;align-items:center;justify-content:space-between;gap:12px;min-height:64px;margin:0 0 16px;padding:8px 0 12px;background:var(--bg0);isolation:isolate}\n.app-brand{display:flex;align-items:center;gap:11px;min-width:0}\n.brand-mark{display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:13px;background:linear-gradient(140deg,#43c8af,#397dea);color:#fff}\n.brand-mark svg{width:24px;height:24px}\n.app-brand>div{min-width:0}.app-header h1{font-size:20px;line-height:1.3;white-space:nowrap}\n.view-heading{margin:3px 0 0;font-size:11px;line-height:1.4;font-weight:500;color:var(--muted)}\n.header-actions{display:flex;gap:8px;align-items:center;flex:none}\n.header-actions>.icon-button{width:44px;height:44px;min-width:44px;min-height:44px;padding:11px;background:var(--glass);border-radius:14px}\n.header-actions>.icon-button[aria-expanded=true]{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 35%,var(--line));background:var(--field)}\n.app-header .appearance-panel{position:absolute;right:0;top:calc(100% - 4px);z-index:1;display:flex;flex-direction:column;align-items:stretch;gap:10px;width:min(294px,calc(100vw - 32px));padding:15px;border:1px solid var(--line);border-radius:20px;background:var(--glass);box-shadow:0 14px 36px rgba(0,0,0,.12);backdrop-filter:blur(20px) saturate(130%);-webkit-backdrop-filter:blur(20px) saturate(130%)}\n.appearance-panel h2{font-size:13px;margin:0 0 2px;color:var(--text)}\n.appearance-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}\n.appearance-row>span{font-size:12px;color:var(--muted);white-space:nowrap}\n.appearance-row .icon-button{width:44px;height:44px;min-width:44px;min-height:44px;padding:11px}\n.appearance-row .theme-switch{gap:5px}.appearance-row:not(:last-child){padding-bottom:10px;border-bottom:1px solid var(--line)}\n#overview{margin-top:0;margin-bottom:14px}\n.subscriptions-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:18px 0 12px;min-width:0}\n.subscriptions-toolbar h2{font-size:15px;margin:0;white-space:nowrap}\n.subscriptions-toolbar .acts{width:auto;justify-content:flex-end;flex-wrap:nowrap;gap:7px}\n.subscriptions-toolbar .btn{min-height:40px;padding:8px 12px}\n.subscriptions-toolbar #sortName{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:44px}\n.subscriptions-toolbar #sortName svg{width:18px;height:18px}\n.subscriptions-toolbar #logout{display:grid;place-items:center;width:40px;min-width:40px;padding:9px}\n.subscriptions-toolbar #logout svg{width:18px;height:18px}\n.bottom-dock.dock{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:40;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));width:438px;max-width:calc(100vw - 28px);gap:4px;padding:5px;border-radius:24px;background:color-mix(in srgb,var(--glass) 88%,transparent);border:1px solid color-mix(in srgb,var(--muted) 23%,var(--line));box-shadow:0 8px 30px rgba(0,0,0,.09),inset 0 1px 0 var(--liquid-rim);backdrop-filter:blur(20px) saturate(135%);-webkit-backdrop-filter:blur(20px) saturate(135%)}\n.bottom-dock.dock button{min-width:0;min-height:52px;padding:10px 12px;border-radius:18px;gap:7px;font-size:12px}\n.bottom-dock.dock button svg{width:20px;height:20px;flex:none}\n.bottom-dock .liquid-thumb>b{border-radius:18px;border-color:color-mix(in srgb,var(--muted) 19%,transparent);background:linear-gradient(150deg,var(--liquid),color-mix(in srgb,var(--glass) 65%,transparent));backdrop-filter:blur(8px) saturate(130%);-webkit-backdrop-filter:blur(8px) saturate(130%)}\n.bottom-dock button[aria-selected=true]{color:var(--text)}\n.subscription-regions,.region-list{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));align-items:stretch;gap:8px 18px;min-width:0}\n.subscription-regions{padding:12px 16px;border-radius:18px}\n.country-chip,.region-chip{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:8px;min-width:0;max-width:100%;min-height:46px;padding:3px 0;font-size:12px;white-space:nowrap}\n.country-chip>.country-name,.region-chip>.country-name{display:flex;flex-direction:column;align-items:flex-start;gap:1px;min-width:0;flex-wrap:nowrap}\n.country-chip .country-name b,.region-chip .country-name b{display:block;width:100%;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.45}\n.country-chip .country-en,.region-chip .country-en{display:block;width:100%;font-size:10px;line-height:1.35;white-space:nowrap;overflow:hidden;overflow-wrap:normal;text-overflow:ellipsis}\n.country-chip>small,.region-chip>.country-count{display:block;min-width:24px;padding:2px 5px;border-radius:7px;text-align:center;background:var(--field);font-size:11px;font-variant-numeric:tabular-nums}\n.region-chip{padding:8px;border-radius:13px;grid-template-columns:20px minmax(0,1fr) auto;transition:background .18s,border-color .18s}\n.region-chip:hover{background:var(--glass-2)}\n.country-unknown,.region-list .country-unknown{grid-column:1/-1;padding-top:8px;margin-top:2px;border-top:1px solid var(--line)}\n.region-list{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}\n.region-list .country-unknown{padding:8px;border-left:0;border-right:0;border-bottom:0;background:transparent;border-radius:0}\n.country-group{display:inline-flex;align-items:baseline;gap:4px;white-space:nowrap;max-width:100%;vertical-align:baseline;overflow:hidden;text-overflow:ellipsis}\n.country-group .region-flag{align-self:center}\n.detail-content .subscription-facts{grid-template-columns:1fr 1fr;align-items:start}\n.detail-content .fact b{display:block;max-height:none;-webkit-line-clamp:unset}\n.detail-content .country-group{display:flex;min-height:20px}\n@media(max-width:1000px){.subscription-regions{grid-template-columns:repeat(3,minmax(0,1fr))}}\n@media(max-width:760px){\n body{padding:calc(8px + env(safe-area-inset-top,0px)) max(12px,env(safe-area-inset-right,0px)) calc(108px + env(safe-area-inset-bottom,0px)) max(12px,env(safe-area-inset-left,0px))}\n .app-header.bar{gap:8px;min-height:62px;margin-bottom:12px;padding:7px 0 11px;flex-wrap:nowrap}\n .app-brand{gap:8px}.brand-mark{width:34px;height:34px;border-radius:11px}.brand-mark svg{width:21px;height:21px}\n .app-header h1{font-size:17px;line-height:1.3}.view-heading{font-size:10px;margin-top:3px}\n .header-actions{gap:6px}.header-actions>.icon-button{width:42px;height:42px;min-width:42px;min-height:42px;padding:10px;border-radius:13px}\n .header-actions>.icon-button svg{width:20px;height:20px}\n .app-header .appearance-panel{width:min(294px,calc(100vw - 24px));padding:14px;max-height:calc(100dvh - 180px);overflow:auto;overscroll-behavior:contain}\n #overview{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-bottom:12px;max-width:none}\n #overview>.metric{padding:11px 12px;min-height:104px;min-width:0}\n #overview>.metric strong{font-size:24px;margin:7px 0;line-height:1.2}\n #overview>.metric small{font-size:10px}#overview>.metric>span{font-size:9px}\n .subscription-regions{grid-template-columns:repeat(2,minmax(0,1fr));padding:10px 12px;gap:6px 12px;margin-bottom:14px}\n .country-chip{grid-template-columns:18px minmax(0,1fr) auto;gap:6px;min-height:36px}\n .country-chip .region-flag svg{width:18px;height:12px}.country-chip>small{min-width:22px;padding:2px 4px;font-size:10px}\n .country-chip .country-name b{font-size:11px}.country-chip .country-en{font-size:9px}\n .subscriptions-toolbar{display:grid;grid-template-columns:1fr;gap:9px;margin:15px 0 11px}\n .subscriptions-toolbar h2{font-size:14px}.subscriptions-toolbar .acts{width:100%;display:flex;flex-wrap:nowrap;justify-content:stretch;gap:7px}\n .subscriptions-toolbar #refresh,.subscriptions-toolbar #add{flex:1;min-width:0;font-size:12px;min-height:42px;padding:8px 7px;white-space:nowrap}\n .subscriptions-toolbar #sortName,.subscriptions-toolbar #logout{width:42px;height:42px;min-width:42px;min-height:42px;padding:10px}\n .subscriptions-toolbar #sortName span{display:none}\n .bottom-dock.dock{width:360px;max-width:calc(100vw - 24px);bottom:calc(10px + env(safe-area-inset-bottom,0px));gap:3px;padding:5px;border-radius:24px}\n .bottom-dock.dock button{min-height:54px;flex-direction:column;gap:3px;padding:7px 6px;font-size:10px;line-height:1.25;border-radius:18px}\n .bottom-dock.dock button svg{width:21px;height:21px}\n .detail-content .subscription-facts{grid-template-columns:1fr;gap:10px}\n .detail-dialog{max-height:calc(100dvh - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px) - 30px)}\n dialog input[type=text],dialog input[type=password],dialog input[type=url],dialog input[type=number],dialog select{font-size:16px}\n :root[data-keyboard=true] .bottom-dock{visibility:hidden;pointer-events:none}\n}\n@media(max-width:359px){.app-header h1{font-size:15px}.brand-mark{display:none}.subscription-regions{grid-template-columns:1fr}.country-chip .country-en{font-size:10px}.region-list{grid-template-columns:1fr}#overview>.metric strong{font-size:22px}}\n@media(orientation:landscape) and (max-height:500px){.app-header.bar{position:relative;top:auto}.bottom-dock.dock button{flex-direction:row;min-height:40px}.bottom-dock.dock{bottom:calc(7px + env(safe-area-inset-bottom,0px))}.app-header .appearance-panel{max-height:calc(100dvh - 110px)}}\n@supports not (backdrop-filter:blur(8px)){.bottom-dock.dock,.app-header .appearance-panel{background:var(--glass)}}\n\n.node-country .country-name{display:flex;flex-direction:column;align-items:flex-start;gap:1px;flex-wrap:nowrap;white-space:nowrap}.node-country .country-en{white-space:nowrap;overflow-wrap:normal}\n\n/* v13: only the requested header, country spacing and action-row changes. */\n.app-header.bar{min-height:54px;padding:4px 0 8px;margin-bottom:10px}\n.app-brand h1{line-height:1.3}\n.header-actions.reference-controls{gap:8px;align-items:center}\n.reference-controls .theme-switch{gap:8px}\n.reference-controls .icon-button{width:40px;height:40px;min-width:40px;min-height:40px;padding:9px;border-radius:50%;background:transparent}\n.reference-controls .icon-button svg{width:21px;height:21px}\n.reference-controls .icon-button:hover{background:var(--glass-2)}\n.reference-controls .display-button{margin-left:2px;background:var(--glass)}\n.subscription-regions{padding:6px 12px;gap:2px 14px;margin-bottom:8px;min-height:0;border-radius:16px}\n.country-chip{min-height:29px;padding:0;gap:6px}\n.country-chip>.country-name{gap:0}\n.country-chip .country-name b{font-size:11px;line-height:1.25}\n.country-chip .country-en{font-size:9px;line-height:1.25}\n.country-chip>small{min-width:20px;font-size:10px;padding:1px 4px}\n.subscription-regions .country-unknown{padding-top:3px;margin-top:2px;min-height:28px}\n.subscriptions-toolbar{display:flex;justify-content:flex-end;gap:0;margin:10px 0}\n.subscriptions-toolbar .acts{display:flex;align-items:center;width:auto;flex-wrap:nowrap;gap:7px}\n.subscriptions-toolbar #screenOpen{display:grid;place-items:center;width:40px;height:40px;min-width:40px;min-height:40px;padding:9px;border:1px solid var(--line);border-radius:12px;background:var(--glass)}\n.subscriptions-toolbar #screenOpen svg{width:20px;height:20px}\n.subscriptions-toolbar #refresh,.subscriptions-toolbar #add{min-height:40px}\n@media(max-width:760px){\n .app-header.bar{display:flex;flex-wrap:nowrap;gap:8px;padding:3px 0 6px;margin-bottom:8px}\n .app-brand{gap:8px}.app-header h1{font-size:16px}.brand-mark{display:grid;width:32px;height:32px}\n .header-actions.reference-controls{justify-content:flex-end;gap:6px}\n .reference-controls .theme-switch{gap:6px}\n .reference-controls .icon-button{width:40px;height:40px;min-width:40px;min-height:40px;padding:9px;border-radius:50%}\n .subscription-regions{padding:5px 10px;gap:2px 12px;margin-bottom:8px}\n .country-chip{min-height:28px;padding:0;gap:5px}\n .country-chip .country-name b{font-size:10px;line-height:1.25}\n .country-chip .country-en{font-size:9px;line-height:1.25}\n .country-chip>small{min-width:20px;font-size:10px;padding:1px 4px}\n .subscriptions-toolbar{display:block;margin:9px 0 10px}\n .subscriptions-toolbar .acts{display:grid;grid-template-columns:40px minmax(0,1fr) minmax(0,1.1fr) 40px;width:100%;gap:6px}\n .subscriptions-toolbar #refresh,.subscriptions-toolbar #add{min-height:40px;padding:7px 6px;font-size:11px}\n .subscriptions-toolbar #screenOpen,.subscriptions-toolbar #sortName{width:40px;height:40px;min-width:40px;min-height:40px;padding:9px}\n .subscriptions-toolbar #sortName span{display:none}\n}\n@media(max-width:359px){.app-header.bar{display:grid;grid-template-columns:minmax(0,1fr);gap:5px}.header-actions.reference-controls{justify-self:end}.subscription-regions{grid-template-columns:repeat(2,minmax(0,1fr))}.app-header h1{font-size:16px}.country-chip .country-en{font-size:8px}}\n\n/* v14: same-row theme folding and actions immediately under the title. */\n.app-header.bar{flex-wrap:wrap}\n.app-brand{flex:none}\n.header-actions.reference-controls{margin-left:auto;gap:6px}\n.inline-header-tools{display:flex;align-items:center;gap:8px;flex:none;width:max-content;max-width:240px;min-width:0;overflow:hidden;opacity:1;visibility:visible;transition:max-width .2s ease,opacity .16s ease}\n.inline-header-tools>.theme-switch{flex:none}.inline-header-tools>.display-button{flex:none}\n.reference-controls[data-collapsed=true] .inline-header-tools{max-width:0;opacity:0;visibility:hidden;pointer-events:none}\n.reference-controls[data-collapsed=true]{gap:0}\n#headerToolsToggle{background:var(--glass);flex:none}\n#headerToolsToggle svg{transition:transform .2s ease}\n#headerToolsToggle[aria-expanded=false] svg{transform:rotate(180deg)}\n.subscriptions-toolbar{justify-content:flex-start;margin:0 0 12px}\n@media(max-width:760px){\n .app-header.bar{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:9px}\n .inline-header-tools{gap:6px}\n .subscriptions-toolbar{margin:0 0 11px}\n}\n@media(prefers-reduced-motion:reduce){.inline-header-tools,#headerToolsToggle svg{transition:none}}\n.reference-controls #headerToolsToggle[aria-expanded]{color:var(--muted);border-color:var(--line);background:var(--glass)}\n\n/* v15: responsive spacing of the existing overview and country area only. */\n#overview{gap:9px;margin-bottom:8px}\n#overview>.metric{padding:8px 12px;min-height:clamp(68px,9svh,88px);border-radius:15px}\n#overview>.metric small{font-size:10px;line-height:1.25}\n#overview>.metric strong{font-size:clamp(21px,2.9svh,25px);line-height:1.15;margin:4px 0}\n#overview>.metric .segment-meter,#overview>.metric .status-strip{height:6px;margin:4px 0}\n#overview>.metric>span{font-size:9px;line-height:1.25}\n.subscription-regions{grid-template-columns:repeat(6,minmax(0,1fr));padding:4px 10px;gap:2px 12px;margin-bottom:8px;border-radius:14px}\n.subscription-regions .country-chip{min-height:23px;padding:0;gap:5px}\n.subscription-regions .country-name{gap:0}\n.subscription-regions .country-name b{font-size:10px;line-height:1.15}\n.subscription-regions .country-en{font-size:9px;line-height:1.15}\n.subscription-regions .country-unknown{min-height:23px;padding-top:2px;margin-top:1px}\n@media(max-width:1000px){.subscription-regions{grid-template-columns:repeat(4,minmax(0,1fr))}}\n@media(max-width:760px){\n #overview{gap:6px;margin-bottom:7px}\n #overview>.metric{padding:6px 10px;min-height:clamp(64px,9svh,78px);border-radius:14px}\n #overview>.metric small{font-size:9px;line-height:1.2}\n #overview>.metric strong{font-size:clamp(19px,2.8svh,23px);line-height:1.1;margin:3px 0}\n #overview>.metric .segment-meter,#overview>.metric .status-strip{height:5px;margin:3px 0}\n #overview>.metric>span{font-size:8px;line-height:1.2}\n .subscription-regions{grid-template-columns:repeat(3,minmax(0,1fr));padding:4px 8px;gap:2px 8px;margin-bottom:7px}\n .subscription-regions .country-chip{grid-template-columns:14px minmax(0,1fr) auto;min-height:22px;gap:4px;padding:0}\n .subscription-regions .country-chip .region-flag svg{width:14px;height:10px}\n .subscription-regions .country-name b{font-size:9px;line-height:1.15}\n .subscription-regions .country-en{font-size:8px;line-height:1.15}\n .subscription-regions .country-chip>small{font-size:9px;min-width:16px;padding:0 3px;border-radius:5px}\n .subscription-regions .country-unknown{min-height:22px;padding-top:2px;margin-top:1px}\n}\n@media(max-height:650px) and (max-width:760px){\n #overview>.metric{padding:5px 9px;min-height:62px}\n #overview>.metric strong{font-size:19px;margin:2px 0}\n #overview>.metric .segment-meter,#overview>.metric .status-strip{margin:2px 0}\n .subscription-regions{padding-top:3px;padding-bottom:3px}\n}\n\n/* v16: single header row, slimmer actions and balanced summary spacing. */\n.app-header.bar{display:flex;flex-wrap:nowrap;align-items:center;gap:8px;min-height:50px}\n.app-brand{min-width:0;flex:1}\n.header-actions.reference-controls{flex:none}\n.subscriptions-toolbar .btn{min-height:34px;padding:6px 10px}\n.subscriptions-toolbar #screenOpen,.subscriptions-toolbar #sortName{width:34px;height:34px;min-width:34px;min-height:34px;padding:7px}\n.subscriptions-toolbar #screenOpen svg,.subscriptions-toolbar #sortName svg{width:18px;height:18px}\n#overview>.metric{min-height:92px;padding:9px 13px}\n#overview>.metric strong{margin:5px 0}\n#overview>.metric .segment-meter,#overview>.metric .status-strip{margin:5px 0}\n.subscription-regions{padding:6px 10px;gap:3px 12px}\n.subscription-regions .country-chip{min-height:28px}\n.subscription-regions .country-unknown{min-height:27px;padding-top:3px;margin-top:2px}\n@media(max-width:760px){\n .app-header.bar{display:flex;flex-wrap:nowrap;gap:4px;min-height:42px;padding:3px 0 6px;margin-bottom:8px}\n .app-brand{gap:6px;min-width:0;flex:1}\n .brand-mark{display:grid;width:clamp(26px,7.7vw,30px);height:clamp(26px,7.7vw,30px);border-radius:10px}\n .brand-mark svg{width:19px;height:19px}\n .app-header h1{font-size:clamp(14px,4.1vw,16px);white-space:nowrap}\n .header-actions.reference-controls,.inline-header-tools,.reference-controls .theme-switch{gap:4px}\n .reference-controls[data-collapsed=true]{gap:0}\n .reference-controls .display-button{margin-left:0}\n .reference-controls .icon-button{width:clamp(28px,9vw,40px);height:clamp(28px,9vw,40px);min-width:clamp(28px,9vw,40px);min-height:clamp(28px,9vw,40px);padding:6px}\n .reference-controls .icon-button svg{width:clamp(17px,5.1vw,20px);height:clamp(17px,5.1vw,20px)}\n .subscriptions-toolbar{margin-bottom:9px}\n .subscriptions-toolbar .acts{grid-template-columns:34px minmax(0,1fr) minmax(0,1.1fr) 34px;gap:6px}\n .subscriptions-toolbar #refresh,.subscriptions-toolbar #add{min-height:34px;padding:6px;font-size:11px}\n .subscriptions-toolbar #screenOpen,.subscriptions-toolbar #sortName{width:34px;height:34px;min-width:34px;min-height:34px;padding:7px}\n #overview{gap:7px;margin-bottom:8px}\n #overview>.metric{min-height:clamp(78px,10.2svh,90px);padding:8px 11px;border-radius:15px}\n #overview>.metric small{font-size:10px;line-height:1.25}\n #overview>.metric strong{font-size:clamp(21px,2.85svh,24px);line-height:1.15;margin:4px 0}\n #overview>.metric .segment-meter,#overview>.metric .status-strip{height:6px;margin:4px 0}\n #overview>.metric>span{font-size:9px;line-height:1.25}\n .subscription-regions{padding:6px 9px;gap:3px 8px;margin-bottom:8px}\n .subscription-regions .country-chip{min-height:28px;gap:4px}\n .subscription-regions .country-name b{font-size:10px;line-height:1.2}\n .subscription-regions .country-en{font-size:9px;line-height:1.2}\n .subscription-regions .country-unknown{min-height:27px;padding-top:3px;margin-top:2px}\n}\n.subscriptions-toolbar #refresh,.subscriptions-toolbar #add{min-height:34px;padding-top:6px;padding-bottom:6px}\n\n/* v17: desktop-only layout; mobile v16 remains untouched. */\n@media(min-width:761px){\n body{padding:24px clamp(20px,3vw,56px) 96px}\n .shell,.fine{max-width:1760px}\n .app-header.bar{min-height:56px;margin-bottom:14px}\n .app-header h1{font-size:23px;line-height:1.3}\n .app-brand{gap:12px}\n .subscriptions-toolbar{margin-bottom:18px}\n .subscriptions-toolbar .acts{gap:9px}\n .subscriptions-toolbar #refresh,.subscriptions-toolbar #add{font-size:13px;padding:8px 16px;min-height:38px;white-space:nowrap}\n .subscriptions-toolbar #screenOpen{width:38px;height:38px;min-width:38px;min-height:38px;padding:9px}\n .subscriptions-toolbar #sortName{width:auto;height:38px;min-width:86px;min-height:38px;padding:8px 12px;gap:7px;flex:none;white-space:nowrap}\n .subscriptions-toolbar #sortName span{display:inline;white-space:nowrap}\n #overview{max-width:none;width:100%;gap:16px;margin-bottom:14px}\n #overview>.metric{min-height:120px;padding:15px 18px;border-radius:18px;display:flex;flex-direction:column}\n #overview>.metric small{font-size:12px;line-height:1.4}\n #overview>.metric strong{font-size:30px;line-height:1.2;margin:7px 0}\n #overview>.metric .segment-meter,#overview>.metric .status-strip{height:8px;min-height:8px;margin:6px 0}\n #overview>.metric>span{font-size:11px;line-height:1.45;white-space:normal;overflow:visible;text-overflow:clip;margin-top:auto}\n .subscription-regions{grid-template-columns:repeat(4,minmax(0,1fr));gap:5px 22px;padding:10px 16px;margin-bottom:18px;border-radius:17px}\n .subscription-regions .country-chip{min-height:34px;gap:8px;grid-template-columns:20px minmax(0,1fr) auto}\n .subscription-regions .country-name b{font-size:12px;line-height:1.3}\n .subscription-regions .country-en{font-size:10px;line-height:1.3}\n .subscription-regions .country-chip>small{font-size:11px;min-width:24px;padding:2px 6px}\n .subscription-regions .country-unknown{min-height:31px;padding-top:5px;margin-top:3px}\n #items{gap:18px;align-items:stretch}\n #items>.card{height:100%;padding:22px 22px 14px;border-radius:20px}\n #items>.card .foot{margin-top:auto;padding-top:10px}\n #items .title h2{font-size:19px}\n #items .card-tags{margin:8px 0 14px}\n #items .chip{font-size:11px}\n :root[data-display=detail] #items .stat-row small{font-size:12px}\n :root[data-display=detail] #items .stat-row b{font-size:15px}\n :root[data-display=detail] #items .stat-note{font-size:11px;height:auto;min-height:17px;line-height:1.5}\n :root[data-display=detail] #items .stat-tiles{gap:15px 20px}\n :root[data-display=detail] #items .subscription-facts{height:auto;min-height:76px;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);gap:12px;padding:13px 0}\n :root[data-display=detail] #items .fact small{font-size:11px;margin-bottom:3px}\n :root[data-display=detail] #items .fact b{display:block;-webkit-line-clamp:unset;max-height:none;font-size:12px;line-height:1.6;overflow:visible}\n :root[data-display=detail] #items .traffic-label small{font-size:11px}\n :root[data-display=detail] #items .mini-nodes{gap:10px;padding:14px 0}\n :root[data-display=detail] #items .node-preview-cell,:root[data-display=detail] #items .node-preview-cell small{font-size:11px}\n :root[data-display=detail] #items .status-ribbon{gap:14px;padding:13px 0 5px;min-height:38px}\n :root[data-display=detail] #items .status-ribbon small,:root[data-display=detail] #items .status-ribbon b{font-size:11px}\n :root[data-display=compact] #items>.card{padding:20px 20px 13px}\n :root[data-display=tiles] #items>.card{padding:18px 18px 12px}\n .subscription-table th{font-size:12px;padding:15px 14px}\n .subscription-table td{padding:16px 14px}\n .table-metric>b{font-size:14px}\n .table-metric>small{font-size:11px}\n .table-name-button{font-size:14px}\n .table-dates b{font-size:12px}\n}\n@media(min-width:761px) and (max-width:1050px){\n #overview{gap:10px}\n #overview>.metric{padding:12px;min-height:124px}\n #overview>.metric strong{font-size:26px}\n #overview>.metric small{font-size:11px}\n .subscription-regions{gap:5px 14px}\n}\n@media(min-width:1280px){\n #items{grid-template-columns:repeat(3,minmax(0,1fr))}\n .subscription-regions{grid-template-columns:repeat(4,minmax(0,1fr))}\n}\n@media(min-width:1700px){\n #items,:root[data-display=tiles] #items{grid-template-columns:repeat(4,minmax(0,1fr))}\n .subscription-regions{grid-template-columns:repeat(8,minmax(0,1fr))}\n}\n\n</style>\n</head>\n<body>\n<div class=\"wall\"><div class=\"orb o1\"></div><div class=\"orb o2\"></div><div class=\"orb o3\"></div><div class=\"orb o4\"></div></div>\n\n<div class=\"shell\">\n  <header class=\"bar app-header\"><div class=\"app-brand\"><span class=\"brand-mark\" aria-hidden=\"true\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"3\"/><path d=\"M7 15v-3m5 3V9m5 6V7\"/></svg></span><div><h1>订阅监控面板</h1><div class=\"sum sr-only\" id=\"sum\">读取中…</div></div></div><div class=\"header-actions reference-controls\"><div id=\"headerTools\" class=\"inline-header-tools\"><div class=\"theme-switch\" id=\"themeSwitch\" role=\"group\" aria-label=\"明暗主题\"><i class=\"liquid-thumb\" id=\"themeThumb\" aria-hidden=\"true\"><b></b></i><button type=\"button\" class=\"icon-button\" id=\"themeLight\" data-theme-choice=\"light\" aria-label=\"白天模式\" title=\"白天模式\" aria-pressed=\"false\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5\"/></svg></button><button type=\"button\" class=\"icon-button\" id=\"themeSystem\" data-theme-choice=\"auto\" aria-label=\"跟随系统\" title=\"跟随系统\" aria-pressed=\"false\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"13\" rx=\"2\"/><path d=\"M8 21h8m-4-4v4\"/></svg></button><button type=\"button\" class=\"icon-button\" id=\"theme\" data-theme-choice=\"dark\" aria-label=\"黑夜模式\" title=\"黑夜模式\" aria-pressed=\"false\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><path d=\"M20.5 13.3A8.7 8.7 0 0 1 10.7 3.5 8.7 8.7 0 1 0 20.5 13.3Z\"/></svg></button></div><button type=\"button\" class=\"icon-button display-button\" id=\"displayMode\" title=\"切换显示方式\" aria-label=\"切换显示方式\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><rect x=\"4\" y=\"3\" width=\"16\" height=\"18\" rx=\"2\"/><path d=\"M4 9h16M4 15h16\"/></svg></button><span class=\"sr-only\" id=\"displayStatus\" role=\"status\" aria-live=\"polite\"></span></div><button type=\"button\" class=\"icon-button\" id=\"headerToolsToggle\" aria-controls=\"headerTools\" aria-expanded=\"true\" aria-label=\"收起主题与布局按钮\" title=\"收起主题与布局按钮\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><path d=\"m9 5 7 7-7 7\"/></svg></button></div></header><div class=\"subscriptions-toolbar\"><div class=\"acts\"><button type=\"button\" class=\"icon-button\" id=\"screenOpen\" aria-label=\"打开中控大屏\" title=\"中控大屏\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><rect x=\"3\" y=\"3\" width=\"18\" height=\"14\" rx=\"2\"/><path d=\"M8 21h8m-4-4v4M7 12l3-3 3 2 4-4\"/></svg></button><button class=\"btn\" id=\"refresh\">立即检测</button><button class=\"btn primary\" id=\"add\">＋ 添加订阅</button><button type=\"button\" class=\"btn sort-name\" id=\"sortName\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><path d=\"M5 20V4m-3 3 3-3 3 3M11 7h10m-10 5h7m-7 5h4\"/></svg><span>名称</span></button></div></div>\n  <p class=\"msg\" id=\"msg\"></p>\n  \n<section id=\"view-subs\"><section class=\"dashboard\" id=\"overview\" aria-label=\"监控总览\"></section><div id=\"subscriptionRegions\" class=\"subscription-regions\" aria-label=\"节点名称标注地区\"></div><main id=\"items\"></main></section>\n<section id=\"view-nodes\" hidden><div class=\"node-insights\"><section class=\"panel glass\"><div class=\"toolbar2\"><h2>节点地区分布</h2><span class=\"chip\">名称推断</span></div><canvas id=\"regionGlobe\" width=\"520\" height=\"390\" tabindex=\"0\" role=\"img\" aria-label=\"节点地区地球仅绕中心纵轴缓慢旋转；拖动或方向键可水平旋转。地区与数量见下方国旗列表\"></canvas><div class=\"globe-actions\"><button class=\"btn globe-icon\" id=\"globeLeft\" aria-label=\"向左旋转\" title=\"向左旋转\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"m14.5 5-7 7 7 7\"/></svg></button><button class=\"btn globe-icon\" id=\"globeReset\" aria-label=\"重置地球视角\" title=\"重置视角\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M20 11a8 8 0 0 0-14-4L4 9M4 4v5h5M4 13a8 8 0 0 0 14 4l2-2m0 5v-5h-5\"/></svg></button><button class=\"btn globe-icon\" id=\"globeRight\" aria-label=\"向右旋转\" title=\"向右旋转\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"m9.5 5 7 7-7 7\"/></svg></button></div><div id=\"regionList\" class=\"region-list\"></div><p class=\"screen-note\" id=\"regionNote\"></p></section><section class=\"panel glass\"><h2>协议组成</h2><p class=\"screen-note\">已过滤公告项 · 每条订阅内的节点分别计数</p><div id=\"protocolList\"></div></section></div><details class=\"node-fold panel glass\"><summary>节点明细 <span class=\"screen-note\">点击展开 / 收起</span></summary><div class=\"toolbar2\"><h2>节点状态</h2><input id=\"nodeSearch\" aria-label=\"搜索节点\" placeholder=\"搜索节点、订阅或协议\"></div><div class=\"panel glass\"><div class=\"table-scroll\"><table class=\"node-table\"><thead><tr><th>节点</th><th>所属订阅</th><th>协议</th><th>地区（推断）</th><th>TCP 状态</th></tr></thead><tbody id=\"nodeRows\"></tbody></table></div><p class=\"screen-note\">节点探测由 Worker 发起，TCP 可达不代表代理协议或实际网页访问正常。UDP 协议、平台限制与未探测节点分别标记。</p></div></details></section>\n<dialog id=\"detailDlg\" class=\"detail-dialog\"><header><h2 id=\"detailTitle\">订阅详情</h2><button class=\"btn\" id=\"detailClose\">关闭</button></header><div id=\"detailContent\" class=\"detail-content\"></div></dialog><section id=\"view-control\" hidden><div class=\"toolbar2\"><h2>控制中心</h2><span class=\"screen-note\" id=\"updateInfo\">等待同步</span></div><div class=\"control-grid\">\n\n<section class=\"panel glass control-export\"><h3>状态快照</h3><p>导出当前状态用于排查，不含订阅链接及节点凭证，不用于恢复订阅。</p><button class=\"btn\" id=\"exportStatus\">导出 JSON 快照</button></section>\n<section class=\"panel glass control-data\"><h3>采集记录</h3><div class=\"control-content\" id=\"collectionInfo\"></div></section>\n<section class=\"panel glass control-issues\"><h3>异常摘要</h3><div class=\"control-content\" id=\"issueInfo\"></div></section>\n<section class=\"panel glass control-versions\"><div class=\"version-heading\"><h3>版本记录</h3><span class=\"chip\">当前版本 v01</span></div><p class=\"screen-note\">程序变更记录，不代表 Cloudflare 部署历史。</p><div class=\"release-current\"><b>v01 · 首次开源发布</b><span>整合订阅监控、QX 兼容流量解析与响应式界面；首次开源版本。</span></div><details class=\"release-history\"><summary>查看 Demo 开发历史</summary><ul><li><b>Demo v18</b> 开源前演示基线：QX 兼容流量解析，保留已确认界面。</li><li><b>Demo v17</b> 桌面布局优化，移动端不变。</li><li><b>Demo v16</b> 顶栏同行与移动端比例调整。</li><li><b>Demo v15</b> 概览和地区栏自适应首屏间距。</li><li><b>Demo v14</b> 顶部按钮同行折叠，操作行移到标题下方。</li><li><b>Demo v13</b> 参考主题顶栏、压缩地区间距并删除副标题与退出按钮。</li><li><b>Demo v12</b> 手机安全区排版、底部液态导航和地区对齐。</li><li><b>Demo v11</b> 保留界面、减少重复抓取并兼容旧推送与流量快照。</li><li><b>Demo v10</b> 独立检测、资源预算与原始错误诊断。</li><li><b>Demo v09</b> 精简筛选行和页头；独立请求超时与历史节点复测。</li><li><b>Demo v08</b> 紧凑顶部概览，统一图形国旗与中英文地区名。</li><li><b>Demo v07</b> 扩展流量识别、手动快照与节点 TCP 探测；统一面板名称。</li><li><b>Demo v06</b> 校准参考配色，保持卡片布局和交互。</li><li><b>Demo v05</b> 嵌入液态交互、扩大导航按钮、缓存拖动位置并平滑让位。</li><li><b>Demo v04</b> 四种统一布局、主题图标与细字状态栏。</li><li><b>Demo v03</b> 分段监控面板与地区概览。</li><li><b>Demo v02</b> 去除本周用量，整理今日用量。</li><li><b>Demo v01</b> 加入今日用量与日界线统计。</li><li><b>Demo 旧版构建 22</b> 统一状态卡片与节点数量显示。</li><li><b>Demo 构建 21</b> 小、中、大组件布局与拖动实时让位。</li><li><b>Demo 构建 20</b> 图标操作、固定纵轴地球与柔和的流量环。</li><li><b>Demo 构建 19</b> 修复卡片拖动预览、紧凑模式信息缺失与控制图标遮挡。</li><li><b>Demo 构建 18</b> 加入可拖动订阅卡片与尺寸调整。</li><li><b>Demo 构建 15</b> 整理控制中心布局；移除在线代码更新及重复入口。</li><li><b>Demo 构建 14</b> 文件导入与重新导入、点阵地图球、液态导航。</li></ul></details></section>\n</div></section>\n<dialog id=\"screenDlg\" class=\"screen\"><div class=\"screen-head\"><h2>监控中控屏</h2><div><button class=\"btn\" id=\"screenFull\">全屏</button><button class=\"btn\" id=\"screenClose\">关闭</button></div></div><div class=\"dashboard\" id=\"screenMetrics\"></div><p class=\"screen-note\" id=\"screenTime\"></p><div id=\"screenList\" class=\"screen-list\"></div></dialog>\n</div>\n<nav class=\"dock glass bottom-dock\" role=\"tablist\" aria-label=\"监控视图\"><i class=\"liquid-thumb\" id=\"dockThumb\" aria-hidden=\"true\"><b></b></i><button role=\"tab\" tabindex=\"0\" aria-selected=\"true\" aria-controls=\"view-subs\" data-view=\"subs\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><rect x=\"4\" y=\"3\" width=\"16\" height=\"18\" rx=\"3\"/><path d=\"M8 8h8m-8 4h8m-8 4h4\"/></svg><span>订阅状态</span></button><button role=\"tab\" tabindex=\"0\" aria-selected=\"false\" aria-controls=\"view-nodes\" data-view=\"nodes\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><circle cx=\"12\" cy=\"5\" r=\"2\"/><rect x=\"3\" y=\"16\" width=\"6\" height=\"5\" rx=\"1\"/><rect x=\"15\" y=\"16\" width=\"6\" height=\"5\" rx=\"1\"/><path d=\"M12 7v5M6 16v-4h12v4\"/></svg><span>节点状态</span></button><button role=\"tab\" tabindex=\"0\" aria-selected=\"false\" aria-controls=\"view-control\" data-view=\"control\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><path d=\"M4 7h16M4 17h16\"/><circle cx=\"9\" cy=\"7\" r=\"3\"/><circle cx=\"15\" cy=\"17\" r=\"3\"/></svg><span>控制中心</span></button></nav>\n<p class=\"fine\">节点只展示协议、状态与延迟，不含服务器地址和密码 · 延迟为 Cloudflare 机房到节点的 TCP 握手耗时，仅供判断连通性</p>\n\n<dialog id=\"login\"><form method=\"dialog\" class=\"dlg glass\" id=\"loginForm\">\n  <h2>访问面板</h2><p>输入 Worker 中配置的 ADMIN_TOKEN。</p>\n  <label for=\"token\">访问口令</label><input id=\"token\" type=\"password\" autocomplete=\"off\" required>\n  <div class=\"err\" id=\"loginErr\"></div>\n  <div class=\"row\"><button class=\"btn primary\">进入</button></div>\n</form></dialog>\n\n<dialog id=\"addDlg\"><form method=\"dialog\" class=\"dlg glass\" id=\"addForm\">\n  <h2>添加订阅</h2>\n  <label for=\"name\">名称</label><input id=\"name\" type=\"text\" maxlength=\"80\" required autocomplete=\"off\">\n  <label>获取方式</label>\n  <div class=\"seg\" id=\"modeSeg\"><button type=\"button\" data-mode=\"pull\" class=\"on\">直连检测</button><button type=\"button\" data-mode=\"push\">推送模式</button><button type=\"button\" data-mode=\"file\">文件导入</button></div>\n  <p id=\"modeHint\" style=\"margin-top:8px\">由 Worker 定时访问订阅链接，适合大多数订阅。</p>\n  <div id=\"urlRow\"><label for=\"url\">订阅链接</label><input id=\"url\" type=\"url\" maxlength=\"2048\" placeholder=\"https://…\"></div>\n  <div id=\"fileRow\" hidden><label for=\"importFile\">配置文件</label><input id=\"importFile\" type=\"file\" accept=\".yaml,.yml,.json,.txt,.conf\"><p id=\"fileSummary\">请选择本地文件</p><p class=\"screen-note\">支持 UTF-8 YAML / JSON / 节点文本，最大 1 MB。文件订阅是静态快照；更新请重新上传，不会自动获取流量变化。</p></div><div class=\"err\" id=\"addErr\"></div>\n  <div class=\"row\"><button type=\"button\" class=\"btn\" id=\"addCancel\">取消</button><button class=\"btn primary\" id=\"saveSubscription\">保存</button></div>\n</form></dialog>\n\n<dialog id=\"quotaDlg\"><form method=\"dialog\" class=\"dlg\" id=\"quotaForm\"><h2 id=\"quotaTitle\">校准流量</h2><p>填写服务商面板的总量和剩余流量，保存为手动快照。连接检测不会自动扣减额度；后续需更新数值。</p><div class=\"quota-fields\"><div><label for=\"quotaTotal\">套餐总量</label><input id=\"quotaTotal\" type=\"number\" min=\"0\" step=\"any\" required></div><div><label for=\"quotaRemaining\">剩余流量</label><input id=\"quotaRemaining\" type=\"number\" min=\"0\" step=\"any\" required></div></div><label for=\"quotaUnit\">单位</label><select id=\"quotaUnit\"><option value=\"GB\">GB</option><option value=\"TB\">TB</option></select><label class=\"quota-lifetime\" for=\"quotaNoExpiry\"><input id=\"quotaNoExpiry\" type=\"checkbox\">长期有效 / 不设到期日</label><div class=\"err\" id=\"quotaErr\"></div><div class=\"row\"><button type=\"button\" class=\"btn\" id=\"quotaCancel\">取消</button><button class=\"btn primary\" id=\"quotaSave\">保存快照</button></div></form></dialog>\n<dialog id=\"pushDlg\"><div class=\"dlg glass\">\n  <h2>推送模式设置</h2>\n  <p>订阅被 Cloudflare 验证页等拦截时，改由你自己电脑上的脚本去拉取，再推送到这里。订阅链接只保存在你的电脑上。</p>\n  <label>面板地址</label><div class=\"kv\"><code id=\"pOrigin\"></code><button class=\"btn sm\" data-copy=\"pOrigin\">复制</button></div>\n  <label>订阅 ID</label><div class=\"kv\"><code id=\"pId\"></code><button class=\"btn sm\" data-copy=\"pId\">复制</button></div>\n  <label>填进脚本 $Items 的一行</label><div class=\"kv\"><code id=\"pLine\"></code><button class=\"btn sm\" data-copy=\"pLine\">复制</button></div>\n  <ol class=\"steps\"><li>用 <b>sub-push.ps1</b> 脚本，按注释填入面板地址、ADMIN_TOKEN 和上面这一行（把链接换成你的订阅地址）。</li><li>右键脚本 → 使用 PowerShell 运行，先手动推送一次。</li><li>没问题后按 README 里的命令建一个每 30 分钟的计划任务。</li></ol>\n  <div class=\"row\"><button class=\"btn primary\" id=\"pushClose\">知道了</button></div>\n</div></dialog>\n\n<script>\n\n\n\"use strict\";\nvar $ = function (id) { return document.getElementById(id); };\nvar token = localStorage.getItem(\"sm_token\") || \"\";\nvar ui = {};            // 每个订阅的界面状态（展开/排序），刷新时保留\nvar layoutKey = \"monitor-card-layout-v1\";\nvar layoutState = (function () { try { return JSON.parse(localStorage.getItem(layoutKey)) || { order: [], sizes: {} }; } catch (_) { return { order: [], sizes: {} }; } })();\nlayoutState.order = Array.isArray(layoutState.order) ? layoutState.order : [];\nlayoutState.sizes = layoutState.sizes && typeof layoutState.sizes === \"object\" ? layoutState.sizes : {};\nvar lastSavedLayout=localStorage.getItem(layoutKey);\nfunction saveLayout(){try{var value=JSON.stringify(layoutState);if(value!==lastSavedLayout){localStorage.setItem(layoutKey,value);lastSavedLayout=value;}}catch(_){}}\nvar firstRender = true;\n\n/* ---------- 工具 ---------- */\nfunction el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; }\nfunction parts(b) {\n  if (b === null || b === undefined || !isFinite(b)) return null;\n  var u = [\"B\", \"KB\", \"MB\", \"GB\", \"TB\"], i = 0, v = b;\n  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }\n  return { n: v >= 100 ? v.toFixed(1) : v.toFixed(2), u: u[i] };\n}\nfunction fmt(b) { var p = parts(b); return p ? p.n + \" \" + p.u : null; }\nfunction dt(ms, short) {\n  if (!ms) return null;\n  var o = short ? { month: \"numeric\", day: \"numeric\", hour: \"2-digit\", minute: \"2-digit\", hour12: false } : { hour12: false };\n  return new Date(ms).toLocaleString(\"zh-CN\", o);\n}\nfunction ago(ms) {\n  var s = Math.max(0, (Date.now() - ms) / 1000);\n  if (s < 90) return \"刚刚\";\n  if (s < 5400) return Math.round(s / 60) + \" 分钟前\";\n  if (s < 129600) return Math.round(s / 3600) + \" 小时前\";\n  return Math.round(s / 86400) + \" 天前\";\n}\nvar STATE = {\n  pending: { t: \"待检测\", c: \"\" }, active: { t: \"可用\", c: \"ok\" }, warning: { t: \"即将用尽或到期\", c: \"warn\" },\n  expired: { t: \"已到期\", c: \"bad\" }, exhausted: { t: \"流量用尽\", c: \"bad\" }, unreachable: { t: \"抓取失败\", c: \"bad\" },\n  no_quota_header:{t:\"可访问\",c:\"info\"},manual_quota:{t:\"手动额度\",c:\"info\"}\n};\n\n/* ---------- 组件 ---------- */\nfunction ring(percent, c) {\n  var NS = \"http://www.w3.org/2000/svg\", R = 42, C = 2 * Math.PI * R;\n  var box = el(\"div\", \"ringbox\");\n  box.style.setProperty(\"--rc\", \"var(--\" + (c || \"accent\") + \")\");\n  var svg = document.createElementNS(NS, \"svg\"); svg.setAttribute(\"viewBox\", \"0 0 100 100\");\n  function circ(cls) {\n    var e = document.createElementNS(NS, \"circle\");\n    e.setAttribute(\"cx\", \"50\"); e.setAttribute(\"cy\", \"50\"); e.setAttribute(\"r\", String(R));\n    e.setAttribute(\"fill\", \"none\"); e.setAttribute(\"stroke-width\", \"9\"); e.setAttribute(\"class\", cls); return e;\n  }\n  var arc = circ(\"arc\"); arc.setAttribute(\"stroke-linecap\", \"round\");\n  arc.setAttribute(\"stroke-dasharray\", String(C));\n  var pct = Math.min(100, Math.max(0, percent));\n  var target = C * (1 - pct / 100);\n  arc.setAttribute(\"stroke-dashoffset\", firstRender ? String(C) : String(target));\n  svg.append(circ(\"trk\"), arc); box.append(svg);\n  if (firstRender) requestAnimationFrame(function () { requestAnimationFrame(function () { arc.setAttribute(\"stroke-dashoffset\", String(target)); }); });\n  var t = el(\"div\", \"ringtxt\"); t.append(el(\"b\", \"\", percent.toFixed(percent >= 10 ? 0 : 1) + \"%\"), el(\"span\", \"\", \"已使用\"));\n  box.append(t);\n  return box;\n}\n\nfunction probeText(n){var state=n&&n.probeState;return {timeout:'CF 超时',refused:'连接拒绝',failed:'连接失败',restricted:'平台受限',dns:'DNS 失败',unsupported:'UDP 协议',invalid:'地址缺失',budget:'未探测',resource_limit:'平台限额',metadata:'说明条目'}[state]||(!n||n.testable===false?'未探测':n.online===false?'CF 未达':'待检测');}\nfunction latPill(n){var valid=n.testable!==false&&n.online===true&&Number.isFinite(n.latencyMs),text=valid?n.latencyMs+' ms':probeText(n),cls=valid?(n.latencyMs<200?'fast':n.latencyMs<800?'mid':'slow'):n.online===false?'slow':'off';var pill=el('span','lat '+cls,text);pill.title=n.probeReason||(valid?'Cloudflare 机房到节点的 TCP 连接耗时，不是本地代理延迟':'暂无有效 TCP 探测结果');return pill;}\n\nfunction nodesBlock(s, st) {\n  var wrap = el(\"div\", \"nodes\");\n  var tested = s.nodes.filter(function (n) { return n.testable; });\n  var up = tested.filter(function (n) { return n.online === true; });\n  var lats = up.map(function (n) { return n.latencyMs; }).filter(isFinite).sort(function (a, b) { return a - b; });\n  var head = el(\"div\", \"nh\"), left = el(\"div\");\n  left.append(el(\"b\", \"\", \"节点\"));\n  var summary = tested.length\n    ? \"在线 \" + up.length + \"/\" + tested.length + (lats.length ? \" · 中位 \" + lats[Math.floor(lats.length / 2)] + \" ms\" : \"\")\n    : \"共 \" + s.nodes.length + \" 个\";\n  left.append(el(\"span\", \"ns\", summary + (s.nodesMore ? \" · 另有 \" + s.nodesMore + \" 个未展示\" : \"\")));\n  head.append(left);\n  var seg = el(\"div\", \"seg\"), b1 = el(\"button\", \"\", \"默认\"), b2 = el(\"button\", \"\", \"按延迟\");\n  seg.append(b1, b2); head.append(seg); wrap.append(head);\n  var list = el(\"div\"); wrap.append(list);\n  var more = el(\"button\", \"btn ghost sm more\"); wrap.append(more);\n\n  function draw() {\n    b1.className = st.byLatency ? \"\" : \"on\"; b2.className = st.byLatency ? \"on\" : \"\";\n    var arr = s.nodes.slice();\n    if (st.byLatency) arr.sort(function (a, b) {\n      var la = a.online === true && isFinite(a.latencyMs) ? a.latencyMs : 1e9, lb = b.online === true && isFinite(b.latencyMs) ? b.latencyMs : 1e9;\n      return la - lb;\n    });\n    var limit = st.expanded ? arr.length : 6;\n    list.replaceChildren.apply(list, arr.slice(0, limit).map(function (n) {\n      var r = el(\"div\", \"node\"), mid = el(\"div\");\n      mid.append(el(\"div\", \"nname\", n.name), el(\"div\", \"ntags\", [n.protocol, n.transport, n.security].filter(Boolean).join(\" · \")));\n      r.append(el(\"span\", \"ndot \" + (n.testable ? (n.online ? \"up\" : \"down\") : \"\")), mid, latPill(n));\n      return r;\n    }));\n    more.style.display = arr.length > 6 ? \"\" : \"none\";\n    more.textContent = st.expanded ? \"收起\" : \"展开全部 \" + arr.length + \" 个\";\n  }\n  b1.onclick = function () { st.byLatency = false; draw(); };\n  b2.onclick = function () { st.byLatency = true; draw(); };\n  more.onclick = function () { st.expanded = !st.expanded; draw(); };\n  draw();\n  return wrap;\n}\n\nfunction quotaColor(p){if(!Number.isFinite(p))return \"var(--segment-empty)\";return p>=60?\"var(--quota-alert)\":p>=35?\"var(--quota-amber)\":\"var(--quota-green)\";}\n// CSS colors resolve on theme changes without rebuilding any cards.\nfunction quotaSegmentColor(p){if(!Number.isFinite(p)||p>=60)return quotaColor(p);var colors=['var(--quota-green)','var(--quota-lime)','var(--quota-yellowgreen)','var(--quota-yellow)','var(--quota-amber)'];return function(index){return colors[Math.min(4,Math.floor(index/4))];};}\nfunction toolIcon(name){var paths={move:'<circle cx=\"9\" cy=\"5\" r=\"1.5\"/><circle cx=\"15\" cy=\"5\" r=\"1.5\"/><circle cx=\"9\" cy=\"12\" r=\"1.5\"/><circle cx=\"15\" cy=\"12\" r=\"1.5\"/><circle cx=\"9\" cy=\"19\" r=\"1.5\"/><circle cx=\"15\" cy=\"19\" r=\"1.5\"/>',resize:'<path d=\"M4 20 20 4M12 4h8v8M4 12v8h8\"/>'};return '<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\">'+paths[name]+'</svg>';}\nfunction sizeLabel(size){return {compact:\"小组件\",standard:\"中组件\",large:\"大组件\"}[size]||\"中组件\";}\nfunction usageWidget(s){\n var wrap=el('section','usage-widget'),top=el('div','usage-top'),label=el('small','','今日用量'),value=el('strong','usage-value'),track=el('div','usage-track'),bar=el('i'),caption=el('div','usage-caption'),note=el('div','usage-note');\n var data=s.usageToday,has=data&&Number.isFinite(data.bytes),pct=has&&s.total>0?Math.max(0,Math.min(100,data.bytes/s.total*100)):null;\n value.textContent=has?fmt(data.bytes):'—';bar.style.width=(pct===null?0:pct)+'%';track.classList.toggle('unavailable',pct===null);track.setAttribute('role',pct===null?'img':'progressbar');track.setAttribute('aria-label',pct===null?'暂无可计算的今日用量':'今日用量占套餐总量');\n if(pct!==null){track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(Math.round(pct*100)/100));}\n caption.textContent=has?(pct===null?'套餐总量未提供':'占套餐总量 '+(pct<.01&&pct>0?'<0.01':pct.toFixed(2))+'%'):'暂无用量记录';\n note.textContent=has?(data.partial?'自 '+dt(data.since,true)+' 起记录':'北京时间零点起 · 快照估算')+(data.reset?' · 流量重置':''):s.total==null&&s.used==null?'上游未提供流量数据':'等待今日的流量快照';\n track.append(bar);top.append(label,value);wrap.append(top,track,caption,note);return wrap;\n}\nfunction segmentMeter(percent,color,label){\n var rail=el('div','segment-meter'),valid=Number.isFinite(percent),pct=valid?Math.max(0,Math.min(100,percent)):0;\n rail.setAttribute('role',valid?'progressbar':'img');rail.setAttribute('aria-label',label+(valid?'':'：暂无数据'));\n if(valid){rail.setAttribute('aria-valuemin','0');rail.setAttribute('aria-valuemax','100');rail.setAttribute('aria-valuenow',String(Math.round(pct*100)/100));}\n for(var i=0;i<20;i++){var block=el('i');if(valid&&i<pct/5){block.style.background=typeof color==='function'?color(i,pct):color;block.style.opacity=String(Math.min(1,pct/5-i));}rail.append(block);}return rail;\n}\nfunction statTile(label,value,percent,color,note){var tile=el('div','stat-tile'),row=el('div','stat-row');row.append(el('small','',label),el('b','',value||'—'));var caption=el('span','stat-note',note||'暂无数据');caption.title=caption.textContent;tile.append(row,caption,segmentMeter(percent,color,label+'占套餐总量'));return tile;}\nfunction expiryText(s){if(s.noExpiry===true)return '长期有效';if(!Number.isFinite(s.expire)||s.expire<=0)return '未提供';var days=Math.ceil((s.expire-Date.now())/86400000);return days<=0?'已到期':days+' 天';}\nfunction checkText(s){var at=s.source==='file'?s.pushedAt||s.resourceUpdatedAt:s.lastCheck;return at?ago(at):s.source==='file'?'等待导入':'未检测';}\nfunction nodeSummary(s){var nodes=cleanNodes(s),tested=nodes.filter(n=>n.testable!==false&&typeof n.online==='boolean'),up=tested.filter(n=>n.online).length,protocols={},regions={};nodes.forEach(function(n){var p=n.protocol||'未知';protocols[p]=(protocols[p]||0)+1;var r=nodeRegion(n);if(r)regions[r[0]]=r[1];});return {nodes:nodes,tested:tested.length,up:up,protocols:protocols,regions:regions};}\nfunction subscriptionTiles(s){\n var info=nodeSummary(s),total=Number.isFinite(s.total)&&s.total>0?s.total:null,today=s.usageToday&&Number.isFinite(s.usageToday.bytes)?s.usageToday:null,tiles=el('div','stat-tiles');\n var pct=total&&Number.isFinite(s.used)?s.used/total*100:null,reach=info.tested?info.up/info.tested*100:null;\n tiles.append(statTile('已用流量',Number.isFinite(pct)?pct.toFixed(1)+'%':null,pct,'var(--blue)',total?(fmt(s.used)||'—')+' / '+fmt(total):'上游未提供额度'),statTile('今日用量',today?fmt(today.bytes):null,today&&total?today.bytes/total*100:null,'var(--purple)',today?(today.partial?'自 '+dt(today.since,true)+' 起记录':'北京时间零点起 · 估算'):(s.quotaSource==='manual'?'手动快照不计算今日用量':'等待今日流量快照')),statTile('节点数量',String(info.nodes.length),info.nodes.length?info.nodes.length/(info.nodes.length+(s.nodesMore||0))*100:null,'var(--orange)',s.nodesMore?'另有 '+s.nodesMore+' 个未展示':s.resourceFormat||'等待识别资源'),statTile('TCP 可达',info.tested?Math.round(reach)+'%':null,reach,'var(--pink)',info.tested?info.up+' / '+info.tested+' · '+((info.nodes.filter(n=>n.probeState==='unsupported').length)||0)+' UDP · '+(info.nodes.filter(n=>n.online==null&&n.probeState!=='unsupported').length)+' 待测':'展示节点尚未探测'));\n return tiles;\n}\nfunction quotaBlock(s){var box=el('div','balance-block'),head=el('div','balance-head'),total=Number.isFinite(s.total)&&s.total>0?s.total:null,remaining=Number.isFinite(s.remaining)?s.remaining:null,percent=total&&remaining!==null?remaining/total*100:null,usedPct=Number.isFinite(s.percent)?s.percent:total&&Number.isFinite(s.used)?s.used/total*100:null;head.append(el('small','','剩余 '+(fmt(remaining)||'未提供')),el('span','quota-total',total?(fmt(s.used)||'—')+' / '+fmt(total):'额度未提供'));head.title='剩余流量 / 已用流量 / 套餐总量'+(s.quotaSource==='manual'?' · 手动快照 '+dt(s.quotaUpdatedAt):'');box.append(head,segmentMeter(percent,quotaSegmentColor(usedPct),'剩余流量占套餐总量'));return box;}\nfunction trafficBlock(s){var wrap=el('div','traffic-block');[['↑','累计上传',s.upload,'upload'],['↓','累计下载',s.download,'download']].forEach(function(r){var cell=el('div','traffic-cell '+r[3]),label=el('span','traffic-label');label.append(el('i','',r[0]),el('small','',r[1]));cell.append(label,el('b','',fmt(r[2])||'—'));wrap.append(cell);});return wrap;}\nfunction subscriptionFacts(s){var info=nodeSummary(s),wrap=el('div','subscription-facts'),types=el('div','fact'),regions=el('div','fact');types.append(el('small','','节点协议'),el('b','',Object.entries(info.protocols).map(x=>x[0]+' × '+x[1]).join(' · ')||'暂无节点'));var names=Object.keys(info.regions),value=el('b');names.forEach(function(k,i){if(i)value.append(document.createTextNode(' · '));var group=el('span','country-group');group.append(flagIcon(k),document.createTextNode(regionName(k)));value.append(group);});if(!names.length)value.textContent='名称未识别';regions.append(el('small','','地区标注'),value);regions.title=(names.map(regionName).join(' · ')||'名称未识别')+'；按节点名称推断，非服务器 IP 定位';wrap.append(types,regions);return wrap;}\nfunction nodePreview(s){var nodes=cleanNodes(s),wrap=el('div','mini-nodes');for(var i=0;i<3;i++){var n=nodes[i],row=el('div','mini-node'),top=el('div','node-preview-top'),left=el('div','node-preview-cell'),right=el('div','node-preview-cell'),known=n&&n.testable!==false&&typeof n.online==='boolean',lat=known&&n.online&&Number.isFinite(n.latencyMs)?n.latencyMs:null,color=lat===null?'var(--faint)':lat<200?'var(--success-bar)':lat<800?'var(--warn-bar)':'var(--bad-bar)',message=n?probeText(n):'—';left.append(el('span','',n?n.name||'未命名节点':i===0?'暂无节点数据':'—'),el('small',lat!==null?(lat<200?'reachable':lat<800?'':'unreachable'):known&&!n.online?'unreachable':'off',lat!==null?lat+' ms':message));right.append(el('span','','CF→节点'),el('small',known?(n.online?'reachable':'unreachable'):'off',known?(n.online?'CF 可达':'CF 未达'):n?message:'—'));top.append(left,right);row.title=n?(n.probeReason||'CF 到节点 TCP 检测，不代表本地代理延迟'):'';row.append(top);var rails=el('div','node-preview-rails');rails.append(segmentMeter(lat!==null?lat/1000*100:null,color,'CF TCP 耗时，刻度 0 至 1000 ms'),segmentMeter(known?(n.online?100:0):null,known&&!n.online?'var(--bad-bar)':'var(--success-bar)','CF TCP 可达状态'));row.append(rails);wrap.append(row);}return wrap;}\n\nfunction statusRibbon(s){var ribbon=el('div','status-ribbon'),expiry=el('span','expiry-meta'),check=el('span','check-meta');expiry.innerHTML=uiIcon('calendar');expiry.append(el('small','','到期'),el('b','',expiryText(s)));if(s.expire)expiry.title=dt(s.expire);check.innerHTML=uiIcon(s.source==='file'?'file':'refresh');check.append(el('small','',s.source==='file'?'导入':'检测'),el('b','',checkText(s)));check.title=(dt(s.lastCheck)||'未检测')+(s.httpStatus?' · HTTP '+s.httpStatus:'')+(s.latencyMs!=null?' · '+s.latencyMs+' ms':'');ribbon.append(check,expiry);ribbon.title=[s.error,s.resourceUpdatedAt&&s.resourceUpdatedAt!==s.lastCheck?'节点数据时间：'+dt(s.resourceUpdatedAt):'',s.quotaUpdatedAt&&s.quotaUpdatedAt!==s.lastCheck?'流量为历史数据：'+dt(s.quotaUpdatedAt):''].filter(Boolean).join('；');return ribbon;}\nfunction openSubscriptionDetail(s){s=Object.assign({},s,{nodes:cleanNodes(s)});var st=ui[s.id]||(ui[s.id]={expanded:false,byLatency:false});$('detailTitle').textContent=s.name;$('detailContent').replaceChildren(subscriptionTiles(s),trafficBlock(s),quotaBlock(s),subscriptionFacts(s),statusRibbon(s));if(s.attempts&&s.attempts.length)$('detailContent').append(el('p','note','客户端结果：'+s.attempts.map(a=>a.ua+' → '+(a.status??a.error??'失败')).join('；')));if(s.errorSnippet)$('detailContent').append(el('p','note','服务器返回：'+s.errorSnippet));if(s.error)$('detailContent').append(el('div','alert',s.error));$('detailContent').append(el('p','note','测量路径：Cloudflare → 节点 TCP 握手；不包含代理认证及本地网络。订阅抓取失败与节点连接失败分别统计。'));if(s.nodeProbeUpdatedAt)$('detailContent').append(el('p','note','节点 TCP 探测时间：'+dt(s.nodeProbeUpdatedAt)));if(s.resourceUpdatedAt)$('detailContent').append(el('p','note','节点数据时间：'+dt(s.resourceUpdatedAt)));if(s.quotaUpdatedAt)$('detailContent').append(el('p','note','流量数据时间：'+dt(s.quotaUpdatedAt)));var quotaAction=el('button','btn','校准流量');quotaAction.type='button';quotaAction.onclick=function(){openQuota(s);};$('detailContent').append(quotaAction);var source={headers:'订阅响应头','body-header':'文件 / 正文元信息','body-metadata':'配置元信息',remarks:'订阅备注',manual:'手动快照'}[s.quotaSource]||'未识别';$('detailContent').append(el('p','note','流量来源：'+source+(s.quotaSource==='manual'?'；不会随连接检测自动扣减。':'')+(s.quotaNote?'；'+s.quotaNote:'')));if(s.quotaAttempts&&s.quotaAttempts.length)$('detailContent').append(el('p','note','补充流量请求：'+s.quotaAttempts.map(a=>a.ua+' → '+(a.status??a.error??'失败')).join('；')));if(s.nodes.length)$('detailContent').append(nodesBlock(s,st));else $('detailContent').append(el('p','note','暂无节点数据'));$('detailDlg').showModal();}\nfunction subscriptionActions(s){var actions=el('div','r'),detail=el('button','btn ghost sm','详情 / 节点');detail.type='button';detail.onclick=function(){openSubscriptionDetail(s);};actions.append(detail);if(s.source==='file'){var imp=el('button','btn ghost sm','重新导入');imp.type='button';imp.onclick=function(){openFileImport(s);};actions.append(imp);}else if(s.mode==='push'){var settings=el('button','btn ghost sm','推送设置');settings.type='button';settings.onclick=function(){openPush(s.id);};actions.append(settings);}var del=el('button','btn ghost danger sm','删除');del.type='button';del.onclick=function(){if(!confirm('删除「'+s.name+'」？'))return;request('/api/subs?id='+encodeURIComponent(s.id),{method:'DELETE'}).then(load).catch(function(e){$('msg').textContent=e.message;});};actions.append(del);return actions;}\nfunction flagIcon(code,cls){var icon=el('span',cls||'region-flag');if(REGION_SVGS[code])icon.innerHTML=REGION_SVGS[code==='TW'?'CN':code];else icon.textContent='🌐';icon.setAttribute('role','img');icon.setAttribute('aria-label',regionName(code)+(code==='TW'?' · 中国国旗':''));return icon;}\nfunction regionName(code){var r=REGIONS.find(function(x){return x[0]===code;});return r?r[1]+' '+REGION_ENGLISH[code]:'未知地区 Unknown';}\nfunction regionLabel(code){var r=REGIONS.find(function(x){return x[0]===code;}),label=el('span','country-name');label.append(el('b','',r?r[1]:'未知地区'),el('span','country-en',REGION_ENGLISH[code]||'Unknown'));return label;}\nfunction subscriptionFlag(s,info){if(/(?:\\bDMIT\\b|\\bVPS(?:[ _-]*A)?\\b)/i.test(s.name||''))return flagIcon('US','card-flag');var codes=Object.keys(info.regions);return codes.length===1?flagIcon(codes[0],'card-flag'):el('span','card-flag','🌐');}\n\nfunction card(s,idx){\n var info=nodeSummary(s),meta=STATE[s.state]||STATE.pending,c=el('section','card glass widget-standard');c.dataset.id=s.id;c.dataset.layout='standard';c.dataset.c=meta.c;c.style.setProperty('--i',String(idx));\n var codes=Object.keys(info.regions),head=el('div','chead'),title=el('div','title');title.append(subscriptionFlag(s,info),el('h2','',s.name));head.append(title,Object.assign(el('span','pill '+meta.c,meta.t),{title:s.error||meta.t}));c.append(head);\n var tags=el('div','card-tags');tags.append(el('span','chip',s.resourceFormat||'等待识别'),el('span','chip',info.nodes.length+' 个节点'));if(s.source==='file')tags.append(el('span','chip','文件导入'));else if(s.mode==='push')tags.append(el('span','chip','推送'));if(s.quotaSource==='manual')tags.append(el('span','chip history-chip','手动快照'));else if(s.quotaUpdatedAt&&s.quotaUpdatedAt!==s.lastCheck)tags.append(el('span','chip history-chip','历史额度'));c.append(tags);\n var scroll=el('div','card-scroll');scroll.append(subscriptionTiles(s),trafficBlock(s),quotaBlock(s),subscriptionFacts(s),nodePreview(s),statusRibbon(s));\n var foot=el('div','foot'),tools=el('div','widget-tools'),drag=el('button','widget-drag');drag.type='button';drag.innerHTML=toolIcon('move');drag.title='拖动排序';drag.setAttribute('aria-label','拖动排序，方向键也可移动');tools.append(drag);foot.append(subscriptionActions(s),tools);c.append(scroll,foot);return c;\n}\nfunction tableCell(value,percent,color,label){var td=el('td','table-metric');td.append(el('b','',value||'—'));if(label)td.append(el('small','',label));td.append(segmentMeter(percent,color,'数据占比'));return td;}\nfunction subscriptionTableRow(s){var info=nodeSummary(s),meta=STATE[s.state]||STATE.pending,tr=el('tr'),name=el('td','table-name'),link=el('button','table-name-button'),codes=Object.keys(info.regions);link.type='button';link.append(subscriptionFlag(s,info),el('b','',s.name));link.onclick=function(){openSubscriptionDetail(s);};var tags=el('div','card-tags');tags.append(el('span','chip',s.resourceFormat||'等待识别'),Object.assign(el('span','pill '+meta.c,meta.t),{title:meta.t}));name.append(link,tags);tr.append(name);\n var total=Number.isFinite(s.total)&&s.total>0?s.total:null,today=s.usageToday&&Number.isFinite(s.usageToday.bytes)?s.usageToday:null;tr.append(tableCell(fmt(s.used),total&&Number.isFinite(s.used)?s.used/total*100:null,'var(--blue)',total?'共 '+fmt(total):'未提供额度'),tableCell(today?fmt(today.bytes):null,today&&total?today.bytes/total*100:null,'var(--purple)',today?(today.partial?'部分记录':'今日估算'):'等待记录'),tableCell(fmt(s.remaining),total&&Number.isFinite(s.remaining)?s.remaining/total*100:null,quotaSegmentColor(s.percent),'剩余流量'));\n var traffic=el('td','table-traffic');traffic.append(el('span','','↑ '+(fmt(s.upload)||'—')),el('span','','↓ '+(fmt(s.download)||'—')));tr.append(traffic,tableCell(String(info.nodes.length),info.nodes.length?100:null,'var(--orange)',Object.keys(info.protocols).join(' / ')||'暂无节点'),tableCell(info.tested?info.up+' / '+info.tested:'未探测',info.tested?info.up/info.tested*100:null,'var(--ok)','TCP 可达'));\n var dates=el('td','table-dates');dates.append(el('b','',expiryText(s)),el('small','',checkText(s)));dates.title=(s.expire?'到期 '+dt(s.expire)+'；':'')+'最近检测 / 导入：'+checkText(s);var actions=el('td','table-actions');actions.append(subscriptionActions(s));tr.append(dates,actions);return tr;}\nfunction renderSubscriptionTable(list){var wrap=el('div','subscription-table-wrap glass'),table=el('table','subscription-table'),head=el('thead'),row=el('tr');['订阅','已用流量','今日用量','剩余流量','累计上传 / 下载','节点','TCP 可达','到期 / 更新','操作'].forEach(function(t){var th=el('th','',t);th.scope='col';row.append(th);});head.append(row);var body=el('tbody');list.forEach(s=>body.append(subscriptionTableRow(s)));table.append(head,body);wrap.append(table);return wrap;}\n\nfunction renderSubscriptionRegions(){var target=$('subscriptionRegions');if(!target)return;var counts={},unknown=0;latestSubs.forEach(function(s){cleanNodes(s).forEach(function(n){var r=nodeRegion(n);if(r)counts[r[0]]=(counts[r[0]]||0)+1;else unknown++;});});target.replaceChildren();Object.keys(counts).sort(function(a,b){return counts[b]-counts[a]||regionName(a).localeCompare(regionName(b),'zh-CN');}).forEach(function(k){var chip=el('span','country-chip');chip.append(flagIcon(k),regionLabel(k),el('small','',counts[k]));chip.title=regionName(k)+' · '+counts[k]+' 个节点';target.append(chip);});if(unknown)target.append(countryUnknown(unknown));if(!Object.keys(counts).length&&!unknown)target.append(el('span','stat-note','等待节点数据'));target.title='按节点名称识别地区，并非服务器 IP 定位';}\n\n$(\"detailClose\").onclick=function(){$(\"detailDlg\").close();};\n/* ---------- 数据 ---------- */\nfunction request(path, options) {\n  options = options || {};\n  var headers = Object.assign({}, options.headers, { authorization: \"Bearer \" + token });\n  return fetch(path, Object.assign({}, options, { headers: headers })).then(function (res) {\n    return res.json().catch(function () { throw new Error(\"服务暂时无法返回状态\"); }).then(function (data) {\n      if (res.status === 401) { $(\"loginErr\").textContent = \"口令不正确\"; if (!$(\"login\").open) $(\"login\").showModal(); throw new Error(\"请重新输入访问口令\"); }\n      if (!res.ok) throw new Error(data.error || \"请求失败\");\n      return data;\n    });\n  });\n}\n\nfunction load() {\n  if (!token) { $(\"login\").showModal(); return Promise.resolve(); }\n  return request(\"/api/status\").then(function (data) {\n    $(\"msg\").textContent = \"\";\n    var nodes = 0, upn = 0;\n    data.subs.forEach(function (s) { (s.nodes || []).forEach(function (n) { if (n.testable) { nodes++; if (n.online) upn++; } }); });\n    latestSubs = data.subs; renderDashboard();\n    $(\"sum\").textContent = data.subs.length + \" 个订阅\" + (nodes ? \" · 节点在线 \" + upn + \"/\" + nodes : \"\") + \" · 页面每分钟刷新\";\n    firstRender = false;\n  }).catch(function (e) { $(\"msg\").textContent = e.message; });\n}\n\n/* ---------- 弹窗与交互 ---------- */\nfunction openPush(id) {\n  $(\"pOrigin\").textContent = location.origin; $(\"pId\").textContent = id;\n  $(\"pLine\").textContent = \"@{ Id = '\" + id + \"'; Url = '在这里粘贴订阅链接' }\";\n  $(\"pushDlg\").showModal();\n}\ndocument.addEventListener(\"click\", function (e) {\n  var b = e.target.closest && e.target.closest(\"[data-copy]\");\n  if (!b) return;\n  var text = $(b.dataset.copy).textContent, old = b.textContent;\n  navigator.clipboard.writeText(text).then(function () { b.textContent = \"已复制\"; }, function () { b.textContent = \"复制失败\"; });\n  setTimeout(function () { b.textContent = old; }, 1200);\n});\n$(\"pushClose\").onclick = function () { $(\"pushDlg\").close(); };\n\nvar addMode = \"pull\";\nfunction setMode(m) {\n  addMode = m; $(\"fileRow\").hidden=m!==\"file\"; $(\"importFile\").required=m===\"file\";\n  document.querySelectorAll(\"#modeSeg button\").forEach(function (b) { b.className = b.dataset.mode === m ? \"on\" : \"\"; });\n  $(\"urlRow\").style.display = m === \"pull\" ? \"\" : \"none\";\n  $(\"url\").required = m === \"pull\";\n  $(\"modeHint\").textContent = m === \"file\" ? \"直接上传已下载的配置，无需 Worker 访问订阅链接。\" : m === \"pull\" ? \"由 Worker 定时访问订阅链接，适合大多数订阅。\" : \"订阅被验证页拦截、Worker 访问不了时使用：由你电脑上的脚本拉取并推送，Worker 不保存订阅链接。\";\n}\ndocument.querySelectorAll(\"#modeSeg button\").forEach(function (b) { b.onclick = function () { setMode(b.dataset.mode); }; });\n$(\"add\").onclick = function () { importTarget=null; $(\"addForm\").reset(); setMode(\"pull\"); $(\"addErr\").textContent = \"\"; $(\"addDlg\").showModal(); };\n$(\"addCancel\").onclick = function () { $(\"addDlg\").close(); };\n$(\"addForm\").onsubmit = function (e) {\n  e.preventDefault();\n  var body = { name: $(\"name\").value.trim(), mode: addMode };\n  if (addMode === \"pull\") body.url = $(\"url\").value.trim();\n  request(\"/api/subs\", { method: \"POST\", headers: { \"content-type\": \"application/json\" }, body: JSON.stringify(body) }).then(function (r) {\n    $(\"addDlg\").close(); return load().then(function () { if (addMode === \"push\") openPush(r.sub.id); });\n  }).catch(function (err) { $(\"addErr\").textContent = err.message; });\n};\n$(\"loginForm\").onsubmit = function (e) {\n  e.preventDefault(); token = $(\"token\").value.trim();\n  request(\"/api/status\").then(function () { localStorage.setItem(\"sm_token\", token); $(\"loginErr\").textContent = \"\"; $(\"login\").close(); return load(); })\n    .catch(function (err) { $(\"loginErr\").textContent = err.message; });\n};\nasync function checkSubscriptions(){\n  var b=$('refresh');b.disabled=true;b.textContent='检测中…';var done=0,next=0,errors=[];\n  try{\n    var snapshot=await request('/api/status'),ids=snapshot.subs.map(function(s){return s.id;});\n    async function run(){while(next<ids.length){var id=ids[next++];try{await request('/api/check?id='+encodeURIComponent(id),{method:'POST'});}catch(error){errors.push(error.message);}done++;b.textContent='检测 '+done+'/'+ids.length;}}\n    await Promise.all(Array.from({length:Math.min(2,ids.length)},run));await load();if(errors.length)$('msg').textContent=errors.join('；');\n  }catch(error){$('msg').textContent=error.message;}finally{b.disabled=false;b.textContent='立即检测';}\n}\n$('refresh').onclick=checkSubscriptions;\n\nvar latestSubs=[];\nvar DISPLAY_MODES=['detail','compact','tiles','table'],DISPLAY_LABELS={detail:'详细卡片',compact:'紧凑卡片',tiles:'密集卡片',table:'表格列表'};\nvar displayMode=localStorage.getItem('monitor-display-mode');if(!DISPLAY_MODES.includes(displayMode))displayMode=localStorage.getItem('monitor-compact')==='1'?'compact':'detail';\nvar themePreference=localStorage.getItem('monitor-theme');if(!['light','dark','auto'].includes(themePreference))themePreference='auto';\nvar themeMedia=matchMedia('(prefers-color-scheme: dark)'),motionMedia=matchMedia('(prefers-reduced-motion: reduce)'),liquidGroups=[],interactionAnimations=new WeakMap(),activeInteractionAnimations=new Set();\nfunction uiIcon(name){var paths={sun:'<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5\"/>',system:'<rect x=\"3\" y=\"4\" width=\"18\" height=\"13\" rx=\"2\"/><path d=\"M8 21h8m-4-4v4\"/>',moon:'<path d=\"M20.5 13.3A8.7 8.7 0 0 1 10.7 3.5 8.7 8.7 0 1 0 20.5 13.3Z\"/>',detail:'<rect x=\"4\" y=\"3\" width=\"16\" height=\"18\" rx=\"2\"/><path d=\"M4 9h16M4 15h16\"/>',compact:'<rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M9 3v18m6-18v18M3 9h18M3 15h18\"/>',tiles:'<rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"/>',table:'<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M3 9h18m-18 5h18M9 4v16\"/>',chevron:'<path d=\"m9 5 7 7-7 7\"/>',calendar:'<rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M7 3v4m10-4v4M3 11h18\"/>',refresh:'<path d=\"M20 10a8 8 0 0 0-14-4L3 9m0-6v6h6m-5 5a8 8 0 0 0 14 4l3-3m0 6v-6h-6\"/>',file:'<path d=\"M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z\"/><path d=\"M14 3v6h6m-12 4h8m-8 4h6\"/>',sort:'<path d=\"M5 20V4m-3 3 3-3 3 3M11 7h10m-10 5h7m-7 5h4\"/>',subs:'<rect x=\"4\" y=\"3\" width=\"16\" height=\"18\" rx=\"3\"/><path d=\"M8 8h8m-8 4h8m-8 4h4\"/>',nodes:'<circle cx=\"12\" cy=\"5\" r=\"2\"/><rect x=\"3\" y=\"16\" width=\"6\" height=\"5\" rx=\"1\"/><rect x=\"15\" y=\"16\" width=\"6\" height=\"5\" rx=\"1\"/><path d=\"M12 7v5M6 16v-4h12v4\"/>',control:'<path d=\"M4 7h16M4 17h16\"/><circle cx=\"9\" cy=\"7\" r=\"3\"/><circle cx=\"15\" cy=\"17\" r=\"3\"/>'};return '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\">'+(paths[name]||paths.detail)+'</svg>';}\nfunction syncLiquidGroups(animate){liquidGroups.forEach(function(g){g.move(animate);});}\nfunction applyThemePreference(value,animate){themePreference=value;localStorage.setItem('monitor-theme',value);document.documentElement.dataset.theme=value==='auto'?(themeMedia.matches?'dark':'light'):value;document.documentElement.dataset.themePreference=value;[['themeLight','light'],['themeSystem','auto'],['theme','dark']].forEach(function(r){$(r[0]).setAttribute('aria-pressed',String(r[1]===value));});syncLiquidGroups(animate);if(!$('view-nodes').hidden)drawGlobe();}\nfunction canAnimate(){return !motionMedia.matches;}\nfunction animateInteraction(target,frames,options){if(!target||!target.animate||!canAnimate())return;var previous=interactionAnimations.get(target);if(previous)previous.cancel();target.style.willChange='transform,opacity';var animation=target.animate(frames,options),entry={target:target,animation:animation};interactionAnimations.set(target,animation);activeInteractionAnimations.add(entry);function clear(){activeInteractionAnimations.delete(entry);if(interactionAnimations.get(target)!==animation)return;target.style.willChange='';interactionAnimations.delete(target);}if(animation.finished)animation.finished.then(clear,clear);else clear();return animation;}\nfunction applyMotionPreference(){document.documentElement.dataset.motion=canAnimate()?'1':'0';if(!canAnimate()){activeInteractionAnimations.forEach(function(entry){entry.animation.cancel();entry.target.style.willChange='';interactionAnimations.delete(entry.target);});activeInteractionAnimations.clear();syncLiquidGroups(false);}setGlobeSpin(!$('view-nodes').hidden);}\nif(motionMedia.addEventListener)motionMedia.addEventListener('change',applyMotionPreference);\nfunction displayLabel(){var next=DISPLAY_MODES[(DISPLAY_MODES.indexOf(displayMode)+1)%4];$('displayMode').innerHTML=uiIcon(displayMode);$('displayMode').title='当前：'+DISPLAY_LABELS[displayMode]+' · 点击切换为'+DISPLAY_LABELS[next];$('displayMode').setAttribute('aria-label',$('displayMode').title);$('displayMode').dataset.mode=displayMode;$('displayStatus').textContent=DISPLAY_LABELS[displayMode];}\nfunction setDisplayMode(mode,animate){if(!DISPLAY_MODES.includes(mode)||widgetBusy)return;if(finishCardDrop)finishCardDrop();displayMode=mode;document.documentElement.dataset.display=mode;localStorage.setItem('monitor-display-mode',mode);displayLabel();renderCards();if(animate)animateInteraction($('items'),[{opacity:.65},{opacity:1}],{duration:150,easing:'ease-out'});}\n$('themeLight').onclick=function(){applyThemePreference('light',true);};$('themeSystem').onclick=function(){applyThemePreference('auto',true);};$('theme').onclick=function(){applyThemePreference('dark',true);};\n$('displayMode').onclick=function(){setDisplayMode(DISPLAY_MODES[(DISPLAY_MODES.indexOf(displayMode)+1)%4],true);};$('displayMode').onkeydown=function(e){if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();var i=DISPLAY_MODES.indexOf(displayMode);setDisplayMode(DISPLAY_MODES[(i+(e.key==='ArrowRight'?1:3))%4],true);}};\nif(themeMedia.addEventListener)themeMedia.addEventListener('change',function(){if(themePreference==='auto')applyThemePreference('auto',true);});\n$('overview').hidden=false;\nvar orderMode=localStorage.getItem('monitor-order-mode')||'manual';function sortLabel(){$('sortName').innerHTML=uiIcon('sort')+'<span>名称</span>';$('sortName').dataset.direction=orderMode;$('sortName').title=orderMode==='name-asc'?'名称升序，点击改为降序':orderMode==='name-desc'?'名称降序，点击恢复手动顺序':'手动顺序，点击按名称升序';}$('sortName').onclick=function(){if(widgetBusy)return;orderMode=orderMode==='manual'?'name-asc':orderMode==='name-asc'?'name-desc':'manual';localStorage.setItem('monitor-order-mode',orderMode);sortLabel();renderCards();};sortLabel();\nfunction setupLiquidInteractions(){\n [['.dock','[data-view]','dockThumb',function(b){return b.getAttribute('aria-selected')==='true';}],['#themeSwitch','[data-theme-choice]','themeThumb',function(b){return b.getAttribute('aria-pressed')==='true';}]].forEach(function(r){var group=document.querySelector(r[0]),thumb=$(r[2]);if(!group||!thumb)return;var buttons=Array.from(group.querySelectorAll(r[1])),lastX=null;\n  function move(animate){var b=buttons.find(r[3]);if(!b)return;var x=b.offsetLeft,y=b.offsetTop,w=b.offsetWidth,h=b.offsetHeight,dx=lastX===null?0:x-lastX;thumb.style.transition=animate&&canAnimate()?'':'none';thumb.style.width=w+'px';thumb.style.height=h+'px';thumb.style.transform='translate3d('+x+'px,'+y+'px,0)';if(animate&&dx)animateInteraction(thumb.firstElementChild,[{transform:'scaleX(1) scaleY(1)'},{transform:'scaleX(1.07) scaleY(.95)',offset:.3},{transform:'scaleX(.985) scaleY(1.02)',offset:.68},{transform:'scaleX(1) scaleY(1)'}],{duration:290,easing:'cubic-bezier(.2,.85,.3,1)'});lastX=x;}\n  liquidGroups.push({move:move});buttons.forEach(function(b){var click=b.onclick;b.onclick=function(e){if(click)click.call(b,e);move(true);};});window.addEventListener('resize',function(){move(false);});if(typeof ResizeObserver==='function')new ResizeObserver(function(){move(false);}).observe(group);move(false);\n });\n document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button');if(!b||b.classList.contains('widget-drag'))return;animateInteraction(b,[{transform:'scale(.97)'},{transform:'scale(1.015)',offset:.55},{transform:'scale(1)'}],{duration:190,easing:'cubic-bezier(.2,.85,.3,1)'});});\n}\n\n document.querySelectorAll(\"[data-view]\").forEach(function(b){b.onclick=function(){if(widgetBusy)return;if(finishCardDrop)finishCardDrop();document.querySelectorAll(\"[data-view]\").forEach(function(x){var on=x===b;x.setAttribute(\"aria-selected\",String(on));$(\"view-\"+x.dataset.view).hidden=!on;});if(b.dataset.view==='subs'){metrics('overview');renderCards();}else if(b.dataset.view==='nodes'){renderNodes();renderInsights();}else renderInsights();setGlobeSpin(b.dataset.view===\"nodes\");};});\nfunction renderCards(){if(widgetBusy)return;if(finishCardDrop)finishCardDrop();var list=latestSubs.slice();var seen={};list.forEach(function(s){seen[s.id]=true;});var ordered=[];layoutState.order.forEach(function(id){var s=list.find(function(x){return x.id===id;});if(s){ordered.push(s);delete seen[id];}});list.forEach(function(s){if(seen[s.id])ordered.push(s);});latestSubs.forEach(function(s){if(!layoutState.order.includes(s.id))layoutState.order.push(s.id);});saveLayout();if(orderMode==='name-asc'||orderMode==='name-desc')ordered.sort(function(a,b){return a.name.localeCompare(b.name,'zh-CN',{numeric:true})*(orderMode==='name-desc'?-1:1);});var target=$(\"items\");target.dataset.display=displayMode;target.replaceChildren();if(!ordered.length)target.append(el(\"div\",\"empty\",\"暂无订阅，点击添加订阅开始\"));else if(displayMode==='table')target.append(renderSubscriptionTable(ordered));else{target.append(...ordered.map(card));bindCardLayout();}renderSubscriptionRegions();}\n\nvar widgetBusy=false;\nfunction commitVisibleOrder(ids){ids=ids.filter(id=>latestSubs.some(s=>s.id===id));orderMode=\"manual\";localStorage.setItem(\"monitor-order-mode\",orderMode);sortLabel();var visible=new Set(ids),next=0;var order=layoutState.order.filter(id=>latestSubs.some(s=>s.id===id));ids.forEach(id=>{if(!order.includes(id))order.push(id);});layoutState.order=order.map(id=>visible.has(id)?ids[next++]:id);saveLayout();}\n// Positions are measured once. Live reordering changes transforms only; DOM order commits on drop.\nvar dragLayoutAnimations=new WeakMap(),finishCardDrop=null;\nfunction layoutRects(grid){return new Map(Array.from(grid.querySelectorAll('.card')).map(function(c){return [c,c.getBoundingClientRect()];}));}\nfunction animateLayout(grid,before){if(!canAnimate())return;var cards=Array.from(grid.querySelectorAll('.card'));cards.forEach(function(c){var animation=dragLayoutAnimations.get(c);if(animation)animation.cancel();});var after=cards.map(c=>c.getBoundingClientRect());cards.forEach(function(c,i){var a=before.get(c),b=after[i];if(!a)return;var dx=a.left-b.left,dy=a.top-b.top;if(Math.abs(dx)+Math.abs(dy)<2)return;var previous=dragLayoutAnimations.get(c);if(previous)previous.cancel();var animation=c.animate?.([{transform:'translate3d('+dx+'px,'+dy+'px,0)'},{transform:'translate3d(0,0,0)'}],{duration:160,easing:'cubic-bezier(.2,.85,.3,1)'});if(animation)dragLayoutAnimations.set(c,animation);});}\nfunction dragSlotIndex(slots,x,y,current){var best=current,bestScore=Infinity,currentScore=Infinity;slots.forEach(function(r,i){var score=Math.pow((x-r.left-r.width/2)/Math.max(1,r.width),2)+Math.pow((y-r.top-r.height/2)/Math.max(1,r.height),2);if(i===current)currentScore=score;if(score<bestScore){bestScore=score;best=i;}});return best!==current&&bestScore+.025<currentScore?best:current;}\nfunction moveDragOrder(order,card,index){var next=order.slice(),from=next.indexOf(card);if(from<0||from===index)return next;next.splice(from,1);next.splice(index,0,card);return next;}\nfunction keyboardDragIndex(cards,rects,index,key){var origin=rects[index],cx=origin.left+origin.width/2,cy=origin.top+origin.height/2,vertical=key==='ArrowUp'||key==='ArrowDown',direction=key==='ArrowRight'||key==='ArrowDown'?1:-1,best=index,score=Infinity;rects.forEach(function(r,i){if(i===index)return;var x=r.left+r.width/2-cx,y=r.top+r.height/2-cy,along=vertical?y:x,across=vertical?x:y;if(along*direction<=1)return;var next=Math.abs(along)+Math.abs(across)*4;if(next<score){score=next;best=i;}});return best;}\nfunction bindCardLayout(){var grid=$('items');if(!grid||!grid.querySelectorAll)return;\n var cards=Array.from(grid.querySelectorAll('.card'));\n cards.forEach(function(card){var handle=card.querySelector('.widget-drag'),header=card.querySelector('.chead');if(!handle)return;\n handle.onkeydown=function(e){if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)||widgetBusy)return;e.preventDefault();if(finishCardDrop)finishCardDrop();var before=layoutRects(grid),current=Array.from(grid.querySelectorAll('.card')),i=current.indexOf(card),j=keyboardDragIndex(current,current.map(c=>before.get(c)),i,e.key);if(j===i)return;var next=moveDragOrder(current,card,j);grid.append(...next);commitVisibleOrder(next.map(c=>c.dataset.id));animateLayout(grid,before);handle.focus();};\n function start(e){if(e.button!==0||e.isPrimary===false||widgetBusy)return;if(e.target.closest('button,input,a,select,textarea')&&e.currentTarget!==handle)return;e.preventDefault();if(finishCardDrop)finishCardDrop();\n // All geometry reads are batched before any drag visuals are written.\n var original=Array.from(grid.querySelectorAll('.card'));original.forEach(function(c){var animation=dragLayoutAnimations.get(c);if(animation)animation.cancel();});\n var slots=original.map(c=>c.getBoundingClientRect()),index=original.indexOf(card),rect=slots[index],computed=window.getComputedStyle(card),scrollStart=window.scrollY||0,viewHeight=window.innerHeight,maxScroll=Math.max(0,document.documentElement.scrollHeight-viewHeight),startX=e.clientX,startY=e.clientY,px=startX,py=startY,frame=0,ghost=null,started=false,finished=false,order=original.slice(),targetIndex=index,threshold=e.pointerType==='touch'?5:3,capture=e.currentTarget||handle;\n var saved=original.map(function(c){return {transform:c.style.transform,transition:c.style.transition,willChange:c.style.willChange};});\n widgetBusy=true;capture.setPointerCapture?.(e.pointerId);\n function schedule(){if(!frame&&!finished)frame=requestAnimationFrame(draw);}\n function shift(){var writes=order.map(function(c,i){var source=slots[original.indexOf(c)],target=slots[i];return {card:c,dx:target.left-source.left,dy:target.top-source.top};});writes.forEach(function(w){w.card.style.willChange=w.dx||w.dy?'transform':'';w.card.style.transform='translate3d('+w.dx+'px,'+w.dy+'px,0)';});}\n function draw(){frame=0;if(!started||finished)return;var scroll=window.scrollY||0,deltaScroll=scroll-scrollStart,centerX=rect.left+rect.width/2+(px-startX),centerY=rect.top+rect.height/2+(py-startY)+deltaScroll,next=dragSlotIndex(slots,centerX,centerY,targetIndex);\n if(next!==targetIndex){targetIndex=next;order=moveDragOrder(order,card,next);shift();}\n ghost.style.transform='translate3d('+(px-startX)+'px,'+(py-startY)+'px,0)';\n // Auto-scroll is bounded and stops on drop/cancel; target geometry stays cached.\n var margin=64,step=py<margin?-Math.ceil((margin-py)/margin*12):py>viewHeight-margin?Math.ceil((py-viewHeight+margin)/margin*12):0;step=Math.max(-14,Math.min(14,step));if(step&&((step<0&&scroll>0)||(step>0&&scroll<maxScroll))){window.scrollBy(0,step);schedule();}\n }\n function move(ev){if(ev.pointerId!==e.pointerId)return;var samples=ev.getCoalescedEvents?.(),sample=samples&&samples.length?samples[samples.length-1]:ev;px=sample.clientX;py=sample.clientY;if(!started&&Math.hypot(px-startX,py-startY)<threshold)return;\n if(!started){started=true;ghost=card.cloneNode(true);ghost.classList.add('widget-preview');ghost.setAttribute('aria-hidden','true');ghost.inert=true;ghost.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));Object.assign(ghost.style,{left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',padding:computed.padding,borderRadius:computed.borderRadius,margin:'0'});document.body.append(ghost);original.forEach(c=>c.classList.add('drag-shift'));card.classList.add('widget-placeholder');}\n schedule();\n }\n function finish(aborted){if(finished)return;if(frame)cancelAnimationFrame(frame);frame=0;if(started&&!aborted){draw();if(frame)cancelAnimationFrame(frame);}finished=true;\n document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',cancel);document.removeEventListener('keydown',key);window.removeEventListener('blur',blur);window.removeEventListener('scroll',schedule);window.removeEventListener('resize',cancel);capture.removeEventListener?.('lostpointercapture',cancel);if(capture.hasPointerCapture?.(e.pointerId))capture.releasePointerCapture(e.pointerId);\n original.forEach(function(c,i){c.style.transition='none';c.style.transform=saved[i].transform;c.style.willChange=saved[i].willChange;c.classList.remove('drag-shift');});\n if(started&&!aborted){grid.append(...order);commitVisibleOrder(order.map(c=>c.dataset.id));}\n var dropDone=false,dropAnimation=null;\n function settle(){if(dropDone)return;dropDone=true;if(dropAnimation)dropAnimation.cancel();if(ghost)ghost.remove();card.classList.remove('widget-placeholder');if(finishCardDrop===settle)finishCardDrop=null;}\n if(ghost&&!aborted&&canAnimate()&&ghost.animate){var target=slots[targetIndex],end='translate3d('+(target.left-rect.left)+'px,'+(target.top-rect.top-((window.scrollY||0)-scrollStart))+'px,0)';dropAnimation=ghost.animate([{transform:ghost.style.transform,opacity:.97},{transform:end,opacity:1}],{duration:125,easing:'cubic-bezier(.2,.85,.3,1)',fill:'forwards'});finishCardDrop=settle;if(dropAnimation.finished)dropAnimation.finished.then(settle,settle);else settle();}else settle();\n requestAnimationFrame(function(){original.forEach(function(c,i){c.style.transition=saved[i].transition;});});widgetBusy=false;flushDeferredDashboard();\n }\n function up(ev){if(ev.pointerId!==e.pointerId)return;px=ev.clientX;py=ev.clientY;finish(false);}function cancel(ev){if(ev&&ev.pointerId!=null&&ev.pointerId!==e.pointerId)return;finish(true);}function key(ev){if(ev.key==='Escape')finish(true);}function blur(){finish(true);}\n document.addEventListener('pointermove',move,{passive:true});document.addEventListener('pointerup',up);document.addEventListener('pointercancel',cancel);document.addEventListener('keydown',key);window.addEventListener('blur',blur);window.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',cancel);capture.addEventListener?.('lostpointercapture',cancel,{once:true});\n }\n handle.onpointerdown=start;if(header)header.onpointerdown=start;\n });}\n\nfunction renderNodes(){var q=$(\"nodeSearch\").value.toLowerCase(),rows=[];latestSubs.forEach(function(s){cleanNodes(s).forEach(function(n){if(![s.name,n.name,n.protocol].join(\" \").toLowerCase().includes(q))return;var tr=el(\"tr\");[n.name,s.name,n.protocol].forEach(function(v){tr.append(el(\"td\",\"\",v));});var region=nodeRegion(n),regionCell=el(\"td\"),regionContent=el(\"span\",\"node-country\");if(region)regionContent.append(flagIcon(region[0]),regionLabel(region[0]));else regionContent.textContent=\"未知地区 Unknown\";regionCell.append(regionContent);tr.append(regionCell);var td=el(\"td\");td.append(latPill(n));if(!s.online)td.append(el(\"small\",\"\",\" · 历史\"));tr.append(td);rows.push(tr);});});$(\"nodeRows\").replaceChildren(...rows);if(!rows.length){var tr=el(\"tr\"),td=el(\"td\",\"\",\"暂无匹配节点\");td.colSpan=5;tr.append(td);$(\"nodeRows\").append(tr);}}\nfunction renderScreen(){metrics(\"screenMetrics\");$(\"screenTime\").textContent=\"页面同步于 \"+new Date().toLocaleTimeString(\"zh-CN\")+\" · 具体数据时间见各订阅\";$(\"screenList\").replaceChildren(...latestSubs.map(function(s){var r=el(\"div\",\"screen-row\"),m=STATE[s.state]||STATE.pending;r.append(el(\"b\",\"\",s.name),el(\"span\",\"pill \"+m.c,m.t),el(\"span\",\"\",Number.isFinite(s.remaining)?fmt(s.remaining)+\" 剩余\":\"额度未提供\"),el(\"small\",\"\",dt(s.lastCheck,true)||\"等待检测\"));return r;}));}\nvar dashboardDeferred=false;\nfunction flushDeferredDashboard(){if(!dashboardDeferred)return;dashboardDeferred=false;renderDashboard();}\nfunction renderDashboard(){if(widgetBusy){dashboardDeferred=true;return;}if(!$('view-subs').hidden){metrics('overview');renderCards();}if(!$('view-nodes').hidden){renderNodes();renderInsights();}else if(!$('view-control').hidden)renderInsights();if($('screenDlg').open)renderScreen();$('updateInfo').textContent='页面同步：'+new Date().toLocaleString('zh-CN');}\n$(\"nodeSearch\").oninput=renderNodes;\n\n$(\"screenOpen\").onclick=function(){renderScreen();$(\"screenDlg\").showModal();};\n$(\"screenClose\").onclick=async function(){if(document.fullscreenElement)await document.exitFullscreen();$(\"screenDlg\").close();};\n$(\"screenFull\").onclick=async function(){try{if(document.fullscreenElement)await document.exitFullscreen();else if($(\"screenDlg\").requestFullscreen)await $(\"screenDlg\").requestFullscreen();else $(\"screenFull\").textContent=\"浏览器不支持全屏\";}catch(e){$(\"screenFull\").textContent=\"无法进入全屏\";}};\n\nfunction isNoticeNode(n){var x=(n.name||'').trim().replace(/^[\\s📢📣⚠️🔔🔗👉⭐★☆]+/u,'');return /^(剩余(?:流量|额度)|总流量|已用流量|套餐流量|到期日期|请选择节点|防失联(?:网址|地址|域名)?|售前\\s*[\\/／]\\s*售后|(?:官网|官方网站|网站地址|订阅地址|更新订阅|剩余流量|套餐到期|到期时间|流量重置|重置时间|联系客服|官网客服|公告|通知)\\s*[:：]|.*请联系网站在线客服)/i.test(x);}\nfunction cleanNodes(s){return (s.nodes||[]).filter(function(n){return !isNoticeNode(n);});}\nvar REGIONS=[\n ['HK','香港',114.2,22.3,/香港|Hong\\s*Kong|\\bHK\\b|🇭🇰/i],['TW','台湾',121,24,/台湾|台灣|Taiwan|\\bTW\\b|🇹🇼/i],['MO','澳门',113.5,22.2,/澳门|Macau|\\bMO\\b|🇲🇴/i],['JP','日本',139,36,/日本|东京|大阪|Japan|Tokyo|Osaka|\\bJP\\b|🇯🇵/i],['SG','新加坡',103.8,1.3,/新加坡|狮城|Singapore|\\bSG\\b|🇸🇬/i],['US','美国',-98,39,/美国|美國|洛杉矶|圣何塞|西雅图|纽约|United\\s*States|Los\\s*Angeles|\\b(?:US|USA|LAX|SJC)\\b|🇺🇸/i],['KR','韩国',128,36,/韩国|首尔|Korea|Seoul|\\bKR\\b|🇰🇷/i],['GB','英国',-2,54,/英国|伦敦|London|Britain|\\b(?:UK|GB)\\b|🇬🇧/i],['DE','德国',10,51,/德国|法兰克福|Germany|Frankfurt|\\bDE\\b|🇩🇪/i],['FR','法国',2,47,/法国|巴黎|France|Paris|\\bFR\\b|🇫🇷/i],['CA','加拿大',-106,56,/加拿大|Canada|Toronto|\\bCA\\b|🇨🇦/i],['AU','澳大利亚',134,-25,/澳大利亚|澳洲|悉尼|Australia|Sydney|\\bAU\\b|🇦🇺/i],['IN','印度',79,22,/印度(?!尼西亚)|India\\b|\\bIN\\b|🇮🇳/i],['ID','印度尼西亚',117,-3,/印度尼西亚|印尼|Indonesia|\\bID\\b|🇮🇩/i],['MY','马来西亚',102,4,/马来西亚|Malaysia|\\bMY\\b|🇲🇾/i],['TH','泰国',101,15,/泰国|Thailand|\\bTH\\b|🇹🇭/i],['VN','越南',106,16,/越南|Vietnam|\\bVN\\b|🇻🇳/i],['PH','菲律宾',122,12,/菲律宾|Philippines|\\bPH\\b|🇵🇭/i],['RU','俄罗斯',100,60,/俄罗斯|Russia|\\bRU\\b|🇷🇺/i],['NL','荷兰',5,52,/荷兰|Netherlands|\\bNL\\b|🇳🇱/i],['TR','土耳其',35,39,/土耳其|Turkey|\\bTR\\b|🇹🇷/i],['BR','巴西',-52,-12,/巴西|Brazil|\\bBR\\b|🇧🇷/i],['ZA','南非',25,-29,/南非|South\\s*Africa|\\bZA\\b|🇿🇦/i],['AE','阿联酋',54,24,/阿联酋|迪拜|Dubai|\\bAE\\b|🇦🇪/i],['CN','中国大陆',105,35,/中国|大陆|北京|上海|广州|China|\\bCN\\b|🇨🇳/i]];\nvar REGION_FLAGS={HK:\"🇭🇰\",TW:\"🇹🇼\",MO:\"🇲🇴\",JP:\"🇯🇵\",SG:\"🇸🇬\",US:\"🇺🇸\",KR:\"🇰🇷\",GB:\"🇬🇧\",DE:\"🇩🇪\",FR:\"🇫🇷\",CA:\"🇨🇦\",AU:\"🇦🇺\",IN:\"🇮🇳\",ID:\"🇮🇩\",MY:\"🇲🇾\",TH:\"🇹🇭\",VN:\"🇻🇳\",PH:\"🇵🇭\",RU:\"🇷🇺\",NL:\"🇳🇱\",TR:\"🇹🇷\",BR:\"🇧🇷\",ZA:\"🇿🇦\",AE:\"🇦🇪\",CN:\"🇨🇳\"};\nvar REGION_ENGLISH={\"HK\":\"Hong Kong\",\"TW\":\"Taiwan\",\"MO\":\"Macau\",\"JP\":\"Japan\",\"SG\":\"Singapore\",\"US\":\"United States\",\"KR\":\"South Korea\",\"GB\":\"United Kingdom\",\"DE\":\"Germany\",\"FR\":\"France\",\"CA\":\"Canada\",\"AU\":\"Australia\",\"IN\":\"India\",\"ID\":\"Indonesia\",\"MY\":\"Malaysia\",\"TH\":\"Thailand\",\"VN\":\"Vietnam\",\"PH\":\"Philippines\",\"RU\":\"Russia\",\"NL\":\"Netherlands\",\"TR\":\"Turkey\",\"BR\":\"Brazil\",\"ZA\":\"South Africa\",\"AE\":\"United Arab Emirates\",\"CN\":\"Mainland China\"};\nvar REGION_SVGS={\"US\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0.0\\\" width=\\\"38\\\" height=\\\"1.548\\\" fill=\\\"#bf0a30\\\"/><rect x=\\\"0\\\" y=\\\"1.538\\\" width=\\\"38\\\" height=\\\"1.548\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"3.077\\\" width=\\\"38\\\" height=\\\"1.548\\\" fill=\\\"#bf0a30\\\"/><rect x=\\\"0\\\" y=\\\"4.615\\\" width=\\\"38\\\" height=\\\"1.548\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"6.154\\\" width=\\\"38\\\" height=\\\"1.548\\\" fill=\\\"#bf0a30\\\"/><rect x=\\\"0\\\" y=\\\"7.692\\\" width=\\\"38\\\" height=\\\"1.548\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"9.231\\\" width=\\\"38\\\" height=\\\"1.548\\\" fill=\\\"#bf0a30\\\"/><rect x=\\\"0\\\" y=\\\"10.769\\\" width=\\\"38\\\" height=\\\"1.548\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"12.308\\\" width=\\\"38\\\" height=\\\"1.548\\\" fill=\\\"#bf0a30\\\"/><rect x=\\\"0\\\" y=\\\"13.846\\\" width=\\\"38\\\" height=\\\"1.548\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"15.385\\\" width=\\\"38\\\" height=\\\"1.548\\\" fill=\\\"#bf0a30\\\"/><rect x=\\\"0\\\" y=\\\"16.923\\\" width=\\\"38\\\" height=\\\"1.548\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"18.462\\\" width=\\\"38\\\" height=\\\"1.548\\\" fill=\\\"#bf0a30\\\"/><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"15.2\\\" height=\\\"10.77\\\" fill=\\\"#002868\\\"/><polygon points=\\\"1.250,0.530 1.361,0.848 1.697,0.855 1.429,1.058 1.526,1.380 1.250,1.188 0.974,1.380 1.071,1.058 0.803,0.855 1.139,0.848\\\" fill=\\\"#fff\\\"/><polygon points=\\\"3.790,0.530 3.901,0.848 4.237,0.855 3.969,1.058 4.066,1.380 3.790,1.188 3.514,1.380 3.611,1.058 3.343,0.855 3.679,0.848\\\" fill=\\\"#fff\\\"/><polygon points=\\\"6.330,0.530 6.441,0.848 6.777,0.855 6.509,1.058 6.606,1.380 6.330,1.188 6.054,1.380 6.151,1.058 5.883,0.855 6.219,0.848\\\" fill=\\\"#fff\\\"/><polygon points=\\\"8.870,0.530 8.981,0.848 9.317,0.855 9.049,1.058 9.146,1.380 8.870,1.188 8.594,1.380 8.691,1.058 8.423,0.855 8.759,0.848\\\" fill=\\\"#fff\\\"/><polygon points=\\\"11.410,0.530 11.521,0.848 11.857,0.855 11.589,1.058 11.686,1.380 11.410,1.188 11.134,1.380 11.231,1.058 10.963,0.855 11.299,0.848\\\" fill=\\\"#fff\\\"/><polygon points=\\\"13.950,0.530 14.061,0.848 14.397,0.855 14.129,1.058 14.226,1.380 13.950,1.188 13.674,1.380 13.771,1.058 13.503,0.855 13.839,0.848\\\" fill=\\\"#fff\\\"/><polygon points=\\\"2.520,1.630 2.631,1.948 2.967,1.955 2.699,2.158 2.796,2.480 2.520,2.288 2.244,2.480 2.341,2.158 2.073,1.955 2.409,1.948\\\" fill=\\\"#fff\\\"/><polygon points=\\\"5.060,1.630 5.171,1.948 5.507,1.955 5.239,2.158 5.336,2.480 5.060,2.288 4.784,2.480 4.881,2.158 4.613,1.955 4.949,1.948\\\" fill=\\\"#fff\\\"/><polygon points=\\\"7.600,1.630 7.711,1.948 8.047,1.955 7.779,2.158 7.876,2.480 7.600,2.288 7.324,2.480 7.421,2.158 7.153,1.955 7.489,1.948\\\" fill=\\\"#fff\\\"/><polygon points=\\\"10.140,1.630 10.251,1.948 10.587,1.955 10.319,2.158 10.416,2.480 10.140,2.288 9.864,2.480 9.961,2.158 9.693,1.955 10.029,1.948\\\" fill=\\\"#fff\\\"/><polygon points=\\\"12.680,1.630 12.791,1.948 13.127,1.955 12.859,2.158 12.956,2.480 12.680,2.288 12.404,2.480 12.501,2.158 12.233,1.955 12.569,1.948\\\" fill=\\\"#fff\\\"/><polygon points=\\\"1.250,2.730 1.361,3.048 1.697,3.055 1.429,3.258 1.526,3.580 1.250,3.388 0.974,3.580 1.071,3.258 0.803,3.055 1.139,3.048\\\" fill=\\\"#fff\\\"/><polygon points=\\\"3.790,2.730 3.901,3.048 4.237,3.055 3.969,3.258 4.066,3.580 3.790,3.388 3.514,3.580 3.611,3.258 3.343,3.055 3.679,3.048\\\" fill=\\\"#fff\\\"/><polygon points=\\\"6.330,2.730 6.441,3.048 6.777,3.055 6.509,3.258 6.606,3.580 6.330,3.388 6.054,3.580 6.151,3.258 5.883,3.055 6.219,3.048\\\" fill=\\\"#fff\\\"/><polygon points=\\\"8.870,2.730 8.981,3.048 9.317,3.055 9.049,3.258 9.146,3.580 8.870,3.388 8.594,3.580 8.691,3.258 8.423,3.055 8.759,3.048\\\" fill=\\\"#fff\\\"/><polygon points=\\\"11.410,2.730 11.521,3.048 11.857,3.055 11.589,3.258 11.686,3.580 11.410,3.388 11.134,3.580 11.231,3.258 10.963,3.055 11.299,3.048\\\" fill=\\\"#fff\\\"/><polygon points=\\\"13.950,2.730 14.061,3.048 14.397,3.055 14.129,3.258 14.226,3.580 13.950,3.388 13.674,3.580 13.771,3.258 13.503,3.055 13.839,3.048\\\" fill=\\\"#fff\\\"/><polygon points=\\\"2.520,3.830 2.631,4.148 2.967,4.155 2.699,4.358 2.796,4.680 2.520,4.488 2.244,4.680 2.341,4.358 2.073,4.155 2.409,4.148\\\" fill=\\\"#fff\\\"/><polygon points=\\\"5.060,3.830 5.171,4.148 5.507,4.155 5.239,4.358 5.336,4.680 5.060,4.488 4.784,4.680 4.881,4.358 4.613,4.155 4.949,4.148\\\" fill=\\\"#fff\\\"/><polygon points=\\\"7.600,3.830 7.711,4.148 8.047,4.155 7.779,4.358 7.876,4.680 7.600,4.488 7.324,4.680 7.421,4.358 7.153,4.155 7.489,4.148\\\" fill=\\\"#fff\\\"/><polygon points=\\\"10.140,3.830 10.251,4.148 10.587,4.155 10.319,4.358 10.416,4.680 10.140,4.488 9.864,4.680 9.961,4.358 9.693,4.155 10.029,4.148\\\" fill=\\\"#fff\\\"/><polygon points=\\\"12.680,3.830 12.791,4.148 13.127,4.155 12.859,4.358 12.956,4.680 12.680,4.488 12.404,4.680 12.501,4.358 12.233,4.155 12.569,4.148\\\" fill=\\\"#fff\\\"/><polygon points=\\\"1.250,4.930 1.361,5.248 1.697,5.255 1.429,5.458 1.526,5.780 1.250,5.588 0.974,5.780 1.071,5.458 0.803,5.255 1.139,5.248\\\" fill=\\\"#fff\\\"/><polygon points=\\\"3.790,4.930 3.901,5.248 4.237,5.255 3.969,5.458 4.066,5.780 3.790,5.588 3.514,5.780 3.611,5.458 3.343,5.255 3.679,5.248\\\" fill=\\\"#fff\\\"/><polygon points=\\\"6.330,4.930 6.441,5.248 6.777,5.255 6.509,5.458 6.606,5.780 6.330,5.588 6.054,5.780 6.151,5.458 5.883,5.255 6.219,5.248\\\" fill=\\\"#fff\\\"/><polygon points=\\\"8.870,4.930 8.981,5.248 9.317,5.255 9.049,5.458 9.146,5.780 8.870,5.588 8.594,5.780 8.691,5.458 8.423,5.255 8.759,5.248\\\" fill=\\\"#fff\\\"/><polygon points=\\\"11.410,4.930 11.521,5.248 11.857,5.255 11.589,5.458 11.686,5.780 11.410,5.588 11.134,5.780 11.231,5.458 10.963,5.255 11.299,5.248\\\" fill=\\\"#fff\\\"/><polygon points=\\\"13.950,4.930 14.061,5.248 14.397,5.255 14.129,5.458 14.226,5.780 13.950,5.588 13.674,5.780 13.771,5.458 13.503,5.255 13.839,5.248\\\" fill=\\\"#fff\\\"/><polygon points=\\\"2.520,6.030 2.631,6.348 2.967,6.355 2.699,6.558 2.796,6.880 2.520,6.688 2.244,6.880 2.341,6.558 2.073,6.355 2.409,6.348\\\" fill=\\\"#fff\\\"/><polygon points=\\\"5.060,6.030 5.171,6.348 5.507,6.355 5.239,6.558 5.336,6.880 5.060,6.688 4.784,6.880 4.881,6.558 4.613,6.355 4.949,6.348\\\" fill=\\\"#fff\\\"/><polygon points=\\\"7.600,6.030 7.711,6.348 8.047,6.355 7.779,6.558 7.876,6.880 7.600,6.688 7.324,6.880 7.421,6.558 7.153,6.355 7.489,6.348\\\" fill=\\\"#fff\\\"/><polygon points=\\\"10.140,6.030 10.251,6.348 10.587,6.355 10.319,6.558 10.416,6.880 10.140,6.688 9.864,6.880 9.961,6.558 9.693,6.355 10.029,6.348\\\" fill=\\\"#fff\\\"/><polygon points=\\\"12.680,6.030 12.791,6.348 13.127,6.355 12.859,6.558 12.956,6.880 12.680,6.688 12.404,6.880 12.501,6.558 12.233,6.355 12.569,6.348\\\" fill=\\\"#fff\\\"/><polygon points=\\\"1.250,7.130 1.361,7.448 1.697,7.455 1.429,7.658 1.526,7.980 1.250,7.788 0.974,7.980 1.071,7.658 0.803,7.455 1.139,7.448\\\" fill=\\\"#fff\\\"/><polygon points=\\\"3.790,7.130 3.901,7.448 4.237,7.455 3.969,7.658 4.066,7.980 3.790,7.788 3.514,7.980 3.611,7.658 3.343,7.455 3.679,7.448\\\" fill=\\\"#fff\\\"/><polygon points=\\\"6.330,7.130 6.441,7.448 6.777,7.455 6.509,7.658 6.606,7.980 6.330,7.788 6.054,7.980 6.151,7.658 5.883,7.455 6.219,7.448\\\" fill=\\\"#fff\\\"/><polygon points=\\\"8.870,7.130 8.981,7.448 9.317,7.455 9.049,7.658 9.146,7.980 8.870,7.788 8.594,7.980 8.691,7.658 8.423,7.455 8.759,7.448\\\" fill=\\\"#fff\\\"/><polygon points=\\\"11.410,7.130 11.521,7.448 11.857,7.455 11.589,7.658 11.686,7.980 11.410,7.788 11.134,7.980 11.231,7.658 10.963,7.455 11.299,7.448\\\" fill=\\\"#fff\\\"/><polygon points=\\\"13.950,7.130 14.061,7.448 14.397,7.455 14.129,7.658 14.226,7.980 13.950,7.788 13.674,7.980 13.771,7.658 13.503,7.455 13.839,7.448\\\" fill=\\\"#fff\\\"/><polygon points=\\\"2.520,8.230 2.631,8.548 2.967,8.555 2.699,8.758 2.796,9.080 2.520,8.888 2.244,9.080 2.341,8.758 2.073,8.555 2.409,8.548\\\" fill=\\\"#fff\\\"/><polygon points=\\\"5.060,8.230 5.171,8.548 5.507,8.555 5.239,8.758 5.336,9.080 5.060,8.888 4.784,9.080 4.881,8.758 4.613,8.555 4.949,8.548\\\" fill=\\\"#fff\\\"/><polygon points=\\\"7.600,8.230 7.711,8.548 8.047,8.555 7.779,8.758 7.876,9.080 7.600,8.888 7.324,9.080 7.421,8.758 7.153,8.555 7.489,8.548\\\" fill=\\\"#fff\\\"/><polygon points=\\\"10.140,8.230 10.251,8.548 10.587,8.555 10.319,8.758 10.416,9.080 10.140,8.888 9.864,9.080 9.961,8.758 9.693,8.555 10.029,8.548\\\" fill=\\\"#fff\\\"/><polygon points=\\\"12.680,8.230 12.791,8.548 13.127,8.555 12.859,8.758 12.956,9.080 12.680,8.888 12.404,9.080 12.501,8.758 12.233,8.555 12.569,8.548\\\" fill=\\\"#fff\\\"/><polygon points=\\\"1.250,9.330 1.361,9.648 1.697,9.655 1.429,9.858 1.526,10.180 1.250,9.988 0.974,10.180 1.071,9.858 0.803,9.655 1.139,9.648\\\" fill=\\\"#fff\\\"/><polygon points=\\\"3.790,9.330 3.901,9.648 4.237,9.655 3.969,9.858 4.066,10.180 3.790,9.988 3.514,10.180 3.611,9.858 3.343,9.655 3.679,9.648\\\" fill=\\\"#fff\\\"/><polygon points=\\\"6.330,9.330 6.441,9.648 6.777,9.655 6.509,9.858 6.606,10.180 6.330,9.988 6.054,10.180 6.151,9.858 5.883,9.655 6.219,9.648\\\" fill=\\\"#fff\\\"/><polygon points=\\\"8.870,9.330 8.981,9.648 9.317,9.655 9.049,9.858 9.146,10.180 8.870,9.988 8.594,10.180 8.691,9.858 8.423,9.655 8.759,9.648\\\" fill=\\\"#fff\\\"/><polygon points=\\\"11.410,9.330 11.521,9.648 11.857,9.655 11.589,9.858 11.686,10.180 11.410,9.988 11.134,10.180 11.231,9.858 10.963,9.655 11.299,9.648\\\" fill=\\\"#fff\\\"/><polygon points=\\\"13.950,9.330 14.061,9.648 14.397,9.655 14.129,9.858 14.226,10.180 13.950,9.988 13.674,10.180 13.771,9.858 13.503,9.655 13.839,9.648\\\" fill=\\\"#fff\\\"/></svg>\",\"GB\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#012169\\\"/><path d=\\\"M0 0 38 20M38 0 0 20\\\" stroke=\\\"#fff\\\" stroke-width=\\\"4\\\"/><path d=\\\"M0 0 38 20M38 0 0 20\\\" stroke=\\\"#c8102e\\\" stroke-width=\\\"1.6\\\"/><rect x=\\\"16\\\" y=\\\"0\\\" width=\\\"6\\\" height=\\\"20\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"7\\\" width=\\\"38\\\" height=\\\"6\\\" fill=\\\"#fff\\\"/><rect x=\\\"17\\\" y=\\\"0\\\" width=\\\"4\\\" height=\\\"20\\\" fill=\\\"#c8102e\\\"/><rect x=\\\"0\\\" y=\\\"8\\\" width=\\\"38\\\" height=\\\"4\\\" fill=\\\"#c8102e\\\"/></svg>\",\"JP\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#fff\\\"/><circle cx=\\\"19\\\" cy=\\\"10\\\" r=\\\"6\\\" fill=\\\"#bc002d\\\"/></svg>\",\"CN\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#de2910\\\"/><polygon points=\\\"6.500,2.700 7.229,4.797 9.448,4.842 7.679,6.183 8.322,8.308 6.500,7.040 4.678,8.308 5.321,6.183 3.552,4.842 5.771,4.797\\\" fill=\\\"#ffde00\\\"/><polygon points=\\\"11.475,1.391 12.044,1.882 12.703,1.520 12.411,2.213 12.959,2.727 12.210,2.664 11.890,3.344 11.719,2.612 10.973,2.518 11.616,2.129\\\" fill=\\\"#ffde00\\\"/><polygon points=\\\"13.196,4.525 13.898,4.792 14.393,4.226 14.356,4.977 15.047,5.273 14.322,5.470 14.254,6.219 13.843,5.589 13.110,5.756 13.581,5.171\\\" fill=\\\"#ffde00\\\"/><polygon points=\\\"12.966,8.218 13.708,8.098 13.854,7.360 14.197,8.029 14.944,7.940 14.414,8.473 14.729,9.155 14.058,8.816 13.507,9.327 13.623,8.584\\\" fill=\\\"#ffde00\\\"/><polygon points=\\\"10.891,11.525 11.382,10.956 11.020,10.297 11.713,10.589 12.227,10.041 12.164,10.790 12.844,11.110 12.112,11.281 12.018,12.027 11.629,11.384\\\" fill=\\\"#ffde00\\\"/></svg>\",\"TW\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#fe0000\\\"/><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"19\\\" height=\\\"10\\\" fill=\\\"#000095\\\"/><polygon points=\\\"9.500,1.600 9.852,3.686 11.200,2.056 10.462,4.038 12.444,3.300 10.814,4.648 12.900,5.000 10.814,5.352 12.444,6.700 10.462,5.962 11.200,7.944 9.852,6.314 9.500,8.400 9.148,6.314 7.800,7.944 8.538,5.962 6.556,6.700 8.186,5.352 6.100,5.000 8.186,4.648 6.556,3.300 8.538,4.038 7.800,2.056 9.148,3.686\\\" fill=\\\"#fff\\\"/><circle cx=\\\"9.5\\\" cy=\\\"5\\\" r=\\\"2.4\\\" fill=\\\"#000095\\\"/><circle cx=\\\"9.5\\\" cy=\\\"5\\\" r=\\\"1.85\\\" fill=\\\"#fff\\\"/></svg>\",\"SG\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0.0\\\" width=\\\"38\\\" height=\\\"10.01\\\" fill=\\\"#ef3340\\\"/><rect x=\\\"0\\\" y=\\\"10.0\\\" width=\\\"38\\\" height=\\\"10.01\\\" fill=\\\"#fff\\\"/><circle cx=\\\"7\\\" cy=\\\"5\\\" r=\\\"3.3\\\" fill=\\\"#fff\\\"/><circle cx=\\\"8.3\\\" cy=\\\"5\\\" r=\\\"2.739\\\" fill=\\\"#ef3340\\\"/><polygon points=\\\"12.000,2.000 12.200,2.575 12.808,2.587 12.323,2.955 12.500,3.538 12.000,3.190 11.500,3.538 11.677,2.955 11.192,2.587 11.800,2.575\\\" fill=\\\"#fff\\\"/><polygon points=\\\"14.045,3.486 14.245,4.061 14.853,4.073 14.368,4.441 14.544,5.023 14.045,4.676 13.545,5.023 13.721,4.441 13.236,4.073 13.845,4.061\\\" fill=\\\"#fff\\\"/><polygon points=\\\"13.264,5.889 13.464,6.464 14.072,6.477 13.587,6.844 13.763,7.427 13.264,7.079 12.764,7.427 12.940,6.844 12.455,6.477 13.064,6.464\\\" fill=\\\"#fff\\\"/><polygon points=\\\"10.736,5.889 10.936,6.464 11.545,6.477 11.060,6.844 11.236,7.427 10.736,7.079 10.237,7.427 10.413,6.844 9.928,6.477 10.536,6.464\\\" fill=\\\"#fff\\\"/><polygon points=\\\"9.955,3.486 10.155,4.061 10.764,4.073 10.279,4.441 10.455,5.023 9.955,4.676 9.456,5.023 9.632,4.441 9.147,4.073 9.755,4.061\\\" fill=\\\"#fff\\\"/></svg>\",\"HK\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#de2910\\\"/><g transform=\\\"rotate(0 19 10)\\\"><path d=\\\"M19 10C14.1 9.8 13.9 3.9 18.1 3.4C20.7 3.1 22.1 6.1 19 10Z\\\" fill=\\\"#fff\\\"/><polygon points=\\\"18.000,4.870 18.148,5.296 18.599,5.305 18.240,5.578 18.370,6.010 18.000,5.752 17.630,6.010 17.760,5.578 17.401,5.305 17.852,5.296\\\" fill=\\\"#de2910\\\"/><path d=\\\"M19 10Q16.8 7.8 18.2 5.5\\\" fill=\\\"none\\\" stroke=\\\"#de2910\\\" stroke-width=\\\".25\\\"/></g><g transform=\\\"rotate(72 19 10)\\\"><path d=\\\"M19 10C14.1 9.8 13.9 3.9 18.1 3.4C20.7 3.1 22.1 6.1 19 10Z\\\" fill=\\\"#fff\\\"/><polygon points=\\\"18.000,4.870 18.148,5.296 18.599,5.305 18.240,5.578 18.370,6.010 18.000,5.752 17.630,6.010 17.760,5.578 17.401,5.305 17.852,5.296\\\" fill=\\\"#de2910\\\"/><path d=\\\"M19 10Q16.8 7.8 18.2 5.5\\\" fill=\\\"none\\\" stroke=\\\"#de2910\\\" stroke-width=\\\".25\\\"/></g><g transform=\\\"rotate(144 19 10)\\\"><path d=\\\"M19 10C14.1 9.8 13.9 3.9 18.1 3.4C20.7 3.1 22.1 6.1 19 10Z\\\" fill=\\\"#fff\\\"/><polygon points=\\\"18.000,4.870 18.148,5.296 18.599,5.305 18.240,5.578 18.370,6.010 18.000,5.752 17.630,6.010 17.760,5.578 17.401,5.305 17.852,5.296\\\" fill=\\\"#de2910\\\"/><path d=\\\"M19 10Q16.8 7.8 18.2 5.5\\\" fill=\\\"none\\\" stroke=\\\"#de2910\\\" stroke-width=\\\".25\\\"/></g><g transform=\\\"rotate(216 19 10)\\\"><path d=\\\"M19 10C14.1 9.8 13.9 3.9 18.1 3.4C20.7 3.1 22.1 6.1 19 10Z\\\" fill=\\\"#fff\\\"/><polygon points=\\\"18.000,4.870 18.148,5.296 18.599,5.305 18.240,5.578 18.370,6.010 18.000,5.752 17.630,6.010 17.760,5.578 17.401,5.305 17.852,5.296\\\" fill=\\\"#de2910\\\"/><path d=\\\"M19 10Q16.8 7.8 18.2 5.5\\\" fill=\\\"none\\\" stroke=\\\"#de2910\\\" stroke-width=\\\".25\\\"/></g><g transform=\\\"rotate(288 19 10)\\\"><path d=\\\"M19 10C14.1 9.8 13.9 3.9 18.1 3.4C20.7 3.1 22.1 6.1 19 10Z\\\" fill=\\\"#fff\\\"/><polygon points=\\\"18.000,4.870 18.148,5.296 18.599,5.305 18.240,5.578 18.370,6.010 18.000,5.752 17.630,6.010 17.760,5.578 17.401,5.305 17.852,5.296\\\" fill=\\\"#de2910\\\"/><path d=\\\"M19 10Q16.8 7.8 18.2 5.5\\\" fill=\\\"none\\\" stroke=\\\"#de2910\\\" stroke-width=\\\".25\\\"/></g></svg>\",\"MO\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#00785e\\\"/><polygon points=\\\"19.000,2.100 19.212,2.709 19.856,2.722 19.342,3.111 19.529,3.728 19.000,3.360 18.471,3.728 18.658,3.111 18.144,2.722 18.788,2.709\\\" fill=\\\"#ffdf00\\\"/><polygon points=\\\"14.100,3.650 14.253,4.090 14.718,4.099 14.347,4.380 14.482,4.826 14.100,4.560 13.718,4.826 13.853,4.380 13.482,4.099 13.947,4.090\\\" fill=\\\"#ffdf00\\\"/><polygon points=\\\"23.900,3.650 24.053,4.090 24.518,4.099 24.147,4.380 24.282,4.826 23.900,4.560 23.518,4.826 23.653,4.380 23.282,4.099 23.747,4.090\\\" fill=\\\"#ffdf00\\\"/><polygon points=\\\"10.500,5.450 10.629,5.822 11.023,5.830 10.709,6.068 10.823,6.445 10.500,6.220 10.177,6.445 10.291,6.068 9.977,5.830 10.371,5.822\\\" fill=\\\"#ffdf00\\\"/><polygon points=\\\"27.500,5.450 27.629,5.822 28.023,5.830 27.709,6.068 27.823,6.445 27.500,6.220 27.177,6.445 27.291,6.068 26.977,5.830 27.371,5.822\\\" fill=\\\"#ffdf00\\\"/><path d=\\\"M19 13C14 12.1 15.2 8 19 6.7C22.8 8 24 12.1 19 13ZM19 13C13 14 10 10.2 12 7.8C14.8 8.8 16.6 10.6 19 13ZM19 13C25 14 28 10.2 26 7.8C23.2 8.8 21.4 10.6 19 13Z\\\" fill=\\\"#fff\\\"/><path d=\\\"M10 14H28M11 15.5H27M13 17H25\\\" stroke=\\\"#fff\\\" stroke-width=\\\".9\\\"/></svg>\",\"KR\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#fff\\\"/><circle cx=\\\"19\\\" cy=\\\"10\\\" r=\\\"4.7\\\" fill=\\\"#cd2e3a\\\"/><path d=\\\"M14.3 10A4.7 4.7 0 0 0 23.7 10A2.35 2.35 0 0 0 19 10A2.35 2.35 0 0 1 14.3 10Z\\\" fill=\\\"#0047a0\\\"/><g transform=\\\"translate(9 5) rotate(-55)\\\"><rect x=\\\"-3\\\" y=\\\"-2.0\\\" width=\\\"6\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"-3\\\" y=\\\"-0.6000000000000001\\\" width=\\\"6\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"-3\\\" y=\\\"0.7999999999999998\\\" width=\\\"6\\\" height=\\\"1\\\" fill=\\\"#111\\\"/></g><g transform=\\\"translate(29 15) rotate(-55)\\\"><rect x=\\\"-3\\\" y=\\\"-2.0\\\" width=\\\"2.5\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"0.5\\\" y=\\\"-2.0\\\" width=\\\"2.5\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"-3\\\" y=\\\"-0.6000000000000001\\\" width=\\\"2.5\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"0.5\\\" y=\\\"-0.6000000000000001\\\" width=\\\"2.5\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"-3\\\" y=\\\"0.7999999999999998\\\" width=\\\"2.5\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"0.5\\\" y=\\\"0.7999999999999998\\\" width=\\\"2.5\\\" height=\\\"1\\\" fill=\\\"#111\\\"/></g><g transform=\\\"translate(29 5) rotate(55)\\\"><rect x=\\\"-3\\\" y=\\\"-2.0\\\" width=\\\"2.5\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"0.5\\\" y=\\\"-2.0\\\" width=\\\"2.5\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"-3\\\" y=\\\"-0.6000000000000001\\\" width=\\\"6\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"-3\\\" y=\\\"0.7999999999999998\\\" width=\\\"2.5\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"0.5\\\" y=\\\"0.7999999999999998\\\" width=\\\"2.5\\\" height=\\\"1\\\" fill=\\\"#111\\\"/></g><g transform=\\\"translate(9 15) rotate(55)\\\"><rect x=\\\"-3\\\" y=\\\"-2.0\\\" width=\\\"6\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"-3\\\" y=\\\"-0.6000000000000001\\\" width=\\\"2.5\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"0.5\\\" y=\\\"-0.6000000000000001\\\" width=\\\"2.5\\\" height=\\\"1\\\" fill=\\\"#111\\\"/><rect x=\\\"-3\\\" y=\\\"0.7999999999999998\\\" width=\\\"6\\\" height=\\\"1\\\" fill=\\\"#111\\\"/></g></svg>\",\"DE\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0.0\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#000\\\"/><rect x=\\\"0\\\" y=\\\"6.667\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#dd0000\\\"/><rect x=\\\"0\\\" y=\\\"13.333\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#ffce00\\\"/></svg>\",\"FR\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0.0\\\" y=\\\"0\\\" width=\\\"12.677\\\" height=\\\"20\\\" fill=\\\"#002654\\\"/><rect x=\\\"12.667\\\" y=\\\"0\\\" width=\\\"12.677\\\" height=\\\"20\\\" fill=\\\"#fff\\\"/><rect x=\\\"25.333\\\" y=\\\"0\\\" width=\\\"12.677\\\" height=\\\"20\\\" fill=\\\"#ed2939\\\"/></svg>\",\"CA\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#d80621\\\"/><rect x=\\\"9.5\\\" y=\\\"0\\\" width=\\\"19\\\" height=\\\"20\\\" fill=\\\"#fff\\\"/><path d=\\\"M19 3L20.2 6.1L22.1 5.1L21.5 9.1L24.7 7.9L24.3 9.6L27 10.2L23.2 13.5L24 15.1L19.6 14.6L19.6 18H18.4V14.6L14 15.1L14.8 13.5L11 10.2L13.7 9.6L13.3 7.9L16.5 9.1L15.9 5.1L17.8 6.1Z\\\" fill=\\\"#d80621\\\"/></svg>\",\"AU\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#012169\\\"/><g transform=\\\"scale(.5)\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#012169\\\"/><path d=\\\"M0 0 38 20M38 0 0 20\\\" stroke=\\\"#fff\\\" stroke-width=\\\"4\\\"/><path d=\\\"M0 0 38 20M38 0 0 20\\\" stroke=\\\"#c8102e\\\" stroke-width=\\\"1.6\\\"/><rect x=\\\"16\\\" y=\\\"0\\\" width=\\\"6\\\" height=\\\"20\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"7\\\" width=\\\"38\\\" height=\\\"6\\\" fill=\\\"#fff\\\"/><rect x=\\\"17\\\" y=\\\"0\\\" width=\\\"4\\\" height=\\\"20\\\" fill=\\\"#c8102e\\\"/><rect x=\\\"0\\\" y=\\\"8\\\" width=\\\"38\\\" height=\\\"4\\\" fill=\\\"#c8102e\\\"/></g><polygon points=\\\"9.500,12.650 9.908,14.153 11.337,13.535 10.416,14.791 11.791,15.523 10.235,15.586 10.520,17.117 9.500,15.940 8.480,17.117 8.765,15.586 7.209,15.523 8.584,14.791 7.663,13.535 9.092,14.153\\\" fill=\\\"#fff\\\"/><polygon points=\\\"28.500,2.300 28.795,3.387 29.829,2.940 29.163,3.849 30.157,4.378 29.032,4.424 29.238,5.532 28.500,4.680 27.762,5.532 27.968,4.424 26.843,4.378 27.837,3.849 27.171,2.940 28.205,3.387\\\" fill=\\\"#fff\\\"/><polygon points=\\\"23.400,7.400 23.678,8.423 24.651,8.002 24.024,8.858 24.960,9.356 23.900,9.399 24.094,10.442 23.400,9.640 22.706,10.442 22.900,9.399 21.840,9.356 22.776,8.858 22.149,8.002 23.122,8.423\\\" fill=\\\"#fff\\\"/><polygon points=\\\"33.100,6.800 33.378,7.823 34.351,7.402 33.724,8.258 34.660,8.756 33.600,8.799 33.794,9.842 33.100,9.040 32.406,9.842 32.600,8.799 31.540,8.756 32.476,8.258 31.849,7.402 32.822,7.823\\\" fill=\\\"#fff\\\"/><polygon points=\\\"28.500,14.200 28.830,15.415 29.985,14.915 29.241,15.931 30.352,16.523 29.094,16.574 29.324,17.812 28.500,16.860 27.676,17.812 27.906,16.574 26.648,16.523 27.759,15.931 27.015,14.915 28.170,15.415\\\" fill=\\\"#fff\\\"/><polygon points=\\\"30.500,10.550 30.700,11.125 31.308,11.137 30.823,11.505 31.000,12.088 30.500,11.740 30.000,12.088 30.177,11.505 29.692,11.137 30.300,11.125\\\" fill=\\\"#fff\\\"/></svg>\",\"IN\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0.0\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#ff9933\\\"/><rect x=\\\"0\\\" y=\\\"6.667\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"13.333\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#138808\\\"/><circle cx=\\\"19\\\" cy=\\\"10\\\" r=\\\"2.7\\\" fill=\\\"#000080\\\"/><circle cx=\\\"19\\\" cy=\\\"10\\\" r=\\\"2.4\\\" fill=\\\"#fff\\\"/><path d=\\\"M19 10L21.350 10.000\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L21.270 10.608\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L21.035 11.175\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L20.662 11.662\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L20.175 12.035\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L19.608 12.270\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L19.000 12.350\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L18.392 12.270\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L17.825 12.035\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L17.338 11.662\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L16.965 11.175\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L16.730 10.608\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L16.650 10.000\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L16.730 9.392\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L16.965 8.825\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L17.338 8.338\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L17.825 7.965\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L18.392 7.730\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L19.000 7.650\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L19.608 7.730\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L20.175 7.965\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L20.662 8.338\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L21.035 8.825\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><path d=\\\"M19 10L21.270 9.392\\\" stroke=\\\"#000080\\\" stroke-width=\\\".18\\\"/><circle cx=\\\"19\\\" cy=\\\"10\\\" r=\\\"0.45\\\" fill=\\\"#000080\\\"/></svg>\",\"ID\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0.0\\\" width=\\\"38\\\" height=\\\"10.01\\\" fill=\\\"#ff0000\\\"/><rect x=\\\"0\\\" y=\\\"10.0\\\" width=\\\"38\\\" height=\\\"10.01\\\" fill=\\\"#fff\\\"/></svg>\",\"RU\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0.0\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"6.667\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#0039a6\\\"/><rect x=\\\"0\\\" y=\\\"13.333\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#d52b1e\\\"/></svg>\",\"NL\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0.0\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#ae1c28\\\"/><rect x=\\\"0\\\" y=\\\"6.667\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"13.333\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#21468b\\\"/></svg>\",\"MY\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0.0\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#cc0001\\\"/><rect x=\\\"0\\\" y=\\\"1.429\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"2.857\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#cc0001\\\"/><rect x=\\\"0\\\" y=\\\"4.286\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"5.714\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#cc0001\\\"/><rect x=\\\"0\\\" y=\\\"7.143\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"8.571\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#cc0001\\\"/><rect x=\\\"0\\\" y=\\\"10.0\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"11.429\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#cc0001\\\"/><rect x=\\\"0\\\" y=\\\"12.857\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"14.286\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#cc0001\\\"/><rect x=\\\"0\\\" y=\\\"15.714\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"17.143\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#cc0001\\\"/><rect x=\\\"0\\\" y=\\\"18.571\\\" width=\\\"38\\\" height=\\\"1.439\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"19\\\" height=\\\"11.43\\\" fill=\\\"#010066\\\"/><circle cx=\\\"6.5\\\" cy=\\\"5.7\\\" r=\\\"4\\\" fill=\\\"#fc0\\\"/><circle cx=\\\"8.0\\\" cy=\\\"5.7\\\" r=\\\"3.32\\\" fill=\\\"#010066\\\"/><polygon points=\\\"12.700,2.700 12.967,4.530 14.002,2.997 13.448,4.762 15.045,3.830 13.781,5.179 15.625,5.032 13.900,5.700 15.625,6.368 13.781,6.221 15.045,7.570 13.448,6.638 14.002,8.403 12.967,6.870 12.700,8.700 12.433,6.870 11.398,8.403 11.952,6.638 10.355,7.570 11.619,6.221 9.775,6.368 11.500,5.700 9.775,5.032 11.619,5.179 10.355,3.830 11.952,4.762 11.398,2.997 12.433,4.530\\\" fill=\\\"#fc0\\\"/></svg>\",\"TH\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#a51931\\\"/><rect x=\\\"0\\\" y=\\\"3.333\\\" width=\\\"38\\\" height=\\\"13.334\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"6.667\\\" width=\\\"38\\\" height=\\\"6.666\\\" fill=\\\"#2d2a4a\\\"/></svg>\",\"VN\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#da251d\\\"/><polygon points=\\\"19.000,4.000 20.411,8.058 24.706,8.146 21.283,10.742 22.527,14.854 19.000,12.400 15.473,14.854 16.717,10.742 13.294,8.146 17.589,8.058\\\" fill=\\\"#ff0\\\"/></svg>\",\"PH\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0.0\\\" width=\\\"38\\\" height=\\\"10.01\\\" fill=\\\"#0038a8\\\"/><rect x=\\\"0\\\" y=\\\"10.0\\\" width=\\\"38\\\" height=\\\"10.01\\\" fill=\\\"#ce1126\\\"/><polygon points=\\\"0,0 17.3,10 0,20\\\" fill=\\\"#fff\\\"/><circle cx=\\\"6.4\\\" cy=\\\"10\\\" r=\\\"2\\\" fill=\\\"#fcd116\\\"/><path d=\\\"M8.200 10.000L10.200 10.000\\\" stroke=\\\"#fcd116\\\" stroke-width=\\\".7\\\"/><path d=\\\"M7.673 11.273L9.087 12.687\\\" stroke=\\\"#fcd116\\\" stroke-width=\\\".7\\\"/><path d=\\\"M6.400 11.800L6.400 13.800\\\" stroke=\\\"#fcd116\\\" stroke-width=\\\".7\\\"/><path d=\\\"M5.127 11.273L3.713 12.687\\\" stroke=\\\"#fcd116\\\" stroke-width=\\\".7\\\"/><path d=\\\"M4.600 10.000L2.600 10.000\\\" stroke=\\\"#fcd116\\\" stroke-width=\\\".7\\\"/><path d=\\\"M5.127 8.727L3.713 7.313\\\" stroke=\\\"#fcd116\\\" stroke-width=\\\".7\\\"/><path d=\\\"M6.400 8.200L6.400 6.200\\\" stroke=\\\"#fcd116\\\" stroke-width=\\\".7\\\"/><path d=\\\"M7.673 8.727L9.087 7.313\\\" stroke=\\\"#fcd116\\\" stroke-width=\\\".7\\\"/><polygon points=\\\"2.300,2.100 2.559,2.844 3.346,2.860 2.718,3.336 2.947,4.090 2.300,3.640 1.653,4.090 1.882,3.336 1.254,2.860 2.041,2.844\\\" fill=\\\"#fcd116\\\"/><polygon points=\\\"2.300,15.700 2.559,16.444 3.346,16.460 2.718,16.936 2.947,17.690 2.300,17.240 1.653,17.690 1.882,16.936 1.254,16.460 2.041,16.444\\\" fill=\\\"#fcd116\\\"/><polygon points=\\\"13.500,8.900 13.759,9.644 14.546,9.660 13.918,10.136 14.147,10.890 13.500,10.440 12.853,10.890 13.082,10.136 12.454,9.660 13.241,9.644\\\" fill=\\\"#fcd116\\\"/></svg>\",\"TR\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#e30a17\\\"/><circle cx=\\\"14\\\" cy=\\\"10\\\" r=\\\"5\\\" fill=\\\"#fff\\\"/><circle cx=\\\"15.8\\\" cy=\\\"10\\\" r=\\\"4.1499999999999995\\\" fill=\\\"#e30a17\\\"/><polygon points=\\\"23.700,10.000 21.874,10.635 21.834,12.568 20.666,11.027 18.816,11.587 19.920,10.000 18.816,8.413 20.666,8.973 21.834,7.432 21.874,9.365\\\" fill=\\\"#fff\\\"/></svg>\",\"BR\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"38\\\" height=\\\"20\\\" fill=\\\"#009739\\\"/><polygon points=\\\"19,2 35,10 19,18 3,10\\\" fill=\\\"#ffdf00\\\"/><circle cx=\\\"19\\\" cy=\\\"10\\\" r=\\\"5.3\\\" fill=\\\"#002776\\\"/><path d=\\\"M14 8.3Q19 7.8 24 11\\\" stroke=\\\"#fff\\\" stroke-width=\\\".9\\\" fill=\\\"none\\\"/><circle cx=\\\"17\\\" cy=\\\"11\\\" r=\\\"0.22\\\" fill=\\\"#fff\\\"/><circle cx=\\\"18\\\" cy=\\\"13\\\" r=\\\"0.22\\\" fill=\\\"#fff\\\"/><circle cx=\\\"20.5\\\" cy=\\\"12.7\\\" r=\\\"0.22\\\" fill=\\\"#fff\\\"/><circle cx=\\\"21.5\\\" cy=\\\"11.4\\\" r=\\\"0.22\\\" fill=\\\"#fff\\\"/><circle cx=\\\"19.5\\\" cy=\\\"8.5\\\" r=\\\"0.22\\\" fill=\\\"#fff\\\"/></svg>\",\"ZA\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0.0\\\" width=\\\"38\\\" height=\\\"10.01\\\" fill=\\\"#de3831\\\"/><rect x=\\\"0\\\" y=\\\"10.0\\\" width=\\\"38\\\" height=\\\"10.01\\\" fill=\\\"#002395\\\"/><path d=\\\"M0 0L16 10L0 20\\\" fill=\\\"#000\\\"/><path d=\\\"M0 1.4L14.7 10L0 18.6\\\" fill=\\\"none\\\" stroke=\\\"#ffb612\\\" stroke-width=\\\"3\\\"/><path d=\\\"M0 0L16 10H38M0 20L16 10\\\" stroke=\\\"#fff\\\" stroke-width=\\\"7\\\" fill=\\\"none\\\"/><path d=\\\"M0 0L16 10H38M0 20L16 10\\\" stroke=\\\"#007a4d\\\" stroke-width=\\\"4.4\\\" fill=\\\"none\\\"/></svg>\",\"AE\":\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 38 20\\\" aria-hidden=\\\"true\\\" focusable=\\\"false\\\"><rect x=\\\"0\\\" y=\\\"0.0\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#00732f\\\"/><rect x=\\\"0\\\" y=\\\"6.667\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#fff\\\"/><rect x=\\\"0\\\" y=\\\"13.333\\\" width=\\\"38\\\" height=\\\"6.677\\\" fill=\\\"#000\\\"/><rect x=\\\"0\\\" y=\\\"0\\\" width=\\\"9.5\\\" height=\\\"20\\\" fill=\\\"#f00\\\"/></svg>\"};\nfunction regionFlag(code){return REGION_FLAGS[code]||\"🌐\";}\nfunction nodeRegion(n){var matches=REGIONS.filter(function(r){return r[4].test(n.name||'');});return matches.length===1?matches[0]:null;}\nfunction allCleanNodes(){return latestSubs.flatMap(cleanNodes);}\nfunction meter(value,total,color){return segmentMeter(total>0?value/total*100:0,color,'占比');}\n\nfunction metrics(target){\n var online=latestSubs.filter(s=>s.online===true).length,attention=latestSubs.filter(s=>!s.online||['warning','expired','exhausted'].includes(s.state)).length;\n var nodes=allCleanNodes(),tested=nodes.filter(n=>n.testable&&typeof n.online==='boolean'),up=tested.filter(n=>n.online).length;\n var quotas=latestSubs.filter(s=>s.quotaUpdatedAt&&s.quotaUpdatedAt===s.lastCheck&&Number.isFinite(s.remaining)&&Number.isFinite(s.total)&&s.total>0),remain=quotas.reduce((a,s)=>a+s.remaining,0),total=quotas.reduce((a,s)=>a+s.total,0);\n var rows=[['订阅数据可用',online+' / '+latestSubs.length,online,latestSubs.length,'linear-gradient(90deg,var(--blue),var(--purple))','直连响应 / 已接收快照'],['需关注订阅',String(attention),attention,latestSubs.length,'linear-gradient(90deg,var(--traffic-accent),var(--bad-bar))',attention?'有 '+attention+' 个订阅需要检查':'当前无订阅告警'],['TCP 可达节点',up+' / '+tested.length,up,tested.length,'linear-gradient(90deg,var(--purple),var(--pink))','未探测 '+(nodes.length-tested.length)+' · 仅统计展示节点'],['已知剩余流量',quotas.length?fmt(remain):'暂无额度',remain,total,'linear-gradient(90deg,var(--quota-green),var(--quota-lime))',quotas.length?'总量 '+fmt(total)+' · 剩余 '+Math.round(remain/total*100)+'% · '+quotas.length+' 个订阅':'暂无完整且最新的流量数据']];\n $(target).replaceChildren(...rows.map(function(r,i){var c=el('div','metric glass');c.append(el('small','',r[0]),el('strong','',r[1]));if(i===0&&latestSubs.length){var strip=el('div','status-strip');latestSubs.forEach(s=>{var bit=el('i');bit.style.background=s.online?'var(--success-bar)':'var(--bad-bar)';bit.title=s.name+' · '+(s.online?'可访问':'需检查');strip.append(bit);});c.append(strip);}else c.append(meter(r[2],r[3],r[4]));var note=el('span','',r[5]);note.title=r[5];c.append(note);return c;}));\n}\nfunction renderInsights(){\n var nodes=allCleanNodes(),counts={},protocols={},unknown=0;nodes.forEach(n=>{var r=nodeRegion(n);if(r)counts[r[0]]=(counts[r[0]]||0)+1;else unknown++;var p=(n.protocol||'未知').toUpperCase();protocols[p]=(protocols[p]||0)+1;});\n if(!$('view-nodes').hidden){$('regionList').replaceChildren(...Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([code,count])=>{var r=REGIONS.find(r=>r[0]===code),b=el('button','region-chip');b.type='button';b.append(flagIcon(code),regionLabel(code),el('span','country-count',count));b.title=regionName(code)+' · '+count+' 个节点';b.onclick=()=>{globeLon=r[2];globeLat=0;drawGlobe();};return b;}));if(unknown)$('regionList').append(countryUnknown(unknown));\n $('protocolList').replaceChildren(...Object.entries(protocols).sort((a,b)=>b[1]-a[1]).map(([name,count])=>{var row=el('div','protocol-row');row.append(el('b','',name),el('span','',count+' 个'),meter(count,nodes.length,'linear-gradient(90deg,var(--blue),var(--purple))'));return row;}));\n if(!nodes.length)$('protocolList').append(el('p','screen-note','暂无节点数据'));\n var hidden=latestSubs.reduce((a,s)=>a+(s.nodes||[]).filter(isNoticeNode).length,0);$('regionNote').textContent='根据名称 / 国旗推断地区，非 IP 定位；多地区名称归为未知。点阵地图为简化示意。已过滤 '+hidden+' 条公告。统计仅含已采集展示的节点，历史结果沿用最近一次记录。';\n globeCounts=counts;drawGlobe();}\n if(!$('view-control').hidden){\n var files=latestSubs.filter(s=>s.source==='file').length,pull=latestSubs.filter(s=>s.mode!=='push').length,push=latestSubs.length-pull-files;\n $('collectionInfo').replaceChildren(el('p','','直连订阅 '+pull+' 个 · 推送订阅 '+push+' 个 · 文件 '+files+' 个'),...latestSubs.map(s=>{var row=el('div','activity-row');row.append(el('b','',s.name),el('span','',s.source==='file'?'文件快照':s.mode==='push'?'本机推送':'Worker 直连'),el('small','',s.lastCheck?dt(s.lastCheck,true):'尚未采集'));return row;}));\n var issues=latestSubs.filter(s=>!s.online||['warning','expired','exhausted'].includes(s.state));$('issueInfo').replaceChildren(...issues.map(s=>{var row=el('div','activity-row');row.append(el('b','',s.name),el('span','',s.error||(STATE[s.state]||STATE.pending).t));return row;}));if(!issues.length)$('issueInfo').append(el('p','','当前无订阅告警'));} \n}\n// Coarse continent outlines, longitude/latitude; local rendering without third-party requests.\nvar LAND=[ [[-168,66],[-145,70],[-125,72],[-110,70],[-95,78],[-75,80],[-60,65],[-65,52],[-53,48],[-67,44],[-80,25],[-89,29],[-97,20],[-88,16],[-80,8],[-105,22],[-117,32],[-125,48],[-140,59],[-168,60]], [[-81,12],[-70,12],[-60,8],[-50,0],[-35,-6],[-40,-22],[-52,-34],[-67,-55],[-74,-45],[-75,-20],[-81,-3]], [[-52,60],[-43,60],[-20,75],[-35,83],[-58,82],[-65,70]], [[-10,36],[-10,44],[0,48],[8,55],[5,60],[20,71],[35,70],[40,62],[60,68],[90,75],[130,70],[170,65],[180,55],[155,50],[140,35],[125,40],[122,25],[110,20],[105,0],[98,10],[90,22],[80,8],[70,23],[57,25],[50,15],[40,12],[35,30],[25,35],[15,38],[10,44],[0,38]], [[-17,36],[5,37],[25,32],[34,30],[43,12],[51,11],[42,-2],[40,-15],[30,-30],[18,-35],[10,-20],[10,0],[-5,5],[-17,15]], [[113,-22],[122,-13],[136,-12],[142,-10],[153,-25],[146,-39],[131,-32],[115,-34]], [[47,-13],[50,-17],[47,-25],[44,-25]], [[130,31],[135,34],[140,40],[145,44],[142,35]], [[-9,50],[-5,59],[0,58],[1,52]], [[96,5],[105,-6],[115,-8],[120,-5],[112,1],[105,1]], [[166,-35],[176,-40],[170,-47],[166,-44]] ];\nvar globeLon=105,globeLat=0,globeCounts={};\nfunction projectPoint(lon,lat){var d=Math.PI/180,a=(lon-globeLon)*d,b=lat*d,t=globeLat*d;return [Math.cos(b)*Math.sin(a),Math.sin(b)*Math.cos(t)-Math.cos(b)*Math.cos(a)*Math.sin(t),Math.sin(b)*Math.sin(t)+Math.cos(b)*Math.cos(a)*Math.cos(t)];}\nvar globeSpinFrame=0,globeSpinActive=false,globeLastFrame=0,globeDragging=false;\nfunction globeSpinTick(time){if(!globeSpinActive){globeSpinFrame=0;return;}if(globeLastFrame&&!globeDragging&&document.visibilityState!==\"hidden\"){var elapsed=Math.min(80,time-globeLastFrame);globeLon=(globeLon+elapsed*.0016)%360;drawGlobe();}globeLastFrame=time;globeSpinFrame=requestAnimationFrame(globeSpinTick);}\nfunction setGlobeSpin(active){active=!!active&&canAnimate();if(active){if(globeSpinActive)return;globeSpinActive=true;globeLastFrame=0;globeSpinFrame=requestAnimationFrame(globeSpinTick);}else{globeSpinActive=false;if(globeSpinFrame)cancelAnimationFrame(globeSpinFrame);globeSpinFrame=0;globeLastFrame=0;}}\nfunction setupGlobe(){var c=$('regionGlobe'),drag=null;c.onpointerdown=e=>{drag=e.clientX;globeDragging=true;if(c.setPointerCapture)c.setPointerCapture(e.pointerId);};c.onpointermove=e=>{if(drag===null)return;globeLon-=(e.clientX-drag)*.45;drag=e.clientX;drawGlobe();};c.onpointerup=c.onpointercancel=()=>{drag=null;globeDragging=false;};c.onkeydown=e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();globeLon+=e.key==='ArrowLeft'?-15:15;drawGlobe();};$('globeLeft').onclick=()=>{globeLon-=20;drawGlobe();};$('globeRight').onclick=()=>{globeLon+=20;drawGlobe();};$('globeReset').onclick=()=>{globeLon=105;globeLat=0;drawGlobe();};setGlobeSpin(!$('view-nodes').hidden);}\nsetupGlobe();\n\nvar landDots=[];\nfunction inLand(lon,lat){return LAND.some(function(poly){var inside=false;for(var i=0,j=poly.length-1;i<poly.length;j=i++){var a=poly[i],b=poly[j];if(((a[1]>lat)!==(b[1]>lat))&&(lon<(b[0]-a[0])*(lat-a[1])/(b[1]-a[1])+a[0]))inside=!inside;}return inside;});}\nfor(var dotLat=-58;dotLat<83;dotLat+=1.9){var step=1.9/Math.max(.3,Math.cos(dotLat*Math.PI/180));for(var dotLon=-180;dotLon<180;dotLon+=step)if(inLand(dotLon,dotLat))landDots.push([dotLon,dotLat]);}\nfunction drawGlobe(){var canvas=$('regionGlobe');if(!canvas.getContext)return;var c=canvas.getContext('2d');if(!c)return;var cx=260,cy=195,r=152,dark=document.documentElement.dataset.theme==='dark';c.clearRect(0,0,520,390);\n var halo=c.createRadialGradient(cx,cy,r*.85,cx,cy,r+26);halo.addColorStop(0,dark?'rgba(130,150,200,.08)':'rgba(170,177,204,.13)');halo.addColorStop(1,'rgba(170,177,204,0)');c.fillStyle=halo;c.beginPath();c.arc(cx,cy,r+26,0,Math.PI*2);c.fill();\n var sphere=c.createRadialGradient(cx-55,cy-65,15,cx+25,cy+20,r+50);sphere.addColorStop(0,dark?'#28364e':'#ffffff');sphere.addColorStop(.7,dark?'#202c40':'#f4f4f9');sphere.addColorStop(1,dark?'#111c30':'#d8dbe8');c.beginPath();c.arc(cx,cy,r,0,Math.PI*2);c.fillStyle=sphere;c.fill();\n landDots.forEach(function(p){var q=projectPoint(p[0],p[1]);if(q[2]<0)return;c.beginPath();c.arc(cx+r*q[0],cy-r*q[1],.75+q[2]*.35,0,Math.PI*2);c.fillStyle=dark?'rgba(171,185,218,'+(.28+.55*q[2])+')':'rgba(145,151,179,'+(.2+.43*q[2])+')';c.fill();});\n REGIONS.forEach(function(a){if(!globeCounts[a[0]])return;var q=projectPoint(a[2],a[3]);if(q[2]<.04)return;var x=cx+r*q[0],y=cy-r*q[1],size=3+Math.min(3,Math.sqrt(globeCounts[a[0]])*.5);c.beginPath();c.arc(x,y,size+4,0,Math.PI*2);c.fillStyle='rgba(91,128,247,.15)';c.fill();c.beginPath();c.arc(x,y,size,0,Math.PI*2);c.fillStyle='#6685ed';c.fill();c.strokeStyle=dark?'#c5d2ff':'white';c.lineWidth=1.4;c.stroke();});\n c.beginPath();c.arc(cx,cy,r,0,Math.PI*2);c.strokeStyle=dark?'rgba(189,208,255,.22)':'rgba(255,255,255,.9)';c.lineWidth=1.5;c.stroke();}\n\nvar importTarget=null;\nfunction openFileImport(s){importTarget=s;s&&($('name').value=s.name);$('addForm').reset();if(s)$('name').value=s.name;setMode('file');$('fileSummary').textContent='请选择本地文件';$('addErr').textContent='';$('addDlg').showModal();}\n$('importFile').onchange=function(){var f=this.files[0];$('fileSummary').textContent=f?f.name+' · '+Math.ceil(f.size/1024)+' KB':'请选择本地文件';if(f&&!$('name').value)$('name').value=f.name.replace(/\\.(ya?ml|json|txt|conf)$/i,'').slice(0,80);};\n$('addForm').onsubmit=async function(e){e.preventDefault();var button=$('saveSubscription');button.disabled=true;$('addErr').textContent='';try{var name=$('name').value.trim();if(!name)throw Error('请填写名称');if(addMode==='file'){var f=$('importFile').files[0];if(!f)throw Error('请选择文件');if(f.size>1000000)throw Error('文件超过 1 MB');$('fileSummary').textContent='正在解析并探测节点…';var bytes=await f.arrayBuffer(),content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);var result=await request('/api/import'+(importTarget?'?id='+encodeURIComponent(importTarget.id):''),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name,content:content})});$('addDlg').close();await load();$('msg').textContent='已导入 '+result.nodes+' 个展示节点 · '+result.format+(result.hasUsage?'':' · 文件未提供流量 / 到期信息');}else{var body={name:name,mode:addMode};if(addMode==='pull')body.url=$('url').value.trim();var result=await request('/api/subs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});$('addDlg').close();await load();if(addMode==='push')openPush(result.sub.id);}}catch(e){$('addErr').textContent=e.message;$('fileSummary').textContent='导入未完成，可更换文件后重试';}finally{button.disabled=false;}};\n$('exportStatus').onclick=function(){var data={exportedAt:new Date().toISOString(),subscriptions:latestSubs},blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='subscription-status.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};\n\nvar quotaTarget=null;\nfunction openQuota(s){quotaTarget=s.id;$('quotaForm').reset();$('quotaTitle').textContent='校准流量 · '+s.name;$('quotaTotal').value=Number.isFinite(s.total)?String(s.total/1024**3):'';$('quotaRemaining').value=Number.isFinite(s.remaining)?String(s.remaining/1024**3):'';$('quotaUnit').value='GB';$('quotaNoExpiry').checked=s.noExpiry===true;$('quotaErr').textContent='';$('detailDlg').close();$('quotaDlg').showModal();}\n$('quotaCancel').onclick=function(){$('quotaDlg').close();};\n$('quotaForm').onsubmit=async function(e){e.preventDefault();var b=$('quotaSave');b.disabled=true;$('quotaErr').textContent='';try{if(!$('quotaTotal').value.trim()||!$('quotaRemaining').value.trim())throw Error('请填写总量和剩余流量');var multiplier=$('quotaUnit').value==='TB'?1024**4:1024**3,total=Math.round(Number($('quotaTotal').value)*multiplier),remaining=Math.round(Number($('quotaRemaining').value)*multiplier);if(!Number.isSafeInteger(total)||total<=0||!Number.isSafeInteger(remaining)||remaining<0||remaining>total)throw Error('剩余流量须在零与总量之间');await request('/api/quota?id='+encodeURIComponent(quotaTarget),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({total:total,remaining:remaining,noExpiry:$('quotaNoExpiry').checked})});$('quotaDlg').close();await load();$('msg').textContent='已保存手动流量快照；后续请同步服务商面板数值。';}catch(error){$('quotaErr').textContent=error.message;}finally{b.disabled=false;}};\n// Embedded by default. Only the operating system's reduced-motion setting is respected.\ntry{localStorage.removeItem('monitor-motion');}catch(_){}applyMotionPreference();\n// Only selected controls deform; no ambient cursor blob.\ndocument.documentElement.dataset.display=displayMode;displayLabel();applyThemePreference(themePreference,false);setupLiquidInteractions();\n\nload();\nsetInterval(function () { if (token && ![\"login\",\"addDlg\",\"pushDlg\",\"quotaDlg\"].some(function(id){return $(id).open;})) load(); }, 60000);\n\n\n// Interface-only controls; subscription requests and polling remain unchanged.\nfunction countryUnknown(count){\n var chip=el('span','country-chip country-unknown'),label=el('span','country-name');\n label.append(el('b','','未识别地区'),el('span','country-en','Unknown / Multiple regions'));\n var icon=el('span','region-flag');\n icon.setAttribute('aria-hidden','true');\n icon.innerHTML='<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><ellipse cx=\"12\" cy=\"12\" rx=\"4\" ry=\"9\"/><path d=\"M3 12h18M5 6h14M5 18h14\"/></svg>';\n chip.append(icon,label,el('small','',count));\n return chip;\n}\nvar bottomTabs=Array.from(document.querySelectorAll('.bottom-dock [data-view]'));\nbottomTabs.forEach(function(button,index){\n var previous=button.onclick;\n button.tabIndex=button.getAttribute('aria-selected')==='true'?0:-1;\n button.onclick=function(event){\n  if(widgetBusy)return;\n  if(previous)previous.call(button,event);\n  if(button.getAttribute('aria-selected')!=='true')return;\n  bottomTabs.forEach(function(tab){tab.tabIndex=tab===button?0:-1;});\n  window.scrollTo({top:0,behavior:'auto'});\n };\n button.onkeydown=function(event){\n  var next=index;\n  if(event.key==='ArrowRight')next=(index+1)%bottomTabs.length;\n  else if(event.key==='ArrowLeft')next=(index+bottomTabs.length-1)%bottomTabs.length;\n  else if(event.key==='Home')next=0;\n  else if(event.key==='End')next=bottomTabs.length-1;\n  else return;\n  event.preventDefault();bottomTabs[next].focus();bottomTabs[next].click();\n };\n});\nif(window.visualViewport){\n function keyboardState(){\n  var input=document.activeElement,editing=input&&/^(INPUT|TEXTAREA|SELECT)$/.test(input.tagName);\n  document.documentElement.dataset.keyboard=String(Boolean(editing&&window.innerHeight-window.visualViewport.height>160));\n }\n window.visualViewport.addEventListener('resize',keyboardState);\n document.addEventListener('focusin',keyboardState);\n document.addEventListener('focusout',function(){requestAnimationFrame(keyboardState);});\n}\n\n// Inline header folding only; existing theme and layout handlers are retained.\nvar headerToolsCollapsed=false;\ntry{headerToolsCollapsed=localStorage.getItem('monitor-header-tools-collapsed')==='1';}catch(_){}\nfunction setHeaderToolsCollapsed(collapsed,save){\n var tools=$('headerTools'),button=$('headerToolsToggle');\n if(collapsed&&tools.contains(document.activeElement))button.focus();\n headerToolsCollapsed=Boolean(collapsed);\n tools.inert=headerToolsCollapsed;\n tools.setAttribute('aria-hidden',String(headerToolsCollapsed));\n tools.parentElement.dataset.collapsed=String(headerToolsCollapsed);\n button.setAttribute('aria-expanded',String(!headerToolsCollapsed));\n button.title=headerToolsCollapsed?'展开主题与布局按钮':'收起主题与布局按钮';\n button.setAttribute('aria-label',button.title);\n if(save)try{localStorage.setItem('monitor-header-tools-collapsed',headerToolsCollapsed?'1':'0');}catch(_){}\n if(!headerToolsCollapsed)requestAnimationFrame(function(){syncLiquidGroups(false);});\n}\n$('headerToolsToggle').onclick=function(){setHeaderToolsCollapsed(!headerToolsCollapsed,true);};\nsetHeaderToolsCollapsed(headerToolsCollapsed,false);\n</script>\n</body>\n</html>\n";}
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
