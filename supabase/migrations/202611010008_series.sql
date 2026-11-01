begin;
alter table public.tasks add column series_revision bigint;
alter table public.recurrence_series add column generated_through date;
create function private.record_task(p_task public.tasks,p_before jsonb,p_type text,p_actor uuid,p_at timestamptz,p_operation uuid) returns void
language plpgsql security definer set search_path='' as $$begin
 if p_task.is_superseded then
  update private.plan_day_entries set withdrawn_at=p_at,withdraw_reason='series_replaced'
  where task_id=p_task.id and withdrawn_at is null and plan_date>(p_at at time zone 'Europe/Moscow')::date;
 else perform private.place_task(p_task,p_at);end if;
 insert into private.task_events(team_id,task_id,event_type,actor_id,is_system,effective_at,recorded_at,version_before,version_after,before_snapshot,after_snapshot,operation_id)
 values(p_task.team_id,p_task.id,p_type,p_actor,p_actor is null,p_at,private.task_now(),(p_before->>'version')::bigint,p_task.version,p_before,to_jsonb(p_task),p_operation);
end;$$;
create function private.rule_matches(p_rule jsonb,p_day date) returns boolean language sql immutable set search_path='' as $$
 select p_day>=(p_rule->>'start_date')::date and (p_rule->>'end_date' is null or p_day<=(p_rule->>'end_date')::date) and
 case p_rule->>'frequency' when 'daily' then true when 'workdays' then extract(isodow from p_day)<6
 when 'weekly' then (p_rule->'weekdays')@>to_jsonb(array[extract(isodow from p_day)::integer])
 when 'monthly' then extract(day from p_day)::integer=least((p_rule->>'month_day')::integer,extract(day from date_trunc('month',p_day)+interval '1 month - 1 day')::integer)
 else false end;
$$;
create function private.series_rule(p_series uuid,p_day date) returns jsonb language sql stable security definer set search_path='' as $$
 select rule_snapshot from private.series_revisions where series_id=p_series and applies_from_date<=p_day order by revision desc limit 1;
$$;
create function private.series_has_future(p_series public.recurrence_series) returns boolean language sql stable security definer set search_path='' as $$
 select p_series.active or coalesce((select (rule_snapshot->>'end_date')::date>=greatest(private.today(),p_series.start_date) from private.series_revisions where series_id=p_series.id order by revision desc limit 1),false);
$$;
create function private.validate_series(p_series public.recurrence_series) returns void language plpgsql stable security definer set search_path='' as $$
begin
 if p_series.frequency is null or p_series.frequency not in ('daily','workdays','weekly','monthly') then perform private.task_validation('frequency','Выберите повторение.');end if;
 if p_series.frequency='weekly' and not private.valid_weekdays(p_series.weekdays) then perform private.task_validation('weekdays','Выберите хотя бы один день недели без повторов.');end if;
 if p_series.frequency<>'weekly' and p_series.weekdays is not null or p_series.frequency<>'monthly' and p_series.month_day is not null
  or p_series.frequency='monthly' and (p_series.month_day is null or p_series.month_day not between 1 and 31) then raise exception 'VALIDATION_ERROR';end if;
 if p_series.start_date is null or p_series.start_date not between date '2000-01-01' and date '2100-12-31' or p_series.end_date<p_series.start_date or p_series.end_date>date '2100-12-31'
  or p_series.duration_days is null or p_series.duration_days not between 1 and 366 then perform private.task_validation('start_date','Проверьте даты и длительность повторения.');end if;
 if p_series.template->>'title' is null or char_length(btrim(p_series.template->>'title')) not between 1 and 200 or char_length(coalesce(p_series.template->>'description',''))>10000 then raise exception 'VALIDATION_ERROR';end if;
 if p_series.template->>'direction' is not null and p_series.template->>'direction' not in ('sto','dbk','rental','uk') or
  (p_series.template->>'important' is null)<>(p_series.template->>'urgent' is null) then raise exception 'VALIDATION_ERROR';end if;
 if not exists(select 1 from public.team_members where team_id=p_series.team_id and user_id=p_series.assignee_id and state='active') then perform private.task_validation('assignee_id','Выберите активного участника.');end if;
 if p_series.deadline_offset_days is not null and abs(p_series.deadline_offset_days)>36890 then raise exception 'VALIDATION_ERROR';end if;
 if p_series.start_date+p_series.duration_days-1>date '2100-12-31' or p_series.start_date+p_series.deadline_offset_days not between date '2000-01-01' and date '2100-12-31' then raise exception 'VALIDATION_ERROR';end if;
