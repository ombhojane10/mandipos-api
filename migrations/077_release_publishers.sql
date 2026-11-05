-- Who may publish an app build to every shop, without Render or the owner's database login.
-- Each person gets their own release token (scripts/release-token.mjs, run by the owner); only
-- its SHA-256 is kept. The API never reads this table: publish_app_release() checks the token
-- and writes the build as the owner, so neither the API role nor a team member's own database
-- login (a member of mandipos_api) can insert a release or read the tokens.
CREATE TABLE release_publishers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  token_sha256  bytea NOT NULL UNIQUE,
  flavors       text[] NOT NULL DEFAULT '{pos,daybook}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
REVOKE ALL ON release_publishers FROM PUBLIC;

ALTER TABLE app_releases ADD COLUMN published_by text NOT NULL DEFAULT '';

-- Publishes one build: the token must be live and allowed this flavor, and the build newer than
-- the published one (Android never installs an older one over a newer). The hash and size are
-- worked out here, not taken from the caller. Keeps the newest three per flavor, as publish-apk.
CREATE FUNCTION publish_app_release(p_token text, p_flavor text, p_code int, p_name text, p_apk bytea, p_notes text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who text;
  newest int;
BEGIN
  SELECT name INTO who FROM release_publishers
  WHERE token_sha256 = sha256(convert_to(p_token, 'UTF8')) AND revoked_at IS NULL AND p_flavor = ANY (flavors);
  IF who IS NULL THEN RAISE EXCEPTION 'release token not allowed' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('app_releases:' || p_flavor, 0));
  SELECT max(version_code) INTO newest FROM app_releases WHERE flavor = p_flavor;
  IF p_code <= COALESCE(newest, 0) THEN
    RAISE EXCEPTION 'versionCode % is not newer than the published %', p_code, newest USING ERRCODE = '23514';
  END IF;
  INSERT INTO app_releases (flavor, version_code, version_name, sha256, size_bytes, apk, notes, published_by)
  VALUES (p_flavor, p_code, p_name, encode(sha256(p_apk), 'hex'), length(p_apk), p_apk, left(COALESCE(p_notes, ''), 500), who);
  DELETE FROM app_releases WHERE flavor = p_flavor AND version_code NOT IN
    (SELECT version_code FROM app_releases WHERE flavor = p_flavor ORDER BY version_code DESC LIMIT 3);
  UPDATE release_publishers SET last_used_at = now() WHERE token_sha256 = sha256(convert_to(p_token, 'UTF8'));
  RETURN who;
END $$;
REVOKE ALL ON FUNCTION publish_app_release(text, text, int, text, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publish_app_release(text, text, int, text, bytea, text) TO mandipos_api;

-- Whether a token may publish this flavor, so a wrong token is refused before the APK is read.
CREATE FUNCTION release_token_ok(p_token text, p_flavor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM release_publishers
                 WHERE token_sha256 = sha256(convert_to(p_token, 'UTF8')) AND revoked_at IS NULL AND p_flavor = ANY (flavors))
$$;
REVOKE ALL ON FUNCTION release_token_ok(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_token_ok(text, text) TO mandipos_api;
