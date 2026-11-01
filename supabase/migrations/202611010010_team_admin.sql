begin;
alter table private.invitations add column version bigint not null default 1;
alter table private.invitations add column last_attempt_at timestamptz;
alter table private.invitations add column delivery_operation_id uuid;
alter table private.invitations add column delivery_lease_until timestamptz;
alter table private.invitations add column password_before_invitation text;
create function private.require_manager(p_team uuid,p_actor uuid) returns void language plpgsql stable security definer set search_path='' as $$begin
 if not exists(select 1 from public.team_members where team_id=p_team and user_id=p_actor and state='active' and role='manager') then raise exception 'ACCESS_DENIED';end if;
end;$$;
create function public.authorize_team_admin(p_team_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$begin
 perform private.require_member(p_team_id);perform private.require_manager(p_team_id,auth.uid());return private.ok(jsonb_build_object('actor_id',auth.uid()));
exception when others then if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED') then return private.app_failure(sqlerrm);end if;raise;end;$$;
create function private.invitation_dto(p_inv private.invitations) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_inv.id,'email',p_inv.email,'display_name',p_inv.display_name,'state',p_inv.state,'sent_at',p_inv.sent_at,
  'expires_at',p_inv.expires_at,'version',p_inv.version,'last_error_code',p_inv.last_error_code,'last_attempt_at',p_inv.last_attempt_at);
$$;
create function private.mail_limit(p_team uuid,p_actor uuid,p_inv private.invitations) returns void language plpgsql security definer set search_path='' as $$begin
 if p_inv.last_attempt_at>private.task_now()-interval '60 seconds' then raise exception 'RATE_LIMITED' using detail=jsonb_build_object('retry_after_seconds',ceil(extract(epoch from p_inv.last_attempt_at+interval '60 seconds'-private.task_now()))::integer)::text;end if;
 perform private.limit_counter('user:'||p_actor,'invite_mail',5,900);perform private.limit_counter('team:'||p_team,'invite_mail',20,86400);
