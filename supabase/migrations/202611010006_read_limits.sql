begin;
-- The volatile outer RPC accounts requests. Its STABLE inner function reads one MVCC snapshot.
create function private.consume_read_rate(p_team_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare k text; n integer; lim integer;
begin
 perform private.require_member(p_team_id);
 foreach k in array array['user:'||auth.uid()::text,'team:'||p_team_id::text] loop
  lim:=case when k like 'user:%' then 120 else 600 end;
  insert into private.rate_limit_counters(scope_key,action_group,window_start,request_count)
   values(k,'read',date_trunc('minute',now()),1) on conflict(scope_key,action_group,window_start)
   do update set request_count=private.rate_limit_counters.request_count+1 returning request_count into n;
  if n>lim then raise exception 'RATE_LIMITED'; end if;
 end loop;
end;
$$;
create function private.read_failure(p_code text) returns jsonb language sql stable set search_path='' as $$
 select private.failure(p_code,case when p_code='RATE_LIMITED' then 'Слишком много запросов.' else 'Доступ к команде не предоставлен.' end,
   case when p_code='RATE_LIMITED' then '{"retry_after_seconds":60}'::jsonb else '{}'::jsonb end);
$$;
alter function public.get_planner(uuid,date,jsonb,text) set schema private;
alter function public.get_task_detail(uuid,uuid) set schema private;
alter function public.get_task_history(uuid,uuid,text) set schema private;
alter function public.list_task_collection(uuid,text,uuid,text,text) set schema private;
create function public.get_planner(p_team_id uuid,p_selected_date date,p_filters jsonb,p_cursor text default null) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform private.consume_read_rate(p_team_id);return private.get_planner(p_team_id,p_selected_date,p_filters,p_cursor);
exception when others then if sqlerrm in ('RATE_LIMITED','ACCESS_DENIED','UNAUTHENTICATED') then return private.read_failure(sqlerrm);end if;raise;end;$$;
create function public.get_task_detail(p_team_id uuid,p_task_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform private.consume_read_rate(p_team_id);return private.get_task_detail(p_team_id,p_task_id);
exception when others then if sqlerrm in ('RATE_LIMITED','ACCESS_DENIED','UNAUTHENTICATED') then return private.read_failure(sqlerrm);end if;raise;end;$$;
create function public.get_task_history(p_team_id uuid,p_task_id uuid,p_cursor text default null) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform private.consume_read_rate(p_team_id);return private.get_task_history(p_team_id,p_task_id,p_cursor);
exception when others then if sqlerrm in ('RATE_LIMITED','ACCESS_DENIED','UNAUTHENTICATED') then return private.read_failure(sqlerrm);end if;raise;end;$$;
create function public.list_task_collection(p_team_id uuid,p_collection text,p_employee_id uuid default null,p_direction text default 'all',p_cursor text default null) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform private.consume_read_rate(p_team_id);return private.list_task_collection(p_team_id,p_collection,p_employee_id,p_direction,p_cursor);
exception when others then if sqlerrm in ('RATE_LIMITED','ACCESS_DENIED','UNAUTHENTICATED') then return private.read_failure(sqlerrm);end if;raise;end;$$;
revoke execute on all functions in schema private from public,anon,authenticated;
grant execute on function private.is_active_member(uuid) to authenticated;
revoke execute on function public.get_planner(uuid,date,jsonb,text),public.get_task_detail(uuid,uuid),public.get_task_history(uuid,uuid,text),public.list_task_collection(uuid,text,uuid,text,text) from public,anon;
grant execute on function public.get_planner(uuid,date,jsonb,text),public.get_task_detail(uuid,uuid),public.get_task_history(uuid,uuid,text),public.list_task_collection(uuid,text,uuid,text,text) to authenticated;
commit;
