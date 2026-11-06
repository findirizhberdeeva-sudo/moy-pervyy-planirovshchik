begin;
-- Calendar visibility is separate from work placements and deadline-based result metrics.
create index events_auto_continuation on private.task_events(team_id,task_id,effective_at desc,event_seq desc)
 where event_type='auto_move' and is_system;
create function private.work_display_end(p_plan_end date,p_deadline date) returns date
language sql immutable set search_path='' as $$select greatest(p_plan_end,p_deadline)$$;
create function private.continuation_date(p_day date,p_deadline date) returns date
language sql immutable set search_path='' as $$
 select case when p_deadline is null then private.next_workday_on_or_after(p_day) else p_day end;
$$;

-- Repair only a future interval whose most recent date change was an old system auto-move.
-- A human move, even to the same Monday, is never inferred from the original task dates.
create function private.repair_deadline_continuations(p_team_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare t public.tasks;e private.task_events;old_t jsonb;day date:=private.today();stamp timestamptz:=private.task_now();
begin
 for t in select task.* from public.tasks task where task.team_id=p_team_id and task.deadline is not null and task.plan_start>day
  and task.status in ('planned','in_progress','waiting') and task.deleted_at is null and not task.is_superseded
  and exists(select 1 from private.task_events a where a.team_id=p_team_id and a.task_id=task.id and a.event_type='auto_move' and a.is_system
   and (a.after_snapshot->>'plan_start')::date=task.plan_start and (a.after_snapshot->>'plan_end')::date=task.plan_end)
  order by task.id for update loop
  select * into e from private.task_events where task_id=t.id and team_id=p_team_id
   and (before_snapshot->>'plan_start',before_snapshot->>'plan_end') is distinct from (after_snapshot->>'plan_start',after_snapshot->>'plan_end')
   order by effective_at desc,event_seq desc limit 1;
  if not found or e.event_type<>'auto_move' or not e.is_system or e.effective_at>stamp
   or (e.after_snapshot->>'plan_start')::date<>t.plan_start or (e.after_snapshot->>'plan_end')::date<>t.plan_end
   or private.next_workday_on_or_after((e.effective_at at time zone 'Europe/Moscow')::date)<>t.plan_start then continue;end if;
  old_t:=to_jsonb(t);
  if private.work_display_end((e.before_snapshot->>'plan_end')::date,t.deadline)>=day then
   t.plan_start:=(e.before_snapshot->>'plan_start')::date;t.plan_end:=(e.before_snapshot->>'plan_end')::date;
  else t.plan_start:=day;t.plan_end:=day;end if;
  t.version:=t.version+1;t.updated_at:=stamp;
  update public.tasks set plan_start=t.plan_start,plan_end=t.plan_end,version=t.version,updated_at=stamp where id=t.id;
  perform private.record_task(t,old_t,'auto_move',null,stamp,md5('ritm-deadline-repair:'||t.id||':'||t.version)::uuid);
 end loop;
end;$$;


-- A scalar, invoker-only predicate: no object lookup or search-path dependency; SQL can inline it.
create function private.deadline_day_visible(p_day date,p_start date,p_end date,p_deadline date,p_status text,p_completed timestamptz,p_cancelled date)
returns boolean language sql immutable as $$
 select case p_status when 'done' then (p_completed at time zone 'Europe/Moscow')::date=p_day
 when 'cancelled' then p_cancelled=p_day else p_day between p_start and greatest(p_end,p_deadline) end;
$$;
create function private.current_list_matches(p_task public.tasks,p_filters jsonb) returns boolean
language sql stable set search_path='' as $$
 select private.list_matches(jsonb_build_object('assignee_id',p_task.assignee_id,'direction',p_task.direction,'status',p_task.status,
 'deadline',p_task.deadline,'overdue',p_task.status in ('planned','in_progress','waiting') and p_task.deleted_at is null and p_task.deadline<private.today(),
 'priority',case when p_task.important is null then 'unset' when p_task.important then case when p_task.urgent then 'important_urgent' else 'important_not_urgent' end
 else case when p_task.urgent then 'not_important_urgent' else 'not_important_not_urgent' end end,
 'title',case when coalesce(p_filters->>'query','')<>'' then p_task.title else '' end,
 'description',case when coalesce(p_filters->>'query','')<>'' then p_task.description else '' end),p_filters);
$$;
-- Count all current/future deadline days in one pass over typed rows, without copying full cards per day.
create function private.deadline_calendar_cells(p_team_id uuid,p_start date,p_end date,p_filters jsonb)
returns table(day date,total integer,done integer) language sql stable security definer set search_path='' as $$
 with tasks as materialized (select t.*,case when t.status='cancelled' then
  (select (max(e.effective_at) at time zone 'Europe/Moscow')::date from private.task_events e where e.task_id=t.id
   and e.after_snapshot->>'status'='cancelled' and e.before_snapshot->>'status' is distinct from 'cancelled' and e.effective_at<=private.task_now()) end as cancelled_day
 from public.tasks t where t.team_id=p_team_id and t.deadline is not null and t.deleted_at is null and not t.is_superseded
 and t.effective_created_at<=private.task_now() and private.current_list_matches(t,p_filters))
 select x::date,count(t.id)::integer,count(t.id) filter(where t.status='done')::integer
 from generate_series(greatest(p_start,private.today())::timestamp,p_end::timestamp,interval '1 day') x
 left join tasks t on private.deadline_day_visible(x::date,t.plan_start,t.plan_end,t.deadline,t.status,t.completed_at,t.cancelled_day)
 group by x order by x;
$$;

-- Like retained work placements, a virtual calendar day survives a same-day reschedule.
create function private.had_deadline_day(p_task_id uuid,p_day date) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.task_events e where e.task_id=p_task_id
  and e.effective_at>=p_day::timestamp at time zone 'Europe/Moscow'
  and e.effective_at<(p_day+1)::timestamp at time zone 'Europe/Moscow'
  and e.before_snapshot->>'deadline' is not null and e.before_snapshot->>'deleted_at' is null
  and not coalesce((e.before_snapshot->>'is_superseded')::boolean,false)
  and e.before_snapshot->>'status' in ('planned','in_progress','waiting')
  and p_day between (e.before_snapshot->>'plan_start')::date
   and private.work_display_end((e.before_snapshot->>'plan_end')::date,(e.before_snapshot->>'deadline')::date));
