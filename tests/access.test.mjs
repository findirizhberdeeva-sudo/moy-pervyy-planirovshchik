import { before,after,beforeEach,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {createDatabase,seedDatabase,asUser,rpc,ids} from './helpers/database.mjs';
let db,team;
before(async()=>{db=await createDatabase();});
after(async()=>{if(db&&!db.closed) await db.close();});
beforeEach(async()=>{team=await seedDatabase(db);});
test('migrations create all 13 tables with RLS and deny direct browser writes',async()=>{
  const {rows}=await db.query(`select n.nspname,c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind='r'`);
  assert.equal(rows.length,13); assert.ok(rows.every(r=>r.relrowsecurity));
  for(const row of rows) {
    const privilege=await db.query(`select has_table_privilege('authenticated',$1,'INSERT,UPDATE,DELETE') as allowed`,[`${row.nspname}.${row.relname}`]);
    assert.equal(privilege.rows[0].allowed,false,`${row.relname} has direct writes`);
  }
});
test('manager and two employees get their actual role and same team; no account email leakage',async()=>{
  for(const key of ['manager','employee1','employee2']) {
    const result=await rpc(db,ids[key],'get_access_context');
    assert.equal(result.ok,true); assert.equal(result.data.team.id,team);
    assert.equal(result.data.member.role,key==='manager'?'manager':'employee');
    assert.equal(result.data.user.email,`${key}@example.test`);
  }
  const {rows}=await asUser(db,ids.employee1,`select * from public.team_members`);
  assert.equal(rows.length,3); assert.ok(rows.every(r=>!('email' in r)));
});
test('anonymous cannot invoke access RPC or read any public data',async()=>{
  await assert.rejects(rpc(db,null,'get_access_context'),/permission denied/);
  for(const table of ['teams','team_members','tasks','comments','notifications','recurrence_series']) await assert.rejects(asUser(db,null,`select * from public.${table}`),/permission denied/);
});
test('outsider gets no rows and no access context',async()=>{
  assert.equal((await asUser(db,ids.outsider,'select * from public.teams')).rows.length,0);
  assert.equal((await asUser(db,ids.outsider,'select * from public.team_members')).rows.length,0);
  assert.equal((await rpc(db,ids.outsider,'get_access_context')).error.code,'ACCESS_DENIED');
});
test('disabling a member revokes access even when the identity/token is unchanged',async()=>{
  await db.query(`update public.team_members set state='disabled',disabled_at=now() where user_id=$1`,[ids.employee1]);
  assert.equal((await rpc(db,ids.employee1,'get_access_context')).error.code,'ACCESS_DENIED');
  assert.equal((await asUser(db,ids.employee1,'select * from public.teams')).rows.length,0);
  assert.equal((await rpc(db,ids.employee1,'update_profile',[team,'Новое имя',2,randomUUID()])).error.code,'ACCESS_DENIED');
});
test('only own name can be changed through RPC; role and other members are immutable to browser',async()=>{
  const result=await rpc(db,ids.employee1,'update_profile',[team,'  Анна  ',1,randomUUID()]);
  assert.equal(result.ok,true); assert.equal(result.data.context.member.display_name,'Анна');
  assert.equal(result.data.context.member.version,2); assert.equal(result.data.context.member.role,'employee');
  assert.equal((await rpc(db,ids.employee2,'get_access_context')).data.member.display_name,'Сотрудник 2');
  await assert.rejects(asUser(db,ids.employee1,`update public.team_members set role='manager' where user_id=$1`,[ids.employee1]),/permission denied/);
  await assert.rejects(asUser(db,ids.manager,`update public.team_members set display_name='Чужое' where user_id=$1`,[ids.employee2]),/permission denied/);
});
test('profile changes persist in actual database after repeated context reads',async()=>{
  await rpc(db,ids.employee1,'update_profile',[team,'Елена',1,randomUUID()]);
  assert.equal((await db.query('select display_name from public.team_members where user_id=$1',[ids.employee1])).rows[0].display_name,'Елена');
  assert.equal((await rpc(db,ids.employee1,'get_access_context')).data.member.display_name,'Елена');
});
test('empty and overlong names fail both RPC validation and database constraints',async()=>{
  for(const name of ['', '   ','А'.repeat(81)]) {
    assert.equal((await rpc(db,ids.employee1,'update_profile',[team,name,1,randomUUID()])).error.code,'VALIDATION_ERROR');
    await assert.rejects(db.query('update public.team_members set display_name=$1 where user_id=$2',[name,ids.employee1]),/check constraint/);
  }
});
test('repeated operation returns the same result once and does not bump profile version',async()=>{
  const op=randomUUID();
  assert.equal((await rpc(db,ids.employee1,'update_profile',[team,'Анна',1,op])).data.idempotent_replay,false);
  assert.equal((await rpc(db,ids.employee1,'update_profile',[team,'Анна',1,op])).data.idempotent_replay,true);
  assert.equal((await rpc(db,ids.employee1,'get_access_context')).data.member.version,2);
  assert.equal((await rpc(db,ids.employee1,'update_profile',[team,'Другое',1,op])).error.code,'OPERATION_ID_REUSED');
});
test('stale version cannot overwrite the saved profile',async()=>{
  await rpc(db,ids.employee1,'update_profile',[team,'Первое имя',1,randomUUID()]);
  const result=await rpc(db,ids.employee1,'update_profile',[team,'Второе имя',1,randomUUID()]);
  assert.equal(result.error.code,'VERSION_CONFLICT'); assert.equal(result.error.latest_entity.display_name,'Первое имя');
});
test('private history/bootstrap and rate functions are not callable by client',async()=>{
  for(const sql of [`select * from private.invitations`,`select * from private.task_events`,
    `select private.bootstrap_team('outsider@example.test','X')`,`select private.consume_write_rate('${team}')`]) await assert.rejects(asUser(db,ids.employee1,sql),/permission denied/);
  await assert.rejects(db.query(`select private.bootstrap_team('outsider@example.test','X')`),/ALREADY_INITIALIZED/);
});
test('database prevents disabling the last manager and cross-team task relationships',async()=>{
  await assert.rejects(db.query(`update public.team_members set state='disabled',disabled_at=now() where user_id=$1`,[ids.manager]),/LAST_MANAGER/);
  const other=(await db.query(`insert into public.teams(name) values('Другие') returning id`)).rows[0].id;
  await assert.rejects(db.query(`insert into public.tasks(team_id,created_by,assignee_id,management_mode,title,plan_start,plan_end,original_plan_start,original_plan_end,create_operation_id) values($1,$2,$2,'manager','X',current_date,current_date,current_date,current_date,$3)`,[other,ids.manager,randomUUID()]),/foreign key constraint/);
});
test('an active member of another team sees only their own workspace',async()=>{
  const other=(await db.query(`insert into public.teams(name) values('Другая команда') returning id`)).rows[0].id;
  await db.query(`insert into public.team_members(team_id,user_id,display_name,role,state,joined_at) values($1,$2,'Другой','manager','active',now())`,[other,ids.outsider]);
  const {rows}=await asUser(db,ids.employee1,'select id from public.teams'); assert.deepEqual(rows.map(x=>x.id),[team]);
  assert.equal((await rpc(db,ids.employee1,'update_profile',[other,'X',1,randomUUID()])).error.code,'ACCESS_DENIED');
});
test('invitation activation requires a sent, unexpired, verified invitation and cannot self-assign manager',async()=>{
  await db.query(`insert into public.team_members(team_id,user_id,display_name,role,state) values($1,$2,'Новый','employee','invited')`,[team,ids.outsider]);
  assert.equal((await rpc(db,ids.outsider,'get_access_context')).error.code,'INVITATION_PENDING');
  assert.equal((await rpc(db,ids.outsider,'activate_invited_member')).error.code,'ACCESS_DENIED');
  await db.query(`insert into private.invitations(team_id,email,display_name,user_id,state,inviter_id,expires_at,operation_id) values($1,'outsider@example.test','Новый',$2,'sent',$3,now()+interval '24 hours',$4)`,[team,ids.outsider,ids.manager,randomUUID()]);
  const result=await rpc(db,ids.outsider,'activate_invited_member'); assert.equal(result.ok,true); assert.equal(result.data.member.role,'employee');
  assert.equal((await rpc(db,ids.outsider,'activate_invited_member')).ok,true);
});
test('profile write rate is enforced in SQL',async()=>{
  await db.query(`insert into private.rate_limit_counters values($1,'write',date_trunc('minute',now()),60)`,[`user:${ids.employee1}`]);
  assert.equal((await rpc(db,ids.employee1,'update_profile',[team,'Имя',1,randomUUID()])).error.code,'RATE_LIMITED');
  assert.equal((await rpc(db,ids.employee1,'get_access_context')).data.member.display_name,'Сотрудник 1');
});
