// TEST ONLY. Auth delivery is simulated; the Edge handler and all SQL are production code.
import {randomUUID} from 'node:crypto';
import {rpc} from './database.mjs';
import {serviceCommand} from './step3.mjs';
import {createTeamAdminHandler} from '../../supabase/functions/team-admin/handler.mjs';
export function adminFixture(db,identityForToken,state={}) {
 state.calls||=[];state.mails||=[];state.bans||=[];
 const createClient=(_url,key)=>{
  if(key==='fixture-public') {
   let userId;
   return {auth:{async getUser(token){state.calls.push('verify');if(state.authUnavailable)return {error:{name:'AuthRetryableFetchError',status:503}};userId=identityForToken(token);return userId?{data:{user:{id:userId}}}:{error:{code:'invalid_jwt'}};}},async rpc(name,params){state.calls.push('role');return state.roleUnavailable?{error:{message:'Unavailable'}}:{data:await rpc(db,userId,name,[params.p_team_id])};}};
  }
  state.calls.push('privileged-client');
  return {async rpc(name,p){
   try{const result=await serviceCommand(db,[p.p_team_id,p.p_actor_id,p.p_action,p.p_payload,p.p_expected_version,p.p_operation_id,p.p_phase,p.p_outcome]);
    if(p.p_phase==='finish'&&state.failFinishAfterCommit){state.failFinishAfterCommit=false;return {error:{code:'lost_response'}};}
    return {data:result};
   }catch(error){return {error:{code:'TEST_SQL',message:error.message}};}
  },auth:{
   async resetPasswordForEmail(email,options){state.mails.push({email,redirectTo:options.redirectTo,type:'recovery'});return state.mailFailure?{error:{message:'secret SMTP diagnostic'}}:{};},
   admin:{async inviteUserByEmail(email,options){
    state.mails.push({email,redirectTo:options.redirectTo,type:'invite'});if(state.mailFailure)return {error:{message:'secret SMTP diagnostic'}};
    let user=(await db.query('select id from auth.users where lower(email)=$1',[email])).rows[0];
    if(!user){user={id:randomUUID()};await db.query('insert into auth.users values($1,$2,null,null)',[user.id,email]);}
    return {data:{user}};
   },async updateUserById(id,attributes){state.bans.push({id,...attributes});return state.authBanFailure?{error:{message:'secret Auth diagnostic'}}:{data:{user:{id}}};}}
  }};
 };
 return {state,handler:createTeamAdminHandler({createClient,url:'https://ritm-test.supabase.co',publicKey:'fixture-public',serviceKey:'fixture-service',appUrl:'https://example.github.io/ritm/',allowedOrigins:['https://example.github.io','http://127.0.0.1:3000']})};
}
