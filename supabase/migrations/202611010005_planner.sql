begin;
create function private.scope_matches(p_task jsonb,p_employee uuid,p_direction text) returns boolean
language sql immutable set search_path='' as $$select
 (p_employee is null or p_task->>'assignee_id'=p_employee::text) and
 (p_direction='all' or (p_direction='none' and p_task->>'direction' is null) or p_task->>'direction'=p_direction)$$;

create function private.period_states(p_team_id uuid,p_start date,p_end_exclusive date,p_as_of timestamptz)
returns table(task_id uuid,snapshot jsonb,first_known_at timestamptz)
language sql stable security definer set search_path='' as $$
 with bounds as (select least(p_as_of,p_end_exclusive::timestamp at time zone 'Europe/Moscow') as t,
   p_as_of >= (p_end_exclusive::timestamp at time zone 'Europe/Moscow') as closed),
 placements as (
  select e.task_id,min(e.effective_from) as known from private.plan_day_entries e join public.tasks t on t.id=e.task_id cross join bounds b
  where t.team_id=p_team_id and e.plan_date>=p_start and e.plan_date<p_end_exclusive
   and (e.effective_from<b.t or (not b.closed and e.effective_from=b.t))
   and e.effective_from<((e.plan_date+1)::timestamp at time zone 'Europe/Moscow')
   and (e.withdrawn_at is null or e.withdrawn_at>least(b.t,e.plan_date::timestamp at time zone 'Europe/Moscow'))
  group by e.task_id)
 select p.task_id,s.state,p.known from placements p cross join bounds b
 cross join lateral (select private.task_state(p.task_id,b.t,b.closed) as state) s where s.state is not null;
$$;
create function private.calculate_period(p_team_id uuid,p_start date,p_end_exclusive date,p_as_of timestamptz,p_employee_id uuid,p_direction text)
returns jsonb language sql stable security definer set search_path='' as $$
 with bounds as (select least(p_as_of,p_end_exclusive::timestamp at time zone 'Europe/Moscow') as t,
   p_start::timestamp at time zone 'Europe/Moscow' as start_at,
   p_as_of >= (p_end_exclusive::timestamp at time zone 'Europe/Moscow') as closed),
 base as (select * from private.period_states(p_team_id,p_start,p_end_exclusive,p_as_of) s
   where private.scope_matches(s.snapshot,p_employee_id,p_direction)),
 plan as (select * from base where snapshot->>'status'<>'cancelled'),
 counts as (select count(*)::int as planned,
  count(*) filter(where snapshot->>'status'='done')::int as done,
  count(*) filter(where snapshot->>'status'='planned' and snapshot->>'deleted_at' is null)::int as status_planned,
  count(*) filter(where snapshot->>'status'='in_progress' and snapshot->>'deleted_at' is null)::int as in_progress,
  count(*) filter(where snapshot->>'status'='waiting' and snapshot->>'deleted_at' is null)::int as waiting,
  count(*) filter(where snapshot->>'status'<>'done' and snapshot->>'deleted_at' is not null)::int as deleted_unfinished,
  count(*) filter(where snapshot->>'deleted_at' is null and snapshot->>'status' in ('planned','in_progress','waiting')
    and (((snapshot->>'deadline')::date+1)::timestamp at time zone 'Europe/Moscow')<=(select t from bounds))::int as overdue from plan),
 events as (select e.* from private.task_events e cross join bounds b where e.team_id=p_team_id
   and e.effective_at>=b.start_at and e.effective_at<(p_end_exclusive::timestamp at time zone 'Europe/Moscow')
   and (e.effective_at<b.t or (not b.closed and e.effective_at=b.t))),
 completions as (select distinct on(e.task_id) e.* from events e cross join bounds b
  where e.after_snapshot->>'status'='done' and e.before_snapshot->>'status' is distinct from 'done'
    and private.scope_matches(e.after_snapshot,p_employee_id,p_direction)
    and not exists(select 1 from private.task_events n where n.task_id=e.task_id
     and (n.effective_at>e.effective_at or (n.effective_at=e.effective_at and n.event_seq>e.event_seq))
     and (n.effective_at<b.t or (not b.closed and n.effective_at=b.t)) and n.after_snapshot->>'status'<>'done')
  order by e.task_id,e.effective_at desc,e.event_seq desc),
 moves as (select * from events e where e.before_snapshot is not null and
   (e.before_snapshot->>'plan_start',e.before_snapshot->>'plan_end') is distinct from (e.after_snapshot->>'plan_start',e.after_snapshot->>'plan_end')
   and private.scope_matches(e.after_snapshot,p_employee_id,p_direction))
 select jsonb_build_object('planned_count',c.planned,'plan_done_count',c.done,
  'progress_percent',case when c.planned=0 then null else round(100.0*c.done/c.planned,1) end,
  'remaining_count',c.planned-c.done,'status_planned_count',c.status_planned,'in_progress_count',c.in_progress,
  'waiting_count',c.waiting,'deleted_unfinished_count',c.deleted_unfinished,'overdue_count',c.overdue,
  'actual_done_count',(select count(*) from completions),
  'late_done_count',(select count(*) from completions where (after_snapshot->>'completed_at')::timestamptz >= (after_snapshot->>'deadline_at_completion')::timestamptz),
  'cancelled_count',(select count(distinct e.task_id) from events e cross join bounds b where e.after_snapshot->>'status'='cancelled'
    and e.before_snapshot->>'status' is distinct from 'cancelled' and private.scope_matches(e.after_snapshot,p_employee_id,p_direction)
    and private.task_state(e.task_id,b.t,b.closed)->>'status'='cancelled'),
  'moved_task_count',(select count(distinct task_id) from moves),
  'manual_moved_task_count',(select count(distinct task_id) from moves where not is_system),
  'auto_moved_task_count',(select count(distinct task_id) from moves where is_system),
  'created_count',(select count(*) from base cross join bounds b where (snapshot->>'effective_created_at')::timestamptz>=b.start_at),
  'added_to_plan_count',(select count(*) from base cross join bounds b where first_known_at>b.start_at)) from counts c;
