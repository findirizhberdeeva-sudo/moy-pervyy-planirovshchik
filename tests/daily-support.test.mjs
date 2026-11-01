import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,rpc,asUser,ids} from './helpers/database.mjs';
import {installClock,clock} from './helpers/step3.mjs';
let db,team;
before(async()=>{db=await createDatabase();await installClock(db);});after(async()=>db.close());
beforeEach(async()=>{team=await seedDatabase(db);await db.exec("update public.team_members set joined_at='2026-10-01T09:00:00+03:00'");await clock(db);});
const progress=async(user='employee1')=>{const r=await rpc(db,ids[user],'get_weekly_progress',[team]);assert.equal(r.ok,true,JSON.stringify(r));return r.data;};
const mutate=(user,action,t,payload={})=>rpc(db,ids[user],'mutate_task',[team,action,t?.id??null,payload,t?.version??null,randomUUID()]);
async function task(){const r=await mutate('manager','create',null,{title:'Проверка поддержки',assignee_id:ids.employee1});assert.equal(r.ok,true,JSON.stringify(r));return r.data.entity;}

test('weekly graph gives seven Moscow days, only self to employee and all active members to manager',async()=>{
 await task();const e=await progress();assert.equal(e.week_start,'2026-11-02');assert.equal(e.week_end,'2026-11-08');assert.equal(e.members.length,1);assert.equal(e.members[0].user_id,ids.employee1);assert.equal(e.members[0].days.length,7);assert.equal(e.members[0].days[0].planned_count,1);assert.equal(e.members[0].days[0].plan_done_count,0);assert.equal(e.members[0].days[6].is_weekend,true);assert.equal((await progress('manager')).members.length,3);
});
test('17:44:59 and 17:45:00 select different workdays; Friday, weekend and month boundary are correct',async()=>{
 await clock(db,'2026-11-02T17:44:59+03:00');assert.equal((await progress()).support_day,'2026-10-30');await clock(db,'2026-11-02T17:45:00+03:00');assert.equal((await progress()).support_day,'2026-11-02');
 for(const [at,expected] of [['2026-10-31T20:00:00+03:00','2026-10-30'],['2026-11-01T20:00:00+03:00','2026-10-30'],['2026-11-06T17:45:00+03:00','2026-11-06'],['2026-11-09T09:00:00+03:00','2026-11-06']]){const r=await db.query('select private.support_day($1::timestamptz)::text as d',[at]);assert.equal(r.rows[0].d,expected);}
});
test('support categories use exact counts including one of one and rounding near 100 percent',async()=>{
 for(const [planned,done,category] of [[0,0,'empty'],[1,0,'encouragement'],[3,1,'encouragement'],[2,1,'progress'],[4,3,'progress'],[1,1,'complete'],[10000,9999,'progress']]){const r=(await db.query('select private.support_payload($1,$2,$3,$4,$5) as p',['2026-11-02',ids.employee1,'Имя',planned,done])).rows[0].p;assert.equal(r.category,category);if(!planned)assert.equal(r.message,'Сегодня не было запланированных задач. Не забывай ставить себе даже небольшие задачи - из маленьких дел складывается большой успех!');}
});
test('manager sees an independent employee message; employee cannot read or claim another recipient message',async()=>{
 await clock(db,'2026-11-02T18:00:00+03:00');const e=await progress(),m=await progress('manager');assert.deepEqual(m.members.find(x=>x.user_id===ids.employee1).support,e.own_support.payload);
 const n=(await db.query("select id from public.notifications where recipient_id=$1 and payload->>'subject_id'=$2",[ids.manager,ids.employee1])).rows[0];const denied=await rpc(db,ids.employee1,'claim_daily_support',[team,n.id]);assert.equal(denied.error.code,'ACCESS_DENIED');
 const direct=await asUser(db,ids.employee1,'select recipient_id from public.notifications');assert.ok(direct.rows.every(r=>r.recipient_id===ids.employee1));
 const one=await rpc(db,ids.employee1,'claim_daily_support',[team,e.own_support.id]);assert.equal(one.data.claimed,true);assert.equal((await progress('manager')).members.find(x=>x.user_id===ids.employee1).support.category,'empty');assert.equal((await db.query('select read_at from public.notifications where id=$1',[n.id])).rows[0].read_at,null);
});
test('claim persists across calls and late completion changes text without resetting read state or duplicating notifications',async()=>{
 let t=await task();await clock(db,'2026-11-02T17:45:00+03:00');let p=await progress();const id=p.own_support.id;assert.equal(p.own_support.payload.category,'encouragement');const claimed=await rpc(db,ids.employee1,'claim_daily_support',[team,id]);assert.equal(claimed.data.claimed,true);assert.equal((await rpc(db,ids.employee1,'claim_daily_support',[team,id])).data.claimed,false);
 const count=(await db.query("select count(*)::int n from public.notifications where type='daily_support'")).rows[0].n;await clock(db,'2026-11-02T19:00:00+03:00');assert.equal((await mutate('employee1','status',t,{status:'done'})).ok,true);p=await progress();assert.equal(p.own_support.id,id);assert.equal(p.own_support.payload.category,'complete');assert.equal(p.own_support.read_at,claimed.data.notification.read_at);assert.equal((await rpc(db,ids.employee1,'claim_daily_support',[team,id])).data.claimed,false);assert.equal((await db.query("select count(*)::int n from public.notifications where type='daily_support'")).rows[0].n,count);
});
test('missed workdays return only latest eligible support and never give a new member a day before joining',async()=>{
 await clock(db,'2026-11-09T09:00:00+03:00');const p=await progress();assert.equal(p.own_support.payload.date,'2026-11-06');await db.query("update public.team_members set joined_at='2026-11-09T08:00:00+03:00' where user_id=$1",[ids.employee1]);await db.query('delete from public.notifications where recipient_id=$1',[ids.employee1]);assert.equal((await progress()).own_support,null);
});
test('chart metrics remain identical to reports after moves, cancellation and soft deletion',async()=>{
 let t=await task();const u=await task();t=(await mutate('employee1','move',t,{plan_start:'2026-11-03'})).data.entity;assert.equal((await mutate('manager','status',u,{status:'cancelled',reason:'Проверка'})).ok,true);assert.equal((await mutate('manager','delete',t)).ok,true);const p=await progress();
 for(const [index,day] of p.members[0].days.entries()){await clock(db,`2026-11-02T09:${String(Math.floor(index*20/60)).padStart(2,'0')}:${String(index*20%60).padStart(2,'0')}+03:00`);const r=await rpc(db,ids.employee1,'get_report',[team,'day',day.date,ids.employee1,'all']);assert.equal(r.ok,true,JSON.stringify(r));for(const key of ['planned_count','plan_done_count','progress_percent'])assert.equal(day[key],r.data.metrics[key],day.date+' '+key);}
});
test('disabled and outsider cannot read support or execute private functions; stable refresh does not bump workspace',async()=>{
 await clock(db,'2026-11-02T18:00:00+03:00');await progress();const v=(await db.query('select state_version from public.teams where id=$1',[team])).rows[0].state_version;await progress();assert.equal((await db.query('select state_version from public.teams where id=$1',[team])).rows[0].state_version,v);
 assert.equal((await rpc(db,ids.outsider,'get_weekly_progress',[team])).error.code,'ACCESS_DENIED');await db.query("update public.team_members set state='disabled',disabled_at=now() where user_id=$1",[ids.employee1]);assert.equal((await rpc(db,ids.employee1,'get_weekly_progress',[team])).error.code,'ACCESS_DENIED');await assert.rejects(asUser(db,ids.manager,'select private.refresh_daily_support($1)',[team]),/permission denied/);await assert.rejects(rpc(db,null,'get_weekly_progress',[team]),/permission denied/);
});
