-- Runs once when the local database volume is first created.
-- Tests use a separate database so they never touch development data.
CREATE DATABASE sandbox_test;
