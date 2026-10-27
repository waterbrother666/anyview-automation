import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';

const core = fs.readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8').replaceAll('export ', '');
const browserTemplate = fs.readFileSync(new URL('../src/browser.js', import.meta.url), 'utf8');
function harness(origin = 'https://anyview.gdut.edu.cn', successCode = 200, chapters = [1,2,3,4,5]) {
  const pname = chapters.includes(1) ? 'DC01PE21' : 'DC06PE01';
  const eid = chapters.includes(1) ? 21 : 61;
  const browser=browserTemplate.replace('__CHAPTERS__',JSON.stringify(chapters))
    .replace('__BANK__',JSON.stringify({[pname]:'#include "example.h"\nint example(void){return 1;}'}));
  const controls = new Map(); const calls = []; const data = new Map(); let passed = false;
  const element = () => ({ textContent:'', disabled:false, value:'', open:false,
    setAttribute(){}, append(){}, click(){}, show(){this.open=true;}, close(){this.open=false;},
    replaceChildren(...options){this.options=options;this.value=options[0]?.value || '';},
    querySelector(selector){if(!controls.has(selector))controls.set(selector,element());return controls.get(selector);} });
  class XHR { open() {} setRequestHeader() {} }
  const localStorage = {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
  const fakeFetch = async (path, options = {}) => {
    calls.push({path,options}); let result;
    if (path === '/api/scheme-service/scheme/list/student') result = [{id:1,classId:2,name:'test course',questionType:1}];
    else if (path.startsWith('/api/scheme-service/catalog/list?')) result = [{pname,eid,pass:passed}];
    else if (path.endsWith('/'+eid)) result={questionFullName:`第${chapters.includes(1)?1:6}章-${pname}`,kind:0,language:1};
    else if (path.endsWith('/compile')) result={result:'编译成功'};
    else if (path.endsWith('/runGroup')) {passed=true;result={passed:true,output:'OK'};}
    else throw Error('Unexpected request: '+path);
    return {ok:true,status:200,json:async()=>({code:successCode,data:result})};
  };
  const context = {location:{origin,href:origin+'/student/exercises/problems',pathname:'/student/exercises/problems'},
    crypto:webcrypto, document:{createElement:()=>element(),body:{append(){}}},
    XMLHttpRequest:XHR, fetch:fakeFetch, Headers, Request, URL, FormData, Blob,
    TextEncoder, AbortSignal, btoa, structuredClone, setTimeout, clearTimeout,setInterval,clearInterval,
    navigator:{locks:{request:async(name,opts,fn)=>fn({name})}},localStorage,
    addEventListener(){}, console};
  context.window=context;
  vm.runInNewContext('(()=>{'+core+'\n'+browser+'})()', context);
  return { context, controls, calls, data, connect(url='/api/catalog',token='test-session-only') {
    const xhr=new context.XMLHttpRequest();xhr.open('GET',url);xhr.setRequestHeader('token',token);
  }};
}
test('browser bundle refuses a different site before touching requests',()=>{
  assert.throws(()=>harness('https://unrelated.invalid'),/官方学生页面/);
});
test('foreign authentication header is ignored and cannot authorize a course read',async()=>{
  const h=harness();h.connect('https://foreign.invalid/api/info');
  await h.controls.get('[data-load]').onclick();
  assert.equal(h.calls.length,0);
});
test('browser transport completes one question and keeps credentials out of storage/report',async()=>{
  const h=harness();h.connect(); await h.controls.get('[data-load]').onclick();
  assert.match(h.controls.get('[data-plan]').textContent,/待做 1/);
  await h.controls.get('[data-one]').onclick();
  const report=h.context.AnyViewAutomation.report();
  assert.equal(report.state,'completed');assert.equal(report.records[0].catalogPass,true);
  const judge=h.calls.find(x=>x.path.endsWith('/runGroup'));
  assert.equal(judge.options.body.get('eID'),'21');
  assert.equal(judge.options.body.get('kind'),'0');
  assert.equal(judge.options.body.get('language'),'1');
  assert.equal(Buffer.from(judge.options.body.get('stuCode'),'base64').toString(),'#include "example.h"\nint example(void){return 1;}');
  assert.ok(!JSON.stringify([...h.data]).includes('test-session-only'));
  assert.ok(!JSON.stringify(report).includes('test-session-only'));
  assert.ok(h.calls.every(x=>x.path.startsWith('/api/')));
});
test('a second browser start skips a server-passed question',async()=>{
  const h=harness();h.connect();await h.controls.get('[data-load]').onclick();
  await h.controls.get('[data-one]').onclick();await h.controls.get('[data-one]').onclick();
  assert.equal(h.calls.filter(x=>x.path.endsWith('/runGroup')).length,1);
});
for (const code of [0,31,41,70,200]) test(`frontend-supported response code ${code} is accepted with valid data`,async()=>{
  const h=harness('https://anyview.gdut.edu.cn',code);h.connect();await h.controls.get('[data-load]').onclick();
  await h.controls.get('[data-one]').onclick();
  assert.equal(h.context.AnyViewAutomation.report().state,'completed');
});
test('an unexpected server code is shown without revealing credentials',async()=>{
  const h=harness('https://anyview.gdut.edu.cn',403);h.connect();await h.controls.get('[data-load]').onclick();
  assert.match(h.controls.get('[data-message]').textContent,/状态码 403/);
  assert.ok(!h.controls.get('[data-message]').textContent.includes('test-session-only'));
  assert.ok(!h.calls.some(x=>x.path.endsWith('/runGroup')));
});
test('the browser entry keeps a chapter 6–8 build in its selected scope',async()=>{
  const h=harness('https://anyview.gdut.edu.cn',31,[6,7,8]);h.connect();await h.controls.get('[data-load]').onclick();
  assert.match(h.controls.get('h3').textContent,/第6、7、8章/);
  assert.equal(h.controls.get('[data-one]').textContent,'先验证 DC06PE01');
  await h.controls.get('[data-one]').onclick();
  const report=h.context.AnyViewAutomation.report();assert.equal(report.state,'completed');
  assert.equal(report.records[0].pname,'DC06PE01');
  assert.equal(h.calls.find(x=>x.path.endsWith('/runGroup')).options.body.get('eID'),'61');
});
