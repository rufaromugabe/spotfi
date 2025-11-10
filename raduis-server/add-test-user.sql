-- Test user for FreeRADIUS authentication
INSERT INTO
  radcheck (username, attribute, op, value)
VALUES
  (
    'testuser',
    'Cleartext-Password',
    ':=',
    'testpass'
  );
-- Add a reply attribute for the test user
INSERT INTO
  radreply (username, attribute, op, value)
VALUES
  ('testuser', 'Service-Type', ':=', 'Framed-User');