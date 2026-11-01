begin;
create or replace function private.ok(p_data jsonb) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('ok',true,'data',p_data,'meta',jsonb_build_object('schema_version',1,'server_time',private.task_now()));
$$;
create or replace function private.failure(p_code text,p_message text,p_detail jsonb default '{}') returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('ok',false,'error',jsonb_build_object('code',p_code,'message',p_message)||p_detail,'meta',jsonb_build_object('schema_version',1,'server_time',private.task_now()));
$$;
-- All writers take the same team lock before row/operation locks.
create function private.lock_team(p_team uuid) returns void language plpgsql security definer set search_path='' as $$
begin perform 1 from public.teams where id=p_team for update; end; $$;
create function private.trim_text(p_text text) returns text language sql immutable set search_path='' as $$
 select regexp_replace(p_text,'^[[:space:]]+|[[:space:]]+$','','g');
$$;
create function private.limit_counter(p_scope text,p_group text,p_limit integer,p_seconds integer) returns void
language plpgsql security definer set search_path='' as $$
declare w timestamptz:=to_timestamp(floor(extract(epoch from private.task_now())/p_seconds)*p_seconds); n integer;
begin
 insert into private.rate_limit_counters values(p_scope,p_group,w,1)
 on conflict(scope_key,action_group,window_start) do update set request_count=private.rate_limit_counters.request_count+1 returning request_count into n;
 if n>p_limit then raise exception 'RATE_LIMITED' using detail=jsonb_build_object('retry_after_seconds',greatest(1,ceil(extract(epoch from w+make_interval(secs=>p_seconds)-private.task_now()))::integer))::text; end if;
