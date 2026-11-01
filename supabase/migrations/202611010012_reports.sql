begin;
-- Each metric and its drill-down use the same set of unique task IDs.
create function private.report_facts(p_team uuid,p_start date,p_end date,p_at timestamptz,p_employee uuid,p_direction text)
returns table(metric_key text,task_id uuid,snapshot jsonb,event_at timestamptz,basis text,repeated boolean)
language sql stable security definer set search_path='' as $$
 with bounds as (select least(p_at,p_end::timestamp at time zone 'Europe/Moscow') as t,
 p_start::timestamp at time zone 'Europe/Moscow' as a,p_at>=(p_end::timestamp at time zone 'Europe/Moscow') as closed),
 base as (select * from private.period_states(p_team,p_start,p_end,p_at) s where private.scope_matches(s.snapshot,p_employee,p_direction)),
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
 select k as metric_key,s.task_id,s.snapshot,null::timestamptz as event_at,'Состояние плана на момент расчёта'::text as basis,false as repeated
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
 case when (e.after_snapshot->>'completed_at')::timestamptz>=(e.after_snapshot->>'deadline_at_completion')::timestamptz then 'late_done_count' end],null)) k
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
create function private.report_metrics(p_rows jsonb) returns jsonb language sql immutable set search_path='' as $$
 select p_rows||jsonb_build_object('progress_percent',case when (p_rows->>'planned_count')::integer=0 then null
 else round(100.0*(p_rows->>'plan_done_count')::integer/(p_rows->>'planned_count')::integer,1) end);
$$;
-- The planner and report use identical metric sets, including valid cancellation events.
create or replace function private.calculate_period(p_team_id uuid,p_start date,p_end_exclusive date,p_as_of timestamptz,p_employee_id uuid,p_direction text)
returns jsonb language sql stable security definer set search_path='' as $$
 with facts as materialized (select * from private.report_facts(p_team_id,p_start,p_end_exclusive,p_as_of,p_employee_id,p_direction)),
 keys as (select unnest(array['planned_count','plan_done_count','remaining_count','status_planned_count','in_progress_count','waiting_count',
 'deleted_unfinished_count','actual_done_count','overdue_count','late_done_count','cancelled_count','moved_task_count','manual_moved_task_count',
 'auto_moved_task_count','created_count','added_to_plan_count']) as k)
 select private.report_metrics(jsonb_object_agg(k,(select count(*) from facts where metric_key=k))) from keys;
$$;
create function private.report_group(p_team uuid,p_start date,p_end date,p_at timestamptz,p_employee uuid,p_direction text)
returns jsonb language sql stable security definer set search_path='' as $$
 with facts as materialized (select * from private.report_facts(p_team,p_start,p_end,p_at,p_employee,p_direction)),
 keys as (select unnest(array['base_count','planned_count','plan_done_count','remaining_count','status_planned_count','in_progress_count','waiting_count',
 'deleted_unfinished_count','actual_done_count','overdue_count','late_done_count','cancelled_count','moved_task_count','manual_moved_task_count',
 'auto_moved_task_count','created_count','added_to_plan_count']) as k),
 sets as (select k,coalesce((select jsonb_agg(jsonb_build_object('id',f.task_id,'title',f.snapshot->>'title',
 'assignee_id',f.snapshot->>'assignee_id','assignee_name',coalesce(m.display_name,'Участник'),'direction',f.snapshot->>'direction',
 'status',f.snapshot->>'status','deleted',f.snapshot->>'deleted_at' is not null,'deadline',f.snapshot->>'deadline',
 'completed_at',f.snapshot->>'completed_at','event_at',f.event_at,'basis',f.basis,'repeated',f.repeated,
 'late',coalesce((f.snapshot->>'completed_at')::timestamptz>=(f.snapshot->>'deadline_at_completion')::timestamptz,false)) order by f.task_id)
 from facts f left join public.team_members m on m.team_id=p_team and m.user_id=(f.snapshot->>'assignee_id')::uuid where f.metric_key=k),'[]') as rows from keys)
 select jsonb_build_object('metrics',private.report_metrics(jsonb_object_agg(k,jsonb_array_length(rows))),'rows',jsonb_object_agg(k,rows)) from sets;
