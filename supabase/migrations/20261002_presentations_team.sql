-- v61: team members can add presentations (links or uploaded PDF/PPTX) to their projects
-- and manage only the ones they added. Clients still only see published decks.
alter table public.presentations add column if not exists created_by text;

drop policy if exists p_sel on public.presentations;
drop policy if exists o_all on public.presentations;
create policy o_all on public.presentations for all to authenticated using (sn_is_owner()) with check (sn_is_owner());
create policy p_sel on public.presentations for select to authenticated using (
  sn_is_owner()
  or (published and sn_can_project(project_key))
  or (sn_is_team_on(project_key) and lower(coalesce(created_by,'')) = sn_email()));
create policy t_ins on public.presentations for insert to authenticated
  with check (sn_is_team_on(project_key) and lower(coalesce(created_by,'')) = sn_email());
create policy t_upd on public.presentations for update to authenticated
  using (sn_is_team_on(project_key) and lower(coalesce(created_by,'')) = sn_email())
  with check (sn_is_team_on(project_key) and lower(coalesce(created_by,'')) = sn_email());
create policy t_del on public.presentations for delete to authenticated
  using (sn_is_team_on(project_key) and lower(coalesce(created_by,'')) = sn_email());
