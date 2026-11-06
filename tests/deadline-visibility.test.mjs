import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createDatabase,seedDatabase,rpc,asUser,ids} from './helpers/database.mjs';
import {installClock,clock} from './helpers/step3.mjs';
let db,team;
const migration='202611060016_deadline_visibility.sql';
before(async()=>{db=await createDatabase();await installClock(db);});
after(()=>db.close());
beforeEach(async()=>{team=await seedDatabase(db);await clock(db,'2026-11-05T10:00:00+03:00');await db.exec('update public.team_members set joined_at=private.task_now()');});
async function create(payload={},user='manager'){
 const r=await rpc(db,ids[user],'mutate_task',[team,'create',null,{title:'Видимость',assignee_id:ids.employee1,deadline:'2026-11-07',...payload},null,randomUUID()]);
 assert.equal(r.ok,true,JSON.stringify(r));return r.data.entity;
}
async function change(t,action,payload={},user='manager'){
 const current=await rpc(db,ids[user],'get_task_detail',[team,t.id]);assert.equal(current.ok,true,JSON.stringify(current));
 const r=await rpc(db,ids[user],'mutate_task',[team,action,t.id,payload,current.data.task.version,randomUUID()]);assert.equal(r.ok,true,JSON.stringify(r));return r.data.entity;
}
async function day(date,filters={},user='employee1',cursor=null){const r=await rpc(db,ids[user],'get_planner',[team,date,filters,cursor]);assert.equal(r.ok,true,JSON.stringify(r));return r.data;}
const idsOf=d=>d.day_tasks.map(t=>t.id);
test('a deadline projects one existing ID onto every calendar day, including Saturday, with consistent week and month counts',async()=>{
 const t=await create();const friday=await create({title:'Срок 6-го',deadline:'2026-11-06'});
 for(const user of ['manager','employee1'])for(const date of ['2026-11-05','2026-11-06','2026-11-07']){
  const d=await day(date,{},user),expected=date==='2026-11-07'?1:2;
  assert.ok(idsOf(d).includes(t.id));assert.equal(d.day_total,expected);
  const w=d.week_days.find(x=>x.date===date),m=d.month_cells.find(x=>x.date===date);assert.equal(w.total,expected);assert.equal(m.total,expected);
  assert.equal(new Set(w.tasks.map(x=>x.id)).size,w.tasks.length);
 }
 assert.deepEqual(idsOf(await day('2026-11-04')),[]);assert.deepEqual(idsOf(await day('2026-11-08')),[]);
 assert.equal((await db.query('select plan_end::text from public.tasks where id=$1',[t.id])).rows[0].plan_end,'2026-11-05');
 assert.equal((await day('2026-11-05')).progress.day.planned_count,0);assert.equal((await day('2026-11-06')).progress.day.planned_count,1);
 assert.equal((await day('2026-11-07')).progress.day.planned_count,2);assert.notEqual(t.id,friday.id);
});
test('early completion stays on the completion day and in historical work days, leaves later calendars, and keeps deadline-based results',async()=>{
 let t=await create();await clock(db,'2026-11-06T12:00:00+03:00');t=await change(t,'status',{status:'done'},'employee1');
 const completed=await day('2026-11-06');assert.deepEqual(completed.day_done_tasks.map(t=>t.id),[t.id]);assert.equal(completed.progress.day.early_done_count,1);
 const future=await day('2026-11-07');assert.equal(future.day_total,0);assert.equal(future.day_done_tasks.length,0);assert.equal(future.progress.day.progress_percent,100);
 assert.equal(future.month_cells.find(x=>x.date==='2026-11-07').total,0);
 const history=await day('2026-11-05');assert.equal(history.day_tasks[0].status,'planned');assert.equal(history.day_tasks[0].historical,true);
 await clock(db,'2026-11-08T10:00:00+03:00');assert.equal((await day('2026-11-06')).day_done_tasks[0].id,t.id);assert.equal((await day('2026-11-07')).day_done_tasks.length,0);
});
test('waiting and overdue tasks continue through Saturday and Sunday once per day, with unique results and no future overdue flood',async()=>{
 let t=await create({deadline:'2026-11-06'});t=await change(t,'status',{status:'waiting'},'employee1');
 for(const date of ['2026-11-06','2026-11-07','2026-11-08','2026-11-09']){
  await clock(db,date+'T10:00:00+03:00');const d=await day(date);assert.deepEqual(idsOf(d),[t.id]);assert.equal(d.day_tasks[0].status,'waiting');
  assert.equal(d.day_tasks[0].overdue,date>'2026-11-06');const count=(await db.query('select count(*)::int n from private.task_events')).rows[0].n;
  await rpc(db,ids.employee1,'sync_workspace',[team]);assert.equal((await db.query('select count(*)::int n from private.task_events')).rows[0].n,count);
 }
 assert.deepEqual(idsOf(await day('2026-11-10')),[]);assert.equal((await day('2026-11-09')).progress.week.planned_count,1);
 t=await change(t,'status',{status:'done'},'employee1');assert.equal((await day('2026-11-09')).day_done_tasks[0].id,t.id);
});
test('deadline edits and manual moves update projections while retaining the closed-day snapshot and the full work duration',async()=>{
 let t=await create({plan_end:'2026-11-09'});assert.deepEqual(idsOf(await day('2026-11-09')),[t.id]);
 t=await change(t,'update',{deadline:'2026-11-11'});assert.deepEqual(idsOf(await day('2026-11-11')),[t.id]);
 t=await change(t,'update',{deadline:'2026-11-06'});assert.deepEqual(idsOf(await day('2026-11-10')),[]);
 await clock(db,'2026-11-06T10:00:00+03:00');t=await change(t,'move',{plan_start:'2026-11-12'});assert.equal(t.plan_end,'2026-11-16');assert.equal(t.deadline,'2026-11-06');
 assert.deepEqual(idsOf(await day('2026-11-07')),[]);assert.deepEqual(idsOf(await day('2026-11-12')),[t.id]);assert.deepEqual(idsOf(await day('2026-11-05')),[t.id]);
});
test('cancel, delete, restore and reopen stop future visibility and resume a deadline task on the current weekend',async()=>{
 let t=await create();t=await change(t,'status',{status:'cancelled',reason:'Пауза'});assert.equal((await day('2026-11-05')).day_cancelled_tasks[0].id,t.id);assert.equal((await day('2026-11-07')).day_cancelled_tasks.length,0);
 await clock(db,'2026-11-08T10:00:00+03:00');t=await change(t,'status',{status:'in_progress'});assert.equal(t.plan_start,'2026-11-08');assert.deepEqual(idsOf(await day('2026-11-08')),[t.id]);
 t=await change(t,'delete');assert.deepEqual(idsOf(await day('2026-11-08')),[]);
 await clock(db,'2026-11-14T10:00:00+03:00');t=await change(t,'restore');assert.equal(t.plan_start,'2026-11-14');assert.deepEqual(idsOf(await day('2026-11-14')),[t.id]);
 assert.deepEqual(idsOf(await day('2026-11-10')),[]);
});
test('a virtual historical day survives a same-day move and deadline removal without duplicate calendar cards',async()=>{
 let t=await create();await clock(db,'2026-11-06T12:00:00+03:00');t=await change(t,'move',{plan_start:'2026-11-09'});t=await change(t,'update',{deadline:null});
 await clock(db,'2026-11-07T12:00:00+03:00');const yesterday=await day('2026-11-06');assert.deepEqual(idsOf(yesterday),[t.id]);assert.equal(yesterday.day_total,1);
 assert.equal(yesterday.day_tasks[0].historical,true);assert.equal(yesterday.day_tasks[0].deadline,null);assert.equal((await day('2026-11-07')).day_total,0);
});
test('reopening and restoring before a future deadline preserve original work dates and daily visibility',async()=>{
 let done=await create({deadline:'2026-11-20'}),deleted=await create({deadline:'2026-11-20'});
 done=await change(done,'status',{status:'done'});deleted=await change(deleted,'delete');await clock(db,'2026-11-07T10:00:00+03:00');
 done=await change(done,'status',{status:'in_progress'});deleted=await change(deleted,'restore');assert.equal(done.plan_start,'2026-11-05');assert.equal(deleted.plan_start,'2026-11-05');
 assert.equal((await day('2026-11-07')).day_total,2);assert.equal((await day('2026-11-20')).day_total,2);
});
test('no-deadline tasks retain workday continuation and a manually future-planned task is not pulled into today',async()=>{
 await clock(db,'2026-11-06T10:00:00+03:00');const plain=await create({deadline:null}),future=await create({plan_start:'2026-11-09',deadline:'2026-11-07'});
 await clock(db,'2026-11-07T10:00:00+03:00');assert.equal((await day('2026-11-07')).day_total,0);
 assert.equal((await db.query('select plan_start::text from public.tasks where id=$1',[plain.id])).rows[0].plan_start,'2026-11-09');
 assert.deepEqual(new Set(idsOf(await day('2026-11-09'))),new Set([plain.id,future.id]));
});
test('recurring occurrences retain separate identities and overlapping deadline visibility respects all list filters',async()=>{
 const r=await rpc(db,ids.manager,'mutate_series',[team,'create',null,null,{title:'Повторение со сроком',assignee_id:ids.employee1,direction:'sto',frequency:'daily',start_date:'2026-11-05',end_date:'2026-11-06',deadline_offset_days:2},null,randomUUID()]);assert.equal(r.ok,true,JSON.stringify(r));
 const d=await day('2026-11-07',{employee_id:ids.employee1,direction:'sto',query:'со сроком',statuses:['planned'],deadline_filter:'next_7_days'});assert.equal(d.day_total,2);assert.equal(new Set(idsOf(d)).size,2);
 assert.equal((await day('2026-11-07',{direction:'uk'})).day_total,0);assert.equal((await day('2026-11-07',{employee_id:ids.employee2})).day_total,0);
});
test('a far deadline does not materialize daily placements or change public response keys and private helpers stay inaccessible',async()=>{
 const t=await create({deadline:'2100-12-31'});const d=await day('2030-06-01');assert.deepEqual(idsOf(d),[t.id]);
 assert.equal((await db.query('select count(*)::int n from private.plan_day_entries where task_id=$1',[t.id])).rows[0].n,1);
 assert.deepEqual(Object.keys(d).sort(),['day_cancelled_tasks','day_done_tasks','day_tasks','day_total','members','month_cells','next_cursor','overdue_total','progress','selected_date','snapshot_at','timezone','today','week_days'].sort());
 await assert.rejects(asUser(db,ids.employee1,"select * from private.deadline_calendar_states($1,date '2026-11-07')",[team]),/permission denied/);
});
test('overdue filters exclude a completed or cancelled task consistently in cards and calendar counters',async()=>{
 let done=await create({deadline:'2026-11-04'}),active=await create({deadline:'2026-11-04'});
 done=await change(done,'status',{status:'done'});const filters={statuses:[],deadline_filter:'overdue'},d=await day('2026-11-05',filters);
 assert.deepEqual(idsOf(d),[active.id]);assert.equal(d.day_total,1);assert.equal(d.week_days.find(x=>x.date==='2026-11-05').total,1);
 const cell=d.month_cells.find(x=>x.date==='2026-11-05');assert.equal(cell.total,1);assert.equal(cell.done,0);
 assert.equal((await day('2026-11-05',{...filters,statuses:['done']})).day_total,0);
 active=await change(active,'status',{status:'cancelled',reason:'Отмена'});assert.equal((await day('2026-11-05',filters)).day_total,0);
});
test('deadline projections paginate without duplicating the task or its result',async()=>{
 for(let i=0;i<105;i++){if(i%20===0)await db.exec('truncate private.rate_limit_counters');await create({title:'Страница '+i});}
 await db.exec('truncate private.rate_limit_counters');const first=await day('2026-11-07'),last=await day('2026-11-07',{},'employee1',first.next_cursor);
 assert.equal(first.day_total,105);assert.equal(first.day_tasks.length,100);assert.equal(last.day_tasks.length,5);assert.equal(last.next_cursor,null);
 assert.equal(new Set([...idsOf(first),...idsOf(last)]).size,105);assert.equal(first.progress.week.planned_count,105);
});
test('upgrading existing rows repairs only an old automatic Monday jump, preserving human moves and recording the repair at deployment time',async()=>{
 const old=await createDatabase(undefined,{beforeMigration:migration});
 try{
  await installClock(old);const oldTeam=await seedDatabase(old);await clock(old,'2026-11-06T10:00:00+03:00');
  const make=async title=>(await rpc(old,ids.employee1,'mutate_task',[oldTeam,'create',null,{title,deadline:'2026-11-07'},null,randomUUID()])).data.entity;
  const automatic=await make('Авто'),manual=await make('Вручную');
  await rpc(old,ids.employee1,'mutate_task',[oldTeam,'move',manual.id,{plan_start:'2026-11-09'},manual.version,randomUUID()]);
  await clock(old,'2026-11-07T10:00:00+03:00');await rpc(old,ids.employee1,'sync_workspace',[oldTeam]);
  assert.equal((await old.query('select plan_start::text from public.tasks where id=$1',[automatic.id])).rows[0].plan_start,'2026-11-09');
  await old.exec(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
  const r=await rpc(old,ids.employee1,'get_planner',[oldTeam,'2026-11-07',{},null]);assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(idsOf(r.data),[automatic.id]);
  const rows=(await old.query('select id,plan_start::text from public.tasks order by title')).rows;assert.equal(rows.find(t=>t.id===manual.id).plan_start,'2026-11-09');
  const event=(await old.query("select effective_at=private.task_now() as at_deployment from private.task_events where task_id=$1 order by event_seq desc limit 1",[automatic.id])).rows[0];assert.equal(event.at_deployment,true);
  const before=(await old.query('select count(*)::int n from private.task_events')).rows[0].n;await rpc(old,ids.employee1,'sync_workspace',[oldTeam]);assert.equal((await old.query('select count(*)::int n from private.task_events')).rows[0].n,before);
 }finally{await old.close();}
});
