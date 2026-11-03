import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createDatabase,seedDatabase,rpc,asUser,ids} from './helpers/database.mjs';
import {installClock,clock} from './helpers/step3.mjs';
let db,team;
before(async()=>{db=await createDatabase();await installClock(db);});after(()=>db.close());
async function seedAtTestTime(connection){const id=await seedDatabase(connection);await clock(connection);await connection.exec('update public.team_members set joined_at=private.task_now()');return id;}
beforeEach(async()=>{team=await seedAtTestTime(db);});
async function create(p={}){const r=await rpc(db,ids.manager,'mutate_task',[team,'create',null,{title:'Проверка результата',assignee_id:ids.employee1,...p},null,randomUUID()]);assert.equal(r.ok,true,JSON.stringify(r));return r.data.entity;}
async function change(t,action,p={}){t=(await rpc(db,ids.manager,'get_task_detail',[team,t.id])).data.task;const r=await rpc(db,ids.manager,'mutate_task',[team,action,t.id,p,t.version,randomUUID()]);assert.equal(r.ok,true,JSON.stringify(r));return r.data.entity;}
async function metric(date='2026-11-02',period='day'){const r=await rpc(db,ids.manager,'get_report',[team,period,date,ids.employee1,'all']);assert.equal(r.ok,true,JSON.stringify(r));return r.data;}

