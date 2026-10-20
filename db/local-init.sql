-- Local development roles (docker-compose). Production roles are created by an
-- operator with strong generated passwords; see docs/DEPLOYMENT.md.
CREATE ROLE karamay_owner LOGIN PASSWORD 'owner_local_dev_only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE karamay_app LOGIN PASSWORD 'app_local_dev_only' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE karamay OWNER karamay_owner;
