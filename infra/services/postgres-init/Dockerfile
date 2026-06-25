# Postgres with the FUNK schema baked in. Used by the Coolify compose variant,
# where runtime bind-mounts of repo files don't resolve — so the init SQL is
# copied into the image instead of mounted.
FROM postgres:16-alpine
COPY 01-schema.sql /docker-entrypoint-initdb.d/01-schema.sql
