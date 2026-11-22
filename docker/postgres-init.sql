-- Separate databases for the test suites (API e2e and engine integration tests run in parallel).
CREATE DATABASE flowforge_test OWNER flowforge;
CREATE DATABASE flowforge_test_engine OWNER flowforge;
CREATE DATABASE flowforge_test_worker OWNER flowforge;
