# Boots one SP app from its provisioned identity. Both sp_airline/server.py
# and sp_hotel/server.py are thin wrappers around this. Python port of
# sp-shared/serve.ts.

from __future__ import annotations

import os

from helixid_config import Env, SpDefinition, env as default_env
from sp_shared.app import create_sp_app
from sp_shared.audit import create_audit_emitter
from sp_shared.identity import STATUS_LIST_LENGTH, load_sp_identity, state_path
from sp_shared.status_list import build_status_list_credential, create_status_list
from sp_shared.store import SpStore

HERE = os.path.dirname(os.path.abspath(__file__))


def serve_sp(definition: SpDefinition, env: Env = default_env) -> None:
    identity = load_sp_identity(env.wallets_dir, definition.id)
    store = SpStore.open(
        state_path(env.wallets_dir, definition.id),
        build_status_list_credential("1", create_status_list(STATUS_LIST_LENGTH), identity.did, identity.baseUrl),
    )

    def on_audit_error(message: str) -> None:
        print(f"[{definition.id}] {message}", flush=True)

    app, _counters = create_sp_app(
        definition=definition,
        issuer_did=identity.did,
        issuer_private_key_hex=identity.privateKeyHex,
        issuer_public_key_hex=identity.publicKeyHex,
        base_url=identity.baseUrl,
        helix_api_url=env.helix_api_url,
        store=store,
        # Scope resolution happens inside this same process. The public
        # did:web base URL can be localhost, but the server should call its
        # own loopback.
        mcp_server_url=f"http://127.0.0.1:{definition.port}/api/mcp",
        # @helixid/widget has no Python port -- its pre-built browser bundle
        # is served as-is. docker/python.Dockerfile builds it from the public
        # helix-sdk-js repo into ../widget-dist; override WIDGET_DIST_PATH to
        # point at your own checkout when running outside Docker.
        widget_dist_path=os.environ.get(
            "WIDGET_DIST_PATH", os.path.join(HERE, "..", "widget-dist")
        ),
        audit=create_audit_emitter(
            env.helix_api_url,
            env.admin_api_key,
            identity.did,
            definition.display_name,
            on_error=on_audit_error,
        ),
    )

    print(f"[{definition.id}] {definition.display_name} listening on :{definition.port}", flush=True)
    print(f"[{definition.id}] did:web  {identity.did}", flush=True)
    print(f"[{definition.id}] status   {identity.statusListUrl}", flush=True)
    print(f"[{definition.id}] consent  {identity.baseUrl}/consent", flush=True)
    app.run(host="0.0.0.0", port=definition.port)