$$;
create function private.check_filters(p_team_id uuid,p_filters jsonb) returns void language plpgsql stable security definer set search_path='' as $$
declare k text; v text;
begin
 if p_filters is null or jsonb_typeof(p_filters)<>'object' then raise exception 'VALIDATION_ERROR'; end if;
 for k in select jsonb_object_keys(p_filters) loop
  if k not in ('employee_id','direction','statuses','priorities','deadline_filter','query','group_by') then raise exception 'VALIDATION_ERROR'; end if;
 end loop;
 if coalesce(p_filters->>'direction','all') not in ('all','none','sto','dbk','rental','uk') or coalesce(p_filters->>'deadline_filter','all') not in ('all','none','today','next_7_days','overdue')
  or coalesce(p_filters->>'group_by','list') not in ('list','status','priority') or char_length(coalesce(p_filters->>'query',''))>200 then raise exception 'VALIDATION_ERROR'; end if;
 if p_filters->>'employee_id' is not null and not exists(select 1 from public.team_members where team_id=p_team_id and user_id=(p_filters->>'employee_id')::uuid) then raise exception 'ACCESS_DENIED'; end if;
 if p_filters?'statuses' then
  if jsonb_typeof(p_filters->'statuses')<>'array' then raise exception 'VALIDATION_ERROR'; end if;
  for v in select jsonb_array_elements_text(p_filters->'statuses') loop if v not in ('planned','in_progress','waiting','done','cancelled') then raise exception 'VALIDATION_ERROR'; end if; end loop;
 end if;
 if p_filters?'priorities' then
  if jsonb_typeof(p_filters->'priorities')<>'array' then raise exception 'VALIDATION_ERROR'; end if;
  for v in select jsonb_array_elements_text(p_filters->'priorities') loop if v not in ('important_urgent','important_not_urgent','not_important_urgent','not_important_not_urgent','unset') then raise exception 'VALIDATION_ERROR'; end if; end loop;
 end if;
end;
$$;
create function private.list_matches(p_dto jsonb,p_filters jsonb) returns boolean language sql stable set search_path='' as $$ select
 private.scope_matches(p_dto,(p_filters->>'employee_id')::uuid,coalesce(p_filters->>'direction','all'))
 and (not (p_filters?'statuses') or jsonb_array_length(p_filters->'statuses')=0 or (p_filters->'statuses')?(p_dto->>'status'))
 and (not (p_filters?'priorities') or jsonb_array_length(p_filters->'priorities')=0 or (p_filters->'priorities')?(p_dto->>'priority'))
 and (coalesce(p_filters->>'query','')='' or position(lower(p_filters->>'query') in lower((p_dto->>'title')||' '||(p_dto->>'description')))>0)
 and case coalesce(p_filters->>'deadline_filter','all') when 'none' then p_dto->>'deadline' is null
  when 'today' then (p_dto->>'deadline')::date=private.today()
  when 'next_7_days' then (p_dto->>'deadline')::date between private.today() and private.today()+6
  when 'overdue' then (p_dto->>'overdue')::boolean else true end;
