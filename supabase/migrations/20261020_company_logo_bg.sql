-- v71: owner-chosen background colour behind each company's logo on the Studio hub.
create table if not exists public.company_logo_bg (
  review_slug text not null default 'studio',
  company_key text not null,
  color       text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  updated_at  timestamptz not null default now(),
  primary key (review_slug, company_key)
);
alter table public.company_logo_bg enable row level security;
drop policy if exists m_sel on public.company_logo_bg;
create policy m_sel on public.company_logo_bg for select to authenticated using (public.sn_is_member());
drop policy if exists o_all on public.company_logo_bg;
create policy o_all on public.company_logo_bg for all to authenticated using (public.sn_is_owner()) with check (public.sn_is_owner());
