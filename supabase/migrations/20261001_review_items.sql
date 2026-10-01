-- Portal v58: deliverables live in the database (uploaded from /r/studio/), not Sveltia files.

-- Team role on invites: 'client' (review/comment) or 'team' (designers/producers who upload).
alter table public.invites add column if not exists role text not null default 'client';
do $$ begin
  alter table public.invites add constraint invites_role_chk check (role in ('client','team'));
exception when duplicate_object then null; end $$;

-- Can the signed-in user see this project? (owner, or invited to it)
create or replace function public.sn_can_project(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.sn_is_owner()
      or exists (select 1 from public.invites i
                 where i.review_slug = 'studio'
                   and lower(i.email) = public.sn_email()
                   and p = any(i.project_keys));
$$;

create table if not exists public.review_items (
  id             text primary key,               -- same id style as the old CMS files (comments key on it)
  review_slug    text not null default 'studio',
  project_key    text not null,
  section        text not null default 'Other',  -- the "folder" in the project sidebar
  title          text not null,
  version        text not null default '',
  kind           text not null default 'file' check (kind in ('image','video','audio','file')),
  stream_uid     text,
  r2_key         text,
  src_url        text,
  download_url   text,
  file_name      text,
  file_size      bigint,
  mime           text,
  item_order     int  not null default 100,
  archived       boolean not null default false,
  published      boolean not null default true,
  legacy         boolean not null default false, -- imported from the old Sveltia files
  uploader_email text,
  uploader_name  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists review_items_project on public.review_items (review_slug, project_key);

alter table public.review_items enable row level security;
-- Read: only people on that project. All writes go through the portal-items function.
drop policy if exists ri_sel on public.review_items;
create policy ri_sel on public.review_items for select to authenticated
  using (review_slug = 'studio' and public.sn_can_project(project_key));
