begin;
create function private.ok(p_data jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('ok',true,'data',p_data,'meta',jsonb_build_object('schema_version',1,'server_time',now()));
$$;
create function private.failure(p_code text, p_message text, p_detail jsonb default '{}'::jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('ok',false,'error',jsonb_build_object('code',p_code,'message',p_message)||p_detail,
    'meta',jsonb_build_object('schema_version',1,'server_time',now()));
$$;
create function private.require_member(p_team_id uuid) returns public.team_members
language plpgsql stable security definer set search_path = '' as $$
declare v_member public.team_members;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  select * into v_member from public.team_members where team_id=p_team_id and user_id=auth.uid() and state='active';
  if not found then raise exception 'ACCESS_DENIED'; end if;
  return v_member;
end;
$$;
create function private.consume_write_rate(p_team_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_scope text; v_count integer; v_limit integer;
begin
  foreach v_scope in array array['user:'||auth.uid()::text,'team:'||p_team_id::text] loop
    v_limit:=case when v_scope like 'user:%' then 60 else 300 end;
    insert into private.rate_limit_counters(scope_key,action_group,window_start,request_count)
      values(v_scope,'write',date_trunc('minute',now()),1)
      on conflict(scope_key,action_group,window_start) do update
        set request_count=private.rate_limit_counters.request_count+1 returning request_count into v_count;
    if v_count>v_limit then raise exception 'RATE_LIMITED'; end if;
  end loop;
end;
$$;
create function private.guard_member_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Locking the team serializes changes to its last-manager invariant.
  perform 1 from public.teams where id=old.team_id for update;
  if old.role='manager' and old.state='active' and
    (tg_op='DELETE' or new.role<>'manager' or new.state<>'active') and not exists(
      select 1 from public.team_members m where m.team_id=old.team_id and m.user_id<>old.user_id
        and m.role='manager' and m.state='active') then
    raise exception 'LAST_MANAGER';
  end if;
  if tg_op='DELETE' then return old; end if;
  if new.team_id<>old.team_id or new.user_id<>old.user_id then raise exception 'IMMUTABLE_MEMBER_ID'; end if;
  new.updated_at:=now(); new.version:=old.version+1;
  return new;
end;
$$;
create trigger member_update_guard before update or delete on public.team_members
  for each row execute function private.guard_member_update();

-- Owner-only bootstrap: not an exposed signup/admin RPC and cannot create a second team.
create function private.bootstrap_team(p_manager_email text,p_manager_name text,p_team_name text default 'Команда')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_team uuid;
begin
  perform pg_advisory_xact_lock(hashtext('ritm:bootstrap'));
  if exists(select 1 from public.teams) then raise exception 'ALREADY_INITIALIZED'; end if;
  select id into v_user from auth.users where lower(email)=lower(btrim(p_manager_email))
    and email_confirmed_at is not null;
  if v_user is null then raise exception 'CONFIRMED_AUTH_USER_REQUIRED'; end if;
  insert into public.teams(name) values(btrim(p_team_name)) returning id into v_team;
  insert into public.team_members(team_id,user_id,display_name,role,state,joined_at)
    values(v_team,v_user,btrim(p_manager_name),'manager','active',now());
  return v_team;
end;
$$;

create function public.get_access_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_member public.team_members; v_team public.teams; v_email text;
begin
  if auth.uid() is null then return private.failure('UNAUTHENTICATED','Войдите в планировщик.'); end if;
  select * into v_member from public.team_members where user_id=auth.uid() and state='active' order by joined_at,team_id limit 1;
  if not found then
    if exists(select 1 from public.team_members where user_id=auth.uid() and state='invited') then
      return private.failure('INVITATION_PENDING','Завершите настройку доступа.');
    end if;
    return private.failure('ACCESS_DENIED','Доступ к команде не предоставлен или отключён.');
  end if;
  select email into v_email from auth.users where id=auth.uid();
  select * into v_team from public.teams where id=v_member.team_id;
  return private.ok(jsonb_build_object('team',jsonb_build_object('id',v_team.id,'name',v_team.name,'timezone',v_team.timezone),
    'member',jsonb_build_object('user_id',v_member.user_id,'display_name',v_member.display_name,
      'role',v_member.role,'state',v_member.state,'version',v_member.version),
    'user',jsonb_build_object('id',auth.uid(),'email',v_email)));
end;
$$;
create function public.update_profile(p_team_id uuid,p_display_name text,p_expected_version bigint,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_member public.team_members; v_cached private.operation_results; v_hash text; v_result jsonb;
begin
  v_member:=private.require_member(p_team_id);
  if p_operation_id is null then return private.failure('VALIDATION_ERROR','Не указан идентификатор операции.'); end if;
  v_hash:=md5(jsonb_build_array('profile',p_display_name,p_expected_version)::text);
  perform pg_advisory_xact_lock(hashtext(p_team_id::text||auth.uid()::text||p_operation_id::text));
  select * into v_cached from private.operation_results where team_id=p_team_id and actor_id=auth.uid() and operation_id=p_operation_id;
  if found then
    if v_cached.request_hash<>v_hash then return private.failure('OPERATION_ID_REUSED','Эта операция уже использована.'); end if;
    return jsonb_set(v_cached.result,'{data,idempotent_replay}','true'::jsonb);
  end if;
  if p_display_name is null or char_length(btrim(p_display_name)) not between 1 and 80 then
    return private.failure('VALIDATION_ERROR','Проверьте имя.',jsonb_build_object('field_errors',jsonb_build_object('display_name','Введите от 1 до 80 символов.')));
  end if;
  perform private.consume_write_rate(p_team_id);
  select * into v_member from public.team_members where team_id=p_team_id and user_id=auth.uid() for update;
  -- Recheck after taking the lock; deactivation must not race profile writes.
  if v_member.state<>'active' then return private.failure('ACCESS_DENIED','Доступ к команде отключён.'); end if;
  if p_expected_version is null or v_member.version<>p_expected_version then
    return private.failure('VERSION_CONFLICT','Профиль изменился. Загрузите актуальные данные.',
      jsonb_build_object('latest_entity',jsonb_build_object('display_name',v_member.display_name,'version',v_member.version)));
  end if;
  update public.team_members set display_name=btrim(p_display_name) where team_id=p_team_id and user_id=auth.uid();
  v_result:=private.ok(jsonb_build_object('operation_id',p_operation_id,'context',public.get_access_context()->'data','idempotent_replay',false));
  insert into private.operation_results(team_id,actor_id,operation_id,operation_type,request_hash,result)
    values(p_team_id,auth.uid(),p_operation_id,'profile',v_hash,v_result);
  return v_result;
exception
  when others then
    if sqlerrm='RATE_LIMITED' then return private.failure('RATE_LIMITED','Слишком много запросов.',jsonb_build_object('retry_after_seconds',60-extract(second from now())::integer)); end if;
    if sqlerrm in ('UNAUTHENTICATED','ACCESS_DENIED') then return private.failure(sqlerrm,'Доступ к команде не предоставлен.'); end if;
    raise;
end;
$$;

-- Activation only consumes an existing owner-created employee invitation.
-- Creating/reissuing invitations and team administration belong to step 3.
create function public.activate_invited_member() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_inv private.invitations; v_email text; v_password text; v_confirmed timestamptz;
begin
  if auth.uid() is null then return private.failure('UNAUTHENTICATED','Откройте действующую ссылку приглашения.'); end if;
  if exists(select 1 from public.team_members where user_id=auth.uid() and state='active') then return public.get_access_context(); end if;
  select lower(email),encrypted_password,email_confirmed_at into v_email,v_password,v_confirmed from auth.users where id=auth.uid();
  if v_confirmed is null or coalesce(v_password,'')='' then return private.failure('INVITATION_PENDING','Сначала установите пароль.'); end if;
  select i.* into v_inv from private.invitations i join public.team_members m on m.team_id=i.team_id and m.user_id=i.user_id
    where i.user_id=auth.uid() and i.email=v_email and i.state='sent' and i.cancelled_at is null
      and i.expires_at>now() and m.state='invited' and m.role='employee' order by i.created_at limit 1 for update of i,m;
  if not found then return private.failure('ACCESS_DENIED','Приглашение недействительно или срок его действия истёк.'); end if;
  update public.team_members set state='active',joined_at=now() where team_id=v_inv.team_id and user_id=auth.uid();
  update private.invitations set state='accepted',updated_at=now() where id=v_inv.id;
  return public.get_access_context();
end;
$$;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_active_member(uuid) to authenticated;
revoke execute on function public.get_access_context(),public.update_profile(uuid,text,bigint,uuid),public.activate_invited_member() from public,anon;
grant execute on function public.get_access_context(),public.update_profile(uuid,text,bigint,uuid),public.activate_invited_member() to authenticated;
commit;
