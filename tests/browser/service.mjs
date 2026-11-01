// TEST ONLY. The released app has no demo mode, fake account, or local backend.
// Auth HTTPS is simulated here; RPC executes the real migration functions in PostgreSQL.
import { readFile } from 'node:fs/promises';
import { rpc,ids } from '../helpers/database.mjs';
import {adminFixture} from '../helpers/admin-fixture.mjs';
import {installFonts} from './fonts.mjs';
const sdk=await readFile(new URL('../../node_modules/@supabase/supabase-js/dist/umd/supabase.js',import.meta.url),'utf8');
const pptxBundle=await readFile(new URL('../../node_modules/pptxgenjs/dist/pptxgen.bundle.js',import.meta.url),'utf8');
const app=await readFile(new URL('../../app.js',import.meta.url),'utf8');
const configuredBase=app.replace("supabaseUrl: ''","supabaseUrl: 'https://ritm-test.supabase.co'").replace("publishableKey: ''","publishableKey: 'sb_publishable_ritm_automated_tests_only'").replace('emailDeliveryEnabled: false','emailDeliveryEnabled: true');
// Optional test-only phase timings. No test hooks or logging are added to the released app.
const configured=process.env.RITM_EXPORT_PROFILE==='1'?configuredBase.replace('  Bootstrap.start();\n})();',()=>`  for(const key of ['library','layout','tablePages','package','pptx','download']){const original=ReportExport[key];ReportExport[key]=function(...args){const start=performance.now(),result=original.apply(this,args),done=()=>console.log('RITM_PROFILE',key,Math.round(performance.now()-start));if(result?.then)return result.finally(done);done();return result;};}\n  Bootstrap.start();\n})();`):configuredBase;
const realtimeHubs=new WeakMap();
export async function installService(page,db,{emailDeliveryEnabled=true}={}) {
  await installFonts(page);
  if(process.env.RITM_EXPORT_PROFILE==='1')page.on('console',message=>{if(message.text().startsWith('RITM_PROFILE'))console.log(message.text());});
  const state={passwords:Object.fromEntries(Object.keys(ids).map(key=>[key,'Test password 123!'])),failedLogin:false,failedProfile:false,expired:false,
    recoveryRequests:[],passwordUpdates:[],loginRequests:[],failedTask:false,dropTaskResponse:false,taskRequests:[],failedComment:false,dropCommentResponse:false,admin:{emailDeliveryEnabled,mails:[]},rpcRequests:[],detailGates:{},failedPptx:false};
  await page.route('https://cdn.jsdelivr.net/npm/pptxgenjs@4.0.1/dist/pptxgen.bundle.js',route=>state.failedPptx?route.abort('failed'):route.fulfill({status:200,contentType:'text/javascript',body:pptxBundle}));
  let hub=realtimeHubs.get(db);if(!hub){hub=new Set();realtimeHubs.set(db,hub);}
  state.socketMessages=[];state.muteRealtime=false;
  state.emitRealtime=async()=>{
    const teams=(await db.query('select * from public.teams')).rows;
    for(const socket of hub){if(!socket.ready||socket.state.muteRealtime)continue;const team=teams.find(t=>socket.filter==='id=eq.'+t.id);if(!team)continue;
      const active=(await db.query(`select 1 from public.team_members where team_id=$1 and user_id=$2 and state='active'`,[team.id,socket.user])).rows.length;if(!active)continue;
      try{socket.ws.send(JSON.stringify([socket.joinRef,null,socket.topic,'postgres_changes',{ids:[1],data:{schema:'public',table:'teams',type:'UPDATE',columns:[{name:'id',type:'uuid'},{name:'state_version',type:'int8'}],record:team,old_record:{id:team.id},commit_timestamp:new Date().toISOString()}}]));}catch{}
    }
  };
  state.disconnectRealtime=()=>{for(const socket of [...hub])if(socket.state===state){socket.ready=false;socket.ws.close({code:1012,reason:'Test disconnect'});hub.delete(socket);}};
  await page.routeWebSocket(/wss:\/\/ritm-test\.supabase\.co\/realtime\/v1\/websocket/,ws=>{
    const socket={ws,state,ready:false};hub.add(socket);ws.onClose(()=>hub.delete(socket));
    ws.onMessage(message=>{try{
      const frame=JSON.parse(typeof message==='string'?message:message.toString()),[joinRef,ref,topic,event,payload]=frame;state.socketMessages.push({event,topic,payload});
      const send=(status,response={})=>ws.send(JSON.stringify([joinRef,ref,topic,'phx_reply',{status,response}]));
      if(event==='phx_join'){
        const filters=payload.config.postgres_changes;socket.topic=topic;socket.joinRef=joinRef;socket.filter=filters[0]?.filter;
        try{socket.user=JSON.parse(Buffer.from(payload.access_token.split('.')[1],'base64url')).sub;}catch{}
        socket.ready=true;send('ok',{postgres_changes:filters.map((filter,i)=>({...filter,id:i+1}))});
      }else if(event==='phx_leave'){socket.ready=false;send('ok');}else if(event==='heartbeat')send('ok');
    }catch(error){console.error('TEST WS',error.message);}});
  });
  const user=key=>({id:ids[key],email:`${key}@example.test`,aud:'authenticated',role:'authenticated',email_confirmed_at:new Date().toISOString(),app_metadata:{provider:'email',providers:['email']},user_metadata:{},identities:[],created_at:'2026-01-01T00:00:00Z'});
  const session=key=>{
    const expiry=Math.floor(Date.now()/1000)+3600;
    const jwt=[{alg:'HS256',typ:'JWT'},{sub:ids[key],aud:'authenticated',role:'authenticated',exp:expiry,iat:expiry-3600},'test-signature'].map(value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url')).join('.');
    return {access_token:jwt,token_type:'bearer',expires_in:3600,expires_at:expiry,refresh_token:`test-refresh:${key}`,user:user(key)};
  };
  await page.route('**/app.js',route=>route.fulfill({contentType:'text/javascript',body:configured.replace('emailDeliveryEnabled: true',`emailDeliveryEnabled: ${emailDeliveryEnabled}`)}));
  await page.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js',route=>route.fulfill({contentType:'text/javascript',body:sdk}));
  await page.route('https://ritm-test.supabase.co/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    let body={};try{body=req.postDataJSON()||{};}catch{}
    const reply=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data),headers:{'access-control-allow-origin':'*'}});
    const auth=req.headers().authorization || '';
    let uid;try{uid=JSON.parse(Buffer.from(auth.replace('Bearer ','').split('.')[1],'base64url')).sub;}catch{}
    const key=Object.keys(ids).find(k=>ids[k]===uid);
    if(req.method()==='OPTIONS') return reply({});
    if(url.pathname.endsWith('/token')) {
      if(state.failedLogin) return route.abort('failed');
      if(url.searchParams.get('grant_type')==='refresh_token') {
        const refreshKey=body.refresh_token?.split(':')[1];
        return !state.expired&&ids[refreshKey]?reply(session(refreshKey)):reply({code:'refresh_token_not_found',message:'Invalid refresh token'},400);
      }
      state.loginRequests.push({...body});
      const loginKey=Object.keys(ids).find(k=>`${k}@example.test`===body.email);
      if(!loginKey || state.passwords[loginKey]!==body.password) return reply({code:'invalid_credentials',message:'Invalid login credentials'},400);
      return reply(session(loginKey));
    }
    if(url.pathname.endsWith('/recover')) {state.recoveryRequests.push({...body,url:url.href}); return reply({});}
    if(url.pathname.endsWith('/verify')) {
      if(body.token_hash==='valid-recovery' && body.type==='recovery') return reply(session('employee1'));
      if(body.token_hash==='valid-invite' && body.type==='invite') return reply(session('outsider'));
      return reply({code:'otp_expired',message:'Token expired'},403);
    }
    if(url.pathname.endsWith('/logout')) return route.fulfill({status:204,body:''});
    if(!key || state.expired) return reply({code:'bad_jwt',message:'Invalid JWT'},401);
    if(url.pathname.endsWith('/user')) {
      if(req.method()==='PUT' && body.password) {
        state.passwords[key]=body.password; state.passwordUpdates.push(body.password);
        await db.query('update auth.users set encrypted_password=$1 where id=$2',['test-password-hash:'+body.password,ids[key]]);
      }
      return reply(user(key));
    }
    if(url.pathname.includes('/functions/v1/team-admin')){
      const fixture=adminFixture(db,()=>!state.expired&&key?ids[key]:null,state.admin);
      const response=await fixture.handler(new Request(req.url(),{method:req.method(),headers:{...req.headers(),origin:'http://127.0.0.1:3000'},body:req.postData()}));
      if(body.action==='list_team_admin'&&state.teamListGate)await state.teamListGate;
      await state.emitRealtime();
      return route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
    }
    if(url.pathname.includes('/rest/v1/rpc/')) {
      const name=url.pathname.split('/').at(-1);
      state.rpcRequests.push({name,body});
      if(name==='get_weekly_progress'&&state.failedWeekly)return route.abort('failed');
      if(name==='update_profile' && state.failedProfile) return route.abort('failed');
      const ordered={update_profile:['p_team_id','p_display_name','p_expected_version','p_operation_id'],
        get_planner:['p_team_id','p_selected_date','p_filters','p_cursor'],mutate_task:['p_team_id','p_action','p_task_id','p_payload','p_expected_version','p_operation_id'],
        get_report:['p_team_id','p_period_type','p_period_start','p_employee_id','p_direction'],get_report_rows:['p_snapshot_id','p_metric_key','p_cursor','p_limit','p_scope'],get_export_data:['p_snapshot_id'],
        get_task_detail:['p_team_id','p_task_id'],get_task_history:['p_team_id','p_task_id','p_cursor'],list_task_collection:['p_team_id','p_collection','p_employee_id','p_direction','p_cursor'],
        get_weekly_progress:['p_team_id'],claim_daily_support:['p_team_id','p_notification_id'],sync_workspace:['p_team_id'],list_comments:['p_team_id','p_task_id','p_cursor','p_latest'],mutate_comment:['p_team_id','p_action','p_task_id','p_comment_id','p_body','p_expected_version','p_operation_id'],
        get_notifications:['p_team_id','p_unread_only','p_cursor'],read_notifications:['p_team_id','p_ids','p_before','p_operation_id'],
        preview_series:['p_team_id','p_series_id','p_boundary'],mutate_series:['p_team_id','p_action','p_series_id','p_boundary','p_payload','p_expected_version','p_operation_id']};
      const args=(ordered[name]||[]).map(k=>body[k]??null);
      if(name==='mutate_task'){state.taskRequests.push(body);if(state.failedTask)return route.abort('failed');}
      if(name==='mutate_comment'&&state.failedComment)return route.abort('failed');
      try {const result=await rpc(db,ids[key],name,args);if(name==='get_notifications'&&state.notificationsGate)await state.notificationsGate;if(name==='get_task_detail'&&state.detailGates[body.p_task_id])await state.detailGates[body.p_task_id];await state.emitRealtime();if(name==='mutate_task'&&state.dropTaskResponse){state.dropTaskResponse=false;return route.abort('failed');}if(name==='mutate_comment'&&state.dropCommentResponse){state.dropCommentResponse=false;return route.abort('failed');}return reply(result);}
      catch(error) {console.error('TEST RPC',name,error.message);return reply({code:'XX000',message:'Test service error'},500);}
    }
    return reply({message:'Unknown test endpoint'},404);
  });
  return state;
}
export async function login(page,key='employee1',password='Test password 123!') {
  await page.goto('/');
  await page.getByLabel('Электронная почта',{exact:true}).fill(`${key}@example.test`);
  await page.getByLabel('Пароль',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Войти в Ритм',exact:true}).click();
}
