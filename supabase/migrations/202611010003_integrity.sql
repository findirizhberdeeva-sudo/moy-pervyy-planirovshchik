begin;
-- Avoid inheriting PUBLIC grants from an upstream project's default privileges.
revoke all on public.teams,public.team_members,public.tasks,public.recurrence_series,public.comments,public.notifications from public;
create function private.guard_task_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if row(new.id,new.team_id,new.created_by,new.create_operation_id,new.original_plan_start,new.original_plan_end,new.series_id,new.occurrence_date)
    is distinct from row(old.id,old.team_id,old.created_by,old.create_operation_id,old.original_plan_start,old.original_plan_end,old.series_id,old.occurrence_date) then
    raise exception 'IMMUTABLE_TASK_IDENTITY';
  end if;
  return new;
end;
$$;
create trigger task_identity_guard before update on public.tasks for each row execute function private.guard_task_identity();
create function private.validate_comment_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.tasks t join public.team_members m on m.team_id=t.team_id
    where t.id=new.task_id and m.user_id=new.author_id) then
    raise exception 'COMMENT_AUTHOR_NOT_IN_TEAM' using errcode='23503';
  end if;
  if new.deleted_by is not null and not exists(select 1 from public.tasks t join public.team_members m on m.team_id=t.team_id
    where t.id=new.task_id and m.user_id=new.deleted_by) then
    raise exception 'COMMENT_DELETER_NOT_IN_TEAM' using errcode='23503';
  end if;
  return new;
end;
$$;
create trigger comment_member_guard before insert or update on public.comments for each row execute function private.validate_comment_membership();
revoke execute on function private.guard_task_identity(),private.validate_comment_membership() from public,anon,authenticated;
commit;
