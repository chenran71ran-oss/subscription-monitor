const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(__dirname+'/../worker.js','utf8');
function context(code){
 const c=vm.createContext({TextDecoder,TextEncoder,URL,Headers,Request,Response,AbortController,setTimeout,clearTimeout,atob,btoa,console,connect(){throw Error('No real sockets permitted in offline tests');}});
 vm.runInContext(code.slice(0,code.indexOf('function page(){return ')).replace("import { connect } from 'cloudflare:sockets';",''),c);return c;
}
const c=context(source),GB=1024**3,now=Date.now(),tests=[];
const b64=t=>Buffer.from(t).toString('base64');
function test(name,fn){fn();tests.push({name,passed:true});}
function quota(text){return c.bodyUserInfo(text);}
function apply(info){const record={history:[]};c.applyQuota(record,info,now);return record;}
const yaml=name=>`proxies:\n  - name: "${name}"\n    type: trojan\n    server: example.invalid\n    port: 443\n    password: synthetic-test-only\n`;
const link=name=>'trojan://synthetic@example.invalid:443#'+encodeURIComponent(name);
test('Standard headers unchanged',()=>{const r=apply(c.parseUserInfo(`upload=${GB}; download=${2*GB}; total=${10*GB}`));assert.equal(r.remaining,7*GB);});
test('QX header with omitted upload',()=>{const h=`download=${3*GB}, total=${10*GB}`;assert.equal(apply(c.parseUserInfo(h)).remaining,7*GB);});
test('Explicit upload is respected',()=>assert.equal(apply(c.parseUserInfo(`upload=${2*GB}; download=${3*GB}; total=${10*GB}`)).remaining,5*GB));
test('Zero download is a real counter',()=>assert.equal(apply(c.parseUserInfo(`download=0; total=${10*GB}`)).remaining,10*GB));
test('Malformed upload is not silently changed into zero',()=>assert.equal(apply(c.parseUserInfo(`upload=bad; download=${3*GB}; total=${10*GB}`)).used,null));
test('Total-only header does not invent usage',()=>assert.equal(apply(c.parseUserInfo(`total=${10*GB}`)).used,null));
test('Remaining-only Chinese YAML remark',()=>{const r=apply(quota(yaml('📢 剩余流量：6.7 TB')));assert.equal(r.remaining,Math.round(6.7*1024**4));assert.equal(r.total,null);assert.equal(r.used,null);});
test('Traditional Chinese quota',()=>assert.equal(apply(quota(yaml('剩餘流量：512 GB'))).remaining,512*GB));
test('Remaining below node link encoding',()=>assert.equal(apply(quota(link('剩余流量：6.70 TB'))).remaining,Math.round(6.7*1024**4)));
test('Base64 links',()=>assert.equal(apply(quota(b64(link('剩余流量：128 GB')))).remaining,128*GB));
test('Base64 YAML',()=>assert.equal(apply(quota(b64(yaml('剩余流量：128 GB')))).remaining,128*GB));
test('Base64 JSON QX bytes',()=>assert.equal(apply(quota(b64(JSON.stringify({info:{bytes_used:2*GB,bytes_remaining:8*GB}})))).total,10*GB));
test('Base64 QX configuration remark',()=>assert.equal(apply(quota(b64('trojan=example.invalid:443, password=synthetic, tag=剩余流量：128 GB'))).remaining,128*GB));
test('QX info object',()=>{const r=apply(quota(JSON.stringify({info:{bytes_used:2*GB,bytes_remaining:8*GB,expire_date:0}})));assert.equal(r.total,10*GB);assert.equal(r.remaining,8*GB);assert.equal(r.noExpiry,true);});
test('Root QX info object',()=>assert.equal(apply(quota(JSON.stringify({bytes_used:2*GB,bytes_remaining:8*GB}))).remaining,8*GB));
test('QX remaining-only info',()=>{const r=apply(quota(JSON.stringify({info:{bytes_remaining:7*GB}})));assert.equal(r.remaining,7*GB);assert.equal(r.total,null);});
test('Existing subscriptionInfo JSON',()=>assert.equal(apply(quota(JSON.stringify({subscriptionInfo:{total:10*GB,used:2*GB}}))).remaining,8*GB));
test('Shadowrocket STATUS arithmetic with zero upload',()=>{const r=apply(quota('STATUS=🚀↑:0GB,↓:15.1GB,TOT:200GB💡Expires:2026-08-02'));assert.equal(r.used,Math.round(15.1*GB));assert.equal(r.remaining,200*GB-Math.round(15.1*GB));assert.equal(r.expire,Date.UTC(2026,7,1,16));});
test('Shadowrocket STATUS lowercase',()=>assert.equal(apply(quota('status=🚀↑:0.83gb,↓:17.73gb,tot:200gb💡expires:2026-08-02')).remaining,200*GB-Math.round(.83*GB)-Math.round(17.73*GB)));
test('Shadowrocket no expiry does not invent a future date',()=>assert.equal(apply(quota('STATUS=↑:0GB,↓:1GB,TOT:10GB')).expire,null));
test('Incomplete STATUS does not fabricate usage',()=>assert.equal(quota('STATUS=TOT:200GB💡Expires:2026-08-02'),null));
test('Invalid calendar date rejected',()=>assert.equal(apply(quota('STATUS=↑:0GB,↓:1GB,TOT:10GB💡Expires:2026-02-30')).expire,null));
test('Mixed header priority',()=>assert.equal(apply(c.mergeUserInfo(c.parseUserInfo(`upload=0; download=${GB}; total=${10*GB}`),quota(yaml('剩余流量：6.7 TB')))).remaining,9*GB));
test('Exhausted quota clamps remaining to zero',()=>assert.equal(apply(quota('STATUS=↑:1GB,↓:10GB,TOT:10GB')).remaining,0));
test('Currency is not traffic',()=>assert.equal(quota(yaml('余额 100 元')),null));
test('Node count is not traffic',()=>assert.equal(quota(yaml('剩余节点 128')),null));
test('No metadata means unknown, not zero',()=>assert.equal(quota(yaml('US 美国节点')),null));
test('Explicit unlimited term retained',()=>assert.equal(quota(yaml('长期有效')).noExpiry,true));
test('Unsafe integer not accepted',()=>assert.equal(quota(JSON.stringify({info:{bytes_remaining:'99999999999999999999999'}})),null));
test('STATUS metadata node excluded',()=>assert.equal(c.isMetadataNode({name:'STATUS=↑:0GB,↓:1GB,TOT:10GB'}),true));
test('No static #flow fake quota injected',()=>assert.equal(quota(yaml('US 节点 #flow=2046-01-01:1000:0')),null));
test('Original expiry response headers',()=>assert.equal(c.parseUserInfo('expire=0').noExpiry,true));
test('Headers-only body comment',()=>assert.equal(apply(quota(`# subscription-userinfo: download=${2*GB};total=${10*GB}\n${yaml('US')}`)).remaining,8*GB));
test('Previous snapshot retained without quota',()=>{const r={remaining:7*GB,total:10*GB,used:3*GB,quotaUpdatedAt:123,history:[]};c.applyQuota(r,quota(yaml('US')),now);assert.equal(r.remaining,7*GB);assert.equal(r.quotaUpdatedAt,123);});

