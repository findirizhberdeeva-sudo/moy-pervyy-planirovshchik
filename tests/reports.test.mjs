import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,rpc,asUser,ids} from './helpers/database.mjs';
import {installClock,clock} from './helpers/step3.mjs';
import {reportFixture,runReportFixture} from './helpers/report-fixture.mjs';
let db,team;
before(async()=>{db=await createDatabase();await installClock(db);});after(async()=>db.close());beforeEach(async()=>{team=await seedDatabase(db);await clock(db);});
const report=(type='month',date='2026-11-01',user='manager',employee=null,direction='all')=>rpc(db,ids[user],'get_report',[team,type,date,employee,direction]);
async function getReport(...args){const r=await report(...args);assert.equal(r.ok,true,JSON.stringify(r));return r.data;}
async function create(payload={}){const r=await rpc(db,ids.manager,'mutate_task',[team,'create',null,{title:'Отчётная задача',assignee_id:ids.employee1,...payload},null,randomUUID()]);assert.equal(r.ok,true,JSON.stringify(r));return r.data.entity;}
async function change(t,action,payload={}){t=(await rpc(db,ids.manager,'get_task_detail',[team,t.id])).data.task;const r=await rpc(db,ids.manager,'mutate_task',[team,action,t.id,payload,t.version,randomUUID()]);assert.equal(r.ok,true,JSON.stringify(r));return r.data.entity;}
test('TZ JSON fixture executes real RPC: October 40%, November 75%, exact task sets and all counts',async()=>{
 const map=await runReportFixture(db,team);
 for(const expected of reportFixture.expected){const r=await getReport(expected.period_type,expected.period_start);
  for(const [key,value] of Object.entries(expected.metrics))assert.equal(r.metrics[key],value,`${expected.period_start} ${key}`);
  for(const [key,metric] of [['base_task_keys','base_count'],['plan_task_keys','planned_count'],['plan_done_task_keys','plan_done_count'],['actual_done_task_keys','actual_done_count'],['overdue_task_keys','overdue_count']]){
   const rows=await rpc(db,ids.manager,'get_report_rows',[r.snapshot_id,metric,null,50,'all']);assert.equal(rows.ok,true,JSON.stringify(rows));assert.deepEqual(rows.data.rows.map(t=>t.id).sort(),expected[key].map(k=>map[k].id).sort());}
  assert.equal(r.metrics.planned_count,r.metrics.plan_done_count+r.metrics.status_planned_count+r.metrics.in_progress_count+r.metrics.waiting_count+r.metrics.deleted_unfinished_count);
  assert.deepEqual(r.by_direction.map(d=>d.id),['sto','dbk','rental','uk','none']);
  assert.equal(r.by_employee.reduce((n,e)=>n+e.metrics.planned_count,0),r.metrics.planned_count);
 }
});
test('snapshots and exported rows stay immutable after completion, rename, reassignment and deadline changes',async()=>{
 let t=await create({deadline:'2026-11-01'});const r=await getReport();t=await change(t,'update',{title:'Новое имя',assignee_id:ids.employee2,deadline:'2026-11-10'});t=await change(t,'status',{status:'done'});
 const saved=await rpc(db,ids.manager,'get_export_data',[r.snapshot_id]);assert.equal(saved.ok,true);assert.equal(saved.data.metrics.plan_done_count,0);assert.equal(saved.data.overdue_tasks[0].title,'Отчётная задача');assert.equal(saved.data.overdue_tasks[0].assignee_id,ids.employee1);assert.equal(saved.data.overdue_tasks[0].deadline,'2026-11-01');assert.equal(saved.data._rows,undefined);
 assert.equal((await getReport()).metrics.plan_done_count,1);
});
test('closed periods keep assignment, deadline, deleted facts and cancellation history',async()=>{
 await clock(db,'2026-10-30T09:00:00+03:00');let t=await create({deadline:'2026-10-30'});await clock(db,'2026-11-02T12:00:00+03:00');t=await change(t,'update',{assignee_id:ids.employee2,deadline:'2026-11-30'});t=await change(t,'delete');
 let oct=await getReport('month','2026-10-01');assert.equal(oct.metrics.planned_count,1);assert.equal(oct.metrics.overdue_count,1);assert.equal(oct.by_employee.find(e=>e.id===ids.employee1).metrics.planned_count,1);
 t=await change(t,'restore');t=await change(t,'status',{status:'cancelled',reason:'Не требуется'});const oct2=await getReport('month','2026-10-01');assert.deepEqual(oct2.metrics,oct.metrics);assert.equal((await getReport()).metrics.cancelled_count,1);
});
test('reopening in another period keeps old result and marks repeat completion',async()=>{
 await clock(db,'2026-10-30T10:00:00+03:00');let t=await create();t=await change(t,'status',{status:'done'});await clock(db,'2026-11-02T10:00:00+03:00');t=await change(t,'status',{status:'in_progress'});t=await change(t,'status',{status:'done'});
 assert.equal((await getReport('month','2026-10-01')).metrics.actual_done_count,1);const nov=await getReport();assert.equal(nov.metrics.actual_done_count,1);const ex=await rpc(db,ids.manager,'get_export_data',[nov.snapshot_id]);assert.equal(ex.data.actual_done_tasks[0].repeated,true);
});
test('empty/future periods have null progress; month weeks clipped; week Monday Sunday',async()=>{
 const r=await getReport('month','2027-02-18');assert.equal(r.metrics.progress_percent,null);assert.equal(r.by_subperiod[0].start,'2027-02-01');assert.equal(r.by_subperiod.at(-1).end,'2027-02-28');
 const w=await getReport('week','2026-11-08');assert.equal(w.period.start,'2026-11-02');assert.equal(w.period.end,'2026-11-08');assert.equal(w.by_subperiod.length,7);
 const d=await getReport('day','2026-11-02');assert.equal(d.by_subperiod.length,0);
});
test('day at Moscow boundary uses previous period exclusive end; long plan not sum of days',async()=>{
 await clock(db,'2026-10-30T12:00:00+03:00');let t=await create({plan_start:'2026-10-30',plan_end:'2026-11-03'});await clock(db,'2026-11-01T00:00:00+03:00');t=await change(t,'status',{status:'done'});
 assert.equal((await getReport('month','2026-10-01')).metrics.plan_done_count,0);const r=await getReport();assert.equal(r.metrics.planned_count,1);assert.equal(r.metrics.actual_done_count,1);assert.equal(r.metrics.plan_done_count,1);
});
test('metric filters use event responsibility, not current responsibility; no averaging employee percentages',async()=>{
 let t=await create();await change(t,'status',{status:'done'});t=await create();t=await change(t,'move',{plan_start:'2026-11-03'});await change(t,'update',{assignee_id:ids.employee2,direction:'uk'});
 for(let i=0;i<8;i++)await create({assignee_id:ids.employee2});
 const r=await getReport();assert.equal(r.metrics.progress_percent,10);const employee=await getReport('month','2026-11-01','manager',ids.employee1);assert.equal(employee.metrics.actual_done_count,1);assert.equal(employee.metrics.manual_moved_task_count,1);assert.equal(employee.metrics.planned_count,1);
 const filtered=await getReport('month','2026-11-01','employee1',null,'uk');assert.equal(filtered.by_direction.length,1);assert.equal(filtered.metrics.manual_moved_task_count,0);assert.equal(filtered.metrics.planned_count,1);
});
test('snapshot access checks owner, active membership, expiry, private SQL and input bounds',async()=>{
 const r=await getReport();assert.equal((await rpc(db,ids.employee1,'get_export_data',[r.snapshot_id])).error.code,'ACCESS_DENIED');assert.equal((await rpc(db,ids.outsider,'get_export_data',[r.snapshot_id])).error.code,'ACCESS_DENIED');
 await assert.rejects(asUser(db,ids.manager,'select * from private.report_snapshots'),/permission denied/);
 assert.equal((await report('year')).error.code,'VALIDATION_ERROR');assert.equal((await report('month','2026-11-01','manager',null,'bad')).error.code,'VALIDATION_ERROR');
 for(const args of [[r.snapshot_id,'planned_count',null,51,'all'],[r.snapshot_id,'password',null,50,'all'],[r.snapshot_id,'planned_count','oops',50,'all']])assert.equal((await rpc(db,ids.manager,'get_report_rows',args)).error.code,'VALIDATION_ERROR');
 await clock(db,'2026-11-03T09:00:00+03:00');assert.equal((await rpc(db,ids.manager,'get_export_data',[r.snapshot_id])).error.code,'SNAPSHOT_EXPIRED');
});
test('disabled snapshot owner loses access immediately',async()=>{
 const r=await getReport('month','2026-11-01','employee1');await db.query("update public.team_members set state='disabled',disabled_at=now() where team_id=$1 and user_id=$2",[team,ids.employee1]);assert.equal((await rpc(db,ids.employee1,'get_report_rows',[r.snapshot_id,'planned_count',null,50,'all'])).error.code,'ACCESS_DENIED');
});
test('report user/team limits and reading existing snapshot do not consume another creation',async()=>{
 const first=await getReport();for(let i=0;i<5;i++)await getReport();const limited=await report();assert.equal(limited.error.code,'RATE_LIMITED');assert.ok(limited.error.retry_after_seconds>0);assert.match(limited.error.message,new RegExp(`через ${limited.error.retry_after_seconds} секунд`));
 for(let i=0;i<4;i++)assert.equal((await rpc(db,ids.manager,'get_export_data',[first.snapshot_id])).ok,true);
 await clock(db,'2026-11-02T09:02:00+03:00');assert.equal((await report()).ok,true);
});
test('pagination exceeds 100 rows without losing data and each clicked grouped metric matches its frozen rows',async()=>{
 for(let i=0;i<111;i++){if(i%25===0)await db.exec('truncate private.rate_limit_counters');await create({title:`Задача ${i}`});}
 const r=await getReport();assert.equal(r.metrics.planned_count,111);let cursor=null,all=[];do{const p=await rpc(db,ids.manager,'get_report_rows',[r.snapshot_id,'planned_count',cursor,50,'all']);assert.equal(p.ok,true);all.push(...p.data.rows);cursor=p.data.next_cursor;}while(cursor);assert.equal(new Set(all.map(t=>t.id)).size,111);
 for(const group of [...r.by_employee,...r.by_direction,...r.by_subperiod]){const p=await rpc(db,ids.manager,'get_report_rows',[r.snapshot_id,'planned_count',null,50,group.scope]);assert.equal(p.data.total,group.metrics.planned_count);}
});
test('mixed statuses, cancelled-only plan and disabled member rows reconcile to all metric ID sets',async()=>{
 const a=await create(),b=await create(),c=await create(),d=await create();await change(a,'status',{status:'in_progress'});await change(b,'status',{status:'waiting'});await change(c,'delete');await change(d,'status',{status:'cancelled',reason:'Не требуется'});
 await db.query("update public.team_members set state='disabled',disabled_at=now() where team_id=$1 and user_id=$2",[team,ids.employee1]);
 const r=await getReport();assert.equal(r.metrics.planned_count,3);assert.equal(r.metrics.in_progress_count,1);assert.equal(r.metrics.waiting_count,1);assert.equal(r.metrics.deleted_unfinished_count,1);assert.equal(r.metrics.cancelled_count,1);assert.equal(r.by_employee.find(e=>e.id===ids.employee1).state,'disabled');
 for(const [key,value] of Object.entries(r.metrics)){if(key==='progress_percent')continue;const rows=await rpc(db,ids.manager,'get_report_rows',[r.snapshot_id,key,null,50,'all']);assert.equal(rows.data.total,value,key);}
});
test('team report creation limit is separate from per-user limit and reports cannot materialize a future auto-move',async()=>{
 const t=await create();const today=(await db.query('select plan_start from public.tasks where id=$1',[t.id])).rows[0].plan_start;
 for(let batch=0;batch<2;batch++){await clock(db,`2026-11-02T09:0${batch*2}:00+03:00`);for(const user of ['manager','employee1','employee2'])for(let i=0;i<5;i++)await getReport('month','2027-02-01',user);}
 assert.deepEqual((await db.query('select plan_start from public.tasks where id=$1',[t.id])).rows[0].plan_start,today);await clock(db,'2026-11-02T09:04:00+03:00');const r=await report();assert.equal(r.error.code,'RATE_LIMITED');assert.ok(r.error.retry_after_seconds>60);
});
test('a revoked cancellation cannot count for the old assignee or direction after a second cancellation',async()=>{
 let t=await create();t=await change(t,'status',{status:'cancelled',reason:'Первая отмена'});t=await change(t,'status',{status:'in_progress'});t=await change(t,'update',{assignee_id:ids.employee2,direction:'uk'});await change(t,'status',{status:'cancelled',reason:'Действующая отмена'});
 const total=await getReport();assert.equal(total.metrics.cancelled_count,1);
 const old=await getReport('month','2026-11-01','manager',ids.employee1);assert.equal(old.metrics.cancelled_count,0);
 const current=await getReport('month','2026-11-01','manager',ids.employee2,'uk');assert.equal(current.metrics.cancelled_count,1);
 const p=await rpc(db,ids.manager,'get_planner',[team,'2026-11-02',{employee_id:ids.employee1,direction:'all'},null]);assert.equal(p.data.progress.month.cancelled_count,0);
 for(const [key,value] of Object.entries(p.data.progress.month))assert.equal(value,old.metrics[key],key);
});
