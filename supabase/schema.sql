-- Familien-App: Datenbank einrichten
-- Im Supabase-Dashboard unter "SQL Editor" komplett einfügen und auf "Run" klicken.
-- WICHTIG: Unten bei "members" eure zwei E-Mail-Adressen und Namen eintragen.

-- Wer die App benutzen darf
create table if not exists public.members (
  email text primary key,
  display_name text not null
);

insert into public.members (email, display_name) values
  ('DEINE-EMAIL@beispiel.de', 'Anas'),
  ('EMAIL-DEINER-FRAU@beispiel.de', 'Frau')
on conflict (email) do update set display_name = excluded.display_name;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where lower(email) = lower(auth.jwt() ->> 'email'));
$$;

-- Kalender
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  date date not null,
  start_time time,
  end_time time,
  note text,
  created_by uuid default auth.uid(),
  updated_by uuid default auth.uid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Einkaufsliste
create table if not exists public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'Sonstiges',
  quantity text,
  checked boolean not null default false,
  created_by uuid default auth.uid(),
  updated_by uuid default auth.uid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Geräte, die Benachrichtigungen bekommen
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null default auth.uid(),
  subscription jsonb not null,
  created_at timestamptz default now()
);

-- "Zuletzt geändert von" automatisch setzen
create or replace function public.touch_row() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists events_touch on public.events;
create trigger events_touch before update on public.events
  for each row execute function public.touch_row();
drop trigger if exists shopping_touch on public.shopping_items;
create trigger shopping_touch before update on public.shopping_items
  for each row execute function public.touch_row();

-- Zugriff nur für eure zwei Konten
alter table public.members enable row level security;
alter table public.events enable row level security;
alter table public.shopping_items enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists "members read" on public.members;
create policy "members read" on public.members for select to authenticated using (public.is_member());

drop policy if exists "events all" on public.events;
create policy "events all" on public.events for all to authenticated
  using (public.is_member()) with check (public.is_member());

drop policy if exists "shopping all" on public.shopping_items;
create policy "shopping all" on public.shopping_items for all to authenticated
  using (public.is_member()) with check (public.is_member());

drop policy if exists "own subscriptions" on public.push_subscriptions;
create policy "own subscriptions" on public.push_subscriptions for all to authenticated
  using (public.is_member() and user_id = auth.uid())
  with check (public.is_member() and user_id = auth.uid());

-- Live-Synchronisierung einschalten
do $$
begin
  begin alter publication supabase_realtime add table public.events; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.shopping_items; exception when duplicate_object then null; end;
end $$;
