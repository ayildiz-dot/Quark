-- Agent dispute window (hours)
-- Per-scorecard setting, required, default 72. Stamped onto each evaluation at the
-- moment it becomes 'submitted', so changing a scorecard later never shortens or
-- extends the window of evaluations already submitted.
-- Purely additive and safe to re-run. Does not touch any existing evaluation rows.
-- Spot-check disputes (raise_dsat_dispute) are not changed.

-- 1. Scorecard setting: required, default 72 (existing scorecards receive 72).
alter table public.scorecards
  add column if not exists dispute_window_hours integer not null default 72;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'scorecards_dispute_window_hours_check'
  ) then
    alter table public.scorecards
      add constraint scorecards_dispute_window_hours_check
      check (dispute_window_hours between 1 and 8760);
  end if;
end $$;

-- 2. Stamp target on evaluations. Nullable: drafts and evaluations submitted before
--    this migration have no stamp, and raise_dispute falls back to the scorecard value.
alter table public.evaluations
  add column if not exists dispute_window_hours integer;

-- 3. Stamp the window when an evaluation becomes submitted (direct submit, or a
--    draft being submitted). Edits to an already-submitted evaluation do not re-stamp.
create or replace function public._stamp_dispute_window()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status = 'submitted'
     and (tg_op = 'INSERT' or old.status is distinct from 'submitted') then
    select s.dispute_window_hours
      into new.dispute_window_hours
      from scorecards s
     where s.id = new.scorecard_id;
    if new.dispute_window_hours is null then
      new.dispute_window_hours := 72;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_stamp_dispute_window on public.evaluations;
create trigger trg_stamp_dispute_window
  before insert or update of status on public.evaluations
  for each row execute function public._stamp_dispute_window();

-- 4. raise_dispute: the live body, unchanged except for the window check
--    (marked NEW). Same signature, so no client change is needed for it to apply.
create or replace function public.raise_dispute(p_eval_id integer, p_comment text, p_tl_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare rec evaluations; v_email text; v_kg boolean; v_id uuid; v_hours integer;
begin
  if p_comment is null or length(trim(p_comment)) = 0 then raise exception 'A dispute comment is required'; end if;
  if p_tl_id is null then raise exception 'Select a Team Leader'; end if;
  select * into rec from evaluations where id = p_eval_id;
  if rec.id is null then raise exception 'Evaluation not found'; end if;

  -- NEW: the agent's window is counted from submission. Stamped value first,
  -- then the scorecard's current value (older evaluations), then 72.
  select s.dispute_window_hours into v_hours from scorecards s where s.id = rec.scorecard_id;
  v_hours := coalesce(rec.dispute_window_hours, v_hours, 72);
  if rec.submitted_at is null or now() > rec.submitted_at + make_interval(hours => v_hours) then
    raise exception 'The %-hour window to dispute this evaluation has closed.', v_hours;
  end if;

  select trim(elem->>'value') into v_email
    from jsonb_array_elements(rec.metadata_values) elem
    where lower(elem->>'label') = lower('Agent''s Email') limit 1;
  if v_email is null or lower(v_email) <> lower((select email from users where id = auth.uid())) then
    raise exception 'You can only dispute your own evaluations';
  end if;
  select (lower(u.email) like '%@kaizengaming.com') into v_kg from users u where u.id = rec.evaluator_id;
  insert into disputes (evaluation_id, eval_type, hub_id, queue_id, agent_id, tl_id, evaluator_id, evaluator_is_kg, status, deadline_at)
  values (p_eval_id, rec.evaluation_type, rec.hub_id, rec.queue_id, auth.uid(), p_tl_id, rec.evaluator_id, coalesce(v_kg,false), 'tl_pending', now() + interval '24 hours')
  returning id into v_id;
  insert into dispute_events (dispute_id, actor_id, actor_role, action, comment)
  values (v_id, auth.uid(), 'agent', 'raised', p_comment);
  perform _disp_notify(p_tl_id, 'dispute_request', 'You have a Dispute Request',
    'An agent raised a dispute on evaluation #' || coalesce(rec.eval_id::text, rec.id::text) || '.', v_id, true);
  return v_id;
exception when unique_violation then
  raise exception 'There is already an open dispute for this evaluation';
end $function$;

notify pgrst, 'reload schema';