end;$$;
create function public.team_admin_command(p_team_id uuid,p_actor_id uuid,p_action text,p_payload jsonb,p_expected_version bigint,p_operation_id uuid,p_phase text default 'begin',p_outcome jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare req jsonb:=jsonb_build_array(p_action,p_payload,p_expected_version);r jsonb;data jsonb;i private.invitations;m public.team_members;s public.recurrence_series;t public.tasks;
 target uuid;replacement uuid;v_email text;v_label text;detail text;before_t jsonb;tasks_n integer:=0;series_n integer:=0;work jsonb;v_auth_user uuid;
begin
 perform private.lock_team(p_team_id);
 if p_phase='finish' then
  select result into r from private.operation_results where team_id=p_team_id and actor_id=p_actor_id and operation_id=p_operation_id and operation_type='admin' and request_hash=md5(req::text) for update;
  if not found then raise exception 'ACCESS_DENIED';end if;
  if r->'data'->>'next_step'='send_invite' then
   select * into i from private.invitations where id=(r->'data'->'admin_work'->>'invitation_id')::uuid and team_id=p_team_id for update;
   if i.delivery_operation_id is distinct from p_operation_id then raise exception 'ACCESS_DENIED';end if;
   if i.state in ('cancelled','accepted') then
    r:=private.ok(jsonb_build_object('operation_id',p_operation_id,'entity',private.invitation_dto(i),'next_step',null,'idempotent_replay',true));
   elsif p_outcome->>'ok'='true' then
    v_auth_user:=(p_outcome->>'user_id')::uuid;
    if not exists(select 1 from auth.users where id=v_auth_user and lower(email)=i.email) then raise exception 'ACCESS_DENIED';end if;
    if exists(select 1 from public.team_members where team_id=p_team_id and user_id=v_auth_user and state in ('active','disabled')) then raise exception 'ACCESS_DENIED';end if;
    insert into public.team_members(team_id,user_id,display_name,role,state) values(p_team_id,v_auth_user,i.display_name,'employee','invited')
     on conflict(team_id,user_id) do update set display_name=excluded.display_name where public.team_members.state='invited' and public.team_members.role='employee';
    update private.invitations set user_id=v_auth_user,state='sent',sent_at=private.task_now(),expires_at=private.task_now()+interval '24 hours',last_error_code=null,delivery_lease_until=null,
     updated_at=private.task_now(),version=version+1 where id=i.id returning * into i;
    r:=private.ok(jsonb_build_object('operation_id',p_operation_id,'entity',private.invitation_dto(i),'next_step',null,'idempotent_replay',false));
   else
    update private.invitations set state='failed',last_error_code=case when p_outcome->>'error_code'='DELIVERY_UNKNOWN' then 'DELIVERY_UNKNOWN' else 'AUTH_MAIL_FAILED' end,delivery_lease_until=null,updated_at=private.task_now(),version=version+1 where id=i.id returning * into i;
    r:=private.ok(jsonb_build_object('operation_id',p_operation_id,'entity',private.invitation_dto(i),'next_step',null,'idempotent_replay',false));
   end if;
  elsif r->'data'->>'next_step'='sync_auth' then
   r:=jsonb_set(r,'{data,auth_sync_pending}',to_jsonb(p_outcome->>'ok' is distinct from 'true'));
   if p_outcome->>'ok'='true' then r:=jsonb_set(r,'{data,next_step}','null');end if;
   select * into m from public.team_members where team_id=p_team_id and user_id=(r->'data'->'admin_work'->>'user_id')::uuid;
   if (m.state='disabled') is distinct from (r->'data'->'admin_work'->>'disabled')::boolean then
    r:=jsonb_set(r,'{data,admin_work,disabled}',to_jsonb(m.state='disabled'));
    r:=jsonb_set(r,'{data,auth_sync_pending}','true');r:=jsonb_set(r,'{data,next_step}','"sync_auth"');
    r:=jsonb_set(r,'{data,auth_sync_superseded}','true');r:=jsonb_set(r,'{data,entity}',to_jsonb(m));
   end if;
  else return r;end if;
  update private.operation_results set result=r where team_id=p_team_id and actor_id=p_actor_id and operation_id=p_operation_id;
  return r;
 end if;
 if p_phase<>'begin' or p_action not in ('list_team_admin','invite_employee','resend_invitation','cancel_invitation','disable_employee','enable_employee') or p_action is null or p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'VALIDATION_ERROR';end if;
 perform private.require_manager(p_team_id,p_actor_id);
 if p_action<>'list_team_admin' then
  r:=private.command_cached(p_team_id,p_actor_id,p_operation_id,'admin',req);
  if r is not null then
   if r->'data'->>'next_step'='send_invite' then
    select * into i from private.invitations where id=(r->'data'->'admin_work'->>'invitation_id')::uuid for update;
    if i.delivery_operation_id is distinct from p_operation_id then
     r:=private.ok(jsonb_build_object('entity',private.invitation_dto(i),'next_step',null,'operation_id',p_operation_id,'idempotent_replay',true));
     update private.operation_results set result=r where team_id=p_team_id and actor_id=p_actor_id and operation_id=p_operation_id;return r;
    end if;
    if i.delivery_lease_until>private.task_now() then raise exception 'RATE_LIMITED' using detail=jsonb_build_object('retry_after_seconds',greatest(1,ceil(extract(epoch from i.delivery_lease_until-private.task_now()))::integer))::text;end if;
    if i.state in ('cancelled','accepted') then return private.ok(jsonb_build_object('entity',private.invitation_dto(i),'next_step',null,'operation_id',p_operation_id,'idempotent_replay',true));end if;
    perform private.mail_limit(p_team_id,p_actor_id,i);
    update private.invitations set last_attempt_at=private.task_now(),delivery_lease_until=private.task_now()+interval '60 seconds' where id=i.id;
   elsif r->'data'->>'next_step'='sync_auth' then
    select * into m from public.team_members where team_id=p_team_id and user_id=(r->'data'->'admin_work'->>'user_id')::uuid;
    r:=jsonb_set(r,'{data,admin_work,disabled}',to_jsonb(m.state='disabled'));r:=jsonb_set(r,'{data,entity}',to_jsonb(m));
    update private.operation_results set result=r where team_id=p_team_id and actor_id=p_actor_id and operation_id=p_operation_id;
   end if;return r;
  end if;
 end if;
 perform private.limit_counter('user:'||p_actor_id,'admin',20,60);
 perform private.maintain_team(p_team_id,private.today());
 update private.invitations set state='expired',version=version+1 where team_id=p_team_id and state='sent' and expires_at<=private.task_now();
 if p_action='list_team_admin' then
  select coalesce(jsonb_agg(to_jsonb(x) order by display_name,user_id),'[]') into data from (
   select u.user_id,u.display_name,a.email,u.role,u.state,u.version,
    (select count(*) from public.tasks where team_id=p_team_id and assignee_id=u.user_id and status in ('planned','in_progress','waiting') and deleted_at is null and not is_superseded) as active_task_count,
    (select count(*) from public.recurrence_series where team_id=p_team_id and assignee_id=u.user_id and private.series_has_future(recurrence_series)) as active_series_count,
    (select jsonb_build_object('operation_id',o.operation_id,'action',o.result->'data'->'admin_work'->>'action','payload',o.result->'data'->'admin_work'->'retry_payload','expected_version',o.result->'data'->'admin_work'->'expected_version')
     from private.operation_results o where o.team_id=p_team_id and o.actor_id=p_actor_id and o.result->'data'->>'next_step'='sync_auth' and o.result->'data'->'admin_work'->>'user_id'=u.user_id::text order by created_at desc limit 1) as auth_retry
   from public.team_members u join auth.users a on a.id=u.user_id where u.team_id=p_team_id) x;
  return private.ok(jsonb_build_object('members',data,'invitations',(select coalesce(jsonb_agg(private.invitation_dto(v) order by v.created_at desc),'[]') from private.invitations v where v.team_id=p_team_id and v.state<>'accepted')));
 end if;
 -- Administrative writes also share the product's total mutation counters.
 perform private.limit_counter('user:'||p_actor_id,'write',60,60);perform private.limit_counter('team:'||p_team_id,'write',300,60);
 if p_action in ('invite_employee','resend_invitation') then
  if p_action='invite_employee' then
   if p_payload-array['email','display_name']<>'{}' then raise exception 'VALIDATION_ERROR';end if;
   v_email:=lower(private.trim_text(p_payload->>'email'));v_label:=private.trim_text(p_payload->>'display_name');
   if v_email is null or v_email!~'^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(v_email)>254 then perform private.task_validation('invite_email','Введите корректную почту.');end if;
   if v_label is null or char_length(v_label) not between 1 and 80 then perform private.task_validation('invite_name','Введите имя от 1 до 80 символов.');end if;
   if exists(select 1 from public.team_members u join auth.users a on a.id=u.user_id where u.team_id=p_team_id and lower(a.email)=v_email and u.state in ('active','disabled')) then perform private.task_validation('invite_email','Участник уже есть в команде. Для отключённого используйте повторное включение.');end if;
   select * into i from private.invitations where team_id=p_team_id and invitations.email=v_email and state in ('pending','sent','failed');
   if found then return private.command_saved(p_team_id,p_actor_id,p_operation_id,'admin',req,jsonb_build_object('entity',private.invitation_dto(i),'next_step',null));end if;
   insert into private.invitations(team_id,email,display_name,inviter_id,expires_at,operation_id) values(p_team_id,v_email,v_label,p_actor_id,private.task_now()+interval '24 hours',p_operation_id) returning * into i;
  else
   if p_payload-'invitation_id'<>'{}' then raise exception 'VALIDATION_ERROR';end if;
   select * into i from private.invitations where id=(p_payload->>'invitation_id')::uuid and team_id=p_team_id for update;
   if not found then raise exception 'NOT_FOUND';end if;
   if i.version is distinct from p_expected_version then return private.failure('VERSION_CONFLICT','Приглашение изменилось.',jsonb_build_object('latest_entity',private.invitation_dto(i)));end if;
   if i.state in ('cancelled','accepted') then raise exception 'ACCESS_DENIED';end if;
  end if;
  perform private.mail_limit(p_team_id,p_actor_id,i);
  update private.invitations set state='pending',last_attempt_at=private.task_now(),delivery_operation_id=p_operation_id,delivery_lease_until=private.task_now()+interval '60 seconds',last_error_code=null,
   password_before_invitation=coalesce((select a.encrypted_password from auth.users a where lower(a.email)=i.email),''),version=version+1 where id=i.id returning * into i;
  select a.id into v_auth_user from auth.users a where lower(a.email)=i.email;
  work:=jsonb_build_object('invitation_id',i.id,'email',i.email,'display_name',i.display_name,'user_id',v_auth_user,'confirmed',exists(select 1 from auth.users a where a.id=v_auth_user and a.email_confirmed_at is not null));
  return private.command_saved(p_team_id,p_actor_id,p_operation_id,'admin',req,jsonb_build_object('entity',private.invitation_dto(i),'next_step','send_invite','admin_work',work));
 elsif p_action='cancel_invitation' then
  if p_payload-'invitation_id'<>'{}' then raise exception 'VALIDATION_ERROR';end if;
  select * into i from private.invitations where id=(p_payload->>'invitation_id')::uuid and team_id=p_team_id for update;
  if not found then raise exception 'NOT_FOUND';end if;
  if i.version is distinct from p_expected_version then return private.failure('VERSION_CONFLICT','Приглашение изменилось.',jsonb_build_object('latest_entity',private.invitation_dto(i)));end if;
  if i.state='accepted' then raise exception 'ACCESS_DENIED';end if;
  update private.invitations set state='cancelled',cancelled_at=private.task_now(),version=version+1 where id=i.id returning * into i;
  return private.command_saved(p_team_id,p_actor_id,p_operation_id,'admin',req,jsonb_build_object('entity',private.invitation_dto(i)));
 end if;
 if p_payload-array['user_id','replacement_id']<>'{}' then raise exception 'VALIDATION_ERROR';end if;
 target:=(p_payload->>'user_id')::uuid;replacement:=(p_payload->>'replacement_id')::uuid;
 select * into m from public.team_members where team_id=p_team_id and user_id=target for update;
 if not found then raise exception 'NOT_FOUND';end if;
 if m.version is distinct from p_expected_version then return private.failure('VERSION_CONFLICT','Участник изменился.',jsonb_build_object('latest_entity',to_jsonb(m)));end if;
 if m.state='invited' then raise exception 'ACCESS_DENIED';end if;
 if p_action='disable_employee' then
  if m.role='manager' and not exists(select 1 from public.team_members where team_id=p_team_id and role='manager' and state='active' and user_id<>target) then raise exception 'LAST_MANAGER';end if;
  select count(*) into tasks_n from public.tasks where team_id=p_team_id and assignee_id=target and deleted_at is null and not is_superseded and status in ('planned','in_progress','waiting');
  select count(*) into series_n from public.recurrence_series where team_id=p_team_id and assignee_id=target and private.series_has_future(recurrence_series);
  if tasks_n+series_n>0 and (replacement is null or replacement=target or not exists(select 1 from public.team_members where team_id=p_team_id and user_id=replacement and state='active')) then perform private.task_validation('replacement_id','Выберите активного нового исполнителя для задач и повторений.');end if;
  for s in select * from public.recurrence_series where team_id=p_team_id and assignee_id=target and private.series_has_future(recurrence_series) for update loop
   update public.recurrence_series set assignee_id=replacement,management_mode='manager',version=version+1,updated_at=private.task_now() where id=s.id returning * into s;
   insert into private.series_revisions(series_id,revision,applies_from_date,effective_at,rule_snapshot) values(s.id,s.version,private.today(),private.task_now(),to_jsonb(s)||jsonb_build_object('_actor_id',p_actor_id,'_event_type','bulk_transfer'));
  end loop;
  for t in select * from public.tasks where team_id=p_team_id and assignee_id=target and deleted_at is null and not is_superseded and status in ('planned','in_progress','waiting') order by id for update loop
   before_t:=to_jsonb(t);t.assignee_id:=replacement;t.management_mode:='manager';t.version:=t.version+1;t.updated_at:=private.task_now();
   if t.series_id is not null and t.occurrence_date>=private.today() then select version into t.series_revision from public.recurrence_series where id=t.series_id;end if;
   update public.tasks set assignee_id=t.assignee_id,management_mode=t.management_mode,version=t.version,updated_at=t.updated_at,series_revision=t.series_revision where id=t.id;
   perform private.record_task(t,before_t,'bulk_transfer',p_actor_id,private.task_now(),p_operation_id);
  end loop;
  if tasks_n+series_n>0 then perform private.emit_notification(p_team_id,replacement,'bulk_assigned',null,jsonb_build_object('task_count',tasks_n,'series_count',series_n,'from_name',m.display_name),'bulk:'||p_operation_id);end if;
  update public.team_members set state='disabled',disabled_at=private.task_now() where team_id=p_team_id and user_id=target returning * into m;
 else
  update public.team_members set state='active',disabled_at=null,joined_at=coalesce(joined_at,private.task_now()) where team_id=p_team_id and user_id=target returning * into m;
 end if;
 work:=jsonb_build_object('user_id',target,'disabled',p_action='disable_employee','action',p_action,'retry_payload',p_payload,'expected_version',p_expected_version);
 return private.command_saved(p_team_id,p_actor_id,p_operation_id,'admin',req,jsonb_build_object('entity',to_jsonb(m),'transferred_tasks',tasks_n,'transferred_series',series_n,'auth_sync_pending',true,'next_step','sync_auth','admin_work',work));
exception when others then
 get stacked diagnostics detail=pg_exception_detail;
 if sqlstate in ('22P02','22007','23514','23502') then return private.app_failure('VALIDATION_ERROR');end if;
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','NOT_FOUND','VALIDATION_ERROR','RATE_LIMITED','OPERATION_ID_REUSED','LAST_MANAGER') then return private.app_failure(sqlerrm,detail);end if;raise;
end;$$;
create or replace function public.activate_invited_member() returns jsonb language plpgsql security definer set search_path='' as $$
declare i private.invitations;v_email text;v_password text;v_confirmed timestamptz;
begin
 if auth.uid() is null then return private.app_failure('UNAUTHENTICATED');end if;
 if exists(select 1 from public.team_members where user_id=auth.uid() and state='active') then return public.get_access_context();end if;
 select lower(a.email),a.encrypted_password,a.email_confirmed_at into v_email,v_password,v_confirmed from auth.users a where a.id=auth.uid();
 if v_confirmed is null or coalesce(v_password,'')='' then return private.failure('INVITATION_PENDING','Сначала установите пароль.');end if;
 select * into i from private.invitations where user_id=auth.uid() and invitations.email=v_email and state='sent' and cancelled_at is null and expires_at>private.task_now() order by created_at limit 1;
 if not found then return private.app_failure('ACCESS_DENIED');end if;
 perform private.lock_team(i.team_id);
 select * into i from private.invitations where id=i.id and state='sent' and expires_at>private.task_now() and cancelled_at is null for update;
 if not found or not exists(select 1 from public.team_members where team_id=i.team_id and user_id=auth.uid() and state='invited' and role='employee') then return private.app_failure('ACCESS_DENIED');end if;
 if i.password_before_invitation is not null and i.password_before_invitation=v_password then return private.failure('INVITATION_PENDING','Установите новый пароль по действующей служебной ссылке.');end if;
 update public.team_members set state='active',joined_at=private.task_now() where team_id=i.team_id and user_id=auth.uid();
 update private.invitations set state='accepted',version=version+1,updated_at=private.task_now() where id=i.id;
 return public.get_access_context();
end;$$;
revoke execute on all functions in schema private from public,anon,authenticated;
grant execute on function private.is_active_member(uuid) to authenticated;
revoke execute on function public.authorize_team_admin(uuid) from public,anon;
grant execute on function public.authorize_team_admin(uuid) to authenticated;
revoke execute on function public.team_admin_command(uuid,uuid,text,jsonb,bigint,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.team_admin_command(uuid,uuid,text,jsonb,bigint,uuid,text,jsonb) to service_role;
commit;