async function integration(name,respond,previous={},options={}){
 const calls=[],store=new Map([['data:fixture',JSON.stringify(previous)]]);
 c.fetch=async(url,opts)=>{calls.push(opts.headers['User-Agent']);return respond(opts.headers['User-Agent']);};
 const env={SUB_KV:{get:async k=>store.get(k)||null,put:async(k,v)=>store.set(k,v)}};
 const sub={id:'fixture',name:'测试订阅',mode:'pull',url:'https://example.com/synthetic-subscription'};
 const result=await c.checkOne(env,sub,null,{deferProbes:true,...options});
 tests.push({name,passed:true});return {result,calls,saved:JSON.parse(store.get('data:fixture'))};
}
(async()=>{
 const a=await integration('checkOne QX STATUS',()=>new Response('STATUS=↑:0GB,↓:1GB,TOT:10GB\n'+link('US'),{status:200}));
 assert.equal(a.result.remaining,9*GB,JSON.stringify({calls:a.calls,saved:a.saved}));assert.equal(a.calls.length,1);assert(a.saved.nodes.length>0);
 const b=await integration('checkOne total-only header tries bounded QX metadata',ua=>ua.startsWith('Quantumult')?new Response(yaml('US'),{headers:{'subscription-userinfo':`download=${2*GB}; total=${10*GB}`}}):new Response(yaml('US'),{headers:{'subscription-userinfo':`total=${10*GB}`}}));
 assert.equal(b.result.remaining,8*GB);assert.equal(b.calls.length,2);assert(b.calls[1].startsWith('Quantumult'));
 const d=await integration('QX metadata failure keeps original valid nodes',ua=>new Response(yaml('US'),{status:ua.startsWith('Quantumult')?503:200}));
 assert.equal(d.result.online,true);assert.equal(d.calls.length,2);assert.equal(d.result.remaining,null);assert(d.saved.nodes.length>0);
 const e=await integration('Quota retry cooldown preserved',()=>new Response(yaml('US')),{quotaProbeAt:now,history:[]});assert.equal(e.calls.length,1);
 const f=await integration('No request on 429 retry loop',()=>new Response('limited',{status:429}));assert.equal(f.calls.length,1);assert.equal(f.result.online,false);
 const g=await integration('Missing quota preserves previous traffic',()=>new Response(yaml('US')),{remaining:7*GB,total:10*GB,used:3*GB,quotaUpdatedAt:123,history:[],quotaProbeAt:now});assert.equal(g.result.remaining,7*GB);assert.equal(g.saved.quotaUpdatedAt,123);

 console.log(`Passed ${tests.length} offline quota and fetch-pipeline checks. No live account queried.`);
})().catch(e=>{console.error(e);process.exit(1)});
