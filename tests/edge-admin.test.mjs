import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,ids} from './helpers/database.mjs';
import {adminFixture} from './helpers/admin-fixture.mjs';
let db,team;
before(async()=>{db=await createDatabase();});after(async()=>{await db.close();});beforeEach(async()=>{team=await seedDatabase(db);});
const request=(body,origin='https://example.github.io',token='manager')=>new Request('https://ritm-test.supabase.co/functions/v1/team-admin',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({team_id:team,...body})});
test('Edge validates JWT and live manager before constructing service client; origin and redirect are restricted',async()=>{
 const fixture=adminFixture(db,token=>ids[token]||null);
 assert.equal((await fixture.handler(request({action:'list_team_admin'},'https://evil.test'))).status,403);assert.equal(fixture.state.calls.length,0);
 assert.equal((await fixture.handler(request({action:'list_team_admin'},undefined,'bad'))).status,401);assert.ok(!fixture.state.calls.includes('privileged-client'));
 fixture.state.calls=[];assert.equal((await fixture.handler(request({action:'list_team_admin'},undefined,'employee1'))).status,403);assert.ok(!fixture.state.calls.includes('privileged-client'));
 fixture.state.calls=[];fixture.state.roleUnavailable=true;assert.equal((await fixture.handler(request({action:'list_team_admin'}))).status,503);assert.ok(!fixture.state.calls.includes('privileged-client'));fixture.state.roleUnavailable=false;
 fixture.state.calls=[];fixture.state.authUnavailable=true;assert.equal((await fixture.handler(request({action:'list_team_admin'}))).status,503);assert.deepEqual(fixture.state.calls,['verify']);fixture.state.authUnavailable=false;
 fixture.state.calls=[];const ok=await fixture.handler(request({action:'list_team_admin'}));assert.equal(ok.status,200);assert.deepEqual(fixture.state.calls.slice(0,3),['verify','role','privileged-client']);
 assert.equal((await fixture.handler(request({action:'list_team_admin',redirectTo:'https://evil.test'}))).status,400);
});
test('Edge sends invite once, resumes lost finalization response and never exposes service work',async()=>{
 const fixture=adminFixture(db,()=>ids.manager,{failFinishAfterCommit:true});const body={action:'invite_employee',payload:{email:'edge@example.test',display_name:'Новый'},operation_id:randomUUID()};
 let response=await fixture.handler(request(body));assert.equal(response.status,200);let data=await response.json();assert.equal(data.data.entity.state,'sent');assert.ok(!JSON.stringify(data).includes('admin_work'));assert.equal(fixture.state.mails.length,1);assert.equal(fixture.state.mails[0].redirectTo,'https://example.github.io/ritm/');
 response=await fixture.handler(request(body));data=await response.json();assert.equal(data.data.idempotent_replay,true);assert.equal(fixture.state.mails.length,1);
});
test('Edge email failure stays failed with no false success or leaked SMTP diagnostic',async()=>{
 const fixture=adminFixture(db,()=>ids.manager,{mailFailure:true});const response=await fixture.handler(request({action:'invite_employee',payload:{email:'edge@example.test',display_name:'Не доставлено'},operation_id:randomUUID()}));
 const result=await response.json();assert.equal(result.data.entity.state,'failed');assert.ok(!JSON.stringify(result).includes('secret SMTP'));
});
test('Edge failed Auth ban is retryable after membership is already closed',async()=>{
 const fixture=adminFixture(db,()=>ids.manager,{authBanFailure:true});const member=(await db.query('select version from public.team_members where user_id=$1',[ids.employee1])).rows[0];
 const body={action:'disable_employee',payload:{user_id:ids.employee1},expected_version:member.version,operation_id:randomUUID()};
 let response=await fixture.handler(request(body));let r=await response.json();assert.equal(r.data.auth_sync_pending,true);assert.equal((await db.query('select state from public.team_members where user_id=$1',[ids.employee1])).rows[0].state,'disabled');
 fixture.state.authBanFailure=false;response=await fixture.handler(request(body));r=await response.json();assert.equal(r.data.auth_sync_pending,false);assert.equal(fixture.state.bans.length,2);assert.equal(fixture.state.bans[1].ban_duration,'876000h');
});
