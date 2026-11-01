// Runtime-neutral handler: Deno serves it; Node tests exercise this exact implementation.
// Never import this server file into the three published frontend files.
const actions=new Set(['invite_employee','resend_invitation','cancel_invitation','list_team_admin','disable_employee','enable_employee']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createTeamAdminHandler({createClient,url,publicKey,serviceKey,appUrl,allowedOrigins=[]}) {
 const origins=new Set(allowedOrigins);
 const configured=(()=>{try{const redirect=new URL(appUrl);return !!url&&!!publicKey&&!!serviceKey&&origins.has(redirect.origin)&&!redirect.search&&!redirect.hash&&
  (redirect.protocol==='https:'||redirect.protocol==='http:'&&['127.0.0.1','localhost'].includes(redirect.hostname));}catch{return false;}})();
 return async request=>{
  const origin=request.headers.get('origin');
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin'};
  if(origin&&origins.has(origin))Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Max-Age':'600'});
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
  const failure=(code,message,status)=>reply({ok:false,error:{code,message}},status);
  if(origin&&!origins.has(origin))return failure('ACCESS_DENIED','Источник запроса не разрешён.',403);
  if(request.method==='OPTIONS')return origin&&origins.has(origin)?new Response(null,{status:204,headers}):failure('ACCESS_DENIED','Источник запроса не разрешён.',403);
  if(request.method!=='POST')return failure('VALIDATION_ERROR','Используйте POST.',405);
  if(!configured)return failure('NOT_CONFIGURED','Управление командой ещё не подключено.',503);
  const authorization=request.headers.get('authorization')||'';
  if(!/^Bearer \S+$/i.test(authorization))return failure('UNAUTHENTICATED','Войдите снова.',401);
  try {
   const text=await request.text();if(text.length>16384)return failure('VALIDATION_ERROR','Запрос слишком большой.',413);
   let input;try{input=JSON.parse(text);}catch{return failure('VALIDATION_ERROR','Некорректный запрос.',400);}
   if(!input||Array.isArray(input)||!actions.has(input.action)||!uuid.test(input.team_id)||Object.keys(input).some(k=>!['action','team_id','payload','expected_version','operation_id'].includes(k))||
    input.action!=='list_team_admin'&&!uuid.test(input.operation_id))return failure('VALIDATION_ERROR','Некорректные параметры.',400);
   // Verify the JWT with Auth, then check the live database role, before creating the privileged client.
   const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{headers:{Authorization:authorization}}};
   const caller=createClient(url,publicKey,options);
   const {data:identity,error:identityError}=await caller.auth.getUser(authorization.replace(/^Bearer /i,''));
   if(identityError?.name==='AuthRetryableFetchError'||identityError?.status>=500)return failure('NETWORK_OR_SERVICE_ERROR','Не удалось проверить доступ. Повторите после восстановления связи.',503);
   if(identityError||!identity?.user)return failure('UNAUTHENTICATED','Сессия истекла. Войдите снова.',401);
   const {data:access,error:accessError}=await caller.rpc('authorize_team_admin',{p_team_id:input.team_id});
   if(accessError)return failure('NETWORK_OR_SERVICE_ERROR','Не удалось проверить роль. Повторите после восстановления связи.',503);
   if(!access?.ok||access.data.actor_id!==identity.user.id)return failure('ACCESS_DENIED','Доступ руководителя не подтверждён.',403);
   const admin=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
   const parameters={p_team_id:input.team_id,p_actor_id:identity.user.id,p_action:input.action,p_payload:input.payload||{},p_expected_version:input.expected_version??null,p_operation_id:input.operation_id||null};
   const command=async(phase='begin',outcome={})=>{
    const {data,error}=await admin.rpc('team_admin_command',{...parameters,p_phase:phase,p_outcome:outcome});
    if(error||!data)throw new Error('DATABASE_UNAVAILABLE');return data;
   };
   let result=await command();
   if(result.ok&&result.data.next_step==='send_invite') {
    const work=result.data.admin_work;let outcome;
    try {
     if(work.confirmed&&work.user_id) {
      // A confirmed Auth identity whose membership is still invited may need password recovery.
      const {error}=await admin.auth.resetPasswordForEmail(work.email,{redirectTo:appUrl});
      outcome=error?{ok:false,error_code:'AUTH_MAIL_FAILED'}:{ok:true,user_id:work.user_id};
     }else {
      const {data,error}=await admin.auth.admin.inviteUserByEmail(work.email,{redirectTo:appUrl,data:{display_name:work.display_name}});
      outcome=error||!data?.user?{ok:false,error_code:'AUTH_MAIL_FAILED'}:{ok:true,user_id:data.user.id};
     }
    }catch{outcome={ok:false,error_code:'DELIVERY_UNKNOWN'};}
    // A database retry repeats only finalization, never the email call.
    try{result=await command('finish',outcome);}catch{result=await command('finish',outcome);}
   }
   // A concurrent enable/disable may supersede the desired Auth state during the remote call.
   for(let attempt=0;attempt<2&&result.ok&&result.data.next_step==='sync_auth';attempt++) {
    const work=result.data.admin_work;let outcome;
    try{const {error}=await admin.auth.admin.updateUserById(work.user_id,{ban_duration:work.disabled?'876000h':'none'});outcome={ok:!error};}catch{outcome={ok:false};}
    try{result=await command('finish',outcome);}catch{result=await command('finish',outcome);}
    if(!outcome.ok)break;
   }
   const safe=structuredClone(result);if(safe.data){delete safe.data.admin_work;delete safe.data.next_step;}
   const status=result.ok?200:result.error?.code==='RATE_LIMITED'?429:result.error?.code==='VERSION_CONFLICT'?409:result.error?.code==='ACCESS_DENIED'?403:400;
   return reply(safe,status);
  }catch{return failure('NETWORK_OR_SERVICE_ERROR','Не удалось подтвердить операцию. Повторите с тем же идентификатором.',503);}
 };
}
