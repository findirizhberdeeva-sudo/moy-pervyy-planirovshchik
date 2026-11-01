-- Step 1: data foundation. Run with the Supabase migration owner, never the browser.
begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
alter default privileges in schema private revoke all on tables from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  timezone text not null default 'Europe/Moscow' check (timezone = 'Europe/Moscow'),
  last_processed_date date,
  state_version bigint not null default 1 check (state_version > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.team_members (
  team_id uuid not null references public.teams(id),
  user_id uuid not null references auth.users(id),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  role text not null check (role in ('manager','employee')),
  state text not null default 'invited' check (state in ('invited','active','disabled')),
  joined_at timestamptz, disabled_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  version bigint not null default 1 check (version > 0),
  primary key (team_id,user_id),
  check (state <> 'active' or joined_at is not null),
  check ((state = 'disabled') = (disabled_at is not null))
);
create table private.invitations (
  id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id),
  email text not null check (email = lower(btrim(email)) and position('@' in email) > 1),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  user_id uuid references auth.users(id),
  state text not null default 'pending' check (state in ('pending','sent','failed','accepted','cancelled','expired')),
  inviter_id uuid not null, sent_at timestamptz, expires_at timestamptz not null,
  cancelled_at timestamptz, last_error_code text, operation_id uuid not null unique,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (team_id,inviter_id) references public.team_members(team_id,user_id)
);
create unique index invitations_one_pending on private.invitations(team_id,email)
  where state in ('pending','sent','failed');

create function private.valid_weekdays(p_days smallint[]) returns boolean
language sql immutable set search_path = '' as $$
  select p_days is not null and cardinality(p_days) between 1 and 7
    and not exists(select 1 from unnest(p_days) x where x is null or x < 1 or x > 7)
    and cardinality(p_days) = (select count(distinct x) from unnest(p_days) x);
