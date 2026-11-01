import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,rpc,asUser,ids} from './helpers/database.mjs';
import {installClock,clock} from './helpers/step3.mjs';
test('optimized planner preserves full DTO, counts, ordering and pagination across filters and historical days',async()=>{
 const db=await createDatabase();try{await installClock(db);const team=await seedDatabase(db);await clock(db);
  const source=await readFile('supabase/migrations/202611010005_planner.sql','utf8');const reference=source.slice(source.indexOf('create function public.get_planner('),source.indexOf('create function public.get_task_detail(')).replace('create function public.get_planner','create function private.get_planner_reference');await db.exec(reference);
  for(let i=0;i<111;i++){if(i%20===0)await db.exec('truncate private.rate_limit_counters');const payload={title:'Проверка '+i,assignee_id:i%2?ids.employee1:ids.employee2,direction:i%3?'sto':null,important:i%2===0,urgent:i%3===0,deadline:i%5===0?'2026-11-01':null,plan_start:i%7===0?'2026-11-03':'2026-11-02'};
   const r=await rpc(db,ids.manager,'mutate_task',[team,'create',null,payload,null,randomUUID()]);assert.equal(r.ok,true,JSON.stringify(r));if(i%9===0){const s=await rpc(db,ids.manager,'mutate_task',[team,'status',r.data.entity.id,{status:'done'},r.data.entity.version,randomUUID()]);assert.equal(s.ok,true);}}
  await db.exec('truncate private.rate_limit_counters');await clock(db,'2026-11-03T09:00:00+03:00');
  for(const date of ['2026-11-02','2026-11-03','2026-11-04'])for(const filters of [{},{employee_id:ids.employee1},{direction:'none'},{statuses:['done']},{query:'Проверка 1'},{priorities:['important_urgent']},{deadline_filter:'overdue'}]){
   const actual=await rpc(db,ids.manager,'get_planner',[team,date,filters,null]);assert.equal(actual.ok,true,JSON.stringify(actual));await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids.manager]);const expected=(await db.query('select private.get_planner_reference($1,$2,$3,$4) as r',[team,date,filters,null])).rows[0].r;assert.deepEqual(actual.data,expected.data,JSON.stringify({date,filters}));
  }
  for(const cursor of ['0','100']){const actual=await rpc(db,ids.manager,'get_planner',[team,'2026-11-03',{},cursor]);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids.manager]);const expected=(await db.query('select private.get_planner_reference($1,$2,$3,$4) as r',[team,'2026-11-03',{},cursor])).rows[0].r;assert.deepEqual(actual.data,expected.data);}
  await assert.rejects(asUser(db,ids.employee1,"select * from private.day_states($1,date '2026-11-03','{}')",[team]),/permission denied/);
 }finally{await db.close();}
});
