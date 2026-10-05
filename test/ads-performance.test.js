const { test } = require('node:test');
const assert = require('node:assert/strict');
const { localDate, monday, shift, buildPerformance, metrics } = require('../src/services/ads-performance-core');
const now = '2026-10-05T14:24:34Z';
const base = { dateFrom:'2026-08-07', dateTo:'2026-10-05', now };
function adsWeek() {
  return Array.from({length:37}, (_, i) => ({ date:shift('2026-08-29',i),account_id:'1',advertiser_id:'1',campaign_id:'a',campaign_name:'A',roas_target:35,spend:10,attributed_revenue:450,attributed_units:2,clicks:100,impressions:10000,updated_at:now }));
}
test('Brasília timezone and Monday-Sunday boundaries include Sunday late at night', () => {
  assert.equal(localDate('2026-10-05T02:59:59Z'),'2026-10-04');
  assert.equal(localDate('2026-10-05T03:00:00Z'),'2026-10-05');
  assert.equal(monday('2026-10-04'),'2026-09-28');
  const r=buildPerformance({...base,orders:[{date_created:'2026-10-05T02:59:59Z',total_amount:50,status:'paid'}],ads:adsWeek()});
  assert.equal(r.weekly.at(-2).orders,1); assert.equal(r.weekly.at(-1).orders,0);
  assert.equal(r.weekly.at(-1).week_start,'2026-10-05');assert.equal(r.weekly.at(-1).week_end,'2026-10-11');assert.equal(r.weekly.at(-2).partial,false);assert.equal(r.weekly.at(-1).partial,true);
});
test('cancelled excluded and ratios use sums, not daily averages', () => {
  const orders=[{date_created:now,total_amount:200,status:'cancelled'},{date_created:now,total_amount:1000,status:'paid'}];
  const r=buildPerformance({...base,orders,ads:[{date:'2026-10-04',campaign_id:'a',spend:1,attributed_revenue:100},{date:'2026-10-05',campaign_id:'a',spend:9,attributed_revenue:90}]});
  assert.equal(r.totals.orders,1);assert.equal(r.totals.revenue,1000);assert.equal(r.totals.roas,19);assert.equal(r.totals.tacos,1);
});
test('undefined rates remain null; never a false green from no clicks', () => {
  assert.equal(metrics({orders:0,revenue:0,spend:0,clicks:0,impressions:0,attributed_revenue:0,attributed_units:0,organic_promoted_revenue:0}).cvr,null);
  const r=buildPerformance({...base});assert.notEqual(r.status,'good');assert.equal(r.alerts.find(a=>a.metric==='CVR').status,'unknown');
});
test('healthy week, conversion crash and ROAS target checks', () => {
  const ads=adsWeek();const r=buildPerformance({...base,ads});
  assert.equal(r.alerts.find(a=>a.metric==='CVR').status,'good');assert.equal(r.alerts.find(a=>a.metric==='ROAS').status,'good');
  for(const a of ads) if(a.date>='2026-09-28') {a.attributed_units=.5;a.attributed_revenue=200;}
  const bad=buildPerformance({...base,ads});assert.equal(bad.status,'bad');assert.equal(bad.alerts.find(a=>a.metric==='CVR').status,'bad');
});
test('stale history, missing campaign days, low sample prevent green', () => {
  const stale=adsWeek().map(a=>({...a,updated_at:'2026-10-04T00:00:00Z'}));
  assert.notEqual(buildPerformance({...base,ads:stale}).status,'good');
  const ads=adsWeek();ads.push({...ads[0],campaign_id:'b'});
  const r=buildPerformance({...base,ads});assert.equal(r.recent.ads_complete,false);assert.ok(r.recent.missing_campaign_days>0);
  const low=adsWeek().map(a=>({...a,clicks:1}));assert.equal(buildPerformance({...base,ads:low}).alerts.find(a=>a.metric==='CVR').status,'unknown');
});
test('duplicate rows do not inflate portfolio or campaign metrics', () => {
  const ads=adsWeek();const r=buildPerformance({...base,ads:[...ads,...ads]});
  assert.equal(r.recent.spend,70);assert.equal(r.campaigns[0].spend,70);
});
test('partial weeks never get week-over-week comparison', () => {
  const r=buildPerformance({...base});assert.equal(r.weekly[0].revenue_change,null);assert.equal(r.weekly.at(-1).revenue_change,null);
});
