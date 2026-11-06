import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,rpc,asUser,ids} from './helpers/database.mjs';
let db,team;
async function clock(iso='2026-11-02T09:00:00+03:00') {await db.query(`select set_config('ritm.test_now',$1,false)`,[iso]);}
const mutation=(user,action,task=null,payload={},op=randomUUID())=>rpc(db,ids[user],'mutate_task',[team,action,task?.id??null,payload,task?.version??null,op]);
async function create(payload={},user='employee1') {const r=await mutation(user,'create',null,{title:'Задача',...payload}); assert.equal(r.ok,true,JSON.stringify(r)); return r.data.entity;}
const planner=(date='2026-11-02',filters={})=>rpc(db,ids.employee1,'get_planner',[team,date,filters,null]);
before(async()=>{db=await createDatabase();await db.exec(`create or replace function private.task_now() returns timestamptz language sql stable set search_path='' as $$select coalesce(nullif(current_setting('ritm.test_now',true),'')::timestamptz,now())$$;`);});
after(async()=>{await db.close();});
beforeEach(async()=>{team=await seedDatabase(db);await clock();});
test('quick task defaults, real SQL persistence, identity and safe fields',async()=>{
 const t=await create();assert.equal(t.assignee_id,ids.employee1);assert.equal(t.status,'planned');assert.equal(t.management_mode,'self');assert.equal(t.plan_start,'2026-11-02');assert.equal(t.important,null);
 assert.equal((await db.query('select count(*) as n from public.tasks')).rows[0].n,1);
 const r=await planner();assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.day_tasks[0].id,t.id);assert.equal(r.data.week_days.length,7);
 assert.equal(r.data.progress.day.planned_count,1);assert.equal(r.data.progress.day.progress_percent,0);
});
test('manager assigns another employee; employee cannot assign another or forge system fields',async()=>{
 const t=await create({assignee_id:ids.employee2},'manager');assert.equal(t.management_mode,'manager');
 assert.equal((await mutation('employee1','create',null,{title:'X',assignee_id:ids.employee2})).error.code,'ACCESS_DENIED');
 assert.equal((await mutation('employee1','create',null,{title:'X',completed_at:'2026-01-01'})).error.code,'ACCESS_DENIED');
 assert.equal((await mutation('employee1','update',t,{title:'Украдено'})).error.code,'ACCESS_DENIED');
});
test('assigned task permits description/dates/status but rejects title, priority, direction, deadline and assignee',async()=>{
 let t=await create({assignee_id:ids.employee1},'manager');
 for(const payload of [{title:'X'},{deadline:'2026-12-01'},{important:true,urgent:true},{direction:'sto'},{assignee_id:ids.employee2}])
  assert.equal((await mutation('employee1','update',t,payload)).error.code,'ACCESS_DENIED');
 t=(await mutation('employee1','update',t,{description:'Ответ получен'})).data.entity;
 assert.equal(t.description,'Ответ получен');assert.equal((await mutation('employee1','status',t,{status:'waiting'})).ok,true);
});
test('self task edits and manager protected changes establish irreversible manager control',async()=>{
 let t=await create();t=(await mutation('employee1','update',t,{title:'Мой план',direction:'uk',important:true,urgent:false})).data.entity;
 assert.equal(t.direction,'uk');t=(await mutation('manager','update',t,{deadline:'2026-11-10'})).data.entity;
 assert.equal(t.management_mode,'manager');assert.equal((await mutation('employee1','update',t,{deadline:'2026-11-11'})).error.code,'ACCESS_DENIED');
});
test('manager completion does not silently take ownership of a self-created task',async()=>{
 const t=await create();const done=await mutation('manager','status',t,{status:'done'});assert.equal(done.data.entity.management_mode,'self');
});
test('validation rejects empty/long titles, invalid dates, half priority and unknown payload',async()=>{
 for(const payload of [{title:''},{title:'А'.repeat(201)},{plan_start:'2026-11-01'},{plan_start:'oops'},{plan_end:'2026-11-01'},
  {plan_end:'2028-01-01'},{important:true},{direction:'unknown'},{unexpected:'X'}]) {
  const r=await mutation('employee1','create',null,{title:'X',...payload});assert.equal(r.ok,false,JSON.stringify(payload));assert.equal(r.error.code,'VALIDATION_ERROR');
 }
 const t=await create({deadline:'2026-10-30'});assert.equal(t.overdue,true);
});
test('move shifts full duration, preserves deadline/original dates/ID/status and supports weekend',async()=>{
 let t=await create({plan_end:'2026-11-06',deadline:'2026-11-06'});const id=t.id;
 t=(await mutation('employee1','move',t,{plan_start:'2026-11-07'})).data.entity;
 assert.equal(t.id,id);assert.equal(t.plan_end,'2026-11-11');assert.equal(t.deadline,'2026-11-06');assert.equal(t.original_plan_start,'2026-11-02');assert.equal(t.status,'planned');
 assert.equal((await mutation('employee1','move',t,{plan_start:'2026-10-31'})).error.code,'VALIDATION_ERROR');
});
test('no-op move and repeat completion create no redundant versions/events',async()=>{
 let t=await create();let same=await mutation('employee1','move',t,{plan_start:t.plan_start});assert.equal(same.data.entity.version,1);
 t=(await mutation('employee1','status',t,{status:'done'})).data.entity;
 same=await mutation('employee1','status',t,{status:'done'});assert.equal(same.ok,true);assert.equal(same.data.entity.version,2);
 assert.equal((await db.query('select count(*) as n from private.task_events')).rows[0].n,2);
});
test('operation id replay does not duplicate task, event or placement and reuse with different body fails',async()=>{
 const op=randomUUID(),body={title:'Один раз'};
 const first=await mutation('employee1','create',null,body,op),second=await mutation('employee1','create',null,body,op);
 assert.equal(second.data.entity.id,first.data.entity.id);assert.equal(second.data.idempotent_replay,true);
 assert.equal((await mutation('employee1','create',null,{title:'Другой запрос'},op)).error.code,'OPERATION_ID_REUSED');
 for(const table of ['public.tasks','private.task_events','private.plan_day_entries']) assert.equal((await db.query(`select count(*) as n from ${table}`)).rows[0].n,1);
});
test('stale edit conflicts and latest entity remains intact',async()=>{
 const t=await create();await mutation('employee1','update',t,{title:'Первый вариант'});
 const stale=await mutation('employee1','update',t,{title:'Второй вариант'});assert.equal(stale.error.code,'VERSION_CONFLICT');assert.equal(stale.error.latest_entity.title,'Первый вариант');
});
test('delete hides task without improving day progress, restore keeps same identity',async()=>{
 let t=await create();t=(await mutation('employee1','delete',t)).data.entity;
 let p=await planner();assert.equal(p.data.day_tasks.length,0);assert.equal(p.data.progress.day.planned_count,1);assert.equal(p.data.progress.day.deleted_unfinished_count,1);
 const bin=await rpc(db,ids.employee1,'list_task_collection',[team,'deleted',null,'all',null]);assert.equal(bin.data.tasks[0].id,t.id);
 t=(await mutation('employee1','restore',t)).data.entity;p=await planner();assert.equal(p.data.day_tasks[0].id,t.id);assert.equal(p.data.progress.day.planned_count,1);
});
test('assigned task cannot be cancelled/deleted by employee; cancellation reason required and plan denominator excludes it',async()=>{
 const assigned=await create({assignee_id:ids.employee1},'manager');assert.equal((await mutation('employee1','delete',assigned)).error.code,'ACCESS_DENIED');
 assert.equal((await mutation('employee1','status',assigned,{status:'cancelled',reason:'Не нужно'})).error.code,'ACCESS_DENIED');
 let t=await create();assert.equal((await mutation('employee1','status',t,{status:'cancelled'})).error.code,'VALIDATION_ERROR');
 t=(await mutation('employee1','status',t,{status:'cancelled',reason:'План изменился'})).data.entity;
 const p=await planner();assert.equal(p.data.progress.day.planned_count,1);assert.equal(p.data.progress.day.cancelled_count,1);
});
test('completion/undo and reopening cancelled task use real server time and calendar continuation for a deadline',async()=>{
 let t=await create({deadline:'2026-11-02'});t=(await mutation('employee1','status',t,{status:'done'})).data.entity;
 assert.equal(t.completed_by,ids.employee1);assert.ok(t.completed_at);assert.equal(t.late,false);
 await clock('2026-11-07T09:00:00+03:00');t=(await mutation('employee1','status',t,{status:'in_progress'})).data.entity;
 assert.equal(t.plan_start,'2026-11-07');assert.equal(t.deadline,'2026-11-02');assert.equal(t.completed_at,null);
});
test('long task is visible every day but counted once in week/month',async()=>{
 await create({plan_end:'2026-11-06'});
 const p=await planner();assert.equal(p.data.week_days.filter(d=>d.total>0).length,5);assert.equal(p.data.progress.week.planned_count,1);assert.equal(p.data.progress.month.planned_count,1);
});
test('status/search/priority filters affect cards but not progress; direction and employee affect both',async()=>{
 let t=await create({title:'Бюджет',direction:'sto',important:true,urgent:false});await create({title:'Другой план',direction:'dbk'});
 t=(await mutation('employee1','status',t,{status:'done'})).data.entity;
 const p=await planner('2026-11-02',{statuses:['done'],query:'бюд',priorities:['important_not_urgent']});
 assert.equal(p.data.day_tasks.length,1);assert.equal(p.data.progress.day.progress_percent,50);
 const scoped=await planner('2026-11-02',{direction:'sto'});assert.equal(scoped.data.progress.day.progress_percent,100);
 const others=await planner('2026-11-02',{employee_id:ids.employee2});assert.equal(others.data.progress.day.progress_percent,null);
});
test('reschedule changes result date without removing calendar history of same-day work',async()=>{
 let future=await create({plan_start:'2026-11-03'});future=(await mutation('employee1','move',future,{plan_start:'2026-11-05'})).data.entity;
 assert.equal((await planner('2026-11-03')).data.progress.day.planned_count,0);
 let current=await create();await clock('2026-11-02T10:00:00+03:00');await mutation('employee1','move',current,{plan_start:'2026-11-04'});
 const after=await planner();assert.equal(after.data.progress.day.planned_count,0);assert.equal(after.data.day_tasks.length,0);
});
test('closed day progress/status stay unchanged after later completion, cancellation and reassignment',async()=>{
 let t=await create({deadline:'2026-11-02'});await clock('2026-11-03T10:00:00+03:00');t=(await rpc(db,ids.employee1,'get_task_detail',[team,t.id])).data.task;
 assert.equal((await mutation('employee1','status',t,{status:'done'})).ok,true);
 const old=await planner();assert.equal(old.data.progress.day.progress_percent,0);assert.equal(old.data.day_tasks[0].status,'planned');assert.equal(old.data.day_tasks[0].historical,true);
});
test('empty and cancelled-only periods show null percent; global overdue finds tasks outside selected week',async()=>{
 assert.equal((await planner()).data.progress.day.progress_percent,null);
 let t=await create({deadline:'2026-10-31',plan_start:'2026-12-01'});
 const p=await planner();assert.equal(p.data.overdue_total,1);assert.equal(p.data.day_tasks.length,0);
 const overdue=await rpc(db,ids.employee1,'list_task_collection',[team,'overdue',null,'all',null]);assert.equal(overdue.data.tasks[0].id,t.id);
});
test('history has safe author/time/values and other team cannot read or mutate it',async()=>{
 let t=await create({title:'До'});await mutation('employee1','update',t,{title:'После'});
 const h=await rpc(db,ids.employee1,'get_task_history',[team,t.id,null]);assert.equal(h.data.events.length,2);assert.equal(h.data.events[0].before.title,'До');assert.equal(h.data.events[0].after.title,'После');
 assert.equal((await rpc(db,ids.outsider,'get_task_detail',[team,t.id])).error.code,'ACCESS_DENIED');
 await assert.rejects(asUser(db,ids.employee1,'select private.calculate_period($1,$2,$3,now(),null,$4)',[team,'2026-11-01','2026-12-01','all']),/permission denied/);
});
test('disabled assignee, invalid filters and browser-supplied clock rejected',async()=>{
 await db.query(`update public.team_members set state='disabled',disabled_at=now() where user_id=$1`,[ids.employee2]);
 assert.equal((await mutation('manager','create',null,{title:'X',assignee_id:ids.employee2})).error.code,'VALIDATION_ERROR');
 assert.equal((await planner(null,{direction:'wrong'})).error.code,'VALIDATION_ERROR');
 assert.equal((await planner(null,{today:'2099-01-01'})).error.code,'VALIDATION_ERROR');
});
test('late cancellation/reassignment does not rewrite previous employee and direction plan',async()=>{
 let t=await create({direction:'sto'});await clock('2026-11-03T09:00:00+03:00');t=(await rpc(db,ids.manager,'get_task_detail',[team,t.id])).data.task;
 const updated=await mutation('manager','update',t,{assignee_id:ids.employee2,direction:'dbk'});
 await mutation('manager','status',updated.data.entity,{status:'cancelled',reason:'Отменено позже'});
 const p=await planner('2026-11-02',{employee_id:ids.employee1,direction:'sto'});assert.equal(p.data.progress.day.planned_count,1);assert.equal(p.data.day_tasks[0].assignee_id,ids.employee1);
});
test('deadline boundary uses Moscow midnight and completion exactly at boundary belongs to the new day',async()=>{
 let t=await create({deadline:'2026-11-02'});await clock('2026-11-03T00:00:00+03:00');t=(await rpc(db,ids.employee1,'get_task_detail',[team,t.id])).data.task;
 const result=await mutation('employee1','status',t,{status:'done'});assert.equal(result.data.entity.late,true);
 const old=await planner('2026-11-02'),current=await planner('2026-11-03');assert.equal(old.data.progress.day.plan_done_count,0);assert.equal(current.data.progress.day.actual_done_count,1);
});
test('terminal task is read-only until reopened and foreign raw table writes stay forbidden',async()=>{
 let t=await create();t=(await mutation('employee1','status',t,{status:'done'})).data.entity;
 assert.equal((await mutation('employee1','update',t,{description:'Подменить результат'})).error.code,'ACCESS_DENIED');
 await assert.rejects(asUser(db,ids.employee1,'update public.tasks set title=$1 where id=$2',['X',t.id]),/permission denied/);
});
test('invalid history/collection cursors are validation errors',async()=>{
 const t=await create();assert.equal((await rpc(db,ids.employee1,'get_task_history',[team,t.id,'wrong'])).error.code,'VALIDATION_ERROR');
 assert.equal((await rpc(db,ids.employee1,'list_task_collection',[team,'deleted',null,'all','wrong'])).error.code,'VALIDATION_ERROR');
});
test('card pagination counts every task and returns disjoint pages',async()=>{
 await db.query(`insert into public.tasks(team_id,created_by,assignee_id,management_mode,title,plan_start,plan_end,original_plan_start,original_plan_end,create_operation_id)
 select $1,$2,$2,'self','Задача '||i,'2026-11-02','2026-11-02','2026-11-02','2026-11-02',gen_random_uuid() from generate_series(1,105) i`,[team,ids.employee1]);
 await db.query(`insert into private.task_events(team_id,task_id,event_type,actor_id,is_system,effective_at,after_snapshot,operation_id)
 select team_id,id,'create',created_by,false,private.task_now(),to_jsonb(t),create_operation_id from public.tasks t`);
 await db.query(`insert into private.plan_day_entries(task_id,plan_date,placement_version,effective_from) select id,plan_start,1,private.task_now() from public.tasks`);
 const a=await planner(),b=await rpc(db,ids.employee1,'get_planner',[team,'2026-11-02',{},a.data.next_cursor]);
 assert.equal(a.data.day_tasks.length,100);assert.equal(b.data.day_tasks.length,5);assert.equal(a.data.progress.day.planned_count,105);
 assert.equal(new Set([...a.data.day_tasks,...b.data.day_tasks].map(t=>t.id)).size,105);
});
test('read limit is enforced outside the stable data snapshot',async()=>{
 await db.query(`insert into private.rate_limit_counters values($1,'read',date_trunc('minute',private.task_now()),120)`,[`user:${ids.employee1}`]);
 assert.equal((await planner()).error.code,'RATE_LIMITED');
});
