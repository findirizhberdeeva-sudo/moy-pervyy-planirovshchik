begin;
-- Result dates govern statistics; work placements continue to govern the calendar.
create function private.result_states(p_team_id uuid,p_start date,p_end_exclusive date,p_as_of timestamptz)
returns table(task_id uuid,snapshot jsonb,first_known_at timestamptz)
language sql stable security definer set search_path='' as $$
 with bounds as (select least(p_as_of,p_end_exclusive::timestamp at time zone 'Europe/Moscow') as t,
  p_start::timestamp at time zone 'Europe/Moscow' as a,
  p_as_of>=(p_end_exclusive::timestamp at time zone 'Europe/Moscow') as closed),
 candidates as materialized (select t.* from public.tasks t where t.team_id=p_team_id),
 unchanged as (select task_row.id as task_id,to_jsonb(task_row) as s from candidates task_row cross join bounds b
  where (task_row.updated_at<b.t or not b.closed and task_row.updated_at=b.t)
  and (task_row.effective_created_at<b.t or not b.closed and task_row.effective_created_at=b.t)),
 historical as (select distinct on(e.task_id) e.task_id,e.after_snapshot as s
  from private.task_events e join candidates t on t.id=e.task_id cross join bounds b where e.team_id=p_team_id
  and not (t.updated_at<b.t or not b.closed and t.updated_at=b.t)
  and (e.effective_at<b.t or not b.closed and e.effective_at=b.t)
  order by e.task_id,e.effective_at desc,e.event_seq desc),
 latest as materialized (select * from unchanged union all select * from historical),
 dated as (select l.*,coalesce((s->>'deadline')::date,(s->>'plan_end')::date) as due from latest l)
 select d.task_id,d.s-array['comment','series_change'],(d.s->>'effective_created_at')::timestamptz
 from dated d cross join bounds b
 where not coalesce((d.s->>'is_superseded')::boolean,false)
 and (d.s->>'deleted_at' is null or (d.s->>'deleted_at')::timestamptz >= (d.due::timestamp at time zone 'Europe/Moscow'))
 and (d.due>=p_start and d.due<p_end_exclusive
  or d.due<p_start and (d.s->>'status' not in ('done','cancelled') or (d.s->>'completed_at')::timestamptz>=b.a));