test('today is 100 percent when today is done and a Nov 2–3 task is due tomorrow; calendar keeps both workdays',async()=>{
 const today=await create({deadline:'2026-11-02'});await create({plan_end:'2026-11-03',deadline:'2026-11-03'});await change(today,'status',{status:'done'});
 const r=await metric();assert.equal(r.metrics.planned_count,1);assert.equal(r.metrics.plan_done_count,1);assert.equal(r.metrics.progress_percent,100);
 const p=await rpc(db,ids.employee1,'get_planner',[team,'2026-11-02',{},null]);assert.equal(p.data.day_tasks.length,2);assert.equal(p.data.progress.day.progress_percent,100);assert.equal(p.data.progress.week.progress_percent,50);assert.equal(p.data.progress.month.progress_percent,50);
 await clock(db,'2026-11-02T18:00:00+03:00');const w=(await rpc(db,ids.employee1,'get_weekly_progress',[team])).data;assert.ok(w.own_support,'Expected support for a member who joined on the controlled test date');assert.equal(w.own_support.payload.progress_percent,100);assert.equal(w.own_support.payload.category,'complete');assert.equal(w.members[0].days[1].planned_count,1);
});
test('without deadline only last workday determines the result and a same-day move updates the result date',async()=>{
 let t=await create({plan_end:'2026-11-04'});assert.equal((await metric()).metrics.planned_count,0);assert.equal((await metric('2026-11-04')).metrics.planned_count,1);
 t=await change(t,'move',{plan_start:'2026-11-05'});assert.equal(t.plan_end,'2026-11-07');assert.equal((await metric('2026-11-04')).metrics.planned_count,0);assert.equal((await metric('2026-11-07')).metrics.planned_count,1);
});
test('overdue work remains until and including completion day, then leaves the next day; week counts unique IDs',async()=>{
 let t=await create({deadline:'2026-11-02'});await clock(db,'2026-11-03T10:00:00+03:00');assert.equal((await metric('2026-11-03')).metrics.planned_count,1);
 t=await change(t,'status',{status:'done'});assert.equal((await metric('2026-11-03')).metrics.progress_percent,100);assert.equal((await metric('2026-11-04')).metrics.planned_count,0);
 assert.equal((await metric('2026-11-02','week')).metrics.planned_count,1);assert.equal((await metric('2026-11-02','week')).metrics.plan_done_count,1);
});
test('early completion is a separate achievement today, a completed future obligation, with one ID in week/month',async()=>{
 const t=await create({deadline:'2026-11-03',plan_end:'2026-11-03'});await change(t,'status',{status:'done'});
 let r=await metric();assert.equal(r.metrics.progress_percent,null);assert.equal(r.metrics.early_done_count,1);assert.equal(r.metrics.actual_done_count,1);
 const rows=await rpc(db,ids.manager,'get_report_rows',[r.snapshot_id,'early_done_count',null,50,'all']);assert.equal(rows.data.rows[0].id,t.id);
 assert.equal((await metric('2026-11-03')).metrics.progress_percent,100);assert.equal((await metric('2026-11-02','week')).metrics.planned_count,1);
 await clock(db,'2026-11-02T18:00:00+03:00');const w=(await rpc(db,ids.employee1,'get_weekly_progress',[team])).data;assert.ok(w.own_support,'Expected support for a member who joined on the controlled test date');assert.equal(w.own_support.payload.early_done_count,1);assert.equal(w.own_support.payload.category,'empty');assert.equal(w.members[0].days[0].early_done_count,1);
});
test('early achievement uses deadline/assignee at completion, and reopening removes the superseded completion',async()=>{
 let t=await create({deadline:'2026-11-05'});t=await change(t,'status',{status:'done'});assert.equal((await metric()).metrics.early_done_count,1);
 await clock(db,'2026-11-02T11:00:00+03:00');t=await change(t,'status',{status:'in_progress'});assert.equal((await metric()).metrics.early_done_count,0);
});
test('closed result dates are historical and future edits/assignment/completion do not rewrite them',async()=>{
 let t=await create({deadline:'2026-11-02'});await clock(db,'2026-11-03T10:00:00+03:00');t=await change(t,'update',{deadline:'2026-11-10',assignee_id:ids.employee2});await change(t,'status',{status:'done'});
 const old=await metric();assert.equal(old.metrics.planned_count,1);assert.equal(old.metrics.progress_percent,0);assert.equal((await metric('2026-11-03')).metrics.planned_count,0);
});
test('cancellation removes obligations; deletion cannot hide due work but removes not-yet-due work',async()=>{
 let t=await create({deadline:'2026-11-02'});await change(t,'delete');let r=await metric();assert.equal(r.metrics.planned_count,1);assert.equal(r.metrics.deleted_unfinished_count,1);
 t=await create({deadline:'2026-11-03'});await change(t,'delete');assert.equal((await metric('2026-11-03')).metrics.planned_count,1); // only the already-due deleted debt
 t=await create({deadline:'2026-11-02'});await change(t,'status',{status:'cancelled',reason:'Не требуется'});assert.equal((await metric()).metrics.planned_count,1);
 await assert.rejects(asUser(db,ids.employee1,"select * from private.result_states($1,date '2026-11-02',date '2026-11-03',now())",[team]),/permission denied/);
});
test('migration recomputes existing messages in place, preserves read state and expires old report snapshots',async()=>{
 const old=await createDatabase(undefined,{beforeMigration:'202611020015'});try{await installClock(old);const tm=await seedAtTestTime(old);let r=await rpc(old,ids.manager,'mutate_task',[tm,'create',null,{title:'Сегодня',assignee_id:ids.employee1},null,randomUUID()]);await rpc(old,ids.manager,'mutate_task',[tm,'status',r.data.entity.id,{status:'done'},r.data.entity.version,randomUUID()]);await rpc(old,ids.manager,'mutate_task',[tm,'create',null,{title:'Завтра',assignee_id:ids.employee1,plan_end:'2026-11-03',deadline:'2026-11-03'},null,randomUUID()]);
 await clock(old,'2026-11-02T18:00:00+03:00');const w=(await rpc(old,ids.employee1,'get_weekly_progress',[tm])).data;assert.ok(w.own_support,'Expected support for a member who joined on the controlled test date');assert.equal(w.own_support.payload.progress_percent,50);const n=(await rpc(old,ids.employee1,'claim_daily_support',[tm,w.own_support.id])).data.notification;const report=await rpc(old,ids.employee1,'get_report',[tm,'day','2026-11-02',null,'all']);const count=(await old.query("select count(*)::int n from public.notifications where type='daily_support'")).rows[0].n;
 await old.exec(await readFile('supabase/migrations/202611020015_result_dates.sql','utf8'));const updated=(await old.query('select * from public.notifications where id=$1',[n.id])).rows[0];assert.equal(updated.payload.progress_percent,100);assert.equal(new Date(updated.read_at).getTime(),new Date(n.read_at).getTime());assert.equal(new Date(updated.created_at).getTime(),new Date(n.created_at).getTime());assert.equal((await old.query("select count(*)::int n from public.notifications where type='daily_support'")).rows[0].n,count);assert.equal((await rpc(old,ids.employee1,'get_export_data',[report.data.snapshot_id])).error.code,'SNAPSHOT_EXPIRED');
 }finally{await old.close();}
});