$$;
-- Current/future days use current rows; closed days use their last historical snapshot.
-- Intervals are evaluated on read, without expanding a distant deadline into daily rows.
create function private.deadline_calendar_states(p_team_id uuid,p_day date,p_filters jsonb default '{}')
returns table(task_id uuid,snapshot jsonb)
language sql stable security definer set search_path='' as $$
 with bounds as (select least(private.task_now(),(p_day+1)::timestamp at time zone 'Europe/Moscow') as t,
  p_day<private.today() as closed),
 candidates as materialized (select t.* from public.tasks t cross join bounds b where t.team_id=p_team_id
  and (t.deadline is not null or t.updated_at>=case when b.closed then p_day::timestamp at time zone 'Europe/Moscow' else b.t end)),
 unchanged as (select c.id as task_id,to_jsonb(c) as s from candidates c cross join bounds b
  where (c.updated_at<b.t or not b.closed and c.updated_at=b.t)
  and (c.effective_created_at<b.t or not b.closed and c.effective_created_at=b.t)
  and private.current_list_matches(c::public.tasks,p_filters)
  and (c.status in ('planned','in_progress','waiting') and p_day between c.plan_start and greatest(c.plan_end,c.deadline)
   or c.status='done' and (c.completed_at at time zone 'Europe/Moscow')::date=p_day
   or c.status='cancelled' and p_day<=private.today()
   or b.closed and c.updated_at>=p_day::timestamp at time zone 'Europe/Moscow')),
 historical as (select distinct on(e.task_id) e.task_id,e.after_snapshot as s
  from private.task_events e join candidates c on c.id=e.task_id cross join bounds b where e.team_id=p_team_id
  and not (c.updated_at<b.t or not b.closed and c.updated_at=b.t)
  and (e.effective_at<b.t or not b.closed and e.effective_at=b.t)
  order by e.task_id,e.effective_at desc,e.event_seq desc),
 latest as (select * from unchanged union all select * from historical)
 select l.task_id,l.s-array['comment','series_change'] from latest l where l.s->>'deadline' is not null
  or p_day<private.today() and private.had_deadline_day(l.task_id,p_day);