$$;
create function private.day_tasks(p_team_id uuid,p_day date,p_filters jsonb,p_user uuid,p_role text)
returns table(dto jsonb) language sql stable security definer set search_path='' as $$
 select d.dto from private.period_states(p_team_id,p_day,p_day+1,private.task_now()) s
 cross join lateral(select private.task_dto(s.snapshot,p_user,p_role,p_day<private.today(),least(private.task_now(),(p_day+1)::timestamp at time zone 'Europe/Moscow')) as dto) d
 where s.snapshot->>'deleted_at' is null and not coalesce((s.snapshot->>'is_superseded')::boolean,false)
 and (p_day<private.today() or p_day between (s.snapshot->>'plan_start')::date and (s.snapshot->>'plan_end')::date)
 and private.list_matches(d.dto,p_filters)
 order by case when d.dto->>'status' in ('done','cancelled') then 3 when (d.dto->>'overdue')::boolean then 0
   when (d.dto->>'deadline')::date=private.today() then 1 else 2 end,
  case when d.dto->>'status' in ('done','cancelled') then 0 else case d.dto->>'priority' when 'important_urgent' then 0 when 'important_not_urgent' then 1 when 'not_important_urgent' then 2 when 'not_important_not_urgent' then 3 else 4 end end,
  case when d.dto->>'status'='done' then (d.dto->>'completed_at')::timestamptz end desc,
  (d.dto->>'deadline')::date asc nulls last,(d.dto->>'created_at')::timestamptz,d.dto->>'id';
