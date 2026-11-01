begin;
alter table public.teams add column maintenance_checked_at timestamptz;
alter table public.teams add column maintenance_result jsonb;
alter table public.teams add column maintenance_last_error_code text;
alter table public.teams add column maintenance_failed_at timestamptz;
create function private.deadline_notifications(p_team uuid) returns void language plpgsql security definer set search_path='' as $$
declare t public.tasks;m public.team_members;basis bigint;n integer;kind text;day date:=private.today();
begin
 for t in select * from public.tasks where team_id=p_team and deleted_at is null and not is_superseded and status in ('planned','in_progress','waiting') and deadline in(day,day+1) loop
  select event_seq into basis from private.task_events where task_id=t.id and (before_snapshot is null or before_snapshot->>'deadline' is distinct from after_snapshot->>'deadline') order by effective_at desc,event_seq desc limit 1;
  kind:=case when t.deadline=day then 'due_today' else 'due_tomorrow' end;
  perform private.emit_notification(p_team,t.assignee_id,kind,t.id,jsonb_build_object('title',t.title,'deadline',t.deadline),kind||':'||t.id||':'||coalesce(basis,0));
 end loop;
 for m in select * from public.team_members where team_id=p_team and state='active' loop
  select count(*) into n from public.tasks where team_id=p_team and deleted_at is null and not is_superseded and status in ('planned','in_progress','waiting')
   and deadline<day and (m.role='manager' or assignee_id=m.user_id);
  if n>0 then perform private.emit_notification(p_team,m.user_id,'overdue',null,jsonb_build_object('count',n,'date',day,'team_summary',m.role='manager'),'overdue:'||p_team||':'||day);end if;
 end loop;