$$;
create or replace function private.mutate_task_core(p_team_id uuid,p_action text,p_task_id uuid,p_payload jsonb,p_expected_version bigint,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_member public.team_members; v_task public.tasks; v_before jsonb; v_actions jsonb; v_fields jsonb; v_key text;
 v_hash text; v_cache private.operation_results; v_result jsonb; v_now timestamptz:=private.task_now(); v_today date:=private.today();
 v_changed boolean; v_detail text; v_reason text; v_start date; v_requested_action text:=p_action;
begin
 v_member:=private.require_member(p_team_id);
 if p_operation_id is null or p_action is null or p_payload is null or jsonb_typeof(p_payload)<>'object' then perform private.task_validation('_form','Некорректная операция.'); end if;
 if p_action not in ('create','update','move','status','delete','restore','take_control') then perform private.task_validation('_form','Неизвестное действие.'); end if;
 v_hash:=md5(jsonb_build_array(p_action,p_task_id,p_payload,p_expected_version)::text);
 perform pg_advisory_xact_lock(hashtext(p_team_id::text||auth.uid()::text||p_operation_id::text));
 select * into v_cache from private.operation_results where team_id=p_team_id and actor_id=auth.uid() and operation_id=p_operation_id;
 if found then
   if v_cache.request_hash<>v_hash then return private.failure('OPERATION_ID_REUSED','Идентификатор уже использован для другого действия.'); end if;
   return jsonb_set(v_cache.result,'{data,idempotent_replay}','true');
 end if;
 if p_action='create' then
   if p_task_id is not null then perform private.task_validation('_form','При создании ID назначает сервер.'); end if;
   v_task.id:=gen_random_uuid(); v_task.team_id:=p_team_id; v_task.created_by:=auth.uid(); v_task.assignee_id:=auth.uid();
   v_task.management_mode:=case when v_member.role='manager' then 'manager' else 'self' end;
   v_task.title:=''; v_task.description:=''; v_task.plan_start:=v_today; v_task.plan_end:=v_today;
   v_task.status:='planned'; v_task.is_superseded:=false; v_task.version:=1; v_task.create_operation_id:=p_operation_id;
   v_task.created_at:=v_now; v_task.updated_at:=v_now; v_task.effective_created_at:=v_now;
   v_fields:='["title","description","plan_start","plan_end","deadline","important","urgent","direction","assignee_id"]';
 else
   select * into v_task from public.tasks where team_id=p_team_id and id=p_task_id for update;
   if not found then return private.failure('NOT_FOUND','Задача не найдена.'); end if;
   v_before:=to_jsonb(v_task); v_actions:=private.task_actions(v_before,auth.uid(),v_member.role);
   v_fields:=private.task_fields(v_before,auth.uid(),v_member.role);
   if p_action='update' and not (v_actions?'edit') or p_action='move' and not (v_actions?'move')
     or p_action='delete' and not (v_actions?'delete') or p_action='restore' and not (v_actions?'restore')
     or p_action='take_control' and not (v_actions?'take_control') then raise exception 'ACCESS_DENIED'; end if;
   if p_action='status' then
     if p_payload->>'status'='cancelled' then
       if not (v_actions?'cancel') then raise exception 'ACCESS_DENIED'; end if;
     elsif v_task.status in ('done','cancelled') then
       if not (v_actions?'reopen') or p_payload->>'status' not in ('in_progress',v_task.status) then raise exception 'ACCESS_DENIED'; end if;
     elsif not (v_actions?'status') then raise exception 'ACCESS_DENIED'; end if;
   end if;
   if p_expected_version is null or p_expected_version<>v_task.version then
     return private.failure('VERSION_CONFLICT','Задача изменилась у коллеги. Проверьте актуальные данные.',
       jsonb_build_object('latest_entity',private.task_dto(v_before,auth.uid(),v_member.role)));
   end if;
 end if;
 for v_key in select jsonb_object_keys(p_payload) loop
   if (p_action in ('create','update') and not (v_fields?v_key)) or (p_action='move' and v_key<>'plan_start')
     or (p_action='status' and v_key not in ('status','reason')) or (p_action in ('delete','restore','take_control')) then
     if v_key in ('id','team_id','created_by','management_mode','completed_at','deleted_at','version','effective_created_at','role') then raise exception 'ACCESS_DENIED'; end if;
     if p_action='update' then raise exception 'ACCESS_DENIED'; end if;
     perform private.task_validation('_form','Недопустимое поле: '||v_key);
   end if;
 end loop;
 if p_action in ('create','update') then
   if p_payload?'title' then v_task.title:=btrim(p_payload->>'title'); end if;
   if p_payload?'description' then v_task.description:=p_payload->>'description'; end if;
   if p_payload?'assignee_id' then
     if v_member.role<>'manager' and (p_payload->>'assignee_id')::uuid<>auth.uid() then raise exception 'ACCESS_DENIED'; end if;
     v_task.assignee_id:=(p_payload->>'assignee_id')::uuid;
   end if;
   if p_payload?'direction' then v_task.direction:=p_payload->>'direction'; end if;
   if p_payload?'important' then v_task.important:=(p_payload->>'important')::boolean; end if;
   if p_payload?'urgent' then v_task.urgent:=(p_payload->>'urgent')::boolean; end if;
   if p_payload?'deadline' then v_task.deadline:=(p_payload->>'deadline')::date; end if;
   if p_payload?'plan_start' then v_task.plan_start:=(p_payload->>'plan_start')::date; end if;
   if p_payload?'plan_end' then v_task.plan_end:=(p_payload->>'plan_end')::date;
   elsif p_action='create' then v_task.plan_end:=v_task.plan_start; end if;
 elsif p_action='move' then
   v_start:=(p_payload->>'plan_start')::date;
   if v_start is null then perform private.task_validation('plan_start','Выберите дату.'); end if;
   v_task.plan_end:=v_start+(v_task.plan_end-v_task.plan_start); v_task.plan_start:=v_start;
 elsif p_action='status' then
   if p_payload->>'status' is null or p_payload->>'status' not in ('planned','in_progress','waiting','done','cancelled') then perform private.task_validation('status','Выберите статус.'); end if;
   if v_task.deleted_at is not null then return private.failure('ALREADY_DELETED','Задача удалена. Сначала восстановите её.'); end if;
   if p_payload->>'status'='cancelled' then
     v_reason:=btrim(p_payload->>'reason');
     if v_reason is null or char_length(v_reason) not between 1 and 1000 then perform private.task_validation('reason','Укажите причину от 1 до 1000 символов.'); end if;
   end if;
   if v_task.status<>p_payload->>'status' then
     if p_payload->>'status'='done' then
       v_task.completed_at:=v_now; v_task.completed_by:=auth.uid();
       v_task.deadline_at_completion:=((v_task.deadline+1)::timestamp at time zone 'Europe/Moscow');
     else
       v_task.completed_at:=null; v_task.completed_by:=null; v_task.deadline_at_completion:=null;
     end if;
     if v_task.status in ('done','cancelled') and p_payload->>'status'='in_progress' and private.work_display_end(v_task.plan_end,v_task.deadline)<v_today then
       v_task.plan_start:=private.continuation_date(v_today,v_task.deadline); v_task.plan_end:=v_task.plan_start;
     end if;
     v_task.status:=p_payload->>'status';
   end if;
 elsif p_action='delete' then v_task.deleted_at:=v_now; v_task.deleted_by:=auth.uid();
 elsif p_action='restore' then
   v_task.deleted_at:=null; v_task.deleted_by:=null;
   if v_task.status in ('planned','in_progress','waiting') and private.work_display_end(v_task.plan_end,v_task.deadline)<v_today then
     v_task.plan_start:=private.continuation_date(v_today,v_task.deadline); v_task.plan_end:=v_task.plan_start;
   end if;
 elsif p_action='take_control' then v_task.management_mode:='manager';
 end if;
 if v_task.title is null or char_length(v_task.title) not between 1 and 200 then perform private.task_validation('title','Введите название от 1 до 200 символов.'); end if;
 if v_task.description is null or char_length(v_task.description)>10000 then perform private.task_validation('description','Описание не должно превышать 10 000 символов.'); end if;
 if v_task.plan_start is null or v_task.plan_end is null or v_task.plan_end<v_task.plan_start or v_task.plan_end-v_task.plan_start>365
   or v_task.plan_start<date '2000-01-01' or v_task.plan_end>date '2100-12-31' then perform private.task_validation('plan_end','Проверьте интервал: от 1 до 366 дней.'); end if;
 if (p_action='create' or (p_action in ('move','update') and v_task.plan_start<>(v_before->>'plan_start')::date)) and v_task.plan_start<v_today then
   perform private.task_validation('plan_start','Новая дата работы не может быть в прошлом.'); end if;
 if v_task.deadline is not null and v_task.deadline not between date '2000-01-01' and date '2100-12-31' then perform private.task_validation('deadline','Дата должна быть между 2000 и 2100 годами.'); end if;
 if (v_task.important is null)<>(v_task.urgent is null) then perform private.task_validation('priority','Задайте важность и срочность вместе.'); end if;
 if v_task.direction is not null and v_task.direction not in ('sto','dbk','rental','uk') then perform private.task_validation('direction','Неизвестное направление.'); end if;
 if not exists(select 1 from public.team_members where team_id=p_team_id and user_id=v_task.assignee_id and state='active') then perform private.task_validation('assignee_id','Выберите активного сотрудника команды.'); end if;
 if p_action='create' then
   v_task.original_plan_start:=v_task.plan_start; v_task.original_plan_end:=v_task.plan_end;
   perform private.consume_write_rate(p_team_id);
   insert into public.tasks select (v_task).*;
 else
   if v_member.role='manager' and v_task.management_mode='self' and
     row(v_task.title,v_task.assignee_id,v_task.deadline,v_task.important,v_task.urgent,v_task.direction)
     is distinct from row(v_before->>'title',(v_before->>'assignee_id')::uuid,(v_before->>'deadline')::date,
       (v_before->>'important')::boolean,(v_before->>'urgent')::boolean,v_before->>'direction') then v_task.management_mode:='manager'; end if;
   v_changed:=to_jsonb(v_task) is distinct from v_before;
   if v_changed then
     perform private.consume_write_rate(p_team_id); v_task.version:=v_task.version+1; v_task.updated_at:=v_now;
     update public.tasks set title=v_task.title,description=v_task.description,assignee_id=v_task.assignee_id,
       management_mode=v_task.management_mode,direction=v_task.direction,important=v_task.important,urgent=v_task.urgent,
       plan_start=v_task.plan_start,plan_end=v_task.plan_end,deadline=v_task.deadline,status=v_task.status,
       completed_at=v_task.completed_at,completed_by=v_task.completed_by,deadline_at_completion=v_task.deadline_at_completion,
       deleted_at=v_task.deleted_at,deleted_by=v_task.deleted_by,version=v_task.version,updated_at=v_task.updated_at where id=v_task.id;
   end if;
 end if;
 if p_action='create' or v_changed then
   perform private.place_task(v_task,v_now);
   insert into private.task_events(team_id,task_id,event_type,actor_id,is_system,effective_at,recorded_at,version_before,version_after,before_snapshot,after_snapshot,operation_id)
    values(p_team_id,v_task.id,p_action,auth.uid(),false,v_now,v_now,(v_before->>'version')::bigint,v_task.version,v_before,
      to_jsonb(v_task)||case when v_reason is not null then jsonb_build_object('cancel_reason',v_reason) else '{}'::jsonb end,p_operation_id);
 end if;
 v_result:=private.ok(jsonb_build_object('operation_id',p_operation_id,'entity',private.task_dto(to_jsonb(v_task),auth.uid(),v_member.role),'idempotent_replay',false));
 insert into private.operation_results(team_id,actor_id,operation_id,operation_type,request_hash,result) values(p_team_id,auth.uid(),p_operation_id,'task:'||v_requested_action,v_hash,v_result);
 return v_result;
exception when others then
 get stacked diagnostics v_detail=pg_exception_detail;
 if sqlerrm='VALIDATION_ERROR' then return private.failure('VALIDATION_ERROR','Проверьте поля задачи.',coalesce(nullif(v_detail,''),'{}')::jsonb); end if;
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED') then return private.failure(sqlerrm,'Недостаточно прав на это действие.'); end if;
 if sqlerrm='RATE_LIMITED' then return private.failure('RATE_LIMITED','Слишком много запросов.',jsonb_build_object('retry_after_seconds',60)); end if;
 if sqlstate in ('22P02','22007','22008','23514','23502') then return private.failure('VALIDATION_ERROR','Некорректные значения полей задачи.'); end if;
 raise;
end;
$$;
create or replace function private.maintain_team(p_team_id uuid,p_effective_today date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare team public.teams;s public.recurrence_series;t public.tasks;old_t jsonb;d date;first_day date;through date;
 n integer:=0;moved integer:=0;r jsonb;stamp timestamptz;first_event bigint;
begin
 perform private.lock_team(p_team_id);select * into team from public.teams where id=p_team_id;
 if not found then raise exception 'NOT_FOUND';end if;
 if p_effective_today is distinct from private.today() then raise exception 'VALIDATION_ERROR';end if;
 perform private.repair_deadline_continuations(p_team_id);
 select * into team from public.teams where id=p_team_id;
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
   and private.work_display_end(plan_end,deadline)<d and effective_created_at<=stamp order by id for update loop
   old_t:=to_jsonb(t);t.plan_start:=private.continuation_date(d,t.deadline);t.plan_end:=t.plan_start;t.version:=t.version+1;t.updated_at:=private.task_now();
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
create function private.undated_day_states(p_team_id uuid,p_day date,p_filters jsonb) returns table(dto jsonb)
language sql stable security definer set search_path='' as $$
 select d.dto from private.period_states(p_team_id,p_day,p_day+1,private.task_now()) s
  cross join lateral(select s.snapshot||jsonb_build_object(
 'priority',case when s.snapshot->>'important' is null then 'unset' when (s.snapshot->>'important')::boolean then
 case when (s.snapshot->>'urgent')::boolean then 'important_urgent' else 'important_not_urgent' end
 else case when (s.snapshot->>'urgent')::boolean then 'not_important_urgent' else 'not_important_not_urgent' end end,
 'overdue',s.snapshot->>'deleted_at' is null and s.snapshot->>'status' in ('planned','in_progress','waiting') and s.snapshot->>'deadline' is not null
 and (((s.snapshot->>'deadline')::date+1)::timestamp at time zone 'Europe/Moscow')<=least(private.task_now(),(p_day+1)::timestamp at time zone 'Europe/Moscow')) as dto) d
 where s.snapshot->>'deadline' is null
 and (p_day<private.today() or p_day between (s.snapshot->>'plan_start')::date and (s.snapshot->>'plan_end')::date)
 and (p_day>=private.today() or not private.had_deadline_day(s.task_id,p_day))
 and s.snapshot->>'deleted_at' is null and not coalesce((s.snapshot->>'is_superseded')::boolean,false)
 and private.list_matches(d.dto,p_filters);
$$;
create or replace function private.day_states(p_team_id uuid,p_day date,p_filters jsonb) returns table(dto jsonb)
language sql stable security definer set search_path='' as $$
 with visible as (
 select s.snapshot from private.deadline_calendar_states(p_team_id,p_day,p_filters) s
 where private.deadline_day_visible(p_day,(s.snapshot->>'plan_start')::date,(s.snapshot->>'plan_end')::date,
 (s.snapshot->>'deadline')::date,s.snapshot->>'status',(s.snapshot->>'completed_at')::timestamptz,
 case when s.snapshot->>'status'='cancelled' and exists(select 1 from private.task_events e where e.task_id=s.task_id
  and e.team_id=p_team_id and e.after_snapshot->>'status'='cancelled' and e.before_snapshot->>'status' is distinct from 'cancelled'
  and e.effective_at>=p_day::timestamp at time zone 'Europe/Moscow' and e.effective_at<(p_day+1)::timestamp at time zone 'Europe/Moscow') then p_day end)
 or p_day<private.today() and s.snapshot->>'status' in ('planned','in_progress','waiting')
  and (private.had_deadline_day(s.task_id,p_day) or exists(select 1 from private.period_states(p_team_id,p_day,p_day+1,private.task_now()) p where p.task_id=s.task_id)))
 select dto from private.undated_day_states(p_team_id,p_day,p_filters)
 union all
 select d.dto from visible s
  cross join lateral(select s.snapshot||jsonb_build_object(
 'priority',case when s.snapshot->>'important' is null then 'unset' when (s.snapshot->>'important')::boolean then
 case when (s.snapshot->>'urgent')::boolean then 'important_urgent' else 'important_not_urgent' end
 else case when (s.snapshot->>'urgent')::boolean then 'not_important_urgent' else 'not_important_not_urgent' end end,
 'overdue',s.snapshot->>'deleted_at' is null and s.snapshot->>'status' in ('planned','in_progress','waiting') and s.snapshot->>'deadline' is not null
 and (((s.snapshot->>'deadline')::date+1)::timestamp at time zone 'Europe/Moscow')<=least(private.task_now(),(p_day+1)::timestamp at time zone 'Europe/Moscow')) as dto) d
 where s.snapshot->>'deleted_at' is null and not coalesce((s.snapshot->>'is_superseded')::boolean,false)
 and private.list_matches(d.dto,p_filters);
$$;
-- Compatibility path and optimized cards share exactly the same visibility predicate.
create or replace function private.day_tasks(p_team_id uuid,p_day date,p_filters jsonb,p_user uuid,p_role text)
returns table(dto jsonb) language sql stable security definer set search_path='' as $$
 select dto from private.day_cards(p_team_id,p_day,p_filters,p_user,p_role,2147483647,0);
$$;
create or replace function private.get_planner(p_team_id uuid,p_selected_date date,p_filters jsonb,p_cursor text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.team_members; d date:=coalesce(p_selected_date,private.today()); ws date; ms date; me date; gs date; ge date;
 day_rows jsonb; week_rows jsonb:='[]'; month_rows jsonb:='[]'; terminal_done jsonb; terminal_cancelled jsonb;
 x date; v_tasks jsonb; v_total integer; v_done integer; v_employee uuid; v_direction text; v_offset integer:=0;
 v_day_total integer; v_overdue integer; v_result jsonb; v_filters jsonb:=coalesce(p_filters,'{}'); v_week_counts jsonb; v_month_counts jsonb;
begin
 m:=private.require_member(p_team_id); perform private.check_filters(p_team_id,v_filters);
 if d not between date '2000-01-01' and date '2100-12-31' or p_cursor is not null and p_cursor!~'^\d{1,7}$' then raise exception 'VALIDATION_ERROR'; end if;
 v_offset:=coalesce(p_cursor::integer,0); v_employee:=(v_filters->>'employee_id')::uuid; v_direction:=coalesce(v_filters->>'direction','all');
 ws:=d-(extract(isodow from d)::integer-1); ms:=date_trunc('month',d)::date; me:=(ms+interval '1 month')::date;
 gs:=ms-(extract(isodow from ms)::integer-1); ge:=me-1+(7-extract(isodow from me-1)::integer);
 select coalesce(jsonb_object_agg(day::text,jsonb_build_object('total',total,'done',done)),'{}') into v_week_counts
 from private.deadline_calendar_cells(p_team_id,ws,ws+6,v_filters);
 select coalesce(jsonb_object_agg(day::text,jsonb_build_object('total',total,'done',done)),'{}') into v_month_counts
 from private.deadline_calendar_cells(p_team_id,gs,ge,v_filters||'{"statuses":[]}');
 if d>=private.today() then
  select count(*) into v_day_total from private.undated_day_states(p_team_id,d,v_filters);
  v_day_total:=v_day_total+coalesce((v_week_counts->d::text->>'total')::integer,0);
 else select count(*) into v_day_total from private.day_states(p_team_id,d,v_filters);end if;
 select coalesce(jsonb_agg(dto),'[]') into day_rows from (select dto from private.day_cards(p_team_id,d,v_filters,auth.uid(),m.role,100,v_offset)) q;
 select coalesce(jsonb_agg(dto),'[]') into terminal_done from (select dto from private.day_cards(p_team_id,d,v_filters||'{"statuses":["done"]}',auth.uid(),m.role,5)) q;
 select coalesce(jsonb_agg(dto),'[]') into terminal_cancelled from (select dto from private.day_cards(p_team_id,d,v_filters||'{"statuses":["cancelled"]}',auth.uid(),m.role,5)) q;
 for x in select a::date from generate_series(ws::timestamp,(ws+6)::timestamp,interval '1 day') a loop
   if x>=private.today() then
    select count(*) into v_total from private.undated_day_states(p_team_id,x,v_filters);
    v_total:=v_total+coalesce((v_week_counts->x::text->>'total')::integer,0);
   else select count(*) into v_total from private.day_states(p_team_id,x,v_filters);end if;
   select coalesce(jsonb_agg(dto),'[]') into v_tasks from (select dto from private.day_cards(p_team_id,x,v_filters,auth.uid(),m.role,3)) q;
   week_rows:=week_rows||jsonb_build_array(jsonb_build_object('date',x,'total',v_total,'tasks',v_tasks));
 end loop;
 for x in select a::date from generate_series(gs::timestamp,ge::timestamp,interval '1 day') a loop
   if x>=private.today() then
    select count(*),count(*) filter(where dto->>'status'='done') into v_total,v_done from private.undated_day_states(p_team_id,x,v_filters||'{"statuses":[]}');
    v_total:=v_total+coalesce((v_month_counts->x::text->>'total')::integer,0);v_done:=v_done+coalesce((v_month_counts->x::text->>'done')::integer,0);
   else select count(*),count(*) filter(where dto->>'status'='done') into v_total,v_done from private.day_states(p_team_id,x,v_filters||'{"statuses":[]}');end if;
   month_rows:=month_rows||jsonb_build_array(jsonb_build_object('date',x,'total',v_total,'done',v_done));
 end loop;
 select count(*) into v_overdue from public.tasks t where t.team_id=p_team_id and t.deleted_at is null and not t.is_superseded
  and t.status in ('planned','in_progress','waiting') and t.deadline<private.today() and private.scope_matches(to_jsonb(t),v_employee,v_direction);
 v_result:=jsonb_build_object('selected_date',d,'today',private.today(),'timezone','Europe/Moscow','day_tasks',day_rows,
  'day_done_tasks',terminal_done,'day_cancelled_tasks',terminal_cancelled,'day_total',v_day_total,
  'week_days',week_rows,'month_cells',month_rows,'overdue_total',v_overdue,
  'next_cursor',case when v_offset+100<v_day_total then (v_offset+100)::text else null end,'snapshot_at',private.task_now(),
  'members',(select jsonb_agg(jsonb_build_object('user_id',user_id,'display_name',display_name,'state',state,'role',role) order by display_name,user_id) from public.team_members where team_id=p_team_id),
  'progress',jsonb_build_object('day',private.calculate_period(p_team_id,d,d+1,private.task_now(),v_employee,v_direction),
   'week',private.calculate_period(p_team_id,ws,ws+7,private.task_now(),v_employee,v_direction),
   'month',private.calculate_period(p_team_id,ms,me,private.task_now(),v_employee,v_direction)));
 return private.ok(v_result);
exception when others then
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED') then return private.failure(sqlerrm,'Доступ к команде не предоставлен.'); end if;
 if sqlerrm='VALIDATION_ERROR' or sqlstate in ('22P02','22007','22008') then return private.failure('VALIDATION_ERROR','Проверьте дату и фильтры.'); end if;
 raise;
end;
$$;


revoke execute on function private.deadline_day_visible(date,date,date,date,text,timestamptz,date),private.current_list_matches(public.tasks,jsonb),
 private.deadline_calendar_cells(uuid,date,date,jsonb),private.undated_day_states(uuid,date,jsonb) from public,anon,authenticated;
revoke execute on function private.work_display_end(date,date),private.continuation_date(date,date),
 private.repair_deadline_continuations(uuid),private.had_deadline_day(uuid,date),private.deadline_calendar_states(uuid,date,jsonb),
 private.day_states(uuid,date,jsonb),private.day_tasks(uuid,date,jsonb,uuid,text),
 private.maintain_team(uuid,date),private.mutate_task_core(uuid,text,uuid,jsonb,bigint,uuid) from public,anon,authenticated;
-- Invalidate existing UI snapshots; repair runs under the normal team lock on next sync.
update public.teams set state_version=state_version+1,maintenance_checked_at=null;
commit;
