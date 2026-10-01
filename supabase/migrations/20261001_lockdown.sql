-- Portal v58 security lockdown.
-- Before: legacy wide-open policies (USING true, roles public/anon) sat next to the sn_* ones,
-- and Postgres ORs permissive policies, so anyone holding the public page key could read and
-- write invites, comments, approvals, profiles, scheduled emails...
-- After: every policy below is the ONLY policy on its table.
--   owner   = signed-in email is an owner login            -> sn_is_owner()
--   project = owner, or invited to that project            -> sn_can_project(key)
--   member  = owner, or invited to anything                -> sn_is_member()
-- Edge functions use the service role and are unaffected; triggers are SECURITY DEFINER.

begin;

-- ---------- helpers ----------
create or replace function public.sn_my_projects() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce((select array_agg(distinct k) from public.invites i, unnest(i.project_keys) k
                   where i.review_slug = 'studio' and lower(i.email) = public.sn_email()), '{}'::text[]);
$$;
-- asset ids look like "project:section:item" or "deck:project:deckId"
create or replace function public.sn_asset_project(a text) returns text
language sql immutable as $$
  select case when a like 'deck:%' then split_part(a, ':', 2) else split_part(a, ':', 1) end;
$$;
-- login page: "is this email on the invite list?" without exposing the list itself
create or replace function public.sn_is_invited(e text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.invites i where i.review_slug = 'studio' and lower(i.email) = lower(trim(e)));
$$;
revoke all on function public.sn_is_invited(text) from public;
grant execute on function public.sn_is_invited(text) to anon, authenticated;

-- ---------- drop EVERY existing policy on the portal tables ----------
do $$ declare r record; begin
  for r in select tablename, policyname from pg_policies where schemaname = 'public' and tablename in (
    'announcements','approvals','brand_colors','calendar_events','calendar_types','client_assets',
    'comment_reactions','comments','companies','creative_brief','final_folders','final_items',
    'hidden_items','invites','newsletters','partner_activity','presentations','profiles',
    'project_order','project_status','review_settings','scheduled_emails','tasks')
  loop execute format('drop policy %I on public.%I', r.policyname, r.tablename); end loop;
end $$;

-- ---------- owner-only tables ----------
create policy own_all on public.newsletters      for all to authenticated using (sn_is_owner()) with check (sn_is_owner());
create policy own_all on public.scheduled_emails for all to authenticated using (sn_is_owner()) with check (sn_is_owner());

-- ---------- readable by people on the project, written by the owner ----------
create policy p_sel on public.announcements   for select to authenticated using (sn_can_project(project));
create policy o_ins on public.announcements   for insert to authenticated with check (sn_is_owner());
create policy p_sel on public.calendar_events for select to authenticated using (sn_can_project(project_id));
create policy o_all on public.calendar_events for all    to authenticated using (sn_is_owner()) with check (sn_is_owner());
create policy p_sel on public.final_folders   for select to authenticated using (sn_can_project(project_key));
create policy o_all on public.final_folders   for all    to authenticated using (sn_is_owner()) with check (sn_is_owner());
create policy p_sel on public.final_items     for select to authenticated using (sn_can_project(project_key));
create policy o_all on public.final_items     for all    to authenticated using (sn_is_owner()) with check (sn_is_owner());
create policy p_sel on public.project_status  for select to authenticated using (sn_can_project(project_key));
create policy o_all on public.project_status  for all    to authenticated using (sn_is_owner()) with check (sn_is_owner());
create policy p_sel on public.presentations   for select to authenticated using (sn_is_owner() or (published and sn_can_project(project_key)));
create policy o_all on public.presentations   for all    to authenticated using (sn_is_owner()) with check (sn_is_owner());

