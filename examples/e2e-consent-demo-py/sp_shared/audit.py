# Service-Provider-side activity log. Python port of sp-shared/audit.ts.
#
# The SP is the only party that knows several facts the activity trail needs:
# whether a call's proof and chain verified, why they did not, and whether
# the scope a tool requires was in the user's consent. Recording those from
# the agent would mean trusting the agent's account of its own authorization,
# so the SP logs them itself, from the process that made the decision.
#
# This demo writes them to the SP's own log, one JSON line each. The legacy
# shared audit-log endpoint is retired; delivering these to Helix's recorder
# (AuditTrail over POST /v1/audit/submissions, KYA-OS A-1/A-2) is not wired in
# this example. Every emission is best-effort: a booking is not less valid
# because a log write failed.

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional


class AuditEmitter:
    """Event names are the SDK's typed audit event types (helix_sdk.audit), e.g. ``authorization.approved``."""

    def __init__(self, service_did: str, service_name: str, write: Optional[Callable[[str], None]] = None) -> None:
        self._service_did = service_did
        self._service_name = service_name
        self._write = write or (lambda line: print(line, file=sys.stdout, flush=True))

    def emit(self, event: Dict[str, Any]) -> None:
        try:
            line = {
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "serviceDid": self._service_did,
                "serviceName": self._service_name,
                **{k: v for k, v in event.items() if v is not None},
            }
            self._write(json.dumps(line))
        except Exception:  # noqa: BLE001 - never surfaces to the caller
            pass


def create_audit_emitter(service_did: str, service_name: str) -> AuditEmitter:
    return AuditEmitter(service_did, service_name)