end;$$;

-- Replay revisions only once per occurrence. Lazy insertion retains the rule's business time.
create function private.generate_series(p_series uuid,p_from date,p_to date) returns integer
language plpgsql security definer set search_path='' as $$
declare s public.recurrence_series;r private.series_revisions;t public.tasks;d date;rule jsonb;before_t jsonb;existed boolean;matches boolean;
 n integer:=0;actor uuid;event_type text;stamp timestamptz;new_end date;new_deadline date;
begin
 select * into s from public.recurrence_series where id=p_series for update;
 for d in select x::date from generate_series(greatest(s.start_date,p_from)::timestamp,least(p_to,date '2100-12-31')::timestamp,interval '1 day') x loop
  if not exists(select 1 from public.tasks where series_id=s.id and occurrence_date=d) and not private.rule_matches(private.series_rule(s.id,d),d) then continue;end if;
  for r in select * from private.series_revisions where series_id=s.id and applies_from_date<=d order by revision loop
   rule:=r.rule_snapshot;stamp:=r.effective_at;matches:=private.rule_matches(rule,d);
   select * into t from public.tasks where series_id=s.id and occurrence_date=d for update;existed:=found;
   if existed and coalesce(t.series_revision,0)>=r.revision then continue;end if;
   if d<(stamp at time zone 'Europe/Moscow')::date then continue;end if;
   if existed and (t.status='done' or d<(stamp at time zone 'Europe/Moscow')::date) then
    update public.tasks set series_revision=r.revision where id=t.id;continue;
   end if;
   if not existed and not matches then continue;end if;
   before_t:=case when existed then to_jsonb(t) else null end;
   actor:=(rule->>'_actor_id')::uuid;event_type:=coalesce(rule->>'_event_type','series_update');
   if existed and event_type='bulk_transfer' then
    if t.deleted_at is null and t.status in ('planned','in_progress','waiting') and not t.is_superseded then
     t.assignee_id:=(rule->>'assignee_id')::uuid;t.management_mode:='manager';t.series_revision:=r.revision;t.version:=t.version+1;t.updated_at:=private.task_now();
     update public.tasks set assignee_id=t.assignee_id,management_mode=t.management_mode,series_revision=t.series_revision,version=t.version,updated_at=t.updated_at where id=t.id;
     perform private.record_task(t,before_t,'bulk_transfer',actor,stamp,gen_random_uuid());
    else update public.tasks set series_revision=r.revision where id=t.id;end if;
    continue;
   end if;
   if not matches then
    if d<=(stamp at time zone 'Europe/Moscow')::date then update public.tasks set series_revision=r.revision where id=t.id;continue;end if;
    t.is_superseded:=true;
   else
    new_end:=d+(rule->>'duration_days')::integer-1;
    new_deadline:=d+(rule->>'deadline_offset_days')::integer;
    if new_end>date '2100-12-31' or new_deadline not between date '2000-01-01' and date '2100-12-31' then continue;end if;
    if not existed then
     t.id:=gen_random_uuid();t.team_id:=s.team_id;t.created_by:=s.created_by;t.status:='planned';t.is_superseded:=false;
     t.series_id:=s.id;t.occurrence_date:=d;t.create_operation_id:=md5('ritm-instance:'||s.id||':'||d)::uuid;
     t.original_plan_start:=d;t.original_plan_end:=new_end;t.effective_created_at:=stamp;t.created_at:=private.task_now();t.version:=0;
    end if;
    t.title:=rule->'template'->>'title';t.description:=coalesce(rule->'template'->>'description','');t.direction:=rule->'template'->>'direction';
    t.important:=(rule->'template'->>'important')::boolean;t.urgent:=(rule->'template'->>'urgent')::boolean;
    t.assignee_id:=(rule->>'assignee_id')::uuid;t.management_mode:=rule->>'management_mode';t.plan_start:=d;t.plan_end:=new_end;t.deadline:=new_deadline;t.is_superseded:=false;
    if not existed or d>(stamp at time zone 'Europe/Moscow')::date then t.status:='planned';t.deleted_at:=null;t.deleted_by:=null;t.completed_at:=null;t.completed_by:=null;t.deadline_at_completion:=null;end if;
   end if;
   t.series_revision:=r.revision;t.version:=t.version+1;t.updated_at:=private.task_now();
   if not existed then insert into public.tasks select (t).*;n:=n+1;
   else update public.tasks set title=t.title,description=t.description,direction=t.direction,important=t.important,urgent=t.urgent,assignee_id=t.assignee_id,management_mode=t.management_mode,
    plan_start=t.plan_start,plan_end=t.plan_end,deadline=t.deadline,status=t.status,deleted_at=t.deleted_at,deleted_by=t.deleted_by,
    completed_at=t.completed_at,completed_by=t.completed_by,deadline_at_completion=t.deadline_at_completion,is_superseded=t.is_superseded,series_revision=t.series_revision,version=t.version,updated_at=t.updated_at where id=t.id;end if;
   perform private.record_task(t,before_t,case when not existed then 'series_create' when not matches then 'series_replace' else event_type end,actor,stamp,gen_random_uuid());
  end loop;
 end loop;return n;
