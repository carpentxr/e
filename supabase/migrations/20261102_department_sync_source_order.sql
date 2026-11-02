-- Align the existing Office table with the one-placement-per-member sync model.
-- Apply in Supabase SQL Editor before merging/deploying the bot integration.
--
-- Existing rows are preserved. Legacy placement metadata stays NULL until the
-- bot performs a fresh sync; no historical values are guessed.

ALTER TABLE public.member_department_assignments
  ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS placement_key text,
  ADD COLUMN IF NOT EXISTS placement_label text,
  ADD COLUMN IF NOT EXISTS assigned_by_discord_id text,
  ADD COLUMN IF NOT EXISTS assigned_by_tag text,
  ADD COLUMN IF NOT EXISTS inactive_reason text;

UPDATE public.member_department_assignments
SET id = gen_random_uuid()
WHERE id IS NULL;

ALTER TABLE public.member_department_assignments
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN profile_id DROP NOT NULL;

-- profile_id is an optional link to a verified Office profile, not the row
-- identity. The row itself is uniquely identified by its generated id.
ALTER TABLE public.member_department_assignments
  DROP CONSTRAINT IF EXISTS member_department_assignments_pkey;

ALTER TABLE public.member_department_assignments
  ADD CONSTRAINT member_department_assignments_pkey PRIMARY KEY (id);

