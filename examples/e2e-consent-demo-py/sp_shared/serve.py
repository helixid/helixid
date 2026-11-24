# Boots one SP app from its enrolled identity. Both sp_airline/server.py and
# sp_hotel/server.py are thin wrappers around this. Python port of
# sp-shared/serve.ts.

from __future__ import annotations

from helixid_config import Env, SpDefinition, allow_loopback_http, env as default_env
from sp_shared.app import create_sp_app
from sp_shared.audit import create_audit_emitter
from sp_shared.identity import load_sp_identity
from sp_shared.kyaos_gate import Gate


def serve_sp(definition: SpDefinition, env: Env = default_env) -> None:
    identity = load_sp_identity(env.wallets_dir, definition.id)
    gate = Gate(
        service_did=identity.did,
        signing_key=identity.signingKey,
        helix_api_url=env.helix_api_url,
        display_name=definition.display_name,
        catalog=[entry.scope for entry in definition.scope_catalog],
        window_seconds=env.consent_window_seconds,
        hop_lifetime_seconds=env.consent_hop_lifetime_seconds,
        allow_loopback_http=allow_loopback_http,
    )
    app, _counters = create_sp_app(
        definition=definition,
        issuer_did=identity.did,
        gate=gate,
        # This SP's own verification and authorization decisions, in its own log.
        audit=create_audit_emitter(identity.did, definition.display_name),
    )

    print(f"[{definition.id}] {definition.display_name} listening on :{definition.port}", flush=True)
    print(f"[{definition.id}] did:web  {identity.did} (service {identity.serviceId}, its own key)", flush=True)
    print(f"[{definition.id}] consent  Helix's consent page at {env.helix_api_url}/consent/<request>, per challenge", flush=True)
    # threaded: a retry's chain check reads Helix's status lists while other calls are served.
    app.run(host="0.0.0.0", port=definition.port, threaded=True)
