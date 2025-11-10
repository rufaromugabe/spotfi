-- Admin user for FreeRADIUS authentication
INSERT INTO
  radcheck (username, attribute, op, value)
VALUES
  ('admin', 'Cleartext-Password', ':=', 'admin123');
-- Add admin user attributes
INSERT INTO
  radreply (username, attribute, op, value)
VALUES
  (
    'admin',
    'Service-Type',
    ':=',
    'Administrative-User'
  );