begin;
-- Read latest states as one set. A day/month can contain thousands of task IDs.
-- The exclusive period boundary and business timestamps are identical to task_state().
create or replace function private.period_states(p_team_id uuid,p_start date,p_end_exclusive date,p_as_of timestamptz)
returns table(task_id uuid,snapshot jsonb,first_known_at timestamptz)
language sql stable security definer set search_path='' as $$
 with bounds as (select least(p_as_of,p_end_exclusive::timestamp at time zone 'Europe/Moscow') as t,
 p_as_of>=(p_end_exclusive::timestamp at time zone 'Europe/Moscow') as closed),
 placements as materialized (
 select e.task_id,min(e.effective_from) as known from private.plan_day_entries e join public.tasks t on t.id=e.task_id cross join bounds b
 where t.team_id=p_team_id and e.plan_date>=p_start and e.plan_date<p_end_exclusive
 and (e.effective_from<b.t or not b.closed and e.effective_from=b.t)
 and e.effective_from<((e.plan_date+1)::timestamp at time zone 'Europe/Moscow')
 and (e.withdrawn_at is null or e.withdrawn_at>least(b.t,e.plan_date::timestamp at time zone 'Europe/Moscow')) group by e.task_id),
 latest as (select distinct on(e.task_id) e.task_id,e.after_snapshot from private.task_events e join placements p on p.task_id=e.task_id cross join bounds b
 where e.team_id=p_team_id and (e.effective_at<b.t or not b.closed and e.effective_at=b.t) order by e.task_id,e.effective_at desc,e.event_seq desc)
 select p.task_id,l.after_snapshot-array['comment','series_change'],p.known from placements p join latest l on l.task_id=p.task_id;
$$;
-- Calendar counters need states, not complete cards with author/actions/comments.
create function private.day_states(p_team_id uuid,p_day date,p_filters jsonb) returns table(dto jsonb)
language sql stable security definer set search_path='' as $$
 select d.dto from private.period_states(p_team_id,p_day,p_day+1,private.task_now()) s
 cross join lateral(select s.snapshot||jsonb_build_object(
 'priority',case when s.snapshot->>'important' is null then 'unset' when (s.snapshot->>'important')::boolean then
 case when (s.snapshot->>'urgent')::boolean then 'important_urgent' else 'important_not_urgent' end
 else case when (s.snapshot->>'urgent')::boolean then 'not_important_urgent' else 'not_important_not_urgent' end end,
 'overdue',s.snapshot->>'deleted_at' is null and s.snapshot->>'status' in ('planned','in_progress','waiting') and s.snapshot->>'deadline' is not null
 and (((s.snapshot->>'deadline')::date+1)::timestamp at time zone 'Europe/Moscow')<=least(private.task_now(),(p_day+1)::timestamp at time zone 'Europe/Moscow')) as dto) d
 where s.snapshot->>'deleted_at' is null and not coalesce((s.snapshot->>'is_superseded')::boolean,false)
 and (p_day<private.today() or p_day between (s.snapshot->>'plan_start')::date and (s.snapshot->>'plan_end')::date)
 and private.list_matches(d.dto,p_filters);
$$;
create function private.day_cards(p_team_id uuid,p_day date,p_filters jsonb,p_user uuid,p_role text,p_limit integer,p_offset integer default 0)
returns table(dto jsonb) language sql stable security definer set search_path='' as $$
 select private.task_dto(d.dto,p_user,p_role,p_day<private.today(),least(private.task_now(),(p_day+1)::timestamp at time zone 'Europe/Moscow'))
 from (select s.dto from private.day_states(p_team_id,p_day,p_filters) s
 order by case when s.dto->>'status' in ('done','cancelled') then 3 when (s.dto->>'overdue')::boolean then 0 when (s.dto->>'deadline')::date=private.today() then 1 else 2 end,
 case when s.dto->>'status' in ('done','cancelled') then 0 else case s.dto->>'priority' when 'important_urgent' then 0 when 'important_not_urgent' then 1 when 'not_important_urgent' then 2 when 'not_important_not_urgent' then 3 else 4 end end,
 case when s.dto->>'status'='done' then (s.dto->>'completed_at')::timestamptz end desc,
 (s.dto->>'deadline')::date nulls last,(s.dto->>'created_at')::timestamptz,s.dto->>'id'
 limit p_limit offset p_offset) d;
$$;
revoke execute on function private.period_states(uuid,date,date,timestamptz),private.day_states(uuid,date,jsonb),private.day_cards(uuid,date,jsonb,uuid,text,integer,integer) from public,anon,authenticated;
create or replace function private.get_planner(p_team_id uuid,p_selected_date date,p_filters jsonb,p_cursor text default null)
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
 select count(*) into v_day_total from private.day_states(p_team_id,d,v_filters);
 select coalesce(jsonb_agg(dto),'[]') into day_rows from (select dto from private.day_cards(p_team_id,d,v_filters,auth.uid(),m.role,100,v_offset)) q;
 select coalesce(jsonb_agg(dto),'[]') into terminal_done from (select dto from private.day_cards(p_team_id,d,v_filters||'{"statuses":["done"]}',auth.uid(),m.role,5)) q;
 select coalesce(jsonb_agg(dto),'[]') into terminal_cancelled from (select dto from private.day_cards(p_team_id,d,v_filters||'{"statuses":["cancelled"]}',auth.uid(),m.role,5)) q;
 for x in select a::date from generate_series(ws::timestamp,(ws+6)::timestamp,interval '1 day') a loop
   select count(*) into v_total from private.day_states(p_team_id,x,v_filters);
   select coalesce(jsonb_agg(dto),'[]') into v_tasks from (select dto from private.day_cards(p_team_id,x,v_filters,auth.uid(),m.role,3)) q;
   week_rows:=week_rows||jsonb_build_array(jsonb_build_object('date',x,'total',v_total,'tasks',v_tasks));
 end loop;
 for x in select a::date from generate_series(gs::timestamp,ge::timestamp,interval '1 day') a loop
   select count(*),count(*) filter(where dto->>'status'='done') into v_total,v_done from private.day_states(p_team_id,x,v_filters||'{"statuses":[]}');
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

commit;