$$;
create or replace function private.report_facts(p_team uuid,p_start date,p_end date,p_at timestamptz,p_employee uuid,p_direction text)
returns table(metric_key text,task_id uuid,snapshot jsonb,event_at timestamptz,basis text,repeated boolean)
language sql stable security definer set search_path='' as $$
 with bounds as (select least(p_at,p_end::timestamp at time zone 'Europe/Moscow') as t,
 p_start::timestamp at time zone 'Europe/Moscow' as a,p_at>=(p_end::timestamp at time zone 'Europe/Moscow') as closed),
 base as (select * from private.result_states(p_team,p_start,p_end,p_at) s where private.scope_matches(s.snapshot,p_employee,p_direction)),
 events as (select e.* from private.task_events e cross join bounds b where e.team_id=p_team
 and e.effective_at>=b.a and e.effective_at<(p_end::timestamp at time zone 'Europe/Moscow') and (e.effective_at<b.t or not b.closed and e.effective_at=b.t)),
 completions as (select distinct on(e.task_id) e.* from events e cross join bounds b
 where e.after_snapshot->>'status'='done' and e.before_snapshot->>'status' is distinct from 'done'
 and private.scope_matches(e.after_snapshot,p_employee,p_direction)
 and not exists(select 1 from private.task_events n where n.task_id=e.task_id
 and (n.effective_at>e.effective_at or n.effective_at=e.effective_at and n.event_seq>e.event_seq)
 and (n.effective_at<b.t or not b.closed and n.effective_at=b.t) and n.after_snapshot->>'status'<>'done')
 order by e.task_id,e.effective_at desc,e.event_seq desc),
 moves as (select e.* from events e where e.before_snapshot is not null and
 (e.before_snapshot->>'plan_start',e.before_snapshot->>'plan_end') is distinct from (e.after_snapshot->>'plan_start',e.after_snapshot->>'plan_end')
 and private.scope_matches(e.after_snapshot,p_employee,p_direction)),
 facts as (
 select k as metric_key,s.task_id,s.snapshot,null::timestamptz as event_at,'Срок результата и состояние на момент расчёта'::text as basis,false as repeated
 from base s cross join bounds b cross join lateral unnest(array_remove(array[
 'base_count',case when (s.snapshot->>'effective_created_at')::timestamptz>=b.a then 'created_count' end,
 case when s.first_known_at>b.a then 'added_to_plan_count' end,
 case when s.snapshot->>'status'<>'cancelled' then 'planned_count' end,
 case when s.snapshot->>'status'='done' then 'plan_done_count' end,
 case when s.snapshot->>'status' not in ('done','cancelled') then 'remaining_count' end,
 case when s.snapshot->>'status'='planned' and s.snapshot->>'deleted_at' is null then 'status_planned_count' end,
 case when s.snapshot->>'status'='in_progress' and s.snapshot->>'deleted_at' is null then 'in_progress_count' end,
 case when s.snapshot->>'status'='waiting' and s.snapshot->>'deleted_at' is null then 'waiting_count' end,
 case when s.snapshot->>'status' not in ('done','cancelled') and s.snapshot->>'deleted_at' is not null then 'deleted_unfinished_count' end,
 case when s.snapshot->>'status' in ('planned','in_progress','waiting') and s.snapshot->>'deleted_at' is null
 and (((s.snapshot->>'deadline')::date+1)::timestamp at time zone 'Europe/Moscow')<=b.t then 'overdue_count' end
 ],null)) k
 union all
 select k,e.task_id,e.after_snapshot,e.effective_at,'Исполнитель и направление при завершении',
 exists(select 1 from private.task_events old where old.task_id=e.task_id and old.effective_at<(p_start::timestamp at time zone 'Europe/Moscow')
 and old.after_snapshot->>'status'='done' and old.before_snapshot->>'status' is distinct from 'done')
 from completions e cross join lateral unnest(array_remove(array['actual_done_count',
 case when (e.after_snapshot->>'completed_at')::timestamptz>=(e.after_snapshot->>'deadline_at_completion')::timestamptz then 'late_done_count' end,
 case when (e.effective_at at time zone 'Europe/Moscow')::date < coalesce((e.after_snapshot->>'deadline')::date,(e.after_snapshot->>'plan_end')::date) then 'early_done_count' end],null)) k
 union all
 select distinct on(k,e.task_id) k,e.task_id,e.after_snapshot,e.effective_at,'Исполнитель и направление при переносе',false
 from moves e cross join lateral unnest(array['moved_task_count',case when e.is_system then 'auto_moved_task_count' else 'manual_moved_task_count' end]) k
 union all
 select distinct on(e.task_id) 'cancelled_count',e.task_id,e.after_snapshot,e.effective_at,'Исполнитель и направление при отмене',false
 from events e cross join bounds b where e.after_snapshot->>'status'='cancelled' and e.before_snapshot->>'status' is distinct from 'cancelled'
 and e.event_type<>'series_replace' and private.scope_matches(e.after_snapshot,p_employee,p_direction)
 and private.task_state(e.task_id,b.t,b.closed)->>'status'='cancelled'
 and not exists(select 1 from private.task_events n where n.task_id=e.task_id
 and (n.effective_at>e.effective_at or n.effective_at=e.effective_at and n.event_seq>e.event_seq)
 and (n.effective_at<b.t or not b.closed and n.effective_at=b.t) and n.after_snapshot->>'status'<>'cancelled')
 ) select * from facts;
