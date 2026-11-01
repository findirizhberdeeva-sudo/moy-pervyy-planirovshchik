// Isolated owner-generated scale fixture. Never connects to the user's cloud or workspace team.
import {writeFile,mkdir} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {createDatabase,seedDatabase,rpc,ids} from '../tests/helpers/database.mjs';
import {installClock,clock} from '../tests/helpers/step3.mjs';
await mkdir('.cache',{recursive:true});const db=await createDatabase();
try{
 await installClock(db);const team=await seedDatabase(db);await clock(db,'2026-11-02T12:00:00+03:00');
 await db.query(`select set_config('ritm.scale_team',$1,false),set_config('ritm.scale_actor',$2,false)`,[team,ids.manager]);
 await db.exec(`insert into auth.users(id,email,email_confirmed_at,encrypted_password)
 select gen_random_uuid(),'scale-'||g||'@example.test',now(),'fixture-only' from generate_series(4,20) g;
 insert into public.team_members(team_id,user_id,display_name,role,state,joined_at)
 select $1,id,'Участник '||email,'employee','active',now() from auth.users where email like 'scale-%';`.replaceAll('$1',"current_setting('ritm.scale_team')::uuid"));
 await db.exec(`create temporary table scale_members as select row_number() over(order by user_id) as n,user_id from public.team_members where team_id=$1;
 insert into public.tasks(id,team_id,created_by,assignee_id,management_mode,title,direction,plan_start,plan_end,original_plan_start,original_plan_end,create_operation_id,effective_created_at,created_at,updated_at,version)
 select gen_random_uuid(),$1,$2,m.user_id,'manager','Проверочная задача '||g,(array['sto','dbk','rental','uk',null])[1+g%5],
 date '2026-11-02'+g%29,date '2026-11-02'+g%29,date '2026-11-02'+g%29,date '2026-11-02'+g%29,gen_random_uuid(),
 '2026-10-01T09:00:00+03:00','2026-10-01T09:00:00+03:00','2026-10-01T18:00:00+03:00',10
 from generate_series(1,10000) g join scale_members m on m.n=1+g%20;
 insert into private.plan_day_entries(task_id,plan_date,placement_version,effective_from)
 select id,plan_start,1,effective_created_at from public.tasks where team_id=$1;
 insert into private.task_events(team_id,task_id,event_type,actor_id,is_system,effective_at,version_before,version_after,before_snapshot,after_snapshot,operation_id)
 select $1,t.id,case when n=1 then 'create' else 'update' end,$2,false,t.created_at+(n-1)*interval '1 hour',
 case when n=1 then null else n-1 end,n,case when n=1 then null else to_jsonb(t)||jsonb_build_object('version',n-1) end,
 to_jsonb(t)||jsonb_build_object('version',n),gen_random_uuid() from public.tasks t cross join generate_series(1,10) n where t.team_id=$1;
 update public.teams set last_processed_date=date '2026-11-02',maintenance_checked_at=private.task_now() where id=$1;
 analyze public.tasks;analyze private.task_events;analyze private.plan_day_entries;`.replaceAll('$1',"current_setting('ritm.scale_team')::uuid").replaceAll('$2',"current_setting('ritm.scale_actor')::uuid"));
 const timings=[],bytes=[];let last;
 for(let i=0;i<6;i++){const start=performance.now(),r=await rpc(db,ids.manager,'get_planner',[team,'2026-11-02',{},null]);if(!r.ok)throw new Error(JSON.stringify(r));last=r.data;const ms=performance.now()-start;if(i){timings.push(Math.round(ms));bytes.push(Buffer.byteLength(JSON.stringify(r)));}console.log('planner',i,Math.round(ms),'ms');}
 if(last.progress.month.planned_count!==10000||last.day_tasks.length>100||!last.next_cursor)throw new Error('Scale totals or pagination mismatch');
 const before=performance.now(),created=await rpc(db,ids.manager,'mutate_task',[team,'create',null,{title:'Проверка сохранения на контрольном наборе'},null,crypto.randomUUID()]);if(!created.ok)throw new Error(JSON.stringify(created));const writeMs=Math.round(performance.now()-before);
 const counts=(await db.query('select (select count(*) from public.team_members) as members,(select count(*) from public.tasks) as tasks,(select count(*) from private.task_events) as events')).rows[0];
 const result={environment:'Local PostgreSQL WASM; not a cloud/network SLA',fixture:{members:20,tasks:10000,events:100000},afterWrite:counts,readMs:timings,p95Ms:[...timings].sort((a,b)=>a-b).at(-1),responseBytes:bytes,writeMs,dayCards:last.day_tasks.length,dayTotal:last.day_total,monthPlanned:last.progress.month.planned_count};
 await writeFile('.cache/step5-scale.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await db.close();}
