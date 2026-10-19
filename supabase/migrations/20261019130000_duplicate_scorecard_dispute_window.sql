-- duplicate_scorecard: carry the agent dispute window over to the copy.
-- The live body, unchanged except for two marked lines:
--   1. dispute_window_hours is now copied from the source scorecard (previously the copy
--      silently fell back to the column default of 72).
--   2. SET search_path TO 'public' is pinned, as on the other SECURITY DEFINER functions,
--      so the function cannot be pointed at look-alike tables in another schema.
-- Same signature, so existing grants and callers are unaffected. Safe to re-run.

CREATE OR REPLACE FUNCTION public.duplicate_scorecard(source_id uuid, actor_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'   -- NEW
AS $function$
DECLARE
  new_scorecard_id uuid;
  src RECORD;
  grp RECORD;
  sec RECORD;
  q RECORD;
  opt RECORD;
  new_group_id uuid;
  new_section_id uuid;
  new_question_id uuid;
  new_option_id uuid;
  group_id_map jsonb := '{}'::jsonb;
  section_id_map jsonb := '{}'::jsonb;
  question_id_map jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO src FROM scorecards WHERE id = source_id;
  IF src IS NULL THEN
    RAISE EXCEPTION 'Source scorecard % not found', source_id;
  END IF;

  INSERT INTO scorecards (
    name, description, is_published, created_by, type,
    version, is_archived, parent_scorecard_id, pass_threshold,
    regions, division, queue_id,
    dispute_window_hours                                   -- NEW
  ) VALUES (
    src.name || ' (Copy)', src.description, false, actor_id, src.type,
    1, false, NULL, src.pass_threshold,
    src.regions, src.division, NULL,
    coalesce(src.dispute_window_hours, 72)                 -- NEW
  )
  RETURNING id INTO new_scorecard_id;

  FOR grp IN SELECT * FROM scorecard_question_groups WHERE scorecard_id = source_id LOOP
    INSERT INTO scorecard_question_groups (scorecard_id, name, position)
    VALUES (new_scorecard_id, grp.name, grp.position)
    RETURNING id INTO new_group_id;
    group_id_map := group_id_map || jsonb_build_object(grp.id::text, new_group_id::text);
  END LOOP;

  FOR q IN SELECT * FROM scorecard_questions WHERE scorecard_id = source_id LOOP
    INSERT INTO scorecard_questions (
      scorecard_id, group_id, title, description, weight, is_weighted,
      is_form_critical, is_group_critical, position, validation_rule,
      condition_question_id, condition_answer, allow_na
    ) VALUES (
      new_scorecard_id,
      CASE WHEN q.group_id IS NULL THEN NULL
           ELSE (group_id_map ->> q.group_id::text)::uuid END,
      q.title, q.description, q.weight, q.is_weighted,
      q.is_form_critical, q.is_group_critical, q.position, q.validation_rule,
      NULL, q.condition_answer, q.allow_na
    )
    RETURNING id INTO new_question_id;
    question_id_map := question_id_map || jsonb_build_object(q.id::text, new_question_id::text);
  END LOOP;

  FOR q IN SELECT * FROM scorecard_questions WHERE scorecard_id = source_id AND condition_question_id IS NOT NULL LOOP
    UPDATE scorecard_questions
    SET condition_question_id = (question_id_map ->> q.condition_question_id::text)::uuid
    WHERE id = (question_id_map ->> q.id::text)::uuid;
  END LOOP;

  FOR sec IN SELECT * FROM dsat_sections WHERE scorecard_id = source_id LOOP
    INSERT INTO dsat_sections (scorecard_id, title, description, position)
    VALUES (new_scorecard_id, sec.title, sec.description, sec.position)
    RETURNING id INTO new_section_id;
    section_id_map := section_id_map || jsonb_build_object(sec.id::text, new_section_id::text);
  END LOOP;

  FOR q IN SELECT * FROM dsat_questions WHERE scorecard_id = source_id LOOP
    INSERT INTO dsat_questions (
      scorecard_id, section_id, title, description, is_required,
      position, question_type, system_tag
    ) VALUES (
      new_scorecard_id,
      CASE WHEN q.section_id IS NULL THEN NULL
           ELSE (section_id_map ->> q.section_id::text)::uuid END,
      q.title, q.description, q.is_required,
      q.position, q.question_type, q.system_tag
    )
    RETURNING id INTO new_question_id;
    question_id_map := question_id_map || jsonb_build_object(q.id::text, new_question_id::text);
  END LOOP;

  FOR opt IN SELECT * FROM dsat_options WHERE question_id IN (
    SELECT id FROM dsat_questions WHERE scorecard_id = source_id
  ) LOOP
    INSERT INTO dsat_options (question_id, label, jump_to_section_id, position, is_controllable)
    VALUES (
      (question_id_map ->> opt.question_id::text)::uuid,
      opt.label,
      CASE WHEN opt.jump_to_section_id IS NULL THEN NULL
           ELSE (section_id_map ->> opt.jump_to_section_id::text)::uuid END,
      opt.position, opt.is_controllable
    )
    RETURNING id INTO new_option_id;
  END LOOP;

  INSERT INTO scorecard_metadata_fields (
    scorecard_id, label, field_type, is_required, options, position,
    validation_rule, system_tag
  )
  SELECT new_scorecard_id, label, field_type, is_required, options, position,
         validation_rule, system_tag
  FROM scorecard_metadata_fields
  WHERE scorecard_id = source_id;

  RETURN new_scorecard_id;
END;
$function$;

notify pgrst, 'reload schema';