end; $$;
create or replace function private.consume_write_rate(p_team_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin perform private.limit_counter('user:'||auth.uid(),'write',60,60);perform private.limit_counter('team:'||p_team_id,'write',300,60);end;$$;
create or replace function private.consume_read_rate(p_team_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin perform private.require_member(p_team_id);perform private.limit_counter('user:'||auth.uid(),'read',120,60);perform private.limit_counter('team:'||p_team_id,'read',600,60);end;$$;
create function private.command_cached(p_team uuid,p_actor uuid,p_operation uuid,p_type text,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c private.operation_results;
begin
 if p_operation is null then raise exception 'VALIDATION_ERROR';end if;
 select * into c from private.operation_results where team_id=p_team and actor_id=p_actor and operation_id=p_operation;
 if not found then return null;end if;
 if c.operation_type<>p_type or c.request_hash<>md5(p_request::text) then raise exception 'OPERATION_ID_REUSED';end if;
 return jsonb_set(c.result,'{data,idempotent_replay}','true');
end;$$;
create function private.command_saved(p_team uuid,p_actor uuid,p_operation uuid,p_type text,p_request jsonb,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb:=private.ok(p_data||jsonb_build_object('operation_id',p_operation,'idempotent_replay',false));
begin
 insert into private.operation_results(team_id,actor_id,operation_id,operation_type,request_hash,result)
 values(p_team,p_actor,p_operation,p_type,md5(p_request::text),r);return r;
end;$$;
create function private.app_failure(p_code text,p_detail text default null) returns jsonb language sql stable set search_path='' as $$
 select private.failure(p_code,case p_code when 'RATE_LIMITED' then 'Слишком много запросов. Повторите позже.' when 'VERSION_CONFLICT' then 'Данные изменились у коллеги. Проверьте актуальную версию.'
 when 'OPERATION_ID_REUSED' then 'Не удалось повторить операцию: идентификатор уже использован.' when 'NOT_FOUND' then 'Запись не найдена.'
 when 'VALIDATION_ERROR' then 'Проверьте заполненные поля.' when 'LAST_MANAGER' then 'Последнего руководителя отключить нельзя.'
 when 'ALREADY_DELETED' then 'Задача удалена.' else 'Недостаточно прав или доступ отключён.' end,
 case when p_detail is not null and left(p_detail,1)='{' then p_detail::jsonb when p_code='RATE_LIMITED' then '{"retry_after_seconds":60}'::jsonb else '{}'::jsonb end);
$$;
alter function public.mutate_task(uuid,text,uuid,jsonb,bigint,uuid) rename to mutate_task_core;
alter function public.mutate_task_core(uuid,text,uuid,jsonb,bigint,uuid) set schema private;
create function public.mutate_task(p_team_id uuid,p_action text,p_task_id uuid,p_payload jsonb,p_expected_version bigint,p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform private.lock_team(p_team_id);perform private.require_member(p_team_id);
 return private.mutate_task_core(p_team_id,p_action,p_task_id,p_payload,p_expected_version,p_operation_id);
exception when others then if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED') then return private.app_failure(sqlerrm);end if;raise;end;$$;
alter function public.update_profile(uuid,text,bigint,uuid) rename to update_profile_core;
alter function public.update_profile_core(uuid,text,bigint,uuid) set schema private;
create function public.update_profile(p_team_id uuid,p_display_name text,p_expected_version bigint,p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform private.lock_team(p_team_id);return private.update_profile_core(p_team_id,p_display_name,p_expected_version,p_operation_id);
end;$$;

create function private.emit_notification(p_team uuid,p_recipient uuid,p_type text,p_task uuid,p_payload jsonb,p_key text) returns void
language plpgsql security definer set search_path='' as $$begin
 if exists(select 1 from public.team_members where team_id=p_team and user_id=p_recipient and state='active') then
  insert into public.notifications(team_id,recipient_id,type,task_id,payload,dedupe_key,created_at)
  values(p_team,p_recipient,p_type,p_task,p_payload,p_key,private.task_now()) on conflict(recipient_id,dedupe_key) do nothing;
 end if;
end;$$;
create function private.notify_task_event() returns trigger language plpgsql security definer set search_path='' as $$
declare t public.tasks; recipient uuid;
begin
 if new.event_type in ('comment_create','comment_update','comment_delete') then return new;end if;
 select * into t from public.tasks where id=new.task_id;
 if new.event_type<>'bulk_transfer' and not t.is_superseded and t.deleted_at is null and
  (new.before_snapshot is null or new.before_snapshot->>'assignee_id' is distinct from t.assignee_id::text)
  and t.assignee_id<>coalesce(new.actor_id,t.created_by) then
  perform private.emit_notification(t.team_id,t.assignee_id,'assigned',t.id,jsonb_build_object('title',t.title),'assigned:'||t.id||':'||t.version);
 end if;
 if t.status='done' and new.before_snapshot->>'status' is distinct from 'done' and t.created_by is distinct from new.actor_id
  and exists(select 1 from public.team_members where team_id=t.team_id and user_id=t.created_by and role='manager') then
  perform private.emit_notification(t.team_id,t.created_by,'completed',t.id,jsonb_build_object('title',t.title),'completed:'||t.id||':'||t.version);
 end if;
 return new;
end;$$;
create trigger task_event_notifications after insert on private.task_events for each row execute function private.notify_task_event();
create function private.bump_workspace() returns trigger language plpgsql security definer set search_path='' as $$
declare team uuid;
begin
 if tg_table_name='comments' then select team_id into team from public.tasks where id=new.task_id;else team:=new.team_id;end if;
 update public.teams set state_version=state_version+1,updated_at=private.task_now() where id=team;
 return new;
end;$$;
create trigger tasks_workspace after insert or update on public.tasks for each row execute function private.bump_workspace();
create trigger series_workspace after insert or update on public.recurrence_series for each row execute function private.bump_workspace();
create trigger members_workspace after insert or update on public.team_members for each row execute function private.bump_workspace();
create trigger comments_workspace after insert or update on public.comments for each row execute function private.bump_workspace();
create trigger notifications_workspace after insert or update on public.notifications for each row execute function private.bump_workspace();

create function public.mutate_comment(p_team_id uuid,p_action text,p_task_id uuid,p_comment_id uuid,p_body text,p_expected_version bigint,p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.team_members;t public.tasks;c public.comments;old_c jsonb;r jsonb;detail text;
 request jsonb:=jsonb_build_array(p_action,p_task_id,p_comment_id,p_body,p_expected_version);recipient uuid;task_snapshot jsonb;
begin
 perform private.lock_team(p_team_id);m:=private.require_member(p_team_id);
 r:=private.command_cached(p_team_id,auth.uid(),p_operation_id,'comment',request);if r is not null then return r;end if;
 if p_action is null or p_action not in ('create','update','delete') then raise exception 'VALIDATION_ERROR';end if;
 select * into t from public.tasks where id=p_task_id and team_id=p_team_id for update;
 if not found then raise exception 'NOT_FOUND';end if;
 if t.deleted_at is not null then raise exception 'ALREADY_DELETED';end if;
 if p_action='create' then
  if p_comment_id is not null then raise exception 'VALIDATION_ERROR';end if;
  c.id:=gen_random_uuid();c.task_id:=t.id;c.author_id:=auth.uid();c.body:=private.trim_text(p_body);c.create_operation_id:=p_operation_id;c.version:=1;c.created_at:=private.task_now();c.updated_at:=c.created_at;
 else
  select * into c from public.comments where id=p_comment_id and task_id=t.id for update;
  if not found then raise exception 'NOT_FOUND';end if;
  if c.author_id<>auth.uid() and (m.role<>'manager' or p_action<>'delete') then raise exception 'ACCESS_DENIED';end if;
  if c.deleted_at is not null then raise exception 'ALREADY_DELETED';end if;
  if c.version is distinct from p_expected_version then return private.failure('VERSION_CONFLICT','Комментарий изменился. Проверьте новую версию.',jsonb_build_object('latest_entity',to_jsonb(c)));end if;
  old_c:=to_jsonb(c);c.version:=c.version+1;c.updated_at:=private.task_now();
  if p_action='delete' then c.body:='';c.deleted_at:=private.task_now();c.deleted_by:=auth.uid();else c.body:=private.trim_text(p_body);end if;
 end if;
 if p_action<>'delete' and (c.body is null or char_length(c.body) not between 1 and 4000) then perform private.task_validation('comment_body','Введите от 1 до 4 000 символов.');end if;
 perform private.consume_write_rate(p_team_id);
 if p_action='create' then
  perform private.limit_counter('user:'||auth.uid(),'comment',20,60);insert into public.comments select (c).*;
 else update public.comments set body=c.body,deleted_at=c.deleted_at,deleted_by=c.deleted_by,updated_at=c.updated_at,version=c.version where id=c.id;end if;
 task_snapshot:=to_jsonb(t);
 insert into private.task_events(team_id,task_id,event_type,actor_id,is_system,effective_at,recorded_at,version_before,version_after,before_snapshot,after_snapshot,operation_id)
 values(p_team_id,t.id,'comment_'||p_action,auth.uid(),false,private.task_now(),private.task_now(),t.version,t.version,
  task_snapshot||jsonb_build_object('comment',old_c),task_snapshot||jsonb_build_object('comment',to_jsonb(c)),p_operation_id);
 if p_action='create' then
  for recipient in select distinct x from unnest(array[t.assignee_id,t.created_by]) x where x<>auth.uid() loop
   perform private.emit_notification(p_team_id,recipient,'comment',t.id,jsonb_build_object('title',t.title,'comment_id',c.id),'comment:'||c.id);
  end loop;
 end if;
 return private.command_saved(p_team_id,auth.uid(),p_operation_id,'comment',request,jsonb_build_object('entity',to_jsonb(c)));
exception when others then
 get stacked diagnostics detail=pg_exception_detail;
 if sqlerrm in ('VALIDATION_ERROR','ACCESS_DENIED','UNAUTHENTICATED','NOT_FOUND','ALREADY_DELETED','RATE_LIMITED','OPERATION_ID_REUSED') then return private.app_failure(sqlerrm,detail);end if;raise;
end;$$;
-- Comment snapshots are audit-only, never business task state or task DTOs.
create or replace function private.task_state(p_task_id uuid,p_at timestamptz,p_exclusive boolean default false) returns jsonb
language sql stable security definer set search_path='' as $$
 select after_snapshot-array['comment','series_change'] from private.task_events where task_id=p_task_id
 and (effective_at<p_at or (not p_exclusive and effective_at=p_at)) order by effective_at desc,event_seq desc limit 1;
$$;
create function public.list_comments(p_team_id uuid,p_task_id uuid,p_cursor text default null,p_latest boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.team_members;r jsonb;last_id uuid;last_time timestamptz;more boolean;detail text;
begin
 perform private.consume_read_rate(p_team_id);m:=private.require_member(p_team_id);
 if not exists(select 1 from public.tasks where team_id=p_team_id and id=p_task_id) then raise exception 'NOT_FOUND';end if;
 if p_cursor is not null then
  select id,created_at into last_id,last_time from public.comments where id=p_cursor::uuid and task_id=p_task_id;
  if not found then raise exception 'VALIDATION_ERROR';end if;
 end if;
 select coalesce(jsonb_agg(v order by created_at,id),'[]') into r from (
  select c.id,c.created_at,to_jsonb(c)||jsonb_build_object('author_name',u.display_name,'edited',c.version>1 and c.deleted_at is null,
   'can_edit',c.author_id=auth.uid() and c.deleted_at is null,'can_delete',(c.author_id=auth.uid() or m.role='manager') and c.deleted_at is null) as v
  from public.comments c join public.team_members u on u.team_id=p_team_id and u.user_id=c.author_id where c.task_id=p_task_id
  and (p_cursor is null or (c.created_at,c.id)>(last_time,last_id))
  order by case when p_latest then c.created_at end desc,case when p_latest then c.id end desc,c.created_at,c.id limit 50) q;
 select exists(select 1 from public.comments c where c.task_id=p_task_id and (c.created_at,c.id)>((r->-1->>'created_at')::timestamptz,(r->-1->>'id')::uuid)) into more;
 return private.ok(jsonb_build_object('comments',r,'next_cursor',case when more then r->-1->>'id' else null end,'total',(select count(*) from public.comments where task_id=p_task_id)));
exception when others then
 get stacked diagnostics detail=pg_exception_detail;
 if sqlstate='22P02' then return private.app_failure('VALIDATION_ERROR');end if;
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','NOT_FOUND','RATE_LIMITED','VALIDATION_ERROR') then return private.app_failure(sqlerrm,detail);end if;raise;
end;$$;
create function public.get_notifications(p_team_id uuid,p_unread_only boolean default false,p_cursor text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;cut public.notifications;detail text;
begin
 perform private.consume_read_rate(p_team_id);
 if p_cursor is not null then select * into cut from public.notifications where id=p_cursor::uuid and team_id=p_team_id and recipient_id=auth.uid();if not found then raise exception 'VALIDATION_ERROR';end if;end if;
 select coalesce(jsonb_agg(v order by created_at desc,id desc),'[]') into r from (
  select id,created_at,to_jsonb(n) as v from public.notifications n where team_id=p_team_id and recipient_id=auth.uid() and (not p_unread_only or read_at is null)
   and (p_cursor is null or (created_at,id)<(cut.created_at,cut.id)) order by created_at desc,id desc limit 50) q;
 return private.ok(jsonb_build_object('notifications',r,'unread_count',(select count(*) from public.notifications where team_id=p_team_id and recipient_id=auth.uid() and read_at is null),
  'snapshot_at',private.task_now(),'next_cursor',case when jsonb_array_length(r)=50 and exists(select 1 from public.notifications where team_id=p_team_id and recipient_id=auth.uid()
   and (not p_unread_only or read_at is null) and (created_at,id)<((r->-1->>'created_at')::timestamptz,(r->-1->>'id')::uuid)) then r->-1->>'id' else null end));
exception when others then
 get stacked diagnostics detail=pg_exception_detail;
 if sqlstate='22P02' then return private.app_failure('VALIDATION_ERROR');end if;
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','RATE_LIMITED','VALIDATION_ERROR') then return private.app_failure(sqlerrm,detail);end if;raise;
end;$$;
create function public.read_notifications(p_team_id uuid,p_ids uuid[],p_before timestamptz,p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare req jsonb:=jsonb_build_array(p_ids,p_before);r jsonb;detail text;n integer;
begin
 perform private.lock_team(p_team_id);perform private.require_member(p_team_id);
 r:=private.command_cached(p_team_id,auth.uid(),p_operation_id,'read_notifications',req);if r is not null then return r;end if;
 if p_ids is not null and cardinality(p_ids)>100 or p_ids is null and (p_before is null or p_before>private.task_now()) then raise exception 'VALIDATION_ERROR';end if;
 if p_ids is not null and exists(select 1 from unnest(p_ids) x where not exists(select 1 from public.notifications where id=x and team_id=p_team_id and recipient_id=auth.uid())) then raise exception 'ACCESS_DENIED';end if;
 perform private.consume_write_rate(p_team_id);
 update public.notifications set read_at=private.task_now() where team_id=p_team_id and recipient_id=auth.uid() and read_at is null and
  case when p_ids is not null then id=any(p_ids) else created_at<=p_before end;
 get diagnostics n=row_count;
 return private.command_saved(p_team_id,auth.uid(),p_operation_id,'read_notifications',req,jsonb_build_object('updated_count',n));
exception when others then
 get stacked diagnostics detail=pg_exception_detail;
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','RATE_LIMITED','VALIDATION_ERROR','OPERATION_ID_REUSED') then return private.app_failure(sqlerrm,detail);end if;raise;
end;$$;
revoke execute on all functions in schema private from public,anon,authenticated;
grant execute on function private.is_active_member(uuid) to authenticated;
revoke execute on function public.mutate_task(uuid,text,uuid,jsonb,bigint,uuid),public.update_profile(uuid,text,bigint,uuid),public.mutate_comment(uuid,text,uuid,uuid,text,bigint,uuid),public.list_comments(uuid,uuid,text,boolean),public.get_notifications(uuid,boolean,text),public.read_notifications(uuid,uuid[],timestamptz,uuid) from public,anon;
grant execute on function public.mutate_task(uuid,text,uuid,jsonb,bigint,uuid),public.update_profile(uuid,text,bigint,uuid),public.mutate_comment(uuid,text,uuid,uuid,text,bigint,uuid),public.list_comments(uuid,uuid,text,boolean),public.get_notifications(uuid,boolean,text),public.read_notifications(uuid,uuid[],timestamptz,uuid) to authenticated;
commit;
