# Migrations - the source of truth for the schema

Naming: `NNNN_short_description.sql`, zero-padded, strictly sequential.

Why hand-written SQL rather than an ORM-generated schema: this model depends on `EXCLUDE`
constraints with `btree_gist`, `daterange` generated columns, partial unique indexes,
declarative partitioning and triggers. An ORM that owns the schema fights all five.

Every migration carries a `DO $$ ... $$` post-migration assertion block that proves it did what
it claimed.
