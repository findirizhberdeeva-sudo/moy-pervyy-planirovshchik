import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,rpc,ids} from './helpers/database.mjs';
import {installClock,clock} from './helpers/step3.mjs';
let db,team;
before(async()=>{db=await createDatabase();await installClock(db);});after(async()=>{await db.close();});beforeEach(async()=>{team=await seedDatabase(db);await clock(db);});
const series=(action='create',s=null,patch={},boundary=null,user='employee1',op=randomUUID())=>rpc(db,ids[user],'mutate_series',[team,action,s?.id||null,boundary,{...(action==='create'?{title:'Повторение',frequency:'daily',end_date:'2026-11-06'}:{}),...patch},s?.version||null,op]);
async function newSeries(patch={}){const r=await series('create',null,patch);assert.equal(r.ok,true,JSON.stringify(r));return r.data.entity;}
const sync=()=>rpc(db,ids.employee1,'sync_workspace',[team]);
const rows=async s=>(await db.query(`select id,occurrence_date::text,plan_start::text,plan_end::text,deadline::text,title,status,is_superseded,version,deleted_at from public.tasks where series_id=$1 order by occurrence_date`,[s.id])).rows;
const detail=async id=>(await rpc(db,ids.employee1,'get_task_detail',[team,id])).data.task;
test('daily/workday/weekly generation handles weekends and idempotent operation/occurrence keys',async()=>{
 const op=randomUUID(),args={frequency:'daily',end_date:'2026-11-08'};let r=await series('create',null,args,null,'employee1',op);assert.equal(r.ok,true,JSON.stringify(r));
 const s=r.data.entity;assert.equal((await rows(s)).length,7);assert.equal((await series('create',null,args,null,'employee1',op)).data.idempotent_replay,true);
 await sync();await sync();assert.equal((await rows(s)).length,7);
 const work=await newSeries({frequency:'workdays',end_date:'2026-11-08'});assert.equal((await rows(work)).length,5);
 const weekly=await newSeries({frequency:'weekly',weekdays:[1,6,7],end_date:'2026-11-08'});assert.deepEqual((await rows(weekly)).map(x=>x.occurrence_date),['2026-11-02','2026-11-07','2026-11-08']);
});
test('monthly rule 31 clamps February and returns to 31 in March',async()=>{
 await clock(db,'2026-01-01T09:00:00+03:00');const s=await newSeries({frequency:'monthly',month_day:31,start_date:'2026-01-01',end_date:'2026-03-31'});
 await rpc(db,ids.employee1,'get_planner',[team,'2026-03-15',{},null]);
 assert.deepEqual((await rows(s)).map(x=>x.occurrence_date),['2026-01-31','2026-02-28','2026-03-31']);
});
test('long recurring intervals overlap; deadline offsets and moved occurrence identity remain fixed',async()=>{
 const s=await newSeries({duration_days:3,deadline_offset_days:4,end_date:'2026-11-04'});let all=await rows(s);assert.equal(all.length,3);assert.equal(all[0].plan_end,'2026-11-04');assert.equal(all[1].deadline,'2026-11-07');
 let t=await detail(all[0].id);const r=await rpc(db,ids.employee1,'mutate_task',[team,'move',t.id,{plan_start:'2026-11-09'},t.version,randomUUID()]);assert.equal(r.ok,true);
 await rpc(db,ids.employee1,'get_planner',[team,'2026-11-03',{},null]);all=await rows(s);assert.equal(all[0].id,t.id);assert.equal(all[0].plan_start,'2026-11-09');assert.equal(all[0].deadline,'2026-11-06');assert.equal(all[1].plan_start,'2026-11-03');
});
test('future month materialization includes earlier long starts and never auto-moves into future',async()=>{
 const s=await newSeries({frequency:'monthly',month_day:30,start_date:'2026-11-30',end_date:null,duration_days:5});
 await rpc(db,ids.employee1,'get_planner',[team,'2027-02-01',{},null]);const all=await rows(s);assert.ok(all.some(t=>t.occurrence_date==='2027-01-30'));
 assert.ok(all.every(t=>t.plan_start===t.occurrence_date));assert.equal((await db.query(`select count(*) as n from private.task_events where event_type='auto_move'`)).rows[0].n,0);
});
test('Friday/waiting/long task with deadline auto-continues each calendar day, retaining ID/status/deadline',async()=>{
 await clock(db,'2026-10-30T10:00:00+03:00');let r=await rpc(db,ids.employee1,'mutate_task',[team,'create',null,{title:'Ожидание',deadline:'2026-10-30'},null,randomUUID()]);let t=r.data.entity;
 t=(await rpc(db,ids.employee1,'mutate_task',[team,'status',t.id,{status:'waiting'},t.version,randomUUID()])).data.entity;
 await clock(db,'2026-10-31T00:00:00+03:00');r=await sync();assert.equal(r.data.moved_task_count,1);const moved=await detail(t.id);assert.equal(moved.plan_start,'2026-10-31');assert.equal(moved.status,'waiting');assert.equal(moved.deadline,'2026-10-30');
 await sync();assert.equal((await detail(t.id)).version,moved.version);
 await clock(db,'2026-11-01T00:00:00+03:00');await sync();assert.equal((await detail(t.id)).plan_start,'2026-11-01');
 await clock(db,'2026-11-02T00:00:00+03:00');await sync();assert.equal((await detail(t.id)).id,t.id);
});
test('a manually planned Saturday stays until Sunday then continues Monday',async()=>{
 await clock(db,'2026-10-30T09:00:00+03:00');const t=(await rpc(db,ids.employee1,'mutate_task',[team,'create',null,{title:'Суббота',plan_start:'2026-10-31'},null,randomUUID()])).data.entity;
 await clock(db,'2026-10-31T18:00:00+03:00');await sync();assert.equal((await detail(t.id)).plan_start,'2026-10-31');
 await clock(db,'2026-11-01T00:00:00+03:00');await sync();assert.equal((await detail(t.id)).plan_start,'2026-11-02');
});
test('missed runs fill intermediate working days and are idempotent across repeated sync calls',async()=>{
 await clock(db,'2026-10-30T09:00:00+03:00');const t=(await rpc(db,ids.employee1,'mutate_task',[team,'create',null,{title:'Простой'},null,randomUUID()])).data.entity;
 await clock(db,'2026-11-05T09:00:00+03:00');const first=await sync();assert.equal(first.ok,true);assert.equal(first.data.moved_task_count,1);assert.equal((await detail(t.id)).plan_start,'2026-11-05');
 const dates=(await db.query(`select distinct plan_date::text from private.plan_day_entries where task_id=$1 order by plan_date::text`,[t.id])).rows.map(x=>x.plan_date);
 assert.deepEqual(dates,['2026-10-30','2026-11-02','2026-11-03','2026-11-04','2026-11-05']);const count=(await db.query('select count(*) as n from private.task_events')).rows[0].n;
 await Promise.all([sync(),sync()]);assert.equal((await db.query('select count(*) as n from private.task_events')).rows[0].n,count);
 const monday=await rpc(db,ids.employee1,'get_planner',[team,'2026-11-02',{},null]);assert.equal(monday.data.progress.day.planned_count,1);assert.equal(monday.data.progress.day.progress_percent,0);
});
test('done/cancelled/deleted/future tasks never move; long task gets one-day continuation after interval',async()=>{
 const s=await newSeries({frequency:'weekly',weekdays:[1],duration_days:3,end_date:'2026-11-02'});const long=(await rows(s))[0];
 const done=(await rpc(db,ids.employee1,'mutate_task',[team,'create',null,{title:'Готово'},null,randomUUID()])).data.entity;
 await rpc(db,ids.employee1,'mutate_task',[team,'status',done.id,{status:'done'},done.version,randomUUID()]);
 const cancelled=(await rpc(db,ids.employee1,'mutate_task',[team,'create',null,{title:'Отмена'},null,randomUUID()])).data.entity;
 await rpc(db,ids.employee1,'mutate_task',[team,'status',cancelled.id,{status:'cancelled',reason:'Не требуется'},cancelled.version,randomUUID()]);
 const deleted=(await rpc(db,ids.employee1,'mutate_task',[team,'create',null,{title:'Удалено'},null,randomUUID()])).data.entity;
 await rpc(db,ids.employee1,'mutate_task',[team,'delete',deleted.id,{},deleted.version,randomUUID()]);
 await clock(db,'2026-11-05T09:00:00+03:00');await sync();const t=await detail(long.id);assert.equal(t.plan_start,'2026-11-05');assert.equal(t.plan_end,t.plan_start);assert.equal(t.continuation,true);
 for(const id of [done.id,cancelled.id,deleted.id])assert.equal((await detail(id)).plan_start,'2026-11-02');
});
test('only-this exception survives materialization; next revision replaces future exceptions and keeps IDs/completed/past',async()=>{
 let s=await newSeries({end_date:'2026-11-06'});let all=await rows(s);const id=all[2].id,completed=await detail(all[3].id);
 await rpc(db,ids.employee1,'mutate_task',[team,'status',completed.id,{status:'done'},completed.version,randomUUID()]);
 let t=await detail(id);await rpc(db,ids.employee1,'mutate_task',[team,'update',id,{title:'Исключение'},t.version,randomUUID()]);await rpc(db,ids.employee1,'get_planner',[team,'2026-11-04',{},null]);assert.equal((await detail(id)).title,'Исключение');
 const preview=await rpc(db,ids.employee1,'preview_series',[team,s.id,'2026-11-04']);assert.equal(preview.ok,true);assert.equal(preview.data.affected_count,2);
 const changed=await series('update',s,{title:'Новый шаблон'},'2026-11-04');assert.equal(changed.ok,true,JSON.stringify(changed));s=changed.data.entity;all=await rows(s);
 assert.equal(all[2].id,id);assert.equal(all[2].title,'Новый шаблон');assert.equal(all[0].title,'Повторение');assert.equal(all[3].title,'Повторение');assert.equal(all[3].status,'done');
});
test('schedule revisions supersede disappearing future dates without user cancellations and can restore same IDs',async()=>{
 let s=await newSeries({end_date:'2026-11-08'});const id=(await rows(s)).find(t=>t.occurrence_date==='2026-11-03').id;
 let r=await series('update',s,{frequency:'weekly',weekdays:[1]},'2026-11-03');assert.equal(r.ok,true,JSON.stringify(r));s=r.data.entity;
 assert.equal((await rows(s)).find(t=>t.id===id).is_superseded,true);assert.equal((await rpc(db,ids.employee1,'get_planner',[team,'2026-11-03',{},null])).data.progress.day.planned_count,1);
 assert.equal((await db.query("select count(*)::int n from private.result_states($1,date '2026-11-03',date '2026-11-04',private.task_now()) where task_id=$2",[team,id])).rows[0].n,0);
 r=await series('update',s,{frequency:'daily'},'2026-11-03');assert.equal(r.ok,true,JSON.stringify(r));assert.equal((await rows(s)).find(t=>t.id===id).is_superseded,false);
});
test('stopping removes only future instances and supports stop before first occurrence',async()=>{
 const s=await newSeries();const r=await series('stop',s,{end_date:'2026-11-02'},'2026-11-02');assert.equal(r.ok,true,JSON.stringify(r));
 const all=await rows(s);assert.equal(all[0].is_superseded,false);assert.ok(all.slice(1).every(t=>t.is_superseded));
 const future=await newSeries({start_date:'2026-11-10',end_date:'2026-11-14'});assert.equal((await series('stop',future,{end_date:'2026-11-02'},'2026-11-02')).ok,true);assert.ok((await rows(future)).every(t=>t.is_superseded));assert.equal((await db.query('select private.series_has_future(s) as pending from public.recurrence_series s where id=$1',[future.id])).rows[0].pending,false);
});
test('series permissions, invalid rules, past boundary and conflicting version are enforced in SQL',async()=>{
 const s=await newSeries();assert.equal((await series('update',s,{title:'Чужое'},'2026-11-02','employee2')).error.code,'ACCESS_DENIED');
 assert.equal((await series('update',s,{title:'В прошлом'},'2026-11-01')).error.code,'VALIDATION_ERROR');
 assert.equal((await series('create',null,{frequency:'weekly',weekdays:[]})).error.code,'VALIDATION_ERROR');
 assert.equal((await series('create',null,{frequency:'weekly',weekdays:[1,1]})).error.code,'VALIDATION_ERROR');
 const changed=await series('update',s,{title:'Изменено'},'2026-11-02');assert.equal(changed.ok,true,JSON.stringify(changed));assert.equal((await series('update',s,{title:'Конфликт'},'2026-11-02')).error.code,'VERSION_CONFLICT');
 const assigned=await series('create',null,{assignee_id:ids.employee1},null,'manager');assert.equal(assigned.ok,true);assert.equal((await series('update',assigned.data.entity,{title:'Нельзя'},'2026-11-02')).error.code,'ACCESS_DENIED');
});
test('lazy generation retains rule business time and does not retroactively invent series before creation',async()=>{
 const s=await newSeries({frequency:'monthly',month_day:2,end_date:null});await clock(db,'2027-03-03T09:00:00+03:00');await sync();
 const past=await rpc(db,ids.employee1,'get_planner',[team,'2027-01-04',{},null]);assert.equal(past.data.progress.day.planned_count,3); // Nov/Dec/Jan continuations on Monday.
 const generated=(await db.query(`select effective_created_at,created_at from public.tasks where series_id=$1 and occurrence_date='2027-01-02'`,[s.id])).rows[0];assert.ok(new Date(generated.effective_created_at)<new Date(generated.created_at));
 const before=await rpc(db,ids.employee1,'get_planner',[team,'2026-10-02',{},null]);assert.equal(before.data.progress.month.planned_count,0);
});
test('maintenance failure is observable, rolls back processing date and catches up after repair',async()=>{
 const t=(await rpc(db,ids.employee1,'mutate_task',[team,'create',null,{title:'Проверка сбоя'},null,randomUUID()])).data.entity;
 await clock(db,'2026-11-03T09:00:00+03:00');
 await db.exec(`create function private.test_maintenance_fail() returns trigger language plpgsql as $$begin if new.plan_start<>old.plan_start then raise exception 'TEST_MAINTENANCE_FAILED';end if;return new;end;$$;create trigger test_maintenance_fail before update on public.tasks for each row execute function private.test_maintenance_fail();`);
 try{const r=(await db.query('select private.maintain_all_teams() as r')).rows[0].r;assert.equal(r.errors.length,1);assert.equal(r.processed_teams,0);const state=(await db.query('select last_processed_date::text,maintenance_last_error_code from public.teams')).rows[0];assert.equal(state.last_processed_date,'2026-11-02');assert.equal(state.maintenance_last_error_code,'P0001');}
 finally{await db.exec('drop trigger test_maintenance_fail on public.tasks;drop function private.test_maintenance_fail();');}
 const result=(await db.query('select private.maintain_all_teams() as r')).rows[0].r;assert.equal(result.errors.length,0);assert.equal((await detail(t.id)).plan_start,'2026-11-03');
});