end;$$;
create function private.maintain_team(p_team_id uuid,p_effective_today date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare team public.teams;s public.recurrence_series;t public.tasks;old_t jsonb;d date;first_day date;through date;
 n integer:=0;moved integer:=0;r jsonb;stamp timestamptz;first_event bigint;
begin
 perform private.lock_team(p_team_id);select * into team from public.teams where id=p_team_id;
 if not found then raise exception 'NOT_FOUND';end if;
 if p_effective_today is distinct from private.today() then raise exception 'VALIDATION_ERROR';end if;
 if team.last_processed_date=p_effective_today and team.maintenance_checked_at>private.task_now()-interval '30 seconds' then
  return jsonb_build_object('today',p_effective_today,'timezone',team.timezone,'processed_through',team.last_processed_date,'moved_task_count',0,'generated_count',0,'state_version',team.state_version,'checked_at',team.maintenance_checked_at);
 end if;
 select coalesce(max(event_seq),0) into first_event from private.task_events where team_id=p_team_id;
 through:=(date_trunc('month',p_effective_today)+interval '2 months - 1 day')::date;
 for s in select * from public.recurrence_series where team_id=p_team_id order by id loop
  if s.generated_through is null or s.generated_through<through then
   n:=n+private.generate_series(s.id,coalesce(s.generated_through+1,s.start_date),through);
   update public.recurrence_series set generated_through=through where id=s.id;
  end if;
 end loop;
 first_day:=coalesce(team.last_processed_date+1,(select min((effective_created_at at time zone 'Europe/Moscow')::date) from public.tasks where team_id=p_team_id),p_effective_today);
 for d in select x::date from generate_series(least(first_day,p_effective_today)::timestamp,p_effective_today::timestamp,interval '1 day') x loop
  stamp:=d::timestamp at time zone 'Europe/Moscow';
  for t in select * from public.tasks where team_id=p_team_id and deleted_at is null and not is_superseded and status in ('planned','in_progress','waiting')
   and plan_end<d and effective_created_at<=stamp order by id for update loop
   old_t:=to_jsonb(t);t.plan_start:=private.next_workday_on_or_after(d);t.plan_end:=t.plan_start;t.version:=t.version+1;t.updated_at:=private.task_now();
   update public.tasks set plan_start=t.plan_start,plan_end=t.plan_end,version=t.version,updated_at=t.updated_at where id=t.id;
   perform private.record_task(t,old_t,'auto_move',null,stamp,md5('ritm-auto:'||t.id||':'||d)::uuid);moved:=moved+1;
  end loop;
 end loop;
 perform private.deadline_notifications(p_team_id);
 select * into team from public.teams where id=p_team_id;
 select count(distinct task_id) into moved from private.task_events where team_id=p_team_id and event_seq>first_event and event_type='auto_move';
 if team.last_processed_date is distinct from p_effective_today then team.state_version:=team.state_version+1;end if;
 r:=jsonb_build_object('today',p_effective_today,'timezone',team.timezone,'processed_through',p_effective_today,'moved_task_count',moved,'generated_count',n,'state_version',team.state_version,'checked_at',private.task_now());
 update public.teams set state_version=team.state_version,last_processed_date=p_effective_today,maintenance_checked_at=private.task_now(),maintenance_result=r,maintenance_last_error_code=null,maintenance_failed_at=null where id=p_team_id;
 return r;
end;$$;
create function private.maintain_all_teams() returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid;r jsonb;n integer:=0;moved integer:=0;generated integer:=0;errors jsonb:='[]';
begin
 for t in select id from public.teams order by id loop
  begin
   r:=private.maintain_team(t,private.today());n:=n+1;moved:=moved+(r->>'moved_task_count')::integer;generated:=generated+(r->>'generated_count')::integer;
  exception when others then
   errors:=errors||jsonb_build_array(jsonb_build_object('team_id',t,'code',sqlstate));
   update public.teams set maintenance_last_error_code=sqlstate,maintenance_failed_at=private.task_now() where id=t;
  end;
 end loop;return jsonb_build_object('processed_teams',n,'moved_task_count',moved,'generated_count',generated,'errors',errors,'checked_at',private.task_now());
end;$$;
create function public.sync_workspace(p_team_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare detail text;
begin
 perform private.require_member(p_team_id);perform private.lock_team(p_team_id);perform private.consume_read_rate(p_team_id);
 return private.ok(private.maintain_team(p_team_id,private.today()));
exception when others then get stacked diagnostics detail=pg_exception_detail;
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','RATE_LIMITED') then return private.app_failure(sqlerrm,detail);end if;raise;end;$$;
create or replace function public.get_planner(p_team_id uuid,p_selected_date date,p_filters jsonb,p_cursor text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d date:=coalesce(p_selected_date,private.today());detail text;
begin
 perform private.require_member(p_team_id);perform private.lock_team(p_team_id);perform private.consume_read_rate(p_team_id);perform private.check_filters(p_team_id,coalesce(p_filters,'{}'));
 if d not between date '2000-01-01' and date '2100-12-31' then raise exception 'VALIDATION_ERROR';end if;
 perform private.maintain_team(p_team_id,private.today());
 perform private.materialize_range(p_team_id,date_trunc('month',d)::date,(date_trunc('month',d)+interval '1 month - 1 day')::date);
 return private.get_planner(p_team_id,p_selected_date,p_filters,p_cursor);
exception when others then get stacked diagnostics detail=pg_exception_detail;
 if sqlerrm in ('RATE_LIMITED','ACCESS_DENIED','UNAUTHENTICATED','VALIDATION_ERROR') then return private.app_failure(sqlerrm,detail);end if;raise;end;$$;
create or replace function public.mutate_task(p_team_id uuid,p_action text,p_task_id uuid,p_payload jsonb,p_expected_version bigint,p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform private.lock_team(p_team_id);perform private.require_member(p_team_id);perform private.maintain_team(p_team_id,private.today());
 return private.mutate_task_core(p_team_id,p_action,p_task_id,p_payload,p_expected_version,p_operation_id);
exception when others then if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED') then return private.app_failure(sqlerrm);end if;raise;end;$$;
alter function public.mutate_comment(uuid,text,uuid,uuid,text,bigint,uuid) rename to mutate_comment_core;
alter function public.mutate_comment_core(uuid,text,uuid,uuid,text,bigint,uuid) set schema private;
create function public.mutate_comment(p_team_id uuid,p_action text,p_task_id uuid,p_comment_id uuid,p_body text,p_expected_version bigint,p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform private.require_member(p_team_id);perform private.maintain_team(p_team_id,private.today());
 return private.mutate_comment_core(p_team_id,p_action,p_task_id,p_comment_id,p_body,p_expected_version,p_operation_id);
exception when others then if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED') then return private.app_failure(sqlerrm);end if;raise;end;$$;
alter function public.mutate_series(uuid,text,uuid,date,jsonb,bigint,uuid) rename to mutate_series_core;
alter function public.mutate_series_core(uuid,text,uuid,date,jsonb,bigint,uuid) set schema private;
create function public.mutate_series(p_team_id uuid,p_action text,p_series_id uuid,p_boundary date,p_payload jsonb,p_expected_version bigint,p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform private.require_member(p_team_id);perform private.maintain_team(p_team_id,private.today());
 return private.mutate_series_core(p_team_id,p_action,p_series_id,p_boundary,p_payload,p_expected_version,p_operation_id);
exception when others then if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED') then return private.app_failure(sqlerrm);end if;raise;end;$$;

alter function private.task_actions(jsonb,uuid,text) rename to task_actions_core;
create function private.task_actions(p_task jsonb,p_user uuid,p_role text) returns jsonb language sql immutable set search_path='' as $$
 select case when coalesce((p_task->>'is_superseded')::boolean,false) then '["view"]'::jsonb else private.task_actions_core(p_task,p_user,p_role) end;
$$;
alter function private.task_dto(jsonb,uuid,text,boolean,timestamptz) rename to task_dto_core;
create function private.task_dto(p_task jsonb,p_user uuid,p_role text,p_historical boolean default false,p_at timestamptz default null) returns jsonb
language sql stable security definer set search_path='' as $$
 select private.task_dto_core(p_task-array['comment','series_change'],p_user,p_role,p_historical,p_at)||jsonb_build_object('comment_count',(select count(*) from public.comments where task_id=(p_task->>'id')::uuid),
  'recurrence',case when p_task->>'series_id' is null then null else (select jsonb_build_object('frequency',frequency,'active',active) from public.recurrence_series where id=(p_task->>'series_id')::uuid) end);
$$;
create or replace function public.get_task_detail(p_team_id uuid,p_task_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;t public.tasks;s public.recurrence_series;m public.team_members;
begin
 m:=private.require_member(p_team_id);perform private.maintain_team(p_team_id,private.today());perform private.consume_read_rate(p_team_id);
 r:=private.get_task_detail(p_team_id,p_task_id);
 if r->>'ok'='true' then
  select * into t from public.tasks where id=p_task_id;
  if t.series_id is not null then select * into s from public.recurrence_series where id=t.series_id;
   r:=jsonb_set(r,'{data,series}',to_jsonb(s)||jsonb_build_object('can_manage',m.role='manager' or s.assignee_id=auth.uid() and s.management_mode='self',
    'rule',private.series_rule(s.id,greatest(private.today(),t.occurrence_date))));
  end if;
 end if;return r;
exception when others then if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','RATE_LIMITED') then return private.app_failure(sqlerrm);end if;raise;end;$$;
create or replace function private.get_task_history(p_team_id uuid,p_task_id uuid,p_cursor text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.team_members;rows jsonb;last_seq bigint;detail text;
begin
 m:=private.require_member(p_team_id);
 if not exists(select 1 from public.tasks where team_id=p_team_id and id=p_task_id) then raise exception 'NOT_FOUND';end if;
 if p_cursor is not null and p_cursor!~'^\d{1,20}$' then raise exception 'VALIDATION_ERROR';end if;
 select coalesce(jsonb_agg(v order by event_seq desc),'[]'),min(event_seq) into rows,last_seq from (
  select e.event_seq,jsonb_build_object('id',e.event_seq,'type',e.event_type,'at',e.effective_at,'actor_name',coalesce(u.display_name,'Автоматически'),
   'before',e.before_snapshot-array['comment','series_change','body','email','password'],'after',e.after_snapshot-array['comment','series_change','body','email','password'],
   'series_change',case when e.event_type='series_rule_changed' then jsonb_build_object('before',e.before_snapshot->'series_change','after',e.after_snapshot->'series_change') else null end,
   'comment',case when e.event_type like 'comment_%' then case when m.role='manager' or c.deleted_at is null then
     jsonb_build_object('before',e.before_snapshot->'comment','after',e.after_snapshot->'comment') else jsonb_build_object('deleted',true,'id',c.id) end else null end) as v
  from private.task_events e left join public.team_members u on u.team_id=e.team_id and u.user_id=e.actor_id
  left join public.comments c on c.id=(e.after_snapshot->'comment'->>'id')::uuid
  where e.team_id=p_team_id and e.task_id=p_task_id and e.event_type in ('create','update','move','status','delete','restore','take_control','auto_move','series_create','series_update','series_replace','series_stop','series_rule_changed','bulk_transfer','comment_create','comment_update','comment_delete')
   and (p_cursor is null or e.event_seq<p_cursor::bigint) order by e.event_seq desc limit 50) q;
 return private.ok(jsonb_build_object('events',rows,'next_cursor',case when exists(select 1 from private.task_events where task_id=p_task_id and event_seq<last_seq) then last_seq::text else null end));
exception when others then
 if sqlstate in ('22P02','22003') or sqlerrm='VALIDATION_ERROR' then return private.app_failure('VALIDATION_ERROR');end if;
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','NOT_FOUND') then return private.app_failure(sqlerrm);end if;raise;end;$$;
create or replace function public.get_task_history(p_team_id uuid,p_task_id uuid,p_cursor text default null) returns jsonb language plpgsql security definer set search_path='' as $$begin
 perform private.require_member(p_team_id);perform private.maintain_team(p_team_id,private.today());perform private.consume_read_rate(p_team_id);
 return private.get_task_history(p_team_id,p_task_id,p_cursor);
exception when others then if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','RATE_LIMITED') then return private.app_failure(sqlerrm);end if;raise;end;$$;
revoke execute on all functions in schema private from public,anon,authenticated;
grant execute on function private.is_active_member(uuid) to authenticated;
revoke execute on function public.sync_workspace(uuid),public.mutate_comment(uuid,text,uuid,uuid,text,bigint,uuid),public.mutate_series(uuid,text,uuid,date,jsonb,bigint,uuid) from public,anon;
grant execute on function public.sync_workspace(uuid),public.mutate_comment(uuid,text,uuid,uuid,text,bigint,uuid),public.mutate_series(uuid,text,uuid,date,jsonb,bigint,uuid) to authenticated;
commit;
