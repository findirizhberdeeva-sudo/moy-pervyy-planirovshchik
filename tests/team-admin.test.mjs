import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,rpc,asUser,ids} from './helpers/database.mjs';
import {installClock,clock,serviceCommand} from './helpers/step3.mjs';
let db,team;
before(async()=>{db=await createDatabase();await installClock(db);});after(async()=>{await db.close();});beforeEach(async()=>{team=await seedDatabase(db);await clock(db);});
const admin=(action,payload={},version=null,op=randomUUID(),phase='begin',outcome={},actor=ids.manager)=>serviceCommand(db,[team,actor,action,payload,version,op,phase,outcome]);
const member=async id=>(await db.query('select * from public.team_members where team_id=$1 and user_id=$2',[team,id])).rows[0];
async function createTask(patch={},user='employee1'){const r=await rpc(db,ids[user],'mutate_task',[team,'create',null,{title:'Передать',...patch},null,randomUUID()]);assert.equal(r.ok,true,JSON.stringify(r));return r.data.entity;}
test('admin endpoint SQL is service-only and role cannot be supplied by an employee',async()=>{
 await assert.rejects(rpc(db,ids.manager,'team_admin_command',[team,ids.manager,'list_team_admin',{},null,null,'begin',{}]),/permission denied/);
 assert.equal((await rpc(db,ids.employee1,'authorize_team_admin',[team])).error.code,'ACCESS_DENIED');
 assert.equal((await admin('list_team_admin',{},null,null,'begin',{},ids.employee1)).error.code,'ACCESS_DENIED');
 assert.equal((await rpc(db,ids.manager,'authorize_team_admin',[team])).ok,true);
});
test('invitation intent is durable, double creation keeps one record, finish binds exact Auth identity',async()=>{
 const op=randomUUID(),payload={email:'  NEW@EXAMPLE.TEST ',display_name:'Новый сотрудник'};const begin=await admin('invite_employee',payload,null,op);assert.equal(begin.ok,true,JSON.stringify(begin));assert.equal(begin.data.entity.state,'pending');
 const duplicate=await admin('invite_employee',payload);assert.equal(duplicate.data.entity.id,begin.data.entity.id);assert.equal(duplicate.data.next_step,null);
 assert.equal((await admin('invite_employee',payload,null,op)).error.code,'RATE_LIMITED');
 const user=randomUUID();await db.query('insert into auth.users values($1,$2,null,null)',[user,'new@example.test']);
 const done=await admin('invite_employee',payload,null,op,'finish',{ok:true,user_id:user});assert.equal(done.ok,true,JSON.stringify(done));assert.equal(done.data.entity.state,'sent');assert.equal((await member(user)).state,'invited');
 assert.equal((await admin('invite_employee',payload,null,op)).data.idempotent_replay,true);assert.equal((await db.query('select count(*) as n from private.invitations')).rows[0].n,1);
 assert.equal((await rpc(db,user,'activate_invited_member')).error.code,'INVITATION_PENDING');
 await db.query(`update auth.users set email_confirmed_at=now(),encrypted_password='new-hash' where id=$1`,[user]);assert.equal((await rpc(db,user,'activate_invited_member')).ok,true);assert.equal((await member(user)).role,'employee');
});
test('delivery failure is visible, resend is throttled and cancelled invitation never activates',async()=>{
 const payload={email:'outsider@example.test',display_name:'Приглашённый'},op=randomUUID();let r=await admin('invite_employee',payload,null,op);assert.equal(r.ok,true,JSON.stringify(r));
 r=await admin('invite_employee',payload,null,op,'finish',{ok:false,error_code:'AUTH_MAIL_FAILED'});assert.equal(r.data.entity.state,'failed');let inv=r.data.entity;
 assert.equal((await admin('resend_invitation',{invitation_id:inv.id},inv.version)).error.code,'RATE_LIMITED');
 await clock(db,'2026-11-02T09:01:01+03:00');const resend=randomUUID(),resendVersion=inv.version;r=await admin('resend_invitation',{invitation_id:inv.id},resendVersion,resend);assert.equal(r.ok,true,JSON.stringify(r));inv=r.data.entity;
 r=await admin('cancel_invitation',{invitation_id:inv.id},inv.version);assert.equal(r.data.entity.state,'cancelled');
 r=await admin('resend_invitation',{invitation_id:inv.id},resendVersion,resend,'finish',{ok:true,user_id:ids.outsider});assert.equal(r.data.entity.state,'cancelled');assert.equal(await member(ids.outsider),undefined);
 assert.equal((await rpc(db,ids.outsider,'activate_invited_member')).error.code,'ACCESS_DENIED');
});
test('existing confirmed Auth user must set a new password and invitation expires after 24h',async()=>{
 const payload={email:'outsider@example.test',display_name:'Подтверждённый'},op=randomUUID();await admin('invite_employee',payload,null,op);let r=await admin('invite_employee',payload,null,op,'finish',{ok:true,user_id:ids.outsider});assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal((await rpc(db,ids.outsider,'activate_invited_member')).error.code,'INVITATION_PENDING');
 await db.query(`update auth.users set encrypted_password='changed' where id=$1`,[ids.outsider]);await clock(db,'2026-11-03T09:00:01+03:00');
 assert.equal((await rpc(db,ids.outsider,'activate_invited_member')).error.code,'ACCESS_DENIED');
});
test('password set before delivery finalization is compared with the pre-send hash',async()=>{
 const payload={email:'outsider@example.test',display_name:'Быстро открыл письмо'},op=randomUUID();await admin('invite_employee',payload,null,op);
 await db.query(`update auth.users set encrypted_password='set-before-finalization' where id=$1`,[ids.outsider]);
 assert.equal((await admin('invite_employee',payload,null,op,'finish',{ok:true,user_id:ids.outsider})).ok,true);
 assert.equal((await rpc(db,ids.outsider,'activate_invited_member')).ok,true);
});
test('invitation counters enforce five mails per UTC quarter and replay does not repeat a completed send',async()=>{
 for(let n=0;n<5;n++) {
  const payload={email:'mail'+n+'@example.test',display_name:'Почта'},op=randomUUID();assert.equal((await admin('invite_employee',payload,null,op)).ok,true);
  await admin('invite_employee',payload,null,op,'finish',{ok:false,error_code:'AUTH_MAIL_FAILED'});
 }
 assert.equal((await admin('invite_employee',{email:'mail6@example.test',display_name:'Лимит'})).error.code,'RATE_LIMITED');
 assert.equal((await db.query('select count(*) as n from private.invitations')).rows[0].n,5);
});
test('disable requires replacement, atomically transfers active tasks/series and emits one summary',async()=>{
 const regular=await rpc(db,ids.employee1,'mutate_series',[team,'create',null,null,{title:'Регулярная',frequency:'daily',end_date:'2026-11-04'},null,randomUUID()]);assert.equal(regular.ok,true,JSON.stringify(regular));
 let terminal=await createTask();terminal=(await rpc(db,ids.employee1,'mutate_task',[team,'status',terminal.id,{status:'done'},terminal.version,randomUUID()])).data.entity;
 const deleted=await createTask();await rpc(db,ids.employee1,'mutate_task',[team,'delete',deleted.id,{},deleted.version,randomUUID()]);
 const current=await member(ids.employee1);assert.equal((await admin('disable_employee',{user_id:ids.employee1},current.version)).error.code,'VALIDATION_ERROR');
 const op=randomUUID(),payload={user_id:ids.employee1,replacement_id:ids.employee2};const result=await admin('disable_employee',payload,current.version,op);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.data.auth_sync_pending,true);
 assert.equal((await member(ids.employee1)).state,'disabled');assert.equal((await rpc(db,ids.employee1,'get_access_context')).error.code,'ACCESS_DENIED');assert.equal((await asUser(db,ids.employee1,'select * from public.tasks')).rows.length,0);
 assert.equal((await db.query('select assignee_id from public.tasks where id=$1',[terminal.id])).rows[0].assignee_id,ids.employee1);assert.equal((await db.query('select assignee_id from public.tasks where id=$1',[deleted.id])).rows[0].assignee_id,ids.employee1);
 assert.equal((await db.query(`select count(*) as n from public.tasks where deleted_at is null and status='planned' and assignee_id=$1`,[ids.employee1])).rows[0].n,0);
 assert.equal((await db.query(`select count(*) as n from public.notifications where recipient_id=$1 and type='bulk_assigned'`,[ids.employee2])).rows[0].n,1);
 assert.equal((await db.query(`select count(*) as n from public.notifications where recipient_id=$1 and type='assigned'`,[ids.employee2])).rows[0].n,0);
 const finished=await admin('disable_employee',payload,current.version,op,'finish',{ok:false});assert.equal(finished.data.auth_sync_pending,true);
 const retry=await admin('disable_employee',payload,current.version,op);assert.equal(retry.data.idempotent_replay,true);
 await admin('disable_employee',payload,current.version,op,'finish',{ok:true});assert.equal((await admin('disable_employee',payload,current.version,op)).data.auth_sync_pending,false);
});
test('database failure rolls back membership, every transferred task and operation result',async()=>{
 const a=await createTask(),b=await createTask();const m=await member(ids.employee1),op=randomUUID();
 await db.exec(`create function private.test_fail_transfer() returns trigger language plpgsql as $$begin if new.assignee_id<>old.assignee_id then raise exception 'TEST_TRANSFER_FAILURE';end if;return new;end;$$;create trigger test_fail_transfer before update on public.tasks for each row execute function private.test_fail_transfer();`);
 try{await assert.rejects(admin('disable_employee',{user_id:ids.employee1,replacement_id:ids.employee2},m.version,op),/TEST_TRANSFER_FAILURE/);}finally{await db.exec('drop trigger test_fail_transfer on public.tasks;drop function private.test_fail_transfer();');}
 assert.equal((await member(ids.employee1)).state,'active');assert.equal((await db.query('select count(*) as n from public.tasks where id=any($1::uuid[]) and assignee_id=$2',[[a.id,b.id],ids.employee1])).rows[0].n,2);
 assert.equal((await db.query('select count(*) as n from private.operation_results where operation_id=$1',[op])).rows[0].n,0);
});
test('last manager cannot be disabled; reenable keeps transferred tasks with new owner',async()=>{
 const manager=await member(ids.manager);assert.equal((await admin('disable_employee',{user_id:ids.manager},manager.version)).error.code,'LAST_MANAGER');
 const t=await createTask(),m=await member(ids.employee1);await admin('disable_employee',{user_id:ids.employee1,replacement_id:ids.employee2},m.version);
 const disabled=await member(ids.employee1);const result=await admin('enable_employee',{user_id:ids.employee1},disabled.version);assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal((await member(ids.employee1)).state,'active');assert.equal((await db.query('select assignee_id from public.tasks where id=$1',[t.id])).rows[0].assignee_id,ids.employee2);
});
test('team list contains administrative emails/counts but employee board never receives invitations',async()=>{
 await createTask();const list=await admin('list_team_admin',{},null,null);assert.equal(list.ok,true,JSON.stringify(list));assert.equal(list.data.members.length,3);assert.equal(list.data.members.find(m=>m.user_id===ids.employee1).active_task_count,1);
 const plan=await rpc(db,ids.employee1,'get_planner',[team,null,{},null]);assert.ok(!JSON.stringify(plan.data.members).includes('@'));await assert.rejects(asUser(db,ids.employee1,'select * from private.invitations'),/permission denied/);
});
test('an old pending Auth operation converges to newer membership state instead of reversing it',async()=>{
 const employee=await member(ids.employee1),disableOp=randomUUID(),disablePayload={user_id:ids.employee1};
 await admin('disable_employee',disablePayload,employee.version,disableOp);
 const disabled=await member(ids.employee1);await admin('enable_employee',{user_id:ids.employee1},disabled.version);
 const late=await admin('disable_employee',disablePayload,employee.version,disableOp,'finish',{ok:true});
 assert.equal(late.data.next_step,'sync_auth');assert.equal(late.data.admin_work.disabled,false);assert.equal(late.data.auth_sync_superseded,true);
 const done=await admin('disable_employee',disablePayload,employee.version,disableOp,'finish',{ok:true});assert.equal(done.data.auth_sync_pending,false);assert.equal((await member(ids.employee1)).state,'active');
});
test('superseded email attempt cannot resend or reactivate after a newer resend owns the lease',async()=>{
 const payload={email:'outsider@example.test',display_name:'Повтор'},oldOp=randomUUID();const first=await admin('invite_employee',payload,null,oldOp);
 await clock(db,'2026-11-02T09:01:01+03:00');const second=await admin('resend_invitation',{invitation_id:first.data.entity.id},first.data.entity.version);
 assert.equal(second.ok,true,JSON.stringify(second));const replay=await admin('invite_employee',payload,null,oldOp);assert.equal(replay.data.next_step,null);
});
