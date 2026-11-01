begin;
-- Publish only the non-sensitive version row. Clients reread authorized DTOs, not audit payloads.
do $$begin
 if not exists(select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime;end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='teams') then alter publication supabase_realtime add table public.teams;end if;
end;$$;
create function private.configure_daily_cron() returns boolean language plpgsql security definer set search_path='' as $$
declare job bigint;
begin
 if not exists(select 1 from pg_available_extensions where name='pg_cron') then
  raise notice 'pg_cron unavailable in this runtime: cloud scheduling remains unverified';return false;
 end if;
 execute 'create extension if not exists pg_cron with schema pg_catalog';
 if coalesce(current_setting('cron.timezone',true),'GMT') not in ('UTC','GMT','Etc/UTC') then raise exception 'CRON_TIMEZONE_MUST_BE_UTC';end if;
 -- Schedule by name is an upsert for the same owner; remove duplicate names from prior owners.
 for job in execute 'select jobid from cron.job where jobname=''ritm_daily_maintenance'' and username<>current_user' loop execute 'select cron.unschedule($1)' using job;end loop;
 execute 'select cron.schedule(''ritm_daily_maintenance'',''0 21 * * *'',''select private.maintain_all_teams();'')';
 return true;
end;$$;
select private.configure_daily_cron();
revoke execute on function private.configure_daily_cron() from public,anon,authenticated;
commit;
