-- v66: anyone invited to a job can add calendar events to it; they can change or delete
-- only the events they added. The owner can do everything. Clients still can't touch types.
alter table public.calendar_events add column if not exists created_by text;
alter table public.calendar_events add column if not exists created_by_name text;
update public.calendar_events set created_by = 'shaun@supernerd.tv' where created_by is null;

drop policy if exists m_ins on public.calendar_events;
drop policy if exists m_upd on public.calendar_events;
drop policy if exists m_del on public.calendar_events;
create policy m_ins on public.calendar_events for insert to authenticated
  with check (sn_can_project(project_id) and lower(coalesce(created_by,'')) = sn_email());
create policy m_upd on public.calendar_events for update to authenticated
  using (sn_can_project(project_id) and lower(coalesce(created_by,'')) = sn_email())
  with check (sn_can_project(project_id) and lower(coalesce(created_by,'')) = sn_email());
create policy m_del on public.calendar_events for delete to authenticated
  using (sn_can_project(project_id) and lower(coalesce(created_by,'')) = sn_email());
