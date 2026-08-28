-- OTR Team Portal — submission storage used by feedback and Post-Event Reports.
-- Rerunnable against a new or existing project.

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  submission_type text not null,
  category text,
  quick_feedback text,
  answers jsonb,
  additional_details text,
  submitted_name text,
  anonymous boolean not null default true,
  app_version text,
  source text default 'web',
  created_at timestamptz not null default now()
);

alter table public.submissions add column if not exists submission_type text;
alter table public.submissions add column if not exists category text;
alter table public.submissions add column if not exists quick_feedback text;
alter table public.submissions add column if not exists answers jsonb;
alter table public.submissions add column if not exists additional_details text;
alter table public.submissions add column if not exists submitted_name text;
alter table public.submissions add column if not exists anonymous boolean default true;
alter table public.submissions add column if not exists app_version text;
alter table public.submissions add column if not exists source text default 'web';
alter table public.submissions add column if not exists created_at timestamptz default now();

alter table public.submissions enable row level security;
grant select, insert on table public.submissions to anon;

drop policy if exists "OTR submissions anon insert v1" on public.submissions;
create policy "OTR submissions anon insert v1"
on public.submissions for insert to anon with check (true);

drop policy if exists "OTR submissions anon read temporary beta" on public.submissions;
create policy "OTR submissions anon read temporary beta"
on public.submissions for select to anon using (true);

-- Anonymous reads support the intentionally open V0.5 Admin viewer.
-- Remove this read policy when authenticated administration is introduced.