$$;
create or replace function private.calculate_period(p_team_id uuid,p_start date,p_end_exclusive date,p_as_of timestamptz,p_employee_id uuid,p_direction text)
returns jsonb language sql stable security definer set search_path='' as $$
 with facts as materialized (select * from private.report_facts(p_team_id,p_start,p_end_exclusive,p_as_of,p_employee_id,p_direction)),
 keys as (select unnest(array['planned_count','plan_done_count','remaining_count','status_planned_count','in_progress_count','waiting_count',
 'deleted_unfinished_count','actual_done_count','early_done_count','overdue_count','late_done_count','cancelled_count','moved_task_count','manual_moved_task_count',
 'auto_moved_task_count','created_count','added_to_plan_count']) as k)
 select private.report_metrics(jsonb_object_agg(k,(select count(*) from facts where metric_key=k))) from keys;
$$;
create or replace function private.report_group(p_team uuid,p_start date,p_end date,p_at timestamptz,p_employee uuid,p_direction text)
returns jsonb language sql stable security definer set search_path='' as $$
 with facts as materialized (select * from private.report_facts(p_team,p_start,p_end,p_at,p_employee,p_direction)),
 keys as (select unnest(array['base_count','planned_count','plan_done_count','remaining_count','status_planned_count','in_progress_count','waiting_count',
 'deleted_unfinished_count','actual_done_count','early_done_count','overdue_count','late_done_count','cancelled_count','moved_task_count','manual_moved_task_count',
 'auto_moved_task_count','created_count','added_to_plan_count']) as k),
 sets as (select k,coalesce((select jsonb_agg(jsonb_build_object('id',f.task_id,'title',f.snapshot->>'title',
 'assignee_id',f.snapshot->>'assignee_id','assignee_name',coalesce(m.display_name,'Участник'),'direction',f.snapshot->>'direction',
 'status',f.snapshot->>'status','deleted',f.snapshot->>'deleted_at' is not null,'deadline',f.snapshot->>'deadline',
 'completed_at',f.snapshot->>'completed_at','event_at',f.event_at,'basis',f.basis,'repeated',f.repeated,
 'late',coalesce((f.snapshot->>'completed_at')::timestamptz>=(f.snapshot->>'deadline_at_completion')::timestamptz,false)) order by f.task_id)
 from facts f left join public.team_members m on m.team_id=p_team and m.user_id=(f.snapshot->>'assignee_id')::uuid where f.metric_key=k),'[]') as rows from keys)
 select jsonb_build_object('metrics',private.report_metrics(jsonb_object_agg(k,jsonb_array_length(rows))),'rows',jsonb_object_agg(k,rows)) from sets;
$$;
create function private.support_daily_facts(p_team uuid,p_day date)
returns table(subject_id uuid,planned integer,done integer,early integer)
language sql stable security definer set search_path='' as $$
 select (f.snapshot->>'assignee_id')::uuid,
 count(*) filter(where f.metric_key='planned_count')::integer,
 count(*) filter(where f.metric_key='plan_done_count')::integer,
 count(*) filter(where f.metric_key='early_done_count')::integer
 from private.report_facts(p_team,p_day,p_day+1,private.task_now(),null,'all') f
 where f.metric_key in ('planned_count','plan_done_count','early_done_count')
 group by (f.snapshot->>'assignee_id')::uuid;
$$;
create or replace function private.support_counts(p_team uuid,p_day date) returns table(subject_id uuid,planned integer,done integer)
language sql stable security definer set search_path='' as $$
 select subject_id,planned,done from private.support_daily_facts(p_team,p_day);
$$;
create or replace function private.refresh_daily_support(p_team uuid) returns integer language plpgsql security definer set search_path='' as $$
declare d date:=private.support_day(private.task_now());n integer;
begin
 perform private.lock_team(p_team);
 insert into public.notifications(team_id,recipient_id,type,task_id,payload,created_at,dedupe_key)
 select p_team,recipient.user_id,'daily_support',null,
 private.support_payload(d,subject.user_id,subject.display_name,coalesce(c.planned,0),coalesce(c.done,0))||jsonb_build_object('early_done_count',coalesce(c.early,0)),
 (d+time '17:45') at time zone 'Europe/Moscow','support:'||p_team||':'||subject.user_id||':'||d
 from public.team_members subject left join private.support_daily_facts(p_team,d) c on c.subject_id=subject.user_id
 join public.team_members recipient on recipient.team_id=p_team and recipient.state='active'
  and (recipient.user_id=subject.user_id or recipient.role='manager')
 where subject.team_id=p_team and subject.state='active' and (subject.joined_at at time zone 'Europe/Moscow')::date<=d
 on conflict(recipient_id,dedupe_key) do update set payload=excluded.payload
 where public.notifications.payload is distinct from excluded.payload;
 get diagnostics n=row_count;return n;
