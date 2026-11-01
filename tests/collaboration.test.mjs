import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,rpc,asUser,ids} from './helpers/database.mjs';
import {installClock,clock} from './helpers/step3.mjs';
let db,team;
before(async()=>{db=await createDatabase();await installClock(db);});after(async()=>{await db.close();});
beforeEach(async()=>{team=await seedDatabase(db);await clock(db);});
async function task(user='employee1',patch={}) {const r=await rpc(db,ids[user],'mutate_task',[team,'create',null,{title:'Обсуждение',...patch},null,randomUUID()]);assert.equal(r.ok,true,JSON.stringify(r));return r.data.entity;}
const comment=(user,action,t,c=null,body='Комментарий',op=randomUUID())=>rpc(db,ids[user],'mutate_comment',[team,action,t.id,c?.id||null,body,c?.version||null,op]);
const notices=user=>rpc(db,ids[user],'get_notifications',[team,false,null]);
test('assignment and manager completion notifications have correct recipients and no replay duplicates',async()=>{
 const op=randomUUID(),args=[team,'create',null,{title:'Назначено',assignee_id:ids.employee1},null,op];
 let t=(await rpc(db,ids.manager,'mutate_task',args)).data.entity;await rpc(db,ids.manager,'mutate_task',args);
 assert.equal((await notices('employee1')).data.notifications.filter(n=>n.type==='assigned').length,1);assert.equal((await notices('manager')).data.notifications.length,0);
 t=(await rpc(db,ids.employee1,'mutate_task',[team,'status',t.id,{status:'done'},t.version,randomUUID()])).data.entity;
 assert.equal((await notices('manager')).data.notifications.filter(n=>n.type==='completed').length,1);
 await task('manager');assert.equal((await notices('manager')).data.notifications.filter(n=>n.type==='assigned').length,0);
});
test('comment recipients deduplicate creator/assignee and exclude the commenting user',async()=>{
 const t=await task();const op=randomUUID();const a=await comment('employee2','create',t,null,'Новый текст',op);assert.equal(a.ok,true);
 const replay=await comment('employee2','create',t,null,'Новый текст',op);assert.equal(replay.data.idempotent_replay,true);
 assert.equal((await notices('employee1')).data.notifications.filter(n=>n.type==='comment').length,1);assert.equal((await notices('employee2')).data.notifications.length,0);
 assert.equal((await db.query('select count(*) as n from public.comments')).rows[0].n,1);
 assert.equal((await comment('employee2','create',t,null,'Иной текст',op)).error.code,'OPERATION_ID_REUSED');
});
test('comment edits require author/version; manager may delete but cannot rewrite another author',async()=>{
 const t=await task();const c=(await comment('employee1','create',t)).data.entity;
 assert.equal((await comment('employee2','update',t,c,'Подмена')).error.code,'ACCESS_DENIED');assert.equal((await comment('manager','update',t,c,'Подмена')).error.code,'ACCESS_DENIED');
 const edited=await comment('employee1','update',t,c,'Исправлено');assert.equal(edited.ok,true);
 const conflict=await comment('employee1','update',t,c,'Старый черновик');assert.equal(conflict.error.code,'VERSION_CONFLICT');assert.equal(conflict.error.latest_entity.body,'Исправлено');
 assert.equal((await notices('employee1')).data.notifications.filter(n=>n.type==='comment').length,0);
 assert.equal((await comment('manager','delete',t,edited.data.entity,null)).ok,true);
});
test('deleted text is hidden from rows, task DTOs and employee history; manager audit retains it',async()=>{
 const t=await task();const c=(await comment('employee1','create',t,null,'Закрытый прежний текст')).data.entity;
 await comment('manager','delete',t,c,null);
 const rows=await rpc(db,ids.employee2,'list_comments',[team,t.id,null,false]);assert.equal(rows.data.comments[0].body,'');assert.ok(rows.data.comments[0].deleted_at);
 const raw=(await asUser(db,ids.employee2,'select * from public.comments')).rows;assert.equal(raw[0].body,'');
 const history=await rpc(db,ids.employee2,'get_task_history',[team,t.id,null]);assert.ok(!JSON.stringify(history).includes('Закрытый прежний текст'));
 const detail=await rpc(db,ids.employee2,'get_task_detail',[team,t.id]);assert.ok(!JSON.stringify(detail).includes('Закрытый прежний текст'));assert.equal(detail.data.task.comment_count,1);
 const manager=await rpc(db,ids.manager,'get_task_history',[team,t.id,null]);assert.ok(JSON.stringify(manager).includes('Закрытый прежний текст'));
});
test('comments work on terminal tasks, reject deleted tasks and preserve literal HTML/plain text',async()=>{
 let t=await task();t=(await rpc(db,ids.employee1,'mutate_task',[team,'status',t.id,{status:'done'},t.version,randomUUID()])).data.entity;
 const c=await comment('employee2','create',t,null,'<img src=x onerror=alert(1)>\nhttps://example.test');assert.equal(c.ok,true);assert.ok(c.data.entity.body.includes('<img'));
 t=(await rpc(db,ids.employee1,'mutate_task',[team,'delete',t.id,{},t.version,randomUUID()])).data.entity;
 assert.equal((await comment('employee2','create',t)).error.code,'ALREADY_DELETED');
});
test('comment validation, disabled/nonmember access and independent comment rate limit',async()=>{
 const t=await task();assert.equal((await comment('employee1','create',t,null,'  ')).error.code,'VALIDATION_ERROR');assert.equal((await comment('employee1','create',t,null,'\n\t ')).error.code,'VALIDATION_ERROR');assert.equal((await comment('employee1','create',t,null,'x'.repeat(4001))).error.code,'VALIDATION_ERROR');
 assert.equal((await comment('outsider','create',t)).error.code,'ACCESS_DENIED');
 for(let n=0;n<20;n++)assert.equal((await comment('employee1','create',t,null,'Сообщение '+n)).ok,true);
 const limited=await comment('employee1','create',t);assert.equal(limited.error.code,'RATE_LIMITED');assert.ok(limited.error.retry_after_seconds>0);
 await db.query(`update public.team_members set state='disabled',disabled_at=now() where user_id=$1`,[ids.employee2]);
 assert.equal((await rpc(db,ids.employee2,'list_comments',[team,t.id,null,false])).error.code,'ACCESS_DENIED');
});
test('comment pages are stable 50-item slices and latest page is immediately available',async()=>{
 const t=await task();for(let n=0;n<61;n++)await db.query('insert into public.comments(task_id,author_id,body,create_operation_id,created_at) values($1,$2,$3,$4,$5)',[t.id,ids.employee1,'№'+n,randomUUID(),new Date(Date.UTC(2026,10,2,6,0,n))]);
 const a=await rpc(db,ids.employee1,'list_comments',[team,t.id,null,false]);const b=await rpc(db,ids.employee1,'list_comments',[team,t.id,a.data.next_cursor,false]);
 assert.equal(a.data.comments.length,50);assert.equal(b.data.comments.length,11);assert.equal(new Set([...a.data.comments,...b.data.comments].map(c=>c.id)).size,61);
 const latest=await rpc(db,ids.employee1,'list_comments',[team,t.id,null,true]);assert.equal(latest.data.comments.at(-1).body,'№60');
});
test('notification list does not mark read; one/all reads affect only own records and cutoff',async()=>{
 const t=await task();await comment('employee2','create',t);const list=await notices('employee1');assert.equal(list.data.unread_count,1);
 const n=list.data.notifications[0];assert.equal((await notices('employee1')).data.unread_count,1);
 assert.equal((await rpc(db,ids.employee2,'read_notifications',[team,[n.id],null,randomUUID()])).error.code,'ACCESS_DENIED');
 await clock(db,'2026-11-02T09:00:01+03:00');await comment('employee2','create',t,null,'После снимка');
 const op=randomUUID();assert.equal((await rpc(db,ids.employee1,'read_notifications',[team,null,list.data.snapshot_at,op])).data.updated_count,1);
 assert.equal((await notices('employee1')).data.unread_count,1);assert.equal((await rpc(db,ids.employee1,'read_notifications',[team,null,list.data.snapshot_at,op])).data.idempotent_replay,true);
});
test('deadline changes form new reminder grounds; overdue summary is at most once daily',async()=>{
 let t=await task('manager',{assignee_id:ids.employee1,deadline:'2026-11-03'});
 await clock(db,'2026-11-02T09:01:00+03:00');await rpc(db,ids.employee1,'sync_workspace',[team]);await rpc(db,ids.employee2,'sync_workspace',[team]);
 assert.equal((await notices('employee1')).data.notifications.filter(n=>n.type==='due_tomorrow').length,1);
 t=(await rpc(db,ids.manager,'mutate_task',[team,'update',t.id,{deadline:'2026-11-02'},t.version,randomUUID()])).data.entity;
 await clock(db,'2026-11-02T09:02:00+03:00');await rpc(db,ids.manager,'sync_workspace',[team]);
 assert.equal((await notices('employee1')).data.notifications.filter(n=>n.type==='due_today').length,1);
 t=(await rpc(db,ids.manager,'mutate_task',[team,'update',t.id,{deadline:'2026-11-01'},t.version,randomUUID()])).data.entity;
 for(const time of ['09:03','09:04']){await clock(db,'2026-11-02T'+time+':00+03:00');await rpc(db,ids.employee1,'sync_workspace',[team]);}
 assert.equal((await notices('employee1')).data.notifications.filter(n=>n.type==='overdue').length,1);assert.equal((await notices('manager')).data.notifications.filter(n=>n.type==='overdue').length,1);
});
test('one version row observes comment and notification-read changes without publishing audit text',async()=>{
 const t=await task();const before=(await db.query('select state_version from public.teams')).rows[0].state_version;
 await comment('employee2','create',t);const list=await notices('employee1');await rpc(db,ids.employee1,'read_notifications',[team,[list.data.notifications[0].id],null,randomUUID()]);
 assert.ok((await db.query('select state_version from public.teams')).rows[0].state_version>before);
 const published=(await db.query(`select tablename from pg_publication_tables where pubname='supabase_realtime'`)).rows;assert.deepEqual(published.map(x=>x.tablename),['teams']);
});