$$;
create function public.get_planner(p_team_id uuid,p_selected_date date,p_filters jsonb,p_cursor text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.team_members; d date:=coalesce(p_selected_date,private.today()); ws date; ms date; me date; gs date; ge date;
 day_rows jsonb; week_rows jsonb:='[]'; month_rows jsonb:='[]'; terminal_done jsonb; terminal_cancelled jsonb;
 x date; v_tasks jsonb; v_total integer; v_done integer; v_employee uuid; v_direction text; v_offset integer:=0;
 v_day_total integer; v_overdue integer; v_result jsonb; v_filters jsonb:=coalesce(p_filters,'{}');
begin
 m:=private.require_member(p_team_id); perform private.check_filters(p_team_id,v_filters);
 if d not between date '2000-01-01' and date '2100-12-31' or p_cursor is not null and p_cursor!~'^\d{1,7}$' then raise exception 'VALIDATION_ERROR'; end if;
 v_offset:=coalesce(p_cursor::integer,0); v_employee:=(v_filters->>'employee_id')::uuid; v_direction:=coalesce(v_filters->>'direction','all');
 ws:=d-(extract(isodow from d)::integer-1); ms:=date_trunc('month',d)::date; me:=(ms+interval '1 month')::date;
 gs:=ms-(extract(isodow from ms)::integer-1); ge:=me-1+(7-extract(isodow from me-1)::integer);
 select count(*) into v_day_total from private.day_tasks(p_team_id,d,v_filters,auth.uid(),m.role);
 select coalesce(jsonb_agg(dto),'[]') into day_rows from (select dto from private.day_tasks(p_team_id,d,v_filters,auth.uid(),m.role) limit 100 offset v_offset) q;
 select coalesce(jsonb_agg(dto),'[]') into terminal_done from (select dto from private.day_tasks(p_team_id,d,v_filters||'{"statuses":["done"]}',auth.uid(),m.role) limit 5) q;
 select coalesce(jsonb_agg(dto),'[]') into terminal_cancelled from (select dto from private.day_tasks(p_team_id,d,v_filters||'{"statuses":["cancelled"]}',auth.uid(),m.role) limit 5) q;
 for x in select a::date from generate_series(ws::timestamp,(ws+6)::timestamp,interval '1 day') a loop
   select count(*) into v_total from private.day_tasks(p_team_id,x,v_filters,auth.uid(),m.role);
   select coalesce(jsonb_agg(dto),'[]') into v_tasks from (select dto from private.day_tasks(p_team_id,x,v_filters,auth.uid(),m.role) limit 3) q;
   week_rows:=week_rows||jsonb_build_array(jsonb_build_object('date',x,'total',v_total,'tasks',v_tasks));
 end loop;
 for x in select a::date from generate_series(gs::timestamp,ge::timestamp,interval '1 day') a loop
   select count(*),count(*) filter(where dto->>'status'='done') into v_total,v_done from private.day_tasks(p_team_id,x,v_filters||'{"statuses":[]}',auth.uid(),m.role);
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
create function public.get_task_detail(p_team_id uuid,p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.team_members; t public.tasks;
begin
 m:=private.require_member(p_team_id); select * into t from public.tasks where team_id=p_team_id and id=p_task_id;
 if not found then return private.failure('NOT_FOUND','Задача не найдена.'); end if;
 return private.ok(jsonb_build_object('task',private.task_dto(to_jsonb(t),auth.uid(),m.role)));
 exception when others then if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED') then return private.failure(sqlerrm,'Доступ запрещён.'); end if; raise; end;
$$;
create function public.get_task_history(p_team_id uuid,p_task_id uuid,p_cursor text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_rows jsonb; v_last bigint; v_total integer;
begin
 perform private.require_member(p_team_id);
 if not exists(select 1 from public.tasks where team_id=p_team_id and id=p_task_id) then return private.failure('NOT_FOUND','Задача не найдена.'); end if;
 if p_cursor is not null and p_cursor!~'^\d{1,20}$' then raise exception 'VALIDATION_ERROR'; end if;
 select jsonb_agg(v order by event_seq desc),min(event_seq) into v_rows,v_last from (
  select e.event_seq,jsonb_build_object('id',e.event_seq,'type',e.event_type,'at',e.effective_at,'actor_name',coalesce(m.display_name,'Автоматически'),
   'before',case when e.before_snapshot is null then null else e.before_snapshot-array['body','email','password'] end,
   'after',e.after_snapshot-array['body','email','password']) as v
  from private.task_events e left join public.team_members m on m.team_id=e.team_id and m.user_id=e.actor_id
  where e.task_id=p_task_id and e.team_id=p_team_id and e.event_type in ('create','update','move','status','delete','restore','take_control','auto_move')
   and (p_cursor is null or e.event_seq<p_cursor::bigint) order by e.event_seq desc limit 50) q;
 select count(*) into v_total from private.task_events where task_id=p_task_id and event_seq<v_last;
 return private.ok(jsonb_build_object('events',coalesce(v_rows,'[]'),'next_cursor',case when v_total>0 then v_last::text else null end));
exception when others then
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED') then return private.failure(sqlerrm,'Доступ запрещён.'); end if;
 if sqlerrm='VALIDATION_ERROR' or sqlstate in ('22P02','22003') then return private.failure('VALIDATION_ERROR','Некорректная страница истории.'); end if; raise; end;
$$;
create function public.list_task_collection(p_team_id uuid,p_collection text,p_employee_id uuid default null,p_direction text default 'all',p_cursor text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.team_members; v_rows jsonb; v_total integer; v_offset integer:=0;
begin
 m:=private.require_member(p_team_id);
 if p_collection is null or p_collection not in ('deleted','overdue') or p_cursor is not null and p_cursor!~'^\d{1,7}$' then raise exception 'VALIDATION_ERROR'; end if;
 v_offset:=coalesce(p_cursor::integer,0);
 perform private.check_filters(p_team_id,jsonb_build_object('employee_id',p_employee_id,'direction',p_direction));
 select count(*) into v_total from public.tasks t where t.team_id=p_team_id and
  case when p_collection='deleted' then t.deleted_at is not null and (private.task_actions(to_jsonb(t),auth.uid(),m.role)?'restore')
   else t.deleted_at is null and t.status in ('planned','in_progress','waiting') and t.deadline<private.today() end
  and private.scope_matches(to_jsonb(t),p_employee_id,p_direction);
 select jsonb_agg(dto) into v_rows from (select private.task_dto(to_jsonb(t),auth.uid(),m.role) as dto from public.tasks t where t.team_id=p_team_id and
  case when p_collection='deleted' then t.deleted_at is not null and (private.task_actions(to_jsonb(t),auth.uid(),m.role)?'restore')
   else t.deleted_at is null and t.status in ('planned','in_progress','waiting') and t.deadline<private.today() end
  and private.scope_matches(to_jsonb(t),p_employee_id,p_direction) order by t.deadline nulls last,t.created_at,t.id limit 50 offset v_offset) q;
 return private.ok(jsonb_build_object('tasks',coalesce(v_rows,'[]'),'total',v_total,'next_cursor',case when v_offset+50<v_total then (v_offset+50)::text else null end));
exception when others then
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED') then return private.failure(sqlerrm,'Доступ запрещён.'); end if;
 if sqlerrm='VALIDATION_ERROR' or sqlstate='22P02' then return private.failure('VALIDATION_ERROR','Проверьте параметры списка.'); end if; raise;
end;
$$;
revoke execute on all functions in schema private from public,anon,authenticated;
grant execute on function private.is_active_member(uuid) to authenticated;
revoke execute on function public.get_planner(uuid,date,jsonb,text),public.get_task_detail(uuid,uuid),public.get_task_history(uuid,uuid,text),public.list_task_collection(uuid,text,uuid,text,text) from public,anon;
grant execute on function public.get_planner(uuid,date,jsonb,text),public.get_task_detail(uuid,uuid),public.get_task_history(uuid,uuid,text),public.list_task_collection(uuid,text,uuid,text,text) to authenticated;
commit;
