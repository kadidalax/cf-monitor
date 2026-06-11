-- Remove settings for features intentionally dropped from the Worker edition.
DELETE FROM settings
WHERE key IN (
  'allow_cors',
  'private_site',
  'private_site_password',
  'tempory_share_token',
  'tempory_share_token_expire_at',
  'temporary_share_token',
  'temporary_share_token_expire_at',
  'custom_head',
  'custom_body',
  'custom_footer_html',
  'agent_auto_discovery_key'
);