end;$$;
create function private.materialize_range(p_team uuid,p_start date,p_end date) returns integer language plpgsql security definer set search_path='' as $$
declare s public.recurrence_series;n integer:=0;
begin
 for s in select * from public.recurrence_series where team_id=p_team order by id loop
  n:=n+private.generate_series(s.id,greatest(s.start_date,p_start-(select coalesce(max((rule_snapshot->>'duration_days')::integer),s.duration_days) from private.series_revisions where series_id=s.id)+1),p_end);
 end loop;return n;
end;$$;
create function private.series_fields(p_series public.recurrence_series,p_payload jsonb) returns public.recurrence_series
language plpgsql set search_path='' as $$declare k text;
begin
 for k in select jsonb_object_keys(p_payload) loop
  if k not in ('title','description','direction','important','urgent','assignee_id','frequency','weekdays','month_day','start_date','end_date','duration_days','deadline_offset_days') then raise exception 'VALIDATION_ERROR';end if;
 end loop;
 p_series.template:=coalesce(p_series.template,'{"description":"","direction":null,"important":null,"urgent":null}');
 for k in select unnest(array['title','description','direction','important','urgent']) loop if p_payload?k then p_series.template:=p_series.template||jsonb_build_object(k,p_payload->k);end if;end loop;
 if p_payload?'title' then p_series.template:=jsonb_set(p_series.template,'{title}',to_jsonb(private.trim_text(p_payload->>'title')));end if;
 if p_payload?'assignee_id' then p_series.assignee_id:=(p_payload->>'assignee_id')::uuid;end if;
 if p_payload?'frequency' then p_series.frequency:=p_payload->>'frequency';end if;
 if p_payload?'weekdays' then p_series.weekdays:=case when jsonb_typeof(p_payload->'weekdays')='array' then array(select jsonb_array_elements_text(p_payload->'weekdays')::smallint) else null end;end if;
 if p_payload?'month_day' then p_series.month_day:=(p_payload->>'month_day')::smallint;end if;
 if p_series.frequency<>'weekly' then p_series.weekdays:=null;end if;if p_series.frequency<>'monthly' then p_series.month_day:=null;end if;
 if p_payload?'start_date' then p_series.start_date:=(p_payload->>'start_date')::date;end if;
 if p_payload?'end_date' then p_series.end_date:=(p_payload->>'end_date')::date;end if;
 if p_payload?'duration_days' then p_series.duration_days:=(p_payload->>'duration_days')::integer;end if;
 if p_payload?'deadline_offset_days' then p_series.deadline_offset_days:=(p_payload->>'deadline_offset_days')::integer;end if;
 return p_series;
