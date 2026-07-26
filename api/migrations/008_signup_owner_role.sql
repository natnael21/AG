-- Demote shop owners that signup provisioned as platform super_admins.
--
-- services/signup.js created every approved shop's owner with role
-- 'super_admin'. Two things follow from that role:
--   * resolveWorkspaceId() skips the workspace allowlist entirely, so passing
--     ?workspaceId=<any other shop> was accepted;
--   * /api/workspaces and /api/admin/signups return every row.
-- So any shop that signed up could read and write every other shop's
-- customers, vehicles and repair orders, and review other shops' signup
-- requests. Reproduced end to end before writing this migration.
--
-- signup.js now provisions 'manager', which is full control of the owner's own
-- workspace and nothing outside it. This migration corrects the accounts that
-- were already created the old way.
--
-- It is deliberately narrow: it only touches users that shop_signups points at
-- via user_id, i.e. accounts this provisioning flow created. AG's own platform
-- staff are seeded directly, are not referenced by any signup row, and keep
-- super_admin.
--
-- Note: shop_signups.user_id is TEXT (see 002_shop_signups.sql) and users.id is
-- VARCHAR(64) (see 001_initial.sql), so these compare directly. An earlier
-- revision of this file cast s.user_id::bigint behind a '^[0-9]+$' guard, which
-- matched nothing against production's "usr-<uuid>" ids and silently no-op'd
-- the demotion this migration exists to perform.

UPDATE users u
   SET role = 'manager',
       updated_at = NOW()
 WHERE u.role = 'super_admin'
   AND EXISTS (
     SELECT 1
       FROM shop_signups s
      WHERE s.user_id IS NOT NULL
        AND s.user_id = u.id
   );

-- Their existing sessions carry no role of their own (requireAuth re-reads it
-- from users on every request), so the change takes effect immediately and no
-- session cleanup is required.