-- Preserve the one-placement-per-Discord-member rule and the one-active
-- Discord identity per linked Office profile rule.
CREATE UNIQUE INDEX IF NOT EXISTS member_department_assignments_discord_user_id_key
  ON public.member_department_assignments (discord_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS member_department_assignments_profile_unique
  ON public.member_department_assignments (profile_id)
  WHERE profile_id IS NOT NULL AND is_active = true;


-- Prevent an older bot request from overwriting a newer department change.
CREATE OR REPLACE FUNCTION public.office_sync_department_assignment(
  p_discord_user_id text,
  p_profile_id uuid,
  p_roblox_user_id text,
  p_roblox_username text,
  p_department_key text,
  p_placement_type text,
  p_placement_key text,
  p_placement_label text,
  p_assigned_by_discord_id text,
  p_assigned_by_tag text,
  p_source_updated_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_department_key text;
  v_existing_profile_id uuid;
  v_existing_source_updated_at timestamptz;
  v_source_updated_at timestamptz := coalesce(p_source_updated_at, now());
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized department synchronization';
  END IF;

  IF nullif(trim(p_discord_user_id), '') IS NULL
     OR nullif(trim(p_roblox_user_id), '') IS NULL
     OR nullif(trim(p_roblox_username), '') IS NULL
     OR nullif(trim(p_placement_key), '') IS NULL
     OR nullif(trim(p_placement_label), '') IS NULL
     OR p_department_key IS NULL
     OR p_placement_type IS NULL
  THEN
    RAISE EXCEPTION 'Required department assignment fields are missing';
  END IF;

  v_department_key :=
    CASE
      WHEN p_department_key = 'relations' THEN 'marketing'
      ELSE p_department_key
    END;

  IF v_department_key NOT IN ('operations', 'marketing', 'moderation') THEN
    RAISE EXCEPTION 'Invalid department key: %', p_department_key;
  END IF;

  IF p_placement_type NOT IN ('team', 'board') THEN
    RAISE EXCEPTION 'Invalid placement type';
  END IF;

  IF NOT (
    (v_department_key = 'operations'
      AND (
        (p_placement_type = 'team' AND p_placement_key = 'recruitment')
        OR
        (p_placement_type = 'board' AND p_placement_key = 'operations')
      ))
    OR
    (v_department_key = 'marketing'
      AND (
        (p_placement_type = 'team' AND p_placement_key IN ('social-media', 'outreach'))
        OR
        (p_placement_type = 'board' AND p_placement_key IN ('marketing', 'relations'))
      ))
    OR
    (v_department_key = 'moderation' AND p_placement_key = 'moderation')
  ) THEN
    RAISE EXCEPTION 'Placement key does not match its department';
  END IF;

  SELECT profile_id, source_updated_at
  INTO v_existing_profile_id, v_existing_source_updated_at
  FROM public.member_department_assignments
  WHERE discord_user_id = trim(p_discord_user_id)
  FOR UPDATE;

  IF FOUND THEN
    -- Ignore stale sync requests that arrive after a newer assignment/removal.
    IF v_existing_source_updated_at IS NOT NULL
       AND v_source_updated_at < v_existing_source_updated_at THEN
      RETURN;
    END IF;

    IF v_existing_profile_id IS NOT NULL
       AND p_profile_id IS NOT NULL
       AND v_existing_profile_id <> p_profile_id THEN
      RAISE EXCEPTION
        'Discord identity is already linked to a different Office profile';
    END IF;
  END IF;

  IF p_profile_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.member_department_assignments
       WHERE profile_id = p_profile_id
         AND discord_user_id <> trim(p_discord_user_id)
         AND is_active = true
     ) THEN
    RAISE EXCEPTION
      'Office profile already has another active department identity';
  END IF;

  INSERT INTO public.member_department_assignments (
    discord_user_id,
    profile_id,
    roblox_user_id,
    roblox_username,
    department_key,
    placement_type,
    placement_key,
    placement_label,
    assigned_by_discord_id,
    assigned_by_tag,
    is_active,
    inactive_reason,
    source_updated_at,
    synced_at,
    updated_at
  )
  VALUES (
    trim(p_discord_user_id),
    p_profile_id,
    trim(p_roblox_user_id),
    trim(p_roblox_username),
    v_department_key,
    p_placement_type,
    p_placement_key,
    trim(p_placement_label),
    p_assigned_by_discord_id,
    p_assigned_by_tag,
    true,
    NULL,
    v_source_updated_at,
    now(),
    now()
  )
  ON CONFLICT (discord_user_id)
  DO UPDATE SET
    -- An ambiguous resolver result must not erase a previously verified link.
    profile_id = coalesce(
      EXCLUDED.profile_id,
      public.member_department_assignments.profile_id
    ),
    roblox_user_id = EXCLUDED.roblox_user_id,
    roblox_username = EXCLUDED.roblox_username,
    department_key = EXCLUDED.department_key,
    placement_type = EXCLUDED.placement_type,
    placement_key = EXCLUDED.placement_key,
    placement_label = EXCLUDED.placement_label,
    assigned_by_discord_id = EXCLUDED.assigned_by_discord_id,
    assigned_by_tag = EXCLUDED.assigned_by_tag,
    is_active = true,
    inactive_reason = NULL,
    source_updated_at = EXCLUDED.source_updated_at,
    synced_at = now(),
    updated_at = now();
END;
$function$;


CREATE OR REPLACE FUNCTION public.office_deactivate_department_assignment(
  p_discord_user_id text,
  p_inactive_reason text,
  p_source_updated_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_source_updated_at timestamptz := coalesce(p_source_updated_at, now());
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized department synchronization';
  END IF;

  IF nullif(trim(p_discord_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'Discord user ID is required';
  END IF;

  UPDATE public.member_department_assignments
  SET
    is_active = false,
    inactive_reason = coalesce(
      nullif(trim(p_inactive_reason), ''),
      'removed_by_bot'
    ),
    source_updated_at = v_source_updated_at,
    synced_at = now(),
    updated_at = now()
  WHERE discord_user_id = trim(p_discord_user_id)
    AND (
      source_updated_at IS NULL
      OR v_source_updated_at >= source_updated_at
    );
END;
$function$;


REVOKE ALL ON FUNCTION
  public.office_sync_department_assignment(
    text, uuid, text, text, text, text, text, text,
    text, text, timestamptz
  )
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.office_deactivate_department_assignment(
    text, text, timestamptz
  )
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.office_sync_department_assignment(
    text, uuid, text, text, text, text, text, text,
    text, text, timestamptz
  )
TO service_role;

GRANT EXECUTE ON FUNCTION
  public.office_deactivate_department_assignment(
    text, text, timestamptz
  )
TO service_role;
