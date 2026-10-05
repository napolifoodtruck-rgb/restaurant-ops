-- Access is per person, set by the account owner: most of the team are staff, a few are
-- managers, one is the owner. Square job titles stay as information only.
ALTER TABLE staff ADD COLUMN access text NOT NULL DEFAULT 'staff' CHECK (access IN ('staff', 'manager', 'owner'));
-- Whoever set the account up (job title 'Owner' with an email) is its owner.
UPDATE staff SET access = 'owner' WHERE job_title = 'Owner' AND email IS NOT NULL AND password_hash IS NOT NULL;