-- ---------- readable by any member, written by the owner ----------
create policy m_sel on public.calendar_types  for select to authenticated using (sn_is_member());
create policy o_all on public.calendar_types  for all    to authenticated using (sn_is_owner()) with check (sn_is_owner());
create policy m_sel on public.hidden_items    for select to authenticated using (sn_is_member());
create policy o_all on public.hidden_items    for all    to authenticated using (sn_is_owner()) with check (sn_is_owner());
create policy m_sel on public.project_order   for select to authenticated using (sn_is_member());
create policy o_all on public.project_order   for all    to authenticated using (sn_is_owner()) with check (sn_is_owner());
create policy m_sel on public.review_settings for select to authenticated using (sn_is_member());
create policy o_all on public.review_settings for all    to authenticated using (sn_is_owner()) with check (sn_is_owner());
-- companies: partners add their own company while onboarding; only the owner edits existing ones
create policy m_sel on public.companies for select to authenticated using (sn_is_member());
create policy m_ins on public.companies for insert to authenticated with check (sn_is_member());
create policy o_upd on public.companies for update to authenticated using (sn_is_owner()) with check (sn_is_owner());
create policy o_del on public.companies for delete to authenticated using (sn_is_owner());

-- ---------- invites ----------
-- you see your own invite, plus people who share a project with you (mentions, assignees)
create policy i_sel on public.invites for select to authenticated
  using (sn_is_owner() or lower(email) = sn_email() or project_keys && sn_my_projects());
create policy o_all on public.invites for all to authenticated using (sn_is_owner()) with check (sn_is_owner());

-- ---------- profiles ----------
create policy pr_sel on public.profiles for select to authenticated using (
  sn_is_owner() or id = auth.uid()
  or exists (select 1 from public.invites i where i.review_slug = 'studio'
             and lower(i.email) = lower(profiles.email) and i.project_keys && sn_my_projects()));
create policy pr_ins on public.profiles for insert to authenticated with check (sn_is_member() and (id = auth.uid() or sn_is_owner()));
create policy pr_upd on public.profiles for update to authenticated using (id = auth.uid() or sn_is_owner()) with check (id = auth.uid() or sn_is_owner());
create policy pr_del on public.profiles for delete to authenticated using (sn_is_owner());

-- ---------- comments + reactions ----------
create policy c_sel on public.comments for select to authenticated using (sn_can_project(sn_asset_project(asset_id)));
create policy c_ins on public.comments for insert to authenticated
  with check (sn_can_project(sn_asset_project(asset_id)) and (sn_is_owner() or lower(coalesce(author_email,'')) = sn_email()));
create policy c_upd on public.comments for update to authenticated
  using (sn_is_owner() or lower(coalesce(author_email,'')) = sn_email()) with check (sn_is_owner() or lower(coalesce(author_email,'')) = sn_email());
create policy c_del on public.comments for delete to authenticated using (sn_is_owner() or lower(coalesce(author_email,'')) = sn_email());

create policy r_sel on public.comment_reactions for select to authenticated
  using (exists (select 1 from public.comments c where c.id = comment_id));          -- comments RLS applies inside
create policy r_ins on public.comment_reactions for insert to authenticated
  with check (lower(coalesce(reactor_email,'')) = sn_email() and exists (select 1 from public.comments c where c.id = comment_id));
create policy r_del on public.comment_reactions for delete to authenticated
  using (sn_is_owner() or lower(coalesce(reactor_email,'')) = sn_email());

-- ---------- approvals: approvers on that project ----------
create policy a_sel on public.approvals for select to authenticated using (sn_can_project(project_key));
create policy a_ins on public.approvals for insert to authenticated with check (sn_can_approve() and sn_can_project(project_key));
create policy a_upd on public.approvals for update to authenticated
  using (sn_can_approve() and sn_can_project(project_key)) with check (sn_can_approve() and sn_can_project(project_key));
create policy a_del on public.approvals for delete to authenticated using (sn_can_approve() and sn_can_project(project_key));

-- ---------- shared project tools partners use ----------
create policy p_sel on public.brand_colors for select to authenticated using (sn_can_project(project_key));
create policy p_ins on public.brand_colors for insert to authenticated
  with check (sn_can_project(project_key) and (sn_is_owner() or lower(coalesce(created_by,'')) = sn_email()));
create policy p_upd on public.brand_colors for update to authenticated
  using (sn_is_owner() or lower(coalesce(created_by,'')) = sn_email()) with check (sn_can_project(project_key));
create policy p_del on public.brand_colors for delete to authenticated using (sn_is_owner() or lower(coalesce(created_by,'')) = sn_email());

create policy p_sel on public.client_assets for select to authenticated using (sn_can_project(project_key));
create policy p_ins on public.client_assets for insert to authenticated
  with check (sn_can_project(project_key) and (sn_is_owner() or lower(coalesce(created_by,'')) = sn_email()));
