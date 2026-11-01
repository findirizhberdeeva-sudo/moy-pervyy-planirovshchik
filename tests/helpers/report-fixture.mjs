import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {rpc,ids} from './database.mjs';
import {clock} from './step3.mjs';
export const reportFixture=JSON.parse((await readFile(new URL('../../tz.md',import.meta.url),'utf8')).match(/```json\s*(\{[\s\S]*?"fixture_version"[\s\S]*?)```/)[1]);
export async function runReportFixture(db,team){
 const map={},series={};await clock(db,reportFixture.seed_time);
 for(const s of reportFixture.series){const r=await rpc(db,ids[s.created_by],'mutate_series',[team,'create',null,null,{title:s.title,assignee_id:ids[s.assignee],direction:s.direction,frequency:s.frequency,weekdays:s.weekdays,start_date:s.start_date,end_date:s.end_date,duration_days:s.duration_days,deadline_offset_days:s.deadline_offset_days},null,randomUUID()]);assert.equal(r.ok,true,JSON.stringify(r));series[s.key]=r.data.entity.id;}
 for(const t of reportFixture.tasks){if(t.series){map[t.key]=(await db.query('select * from public.tasks where series_id=$1 and occurrence_date=$2',[series[t.series],t.occurrence_date])).rows[0];continue;}
 const r=await rpc(db,ids.manager,'mutate_task',[team,'create',null,{title:t.title,assignee_id:ids[t.assignee||'employee1'],direction:t.direction||null,plan_start:t.plan_start,plan_end:t.plan_end||t.plan_start,deadline:t.deadline||null},null,randomUUID()]);assert.equal(r.ok,true,JSON.stringify(r));map[t.key]=r.data.entity;}
 for(const e of reportFixture.events){await clock(db,e.at);assert.equal((await rpc(db,ids.manager,'sync_workspace',[team])).ok,true);
 if(!map[e.task]){const instance=reportFixture.tasks.find(t=>t.key===e.task);map[e.task]=(await db.query('select * from public.tasks where series_id=$1 and occurrence_date=$2',[series[instance.series],instance.occurrence_date])).rows[0];}
 const t=(await rpc(db,ids[e.actor],'get_task_detail',[team,map[e.task].id])).data.task;
 const r=await rpc(db,ids[e.actor],'mutate_task',[team,'status',t.id,{status:e.status,...(e.reason?{reason:e.reason}:{})},t.version,randomUUID()]);assert.equal(r.ok,true,JSON.stringify(r));}
 await clock(db,reportFixture.now);assert.equal((await rpc(db,ids.manager,'sync_workspace',[team])).ok,true);return map;
}