$$;
-- Freeze all groupings and rows in one transaction. Nothing is recalculated when exporting.
create function private.report_failure(p_code text,p_detail text) returns jsonb language sql stable set search_path='' as $$
 select case when p_code='RATE_LIMITED' then jsonb_set(r,'{error,message}',to_jsonb('Слишком много запросов. Повторите через '||(r->'error'->>'retry_after_seconds')||' секунд.')) else r end
 from (select private.app_failure(p_code,p_detail) as r) q;
$$;
create function public.get_report(p_team_id uuid,p_period_type text,p_period_start date,p_employee_id uuid default null,p_direction text default 'all')
returns jsonb language plpgsql security definer set search_path='' as $$
declare a date;z date;x date;y date;at_time timestamptz:=private.task_now();sid uuid:=gen_random_uuid();g jsonb;root_group jsonb;
 groups jsonb:='{}';employees jsonb:='[]';directions jsonb:='[]';periods jsonb:='[]';r record;dto jsonb;v_direction text;error_detail text;
begin
 perform private.require_member(p_team_id);
 if p_period_type is null or p_period_type not in ('day','week','month') or p_period_start is null or p_direction is null
 or p_period_start not between date '2000-01-01' and date '2100-12-31' then raise exception 'VALIDATION_ERROR';end if;
 perform private.check_filters(p_team_id,jsonb_build_object('employee_id',p_employee_id,'direction',p_direction));
 a:=case p_period_type when 'month' then date_trunc('month',p_period_start)::date when 'week' then p_period_start-(extract(isodow from p_period_start)::integer-1) else p_period_start end;
 z:=case p_period_type when 'month' then (a+interval '1 month')::date when 'week' then a+7 else a+1 end;
 perform private.lock_team(p_team_id);
 perform private.limit_counter('user:'||auth.uid(),'report',6,60);perform private.limit_counter('team:'||p_team_id,'report',30,3600);
 perform private.maintain_team(p_team_id,private.today());
 for r in select id,start_date from public.recurrence_series where team_id=p_team_id order by id loop
  perform private.generate_series(r.id,greatest(r.start_date,a),z-1);
 end loop;
 root_group:=private.report_group(p_team_id,a,z,at_time,p_employee_id,p_direction);groups:=jsonb_build_object('all',root_group->'rows');
 for r in select * from public.team_members where team_id=p_team_id and (p_employee_id is null or user_id=p_employee_id) order by display_name,user_id loop
  g:=private.report_group(p_team_id,a,z,at_time,r.user_id,p_direction);
  if r.state='active' or exists(select 1 from jsonb_each(g->'metrics') e where e.key<>'progress_percent' and (e.value#>>'{}')::numeric>0) then
   employees:=employees||jsonb_build_array(jsonb_build_object('id',r.user_id,'label',r.display_name,'state',r.state,'metrics',g->'metrics','scope','employee:'||r.user_id));
   groups:=groups||jsonb_build_object('employee:'||r.user_id,g->'rows');
  end if;
 end loop;
 foreach v_direction in array array['sto','dbk','rental','uk','none'] loop
  if p_direction<>'all' and p_direction<>v_direction then continue;end if;
  g:=private.report_group(p_team_id,a,z,at_time,p_employee_id,v_direction);
  directions:=directions||jsonb_build_array(jsonb_build_object('id',v_direction,'label',case v_direction when 'sto' then 'СТО' when 'dbk' then 'ДБК' when 'rental' then 'ПРОКАТ' when 'uk' then 'УК' else 'Без направления' end,'metrics',g->'metrics','scope','direction:'||v_direction));
  groups:=groups||jsonb_build_object('direction:'||v_direction,g->'rows');
 end loop;
 x:=a;
 while x<z and p_period_type<>'day' loop
  y:=least(z,case when p_period_type='month' then x+(8-extract(isodow from x)::integer) else x+1 end);
  g:=private.report_group(p_team_id,x,y,at_time,p_employee_id,p_direction);
  periods:=periods||jsonb_build_array(jsonb_build_object('id',x,'start',x,'end',y-1,'metrics',g->'metrics','scope','period:'||x));
  groups:=groups||jsonb_build_object('period:'||x,g->'rows');x:=y;
 end loop;
 dto:=jsonb_build_object('snapshot_id',sid,'snapshot_at',at_time,'expires_at',at_time+interval '24 hours','state_version',(select state_version from public.teams where id=p_team_id),
 'period',jsonb_build_object('type',p_period_type,'start',a,'end',z-1,'calculated_at',least(at_time,z::timestamp at time zone 'Europe/Moscow'),'closed',at_time>=z::timestamp at time zone 'Europe/Moscow'),
 'filters',jsonb_build_object('employee_id',p_employee_id,'employee_label',coalesce((select display_name from public.team_members where team_id=p_team_id and user_id=p_employee_id),'Все сотрудники'),
 'direction',p_direction),'metrics',root_group->'metrics','by_employee',employees,'by_direction',directions,'by_subperiod',periods,
 'actual_done_tasks',root_group->'rows'->'actual_done_count','overdue_tasks',root_group->'rows'->'overdue_count');
 insert into private.report_snapshots(id,team_id,owner_id,parameters,snapshot_at,data,expires_at) values(sid,p_team_id,auth.uid(),
 jsonb_build_object('period_type',p_period_type,'period_start',a,'employee_id',p_employee_id,'direction',p_direction),at_time,dto||jsonb_build_object('_rows',groups),at_time+interval '24 hours');
 return private.ok(dto-array['actual_done_tasks','overdue_tasks']);
exception when others then
 get stacked diagnostics error_detail=pg_exception_detail;
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','RATE_LIMITED') then return private.report_failure(sqlerrm,error_detail);end if;
 if sqlerrm='VALIDATION_ERROR' or sqlstate in ('22P02','22007','22008') then return private.app_failure('VALIDATION_ERROR');end if;raise;
end;$$;
create function private.require_report(p_id uuid) returns private.report_snapshots language plpgsql security definer set search_path='' as $$
declare r private.report_snapshots;
begin
 select * into r from private.report_snapshots where id=p_id and owner_id=auth.uid();
 if not found then raise exception 'ACCESS_DENIED';end if;
 perform private.require_member(r.team_id);perform private.consume_read_rate(r.team_id);
 if r.expires_at<=private.task_now() then raise exception 'SNAPSHOT_EXPIRED';end if;
 return r;
end;$$;
create function public.get_report_rows(p_snapshot_id uuid,p_metric_key text,p_cursor text default null,p_limit integer default 50,p_scope text default 'all')
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.report_snapshots;v jsonb;result jsonb;offset_n integer:=0;error_detail text;
begin
 r:=private.require_report(p_snapshot_id);
 if p_metric_key='progress_percent' then p_metric_key:='plan_done_count';end if;
 v:=r.data->'_rows'->p_scope->p_metric_key;
 if v is null or p_limit is null or p_limit not between 1 and 50 or p_cursor is not null and p_cursor!~'^\d{1,7}$' then raise exception 'VALIDATION_ERROR';end if;
 offset_n:=coalesce(p_cursor::integer,0);
 select coalesce(jsonb_agg(value order by ord),'[]') into result from jsonb_array_elements(v) with ordinality e(value,ord) where ord>offset_n and ord<=offset_n+p_limit;
 return private.ok(jsonb_build_object('snapshot_id',r.id,'snapshot_at',r.snapshot_at,'metric_key',p_metric_key,'scope',p_scope,'total',jsonb_array_length(v),'rows',result,
 'next_cursor',case when offset_n+p_limit<jsonb_array_length(v) then (offset_n+p_limit)::text else null end));
exception when others then
 get stacked diagnostics error_detail=pg_exception_detail;
 if sqlerrm='SNAPSHOT_EXPIRED' then return private.failure(sqlerrm,'Обновите отчёт перед скачиванием');end if;
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','RATE_LIMITED','VALIDATION_ERROR') then return private.report_failure(sqlerrm,error_detail);end if;raise;
end;$$;
create function public.get_export_data(p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.report_snapshots;error_detail text;
begin r:=private.require_report(p_snapshot_id);return private.ok(r.data-'_rows');
exception when others then
 get stacked diagnostics error_detail=pg_exception_detail;
 if sqlerrm='SNAPSHOT_EXPIRED' then return private.failure(sqlerrm,'Обновите отчёт перед скачиванием');end if;
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','RATE_LIMITED') then return private.report_failure(sqlerrm,error_detail);end if;raise;
end;$$;
revoke execute on all functions in schema private from public,anon,authenticated;
grant execute on function private.is_active_member(uuid) to authenticated;
revoke execute on function public.get_report(uuid,text,date,uuid,text),public.get_report_rows(uuid,text,text,integer,text),public.get_export_data(uuid) from public,anon;
grant execute on function public.get_report(uuid,text,date,uuid,text),public.get_report_rows(uuid,text,text,integer,text),public.get_export_data(uuid) to authenticated;
commit;