create policy p_upd on public.client_assets for update to authenticated
  using (sn_is_owner() or lower(coalesce(created_by,'')) = sn_email()) with check (sn_can_project(project_key));
create policy p_del on public.client_assets for delete to authenticated using (sn_is_owner() or lower(coalesce(created_by,'')) = sn_email());

create policy p_sel on public.creative_brief for select to authenticated using (sn_can_project(project_key));
create policy p_ins on public.creative_brief for insert to authenticated with check (sn_can_project(project_key));
create policy p_upd on public.creative_brief for update to authenticated using (sn_can_project(project_key)) with check (sn_can_project(project_key));

create policy p_sel on public.tasks for select to authenticated using (sn_can_project(project_key));
create policy p_ins on public.tasks for insert to authenticated
  with check (sn_can_project(project_key) and (sn_is_owner() or lower(coalesce(assigner_email,'')) = sn_email()));
create policy p_upd on public.tasks for update to authenticated using (sn_can_project(project_key)) with check (sn_can_project(project_key));
create policy p_del on public.tasks for delete to authenticated using (sn_is_owner() or lower(coalesce(assigner_email,'')) = sn_email());

-- ---------- activity tracking: partners log their own, owner reads ----------
create policy pa_ins on public.partner_activity for insert to authenticated
  with check (lower(coalesce(email,'')) = sn_email() and (project_key is null or sn_can_project(project_key)));
create policy pa_sel on public.partner_activity for select to authenticated using (sn_is_owner());

-- ---------- storage ----------
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'
           and policyname in ('review voice insert','review voice read','av_read','av_upload','av_update','ca_obj_read','ca_obj_insert','ca_obj_delete')
  loop execute format('drop policy %I on storage.objects', r.policyname); end loop;
end $$;
-- buckets stay public for viewing by URL; listing/uploading/deleting needs membership
create policy sn_obj_sel on storage.objects for select to authenticated
  using (bucket_id in ('avatars','client-assets','review-voice') and sn_is_member());
create policy sn_obj_ins on storage.objects for insert to authenticated
  with check (bucket_id in ('avatars','client-assets','review-voice') and sn_is_member());
create policy sn_obj_upd on storage.objects for update to authenticated
  using (bucket_id in ('avatars','client-assets') and (sn_is_owner() or owner = auth.uid()));
create policy sn_obj_del on storage.objects for delete to authenticated
  using (bucket_id in ('avatars','client-assets','review-voice') and (sn_is_owner() or owner = auth.uid()));

commit;

-- ---------- team members (invites.role = 'team') can announce + schedule on their projects ----------
create or replace function public.sn_is_team_on(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.sn_is_owner()
      or exists (select 1 from public.invites i where i.review_slug = 'studio' and lower(i.email) = public.sn_email()
                 and i.role = 'team' and p = any(i.project_keys));
$$;
-- every address must be an owner login or someone invited to the portal
create or replace function public.sn_only_portal(arr text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from unnest(coalesce(arr, '{}'::text[])) e
    where lower(trim(e)) not in ('hello@supernerd.tv','shaun@supernerd.tv')
      and not exists (select 1 from public.invites i where i.review_slug = 'studio' and lower(i.email) = lower(trim(e))));
$$;
drop policy if exists o_ins on public.announcements;
create policy t_ins on public.announcements for insert to authenticated with check (sn_is_team_on(project));
drop policy if exists own_all on public.scheduled_emails;
create policy o_all on public.scheduled_emails for all to authenticated using (sn_is_owner()) with check (sn_is_owner());
create policy t_sel on public.scheduled_emails for select to authenticated
  using (sn_is_team_on(project_key) and lower(coalesce(created_by,'')) = sn_email());
create policy t_ins on public.scheduled_emails for insert to authenticated
  with check (sn_is_team_on(project_key) and lower(coalesce(created_by,'')) = sn_email() and kind = 'notify'
              and sn_only_portal(to_emails) and sn_only_portal(bcc_emails));
create policy t_upd on public.scheduled_emails for update to authenticated
  using (sn_is_team_on(project_key) and lower(coalesce(created_by,'')) = sn_email())
  with check (sn_is_team_on(project_key) and lower(coalesce(created_by,'')) = sn_email() and status in ('scheduled','canceled')
              and sn_only_portal(to_emails) and sn_only_portal(bcc_emails));
