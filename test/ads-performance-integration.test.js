const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/services/ads-performance-core');
function service(overrides={}) {
  const module={exports:{}};
  const fakeRequire = name => ({'../db/supabase':{supabase:{}},'./mercadolivre':{getMercadoLivreAccount:async()=>({account_id:'1'})},'./mercado-ads':{syncAdsDaily:overrides.sync || (async()=>({records_saved:270}))},'./ads-performance-core':core})[name];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/services/ads-performance.js'),'utf8'),{module,require:fakeRequire,process:{env:{}},Date,console,setTimeout,setInterval,Promise});
  return module.exports;
}
test('pagination reads past 1000 records and propagates database errors',async()=>{
  const {paged}=service();const calls=[];
  const rows=await paged(()=>({range:async(a,b)=>{calls.push([a,b]);return {data:Array.from({length:a<1000?500:63},(_,i)=>a+i)}}}));
  assert.equal(rows.length,1063);assert.deepEqual(calls,[[0,499],[500,999],[1000,1499]]);
  await assert.rejects(()=>paged(()=>({range:async()=>({error:{message:'read failed'}})})),/read failed/);
});
test('automatic refresh uses one in-flight sync and retries after a failure',async()=>{
  let finish,calls=0;
  const {refreshAdsPerformance}=service({sync:()=>{calls++;return new Promise(resolve=>finish=resolve)}});
  const first=refreshAdsPerformance(),second=refreshAdsPerformance();assert.equal(calls,1);
  finish({records_saved:270});await Promise.all([first,second]);
  let tries=0;const failed=service({sync:async()=>++tries===1?{records_saved:0}:{records_saved:270}});
  await assert.rejects(()=>failed.refreshAdsPerformance(),/zero registros/);
  assert.equal((await failed.refreshAdsPerformance()).records_saved,270);
});
test('dashboard renders weekly table and alerts with weekly values and partial-period labels',async()=>{
  const fixture = {orders:[{date_created:'2026-10-04T15:00:00Z',status:'paid',total_amount:118467.21}],ads:Array.from({length:37},(_,i)=>({date:core.shift('2026-08-29',i),campaign_id:'a',spend:10,attributed_revenue:450,clicks:100,attributed_units:2,updated_at:'2026-10-05T14:24:34Z',roas_target:35}))};
  const data={success:true,...core.buildPerformance({...fixture,dateFrom:'2026-08-07',dateTo:'2026-10-05',now:'2026-10-05T14:24:34Z'}),sync:{interval_minutes:60,last_success:null,last_error:null}};
  const elements=[];const nodes={days:{value:'60',addEventListener(){}}};
  const make=()=>({innerHTML:'',children:[],setAttribute(){}});
  const document={createElement(){const el=make();elements.push(el);return el},querySelector(){return {before(){}}},head:{append(){}},getElementById(id){return nodes[id]},addEventListener(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/public/ads-performance-ui.js'),'utf8'),{document,window:{addEventListener(){}},Intl,Date,console,setInterval(){},fetch:async()=>({ok:true,json:async()=>data})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(elements[0].innerHTML,/Segunda a domingo/);assert.match(elements[0].innerHTML,/28\/09–04\/10/);assert.match(elements[0].innerHTML,/118\.467,21/);assert.match(elements[0].innerHTML,/Semáforo/);assert.match(elements[0].innerHTML,/Parcial \/ em andamento/);
});
