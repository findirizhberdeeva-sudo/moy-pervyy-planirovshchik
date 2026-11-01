begin;
-- Only tests replace this function with a controllable clock. Production accepts no clock parameter.
create function private.task_now() returns timestamptz language sql stable set search_path='' as $$select now()$$;
create function private.today() returns date language sql stable set search_path='' as $$select (private.task_now() at time zone 'Europe/Moscow')::date$$;
create function private.next_workday_on_or_after(p_date date) returns date language sql immutable set search_path='' as $$
  select p_date+case extract(isodow from p_date)::integer when 6 then 2 when 7 then 1 else 0 end;
$$;
create function private.task_fields(p_task jsonb,p_user uuid,p_role text) returns jsonb
language sql immutable set search_path='' as $$
 select case when p_role='manager' or (p_task->>'assignee_id'=p_user::text and p_task->>'management_mode'='self') then
   '["title","description","plan_start","plan_end","deadline","important","urgent","direction","assignee_id"]'::jsonb
 when p_task->>'assignee_id'=p_user::text then '["description","plan_start","plan_end"]'::jsonb else '[]'::jsonb end;
$$;
create function private.task_actions(p_task jsonb,p_user uuid,p_role text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v_full boolean:=p_role='manager' or (p_task->>'assignee_id'=p_user::text and p_task->>'management_mode'='self');
 v_own boolean:=p_role='manager' or p_task->>'assignee_id'=p_user::text; v_actions jsonb:='["view"]';
begin
 if p_task->>'deleted_at' is not null then return case when v_full then v_actions||'["restore"]'::jsonb else v_actions end; end if;
 if v_full then v_actions:=v_actions||'["cancel","delete"]'::jsonb; end if;
 if p_task->>'status' in ('done','cancelled') then
   if (p_task->>'status'='done' and v_own) or v_full then v_actions:=v_actions||'["reopen"]'::jsonb; end if;
 elsif v_own then v_actions:=v_actions||'["edit","move","complete","status"]'::jsonb;
 end if;
 if p_role='manager' and p_task->>'management_mode'='self' and p_task->>'status' not in ('done','cancelled') then v_actions:=v_actions||'["take_control"]'::jsonb; end if;
 return v_actions;
end;
$$;
create function private.task_dto(p_task jsonb,p_user uuid,p_role text,p_historical boolean default false,p_at timestamptz default null)
returns jsonb language sql stable security definer set search_path='' as $$
 select p_task||jsonb_build_object(
 'assignee_name',(select display_name from public.team_members where team_id=(p_task->>'team_id')::uuid and user_id=(p_task->>'assignee_id')::uuid),
 'author_name',(select display_name from public.team_members where team_id=(p_task->>'team_id')::uuid and user_id=(p_task->>'created_by')::uuid),
 'allowed_actions',case when p_historical then '["view"]'::jsonb else private.task_actions(p_task,p_user,p_role) end,
 'editable_fields',private.task_fields(p_task,p_user,p_role),'historical',p_historical,
 'overdue',p_task->>'deleted_at' is null and p_task->>'status' in ('planned','in_progress','waiting') and
   p_task->>'deadline' is not null and (((p_task->>'deadline')::date+1)::timestamp at time zone 'Europe/Moscow')<=coalesce(p_at,private.task_now()),
 'late',p_task->>'completed_at' is not null and p_task->>'deadline_at_completion' is not null and (p_task->>'completed_at')::timestamptz >= (p_task->>'deadline_at_completion')::timestamptz,
 'continuation',(p_task->>'plan_start')::date>(p_task->>'original_plan_end')::date,
 'priority',case when p_task->>'important' is null then 'unset' when (p_task->>'important')::boolean then
   case when (p_task->>'urgent')::boolean then 'important_urgent' else 'important_not_urgent' end
   else case when (p_task->>'urgent')::boolean then 'not_important_urgent' else 'not_important_not_urgent' end end);
$$;
create function private.place_task(p_task public.tasks,p_at timestamptz) returns void
language plpgsql security definer set search_path='' as $$
begin
 update private.plan_day_entries set withdrawn_at=p_at,withdraw_reason=case when p_task.deleted_at is not null then 'deleted' else 'rescheduled' end
 where task_id=p_task.id and withdrawn_at is null and plan_date>(p_at at time zone 'Europe/Moscow')::date
 and (p_task.deleted_at is not null or p_task.status='cancelled' or plan_date not between p_task.plan_start and p_task.plan_end);
 if p_task.deleted_at is null and p_task.status<>'cancelled' then
   insert into private.plan_day_entries(task_id,plan_date,placement_version,effective_from,recorded_at)
   select p_task.id,d::date,p_task.version,p_at,p_at from generate_series(p_task.plan_start::timestamp,p_task.plan_end::timestamp,interval '1 day') d
   where not exists(select 1 from private.plan_day_entries e where e.task_id=p_task.id and e.plan_date=d::date and e.withdrawn_at is null);
 end if;
end;
$$;
create function private.task_state(p_task_id uuid,p_at timestamptz,p_exclusive boolean default false) returns jsonb
language sql stable security definer set search_path='' as $$
 select after_snapshot from private.task_events where task_id=p_task_id
 and (effective_at<p_at or (not p_exclusive and effective_at=p_at)) order by effective_at desc,event_seq desc limit 1;
$$;
create function private.task_validation(p_field text,p_message text) returns void language plpgsql set search_path='' as $$
begin raise exception 'VALIDATION_ERROR' using detail=jsonb_build_object('field_errors',jsonb_build_object(p_field,p_message))::text; end;
$$;

create function public.mutate_task(p_team_id uuid,p_action text,p_task_id uuid,p_payload jsonb,p_expected_version bigint,p_operation_id uuid)
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
     if v_task.status in ('done','cancelled') and p_payload->>'status'='in_progress' and v_task.plan_end<v_today then
       v_task.plan_start:=private.next_workday_on_or_after(v_today); v_task.plan_end:=v_task.plan_start;
     end if;
     v_task.status:=p_payload->>'status';
   end if;
 elsif p_action='delete' then v_task.deleted_at:=v_now; v_task.deleted_by:=auth.uid();
 elsif p_action='restore' then
   v_task.deleted_at:=null; v_task.deleted_by:=null;
   if v_task.status in ('planned','in_progress','waiting') and v_task.plan_end<v_today then
     v_task.plan_start:=private.next_workday_on_or_after(v_today); v_task.plan_end:=v_task.plan_start;
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
revoke execute on all functions in schema private from public,anon,authenticated;
grant execute on function private.is_active_member(uuid) to authenticated;
revoke execute on function public.mutate_task(uuid,text,uuid,jsonb,bigint,uuid) from public,anon;
grant execute on function public.mutate_task(uuid,text,uuid,jsonb,bigint,uuid) to authenticated;
commit;
