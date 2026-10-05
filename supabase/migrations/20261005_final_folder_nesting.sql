-- v67: nested folders in Final Deliverables.
-- A folder can live inside another folder (parent_id). NULL = top level, so existing folders are unchanged.
-- Deleting a parent sets children back to NULL; the portal moves them up a level before deleting anyway.
alter table public.final_folders
  add column if not exists parent_id uuid references public.final_folders(id) on delete set null;
create index if not exists final_folders_parent_idx on public.final_folders(parent_id);
-- RLS unchanged: existing p_sel (project members read) / o_all (owner writes) policies already cover this column.
