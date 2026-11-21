-- vp_ids: replay registry that VPService never used.
-- service_registry: name lookup nothing read; `services` is the record now.
-- prepared_payloads: prepare/finalize tokens; every signature is in-process now.
DROP TABLE IF EXISTS "vp_ids";
DROP TABLE IF EXISTS "service_registry";
DROP TABLE IF EXISTS "prepared_payloads";