end;$$;
create function public.preview_series(p_team_id uuid,p_series_id uuid,p_boundary date) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.recurrence_series;m public.team_members;
begin
 perform private.consume_read_rate(p_team_id);m:=private.require_member(p_team_id);
 select * into s from public.recurrence_series where team_id=p_team_id and id=p_series_id;
 if not found then raise exception 'NOT_FOUND';end if;
 if m.role<>'manager' and (s.assignee_id<>auth.uid() or s.management_mode<>'self') then raise exception 'ACCESS_DENIED';end if;
 if p_boundary<private.today() or p_boundary is null then raise exception 'VALIDATION_ERROR';end if;
 return private.ok(jsonb_build_object('series',to_jsonb(s),'rule',private.series_rule(s.id,p_boundary),'affected_count',(select count(*) from public.tasks where series_id=s.id and occurrence_date>=p_boundary and status<>'done' and not is_superseded)));
exception when others then if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','NOT_FOUND','VALIDATION_ERROR','RATE_LIMITED') then return private.app_failure(sqlerrm);end if;raise;end;$$;
create function public.mutate_series(p_team_id uuid,p_action text,p_series_id uuid,p_boundary date,p_payload jsonb,p_expected_version bigint,p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.recurrence_series;before_s jsonb;m public.team_members;r jsonb;req jsonb:=jsonb_build_array(p_action,p_series_id,p_boundary,p_payload,p_expected_version);
 boundary date:=coalesce(p_boundary,private.today());detail text;through date;n integer;anchor public.tasks;
begin
 perform private.lock_team(p_team_id);m:=private.require_member(p_team_id);
 r:=private.command_cached(p_team_id,auth.uid(),p_operation_id,'series',req);if r is not null then return r;end if;
 if p_action is null or p_action not in ('create','update','stop') or p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'VALIDATION_ERROR';end if;
 if p_action='create' then
  if p_series_id is not null then raise exception 'VALIDATION_ERROR';end if;
  s.id:=gen_random_uuid();s.team_id:=p_team_id;s.created_by:=auth.uid();s.assignee_id:=auth.uid();s.management_mode:=case when m.role='manager' then 'manager' else 'self' end;
  s.start_date:=private.today();s.duration_days:=1;s.active:=true;s.created_at:=private.task_now();s.updated_at:=s.created_at;s.version:=1;
 else
  select * into s from public.recurrence_series where team_id=p_team_id and id=p_series_id for update;
  if not found then raise exception 'NOT_FOUND';end if;
  if m.role<>'manager' and (s.assignee_id<>auth.uid() or s.management_mode<>'self') then raise exception 'ACCESS_DENIED';end if;
  if p_action='update' and not s.active then raise exception 'ACCESS_DENIED';end if;
  if s.version is distinct from p_expected_version then return private.failure('VERSION_CONFLICT','Правило повторения изменилось.',jsonb_build_object('latest_entity',to_jsonb(s)));end if;
  if boundary<private.today() then perform private.task_validation('boundary','Изменяйте будущие повторения с сегодняшней даты или позже.');end if;
  before_s:=to_jsonb(s);s.version:=s.version+1;s.updated_at:=private.task_now();
 end if;
 if p_action='stop' then
  if p_payload-'end_date'<>'{}'::jsonb or (p_payload->>'end_date')::date<private.today() or p_payload->>'end_date' is null then raise exception 'VALIDATION_ERROR';end if;
  if (p_payload->>'end_date')::date>=s.start_date then s.end_date:=least(coalesce(s.end_date,date '2100-12-31'),(p_payload->>'end_date')::date);end if;
  s.active:=false;boundary:=greatest(private.today(),(p_payload->>'end_date')::date+1);
 else s:=private.series_fields(s,p_payload);end if;
 if s.start_date<private.today() and p_action='create' then perform private.task_validation('start_date','Нельзя создать повторение задним числом.');end if;
 if m.role<>'manager' and s.assignee_id<>auth.uid() then raise exception 'ACCESS_DENIED';end if;
 if m.role='manager' and p_action<>'create' and (to_jsonb(s)-array['description','version','updated_at','template'])||(s.template-'description')
  is distinct from (before_s-array['description','version','updated_at','template'])||((before_s->'template')-'description') then s.management_mode:='manager';end if;
 perform private.validate_series(s);perform private.consume_write_rate(p_team_id);
 if p_action='create' then
  insert into public.recurrence_series select (s).*;boundary:=s.start_date;
 else update public.recurrence_series set template=s.template,assignee_id=s.assignee_id,management_mode=s.management_mode,frequency=s.frequency,weekdays=s.weekdays,month_day=s.month_day,
  start_date=s.start_date,end_date=s.end_date,duration_days=s.duration_days,deadline_offset_days=s.deadline_offset_days,active=s.active,version=s.version,updated_at=s.updated_at where id=s.id;end if;
 insert into private.series_revisions(series_id,revision,applies_from_date,effective_at,rule_snapshot)
 values(s.id,s.version,boundary,private.task_now(),to_jsonb(s)||case when p_action='stop' then jsonb_build_object('end_date',(p_payload->>'end_date')::date) else '{}'::jsonb end||jsonb_build_object('_actor_id',auth.uid(),'_event_type',case when p_action='stop' then 'series_stop' else 'series_update' end));
 through:=greatest((date_trunc('month',private.today())+interval '2 months - 1 day')::date,coalesce(s.generated_through,s.start_date),
  coalesce((select max(occurrence_date) from public.tasks where series_id=s.id),s.start_date));
 n:=private.generate_series(s.id,case when p_action='create' then s.start_date else boundary end,through);
 update public.recurrence_series set generated_through=greatest(coalesce(generated_through,s.start_date),through) where id=s.id;
 select * into anchor from public.tasks where series_id=s.id and not is_superseded and deleted_at is null
 order by (private.today() between plan_start and plan_end) desc,abs(occurrence_date-case when p_action='stop' then private.today() else boundary end),occurrence_date limit 1;
 if found then
  insert into private.task_events(team_id,task_id,event_type,actor_id,is_system,effective_at,recorded_at,version_before,version_after,before_snapshot,after_snapshot,operation_id)
  values(p_team_id,anchor.id,'series_rule_changed',auth.uid(),false,private.task_now(),private.task_now(),anchor.version,anchor.version,
   to_jsonb(anchor)||jsonb_build_object('series_change',before_s),to_jsonb(anchor)||jsonb_build_object('series_change',to_jsonb(s)||case when p_action='stop' then jsonb_build_object('end_date',(p_payload->>'end_date')::date) else '{}'::jsonb end||jsonb_build_object('scope_from',boundary)),p_operation_id);
 end if;
 return private.command_saved(p_team_id,auth.uid(),p_operation_id,'series',req,jsonb_build_object('entity',to_jsonb(s),'generated_count',n));
exception when others then
 get stacked diagnostics detail=pg_exception_detail;
 if sqlstate in ('22P02','22007','22008','23514','23502') then return private.app_failure('VALIDATION_ERROR');end if;
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','NOT_FOUND','VALIDATION_ERROR','RATE_LIMITED','OPERATION_ID_REUSED') then return private.app_failure(sqlerrm,detail);end if;raise;
end;$$;
revoke execute on all functions in schema private from public,anon,authenticated;
grant execute on function private.is_active_member(uuid) to authenticated;
revoke execute on function public.preview_series(uuid,uuid,date),public.mutate_series(uuid,text,uuid,date,jsonb,bigint,uuid) from public,anon;
grant execute on function public.preview_series(uuid,uuid,date),public.mutate_series(uuid,text,uuid,date,jsonb,bigint,uuid) to authenticated;
commit;
