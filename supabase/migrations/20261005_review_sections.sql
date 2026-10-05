-- v68: nested, persistent folders in the review area.
-- A folder name with " / " nests it (e.g. "CD Direction / Exhibit Rooms / AV06"). Folders here exist even before
-- anything is uploaded, so the team can work out of them. Empty folders are hidden from clients (portal logic).
create table if not exists public.review_sections (
  id          uuid primary key default gen_random_uuid(),
  review_slug text not null default 'studio',
  project_key text not null,
  name        text not null,
  ord         integer not null default 0,
  created_by  text,
  created_at  timestamptz not null default now(),
  unique (review_slug, project_key, name)
);
alter table public.review_sections enable row level security;
drop policy if exists rs_sel on public.review_sections;
create policy rs_sel on public.review_sections for select to authenticated using (public.sn_can_project(project_key));
drop policy if exists rs_owner on public.review_sections;
create policy rs_owner on public.review_sections for all to authenticated using (public.sn_is_owner()) with check (public.sn_is_owner());
drop policy if exists rs_team_ins on public.review_sections;
create policy rs_team_ins on public.review_sections for insert to authenticated with check (public.sn_is_team_on(project_key));