$$;
create table public.recurrence_series (
  id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id),
  created_by uuid not null, assignee_id uuid not null,
  management_mode text not null check (management_mode in ('self','manager')),
  template jsonb not null check (jsonb_typeof(template) = 'object'),
  frequency text not null check (frequency in ('daily','workdays','weekly','monthly')),
  weekdays smallint[], month_day smallint check (month_day between 1 and 31),
  start_date date not null check (start_date between date '2000-01-01' and date '2100-12-31'),
  end_date date check (end_date between start_date and date '2100-12-31'),
  duration_days integer not null default 1 check (duration_days between 1 and 366),
  deadline_offset_days integer, active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  version bigint not null default 1 check (version > 0), unique(team_id,id),
  foreign key (team_id,created_by) references public.team_members(team_id,user_id),
  foreign key (team_id,assignee_id) references public.team_members(team_id,user_id),
  check ((frequency = 'weekly' and private.valid_weekdays(weekdays)) or (frequency <> 'weekly' and weekdays is null)),
  check ((frequency = 'monthly') = (month_day is not null))
);
create table public.tasks (
  id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id),
  created_by uuid not null, assignee_id uuid not null,
  management_mode text not null check (management_mode in ('self','manager')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text not null default '' check (char_length(description) <= 10000),
  direction text check (direction in ('sto','dbk','rental','uk')),
  important boolean, urgent boolean,
  plan_start date not null, plan_end date not null,
  original_plan_start date not null, original_plan_end date not null,
  deadline date, status text not null default 'planned'
    check (status in ('planned','in_progress','waiting','done','cancelled')),
  completed_at timestamptz, completed_by uuid, deadline_at_completion timestamptz,
  deleted_at timestamptz, deleted_by uuid,
  series_id uuid, occurrence_date date, is_superseded boolean not null default false,
  effective_created_at timestamptz not null default now(),
  create_operation_id uuid not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  version bigint not null default 1 check (version > 0),
  unique(team_id,id), unique(team_id,created_by,create_operation_id), unique(series_id,occurrence_date),
  foreign key (team_id,created_by) references public.team_members(team_id,user_id),
  foreign key (team_id,assignee_id) references public.team_members(team_id,user_id),
  foreign key (team_id,completed_by) references public.team_members(team_id,user_id),
  foreign key (team_id,deleted_by) references public.team_members(team_id,user_id),
  foreign key (team_id,series_id) references public.recurrence_series(team_id,id),
  check ((important is null) = (urgent is null)),
  check (plan_start between date '2000-01-01' and date '2100-12-31'),
  check (plan_end between plan_start and least(plan_start+365,date '2100-12-31')),
  check (original_plan_start between date '2000-01-01' and date '2100-12-31'),
  check (original_plan_end between original_plan_start and least(original_plan_start+365,date '2100-12-31')),
  check (deadline is null or deadline between date '2000-01-01' and date '2100-12-31'),
  check ((status = 'done') = (completed_at is not null)),
  check ((completed_at is null) = (completed_by is null)),
  check ((deleted_at is null) = (deleted_by is null)),
  check ((series_id is null) = (occurrence_date is null)),
  check (occurrence_date is null or occurrence_date between date '2000-01-01' and date '2100-12-31')
);
create table private.series_revisions (
  id uuid primary key default gen_random_uuid(), series_id uuid not null references public.recurrence_series(id),
  revision bigint not null check (revision > 0), applies_from_date date not null,
  effective_at timestamptz not null, rule_snapshot jsonb not null check (jsonb_typeof(rule_snapshot) = 'object'),
  recorded_at timestamptz not null default now(), unique(series_id,revision)
);
create table private.plan_day_entries (
  id uuid primary key default gen_random_uuid(), task_id uuid not null references public.tasks(id),
  plan_date date not null, placement_version bigint not null check (placement_version > 0),
  effective_from timestamptz not null, withdrawn_at timestamptz, withdraw_reason text,
  recorded_at timestamptz not null default now(),
  unique(task_id,plan_date,placement_version), check (withdrawn_at is null or withdrawn_at >= effective_from)
);
create table private.task_events (
  event_seq bigint generated always as identity primary key,
  team_id uuid not null, task_id uuid not null,
  event_type text not null, actor_id uuid, is_system boolean not null,
  effective_at timestamptz not null, recorded_at timestamptz not null default now(),
  version_before bigint, version_after bigint,
  before_snapshot jsonb, after_snapshot jsonb not null check (jsonb_typeof(after_snapshot) = 'object'),
  operation_id uuid not null,
  foreign key (team_id,task_id) references public.tasks(team_id,id),
  foreign key (team_id,actor_id) references public.team_members(team_id,user_id),
  check (is_system = (actor_id is null))
);
create table public.comments (
  id uuid primary key default gen_random_uuid(), task_id uuid not null references public.tasks(id),
  author_id uuid not null references auth.users(id), body text not null,
  deleted_at timestamptz, deleted_by uuid references auth.users(id), create_operation_id uuid not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  version bigint not null default 1 check (version > 0),
  unique(task_id,author_id,create_operation_id),
  check ((deleted_at is null and char_length(btrim(body)) between 1 and 4000)
    or (deleted_at is not null and body = '')),
  check ((deleted_at is null) = (deleted_by is null))
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(), team_id uuid not null,
  recipient_id uuid not null, type text not null check (type in
    ('assigned','comment','completed','due_tomorrow','due_today','overdue','bulk_assigned')),
  task_id uuid, payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(), read_at timestamptz, dedupe_key text not null,
  foreign key (team_id,recipient_id) references public.team_members(team_id,user_id),
  foreign key (team_id,task_id) references public.tasks(team_id,id), unique(recipient_id,dedupe_key)
);
create table private.operation_results (
  team_id uuid not null, actor_id uuid not null, operation_id uuid not null,
  operation_type text not null, request_hash text not null, result jsonb not null,
  created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '30 days',
  primary key(team_id,actor_id,operation_id),
  foreign key (team_id,actor_id) references public.team_members(team_id,user_id)
);
create table private.report_snapshots (
  id uuid primary key default gen_random_uuid(), team_id uuid not null, owner_id uuid not null,
  parameters jsonb not null, snapshot_at timestamptz not null, data jsonb not null,
  created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '24 hours',
  foreign key (team_id,owner_id) references public.team_members(team_id,user_id)
);
create table private.rate_limit_counters (
  scope_key text not null, action_group text not null, window_start timestamptz not null,
  request_count integer not null check (request_count >= 0), primary key(scope_key,action_group,window_start)
);
create index members_user_state on public.team_members(user_id,state);
create index tasks_assignee_status on public.tasks(team_id,assignee_id,status);
create index tasks_dates on public.tasks(team_id,plan_start,plan_end);
create index tasks_deadline on public.tasks(team_id,deadline) where deleted_at is null;
create index series_assignee on public.recurrence_series(team_id,assignee_id,active);
create index events_task_time on private.task_events(task_id,effective_at,event_seq);
create index entries_date_task on private.plan_day_entries(plan_date,task_id);
create index comments_task_time on public.comments(task_id,created_at,id);
create index notifications_recipient on public.notifications(recipient_id,read_at,created_at desc);

-- The owner bypasses RLS. No browser role can mutate any table directly.
create function private.is_active_member(p_team_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.team_members m where m.team_id=p_team_id
    and m.user_id=(select auth.uid()) and m.state='active');
$$;
grant usage on schema private to authenticated;
grant execute on function private.is_active_member(uuid) to authenticated;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;
grant select on public.teams, public.team_members, public.tasks, public.recurrence_series,
  public.comments, public.notifications to authenticated;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.tasks enable row level security;
alter table public.recurrence_series enable row level security;
alter table public.comments enable row level security;
alter table public.notifications enable row level security;
create policy teams_read on public.teams for select to authenticated using(private.is_active_member(id));
create policy members_read on public.team_members for select to authenticated using(private.is_active_member(team_id));
create policy tasks_read on public.tasks for select to authenticated using(private.is_active_member(team_id));
create policy series_read on public.recurrence_series for select to authenticated using(private.is_active_member(team_id));
create policy comments_read on public.comments for select to authenticated using(exists(
  select 1 from public.tasks t where t.id=task_id and private.is_active_member(t.team_id)));
create policy notifications_read on public.notifications for select to authenticated
  using(recipient_id=(select auth.uid()) and private.is_active_member(team_id));
-- Defense in depth if a private table is ever added to an exposed schema.
alter table private.invitations enable row level security;
alter table private.series_revisions enable row level security;
alter table private.plan_day_entries enable row level security;
alter table private.task_events enable row level security;
alter table private.operation_results enable row level security;
alter table private.report_snapshots enable row level security;
alter table private.rate_limit_counters enable row level security;
revoke all on all sequences in schema private from public, anon, authenticated;
revoke execute on function private.valid_weekdays(smallint[]) from public, anon, authenticated;
commit;
