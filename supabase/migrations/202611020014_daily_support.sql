begin;
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check(type in
 ('assigned','comment','completed','due_tomorrow','due_today','overdue','bulk_assigned','daily_support'));

create function private.support_day(p_at timestamptz) returns date language plpgsql immutable set search_path='' as $$
declare local_time timestamp:=p_at at time zone 'Europe/Moscow';d date:=local_time::date;
begin
 if extract(isodow from d)<=5 and local_time::time>=time '17:45' then return d;end if;
 d:=d-1;while extract(isodow from d)>5 loop d:=d-1;end loop;return d;
end;$$;

create function private.support_payload(p_day date,p_subject uuid,p_name text,p_planned integer,p_done integer)
returns jsonb language plpgsql immutable set search_path='' as $$
declare category text;message text;percent numeric;
begin
 percent:=case when p_planned=0 then null else round(100.0*p_done/p_planned,1) end;
 if p_planned=0 then category:='empty';message:='Сегодня не было запланированных задач. Не забывай ставить себе даже небольшие задачи - из маленьких дел складывается большой успех!';
 elsif p_done=p_planned then category:='complete';message:='Все задачи выполнены! Молодец, так держать!';
 elsif p_done*2>=p_planned then category:='progress';message:='Отличный результат! Есть куда стремиться.';
 else category:='encouragement';message:='Не вешай нос. Завтра можно продолжить — шаг за шагом.';end if;
 return jsonb_build_object('date',p_day,'subject_id',p_subject,'subject_name',p_name,'planned_count',p_planned,
  'plan_done_count',p_done,'progress_percent',percent,'category',category,'message',message);
end;$$;

-- One history pass for all members of a day: the same historical base as report planned/done metrics.
create function private.support_counts(p_team uuid,p_day date) returns table(subject_id uuid,planned integer,done integer)
language sql stable security definer set search_path='' as $$
 select (f.snapshot->>'assignee_id')::uuid,count(*) filter(where f.snapshot->>'status'<>'cancelled')::integer,
 count(*) filter(where f.snapshot->>'status'='done')::integer
 from private.period_states(p_team,p_day,p_day+1,private.task_now()) f
 group by (f.snapshot->>'assignee_id')::uuid;
$$;

create function private.refresh_daily_support(p_team uuid) returns integer language plpgsql security definer set search_path='' as $$
declare d date:=private.support_day(private.task_now());n integer;
begin
 perform private.lock_team(p_team);
 insert into public.notifications(team_id,recipient_id,type,task_id,payload,created_at,dedupe_key)
 select p_team,recipient.user_id,'daily_support',null,
 private.support_payload(d,subject.user_id,subject.display_name,coalesce(c.planned,0),coalesce(c.done,0)),
 (d+time '17:45') at time zone 'Europe/Moscow','support:'||p_team||':'||subject.user_id||':'||d
 from public.team_members subject left join private.support_counts(p_team,d) c on c.subject_id=subject.user_id
 join public.team_members recipient on recipient.team_id=p_team and recipient.state='active'
  and (recipient.user_id=subject.user_id or recipient.role='manager')
 where subject.team_id=p_team and subject.state='active' and (subject.joined_at at time zone 'Europe/Moscow')::date<=d
 on conflict(recipient_id,dedupe_key) do update set payload=excluded.payload
 where public.notifications.payload is distinct from excluded.payload;
 get diagnostics n=row_count;return n;
end;$$;

create function public.get_weekly_progress(p_team_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare caller public.team_members;today date:=private.today();ws date;sd date:=private.support_day(private.task_now());rows jsonb;own jsonb;detail text;
begin
 caller:=private.require_member(p_team_id);perform private.consume_read_rate(p_team_id);
 perform private.lock_team(p_team_id);perform private.maintain_team(p_team_id,today);perform private.refresh_daily_support(p_team_id);
 ws:=today-(extract(isodow from today)::integer-1);
 with days as(select ws+g as day from generate_series(0,6) g),
 facts as materialized(select d.day,c.* from days d cross join lateral private.support_counts(p_team_id,d.day) c),
 members as(select m.*,coalesce((select jsonb_agg(jsonb_build_object('date',d.day,'planned_count',coalesce(c.planned,0),
  'plan_done_count',coalesce(c.done,0),'progress_percent',case when coalesce(c.planned,0)=0 then null else round(100.0*c.done/c.planned,1) end,
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

-- Atomic claim: independent tabs/devices cannot both receive claimed=true.
-- read_at is never reset when late completions update a support message.
create function public.claim_daily_support(p_team_id uuid,p_notification_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare n public.notifications;claimed boolean:=false;detail text;
begin
 perform private.require_member(p_team_id);perform private.lock_team(p_team_id);
 select * into n from public.notifications where team_id=p_team_id and id=p_notification_id
  and recipient_id=auth.uid() and type='daily_support' and payload->>'subject_id'=auth.uid()::text for update;
 if not found then raise exception 'ACCESS_DENIED';end if;
 if n.payload->>'date'<>private.support_day(private.task_now())::text then
  return private.ok(jsonb_build_object('claimed',false,'reason','superseded'));end if;
 if n.read_at is null then
  perform private.consume_write_rate(p_team_id);
  update public.notifications set read_at=private.task_now() where id=n.id returning * into n;claimed:=true;
 end if;
 return private.ok(jsonb_build_object('claimed',claimed,'notification',to_jsonb(n)));
exception when others then
 get stacked diagnostics detail=pg_exception_detail;
 if sqlerrm in ('ACCESS_DENIED','UNAUTHENTICATED','RATE_LIMITED') then return private.app_failure(sqlerrm,detail);end if;raise;
end;$$;

create function private.refresh_all_daily_support() returns jsonb language plpgsql security definer set search_path='' as $$
declare t record;n integer:=0;errors jsonb:='[]';
begin
 for t in select id from public.teams order by id loop
  begin perform private.maintain_team(t.id,private.today());n:=n+private.refresh_daily_support(t.id);
  exception when others then errors:=errors||jsonb_build_array(jsonb_build_object('team_id',t.id,'code',sqlstate));end;
 end loop;
 return jsonb_build_object('updated_count',n,'errors',errors,'checked_at',private.task_now());
end;$$;
create function private.configure_support_cron() returns boolean language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from pg_extension where extname='pg_cron') then return false;end if;
 if coalesce(current_setting('cron.timezone',true),'GMT') not in ('UTC','GMT','Etc/UTC') then raise exception 'CRON_TIMEZONE_MUST_BE_UTC';end if;
 execute 'select cron.schedule(''ritm_daily_support'',''45 14 * * 1-5'',''select private.refresh_all_daily_support();'')';return true;
end;$$;
select private.configure_support_cron();
revoke execute on function private.support_day(timestamptz),private.support_payload(date,uuid,text,integer,integer),
 private.support_counts(uuid,date),private.refresh_daily_support(uuid),private.refresh_all_daily_support(),private.configure_support_cron() from public,anon,authenticated;
revoke execute on function public.get_weekly_progress(uuid),public.claim_daily_support(uuid,uuid) from public,anon;
grant execute on function public.get_weekly_progress(uuid),public.claim_daily_support(uuid,uuid) to authenticated;
commit;