end;$$;
create or replace function public.get_weekly_progress(p_team_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare caller public.team_members;today date:=private.today();ws date;sd date:=private.support_day(private.task_now());rows jsonb;own jsonb;detail text;
begin
 caller:=private.require_member(p_team_id);perform private.consume_read_rate(p_team_id);
 perform private.lock_team(p_team_id);perform private.maintain_team(p_team_id,today);perform private.refresh_daily_support(p_team_id);
 ws:=today-(extract(isodow from today)::integer-1);
 with days as(select ws+g as day from generate_series(0,6) g),
 facts as materialized(select d.day,c.* from days d cross join lateral private.support_daily_facts(p_team_id,d.day) c),
 members as(select m.*,coalesce((select jsonb_agg(jsonb_build_object('date',d.day,'planned_count',coalesce(c.planned,0),
  'plan_done_count',coalesce(c.done,0),'early_done_count',coalesce(c.early,0),'progress_percent',case when coalesce(c.planned,0)=0 then null else round(100.0*c.done/c.planned,1) end,
  'is_today',d.day=today,'is_future',d.day>today,'is_weekend',extract(isodow from d.day)>5) order by d.day)
  from days d left join facts c on c.day=d.day and c.subject_id=m.user_id),'[]') as days
  from public.team_members m where m.team_id=p_team_id and m.state='active' and (caller.role='manager' or m.user_id=auth.uid()))
 select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name',m.display_name,'role',m.role,'days',m.days,
  'support',(select n.payload from public.notifications n where n.team_id=p_team_id and n.recipient_id=auth.uid()
   and n.type='daily_support' and n.payload->>'date'=sd::text and n.payload->>'subject_id'=m.user_id::text))
  order by m.user_id<>auth.uid(),m.display_name,m.user_id),'[]') into rows from members m;
 select jsonb_build_object('id',n.id,'read_at',n.read_at,'payload',n.payload) into own from public.notifications n
 where n.team_id=p_team_id and n.recipient_id=auth.uid() and n.type='daily_support'
 and n.payload->>'date'=sd::text and n.payload->>'subject_id'=auth.uid()::text;
 return private.ok(jsonb_build_object('today',today,'week_start',ws,'week_end',ws+6,'timezone','Europe/Moscow',
  'support_day',sd,'members',rows,'own_support',own));
exception when others then
 get stacked diagnostics detail=pg_exception_detail;
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','RATE_LIMITED') then return private.app_failure(sqlerrm,detail);end if;raise;
end;$$;
-- Existing frozen reports must be refreshed after the metric definition changes.
update private.report_snapshots set expires_at=least(expires_at,private.task_now());
-- Recalculate only existing messages, preserving IDs/read_at/created_at and claims.
with revised as (
 select n.id,private.support_payload((n.payload->>'date')::date,(n.payload->>'subject_id')::uuid,
  n.payload->>'subject_name',coalesce(c.planned,0),coalesce(c.done,0))||
  jsonb_build_object('early_done_count',coalesce(c.early,0)) as payload
 from public.notifications n left join lateral private.support_daily_facts(n.team_id,(n.payload->>'date')::date) c
  on c.subject_id=(n.payload->>'subject_id')::uuid where n.type='daily_support'
) update public.notifications n set payload=r.payload from revised r where n.id=r.id and n.payload is distinct from r.payload;
revoke execute on function private.result_states(uuid,date,date,timestamptz),private.support_daily_facts(uuid,date) from public,anon,authenticated;
commit;
