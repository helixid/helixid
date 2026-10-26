# StatusListCredential construction, matching helix-sdk-js's
# core/status-list-schema.ts buildStatusListCredential() exactly (including
# its slightly odd `id` shape -- ".../v1/status-list/<listId>" even though
# this demo's SPs actually serve the list at "/status-list/<listId>". That
# mismatch is harmless: verifiers resolve the list via the URL carried in
# credentialStatus.statusListUrl, never by parsing this `id` field.
#
# Bitstring encode/decode ported 1:1 from helix-api's own
# src/core/status-list/index.ts (W3C Bitstring Status List: gzip-compressed,
# base64url-encoded bit array). Previously imported from helix_cli.status_list,
# but that module no longer exists -- helix_cli was removed from
# helix-sdk-py entirely (see helix-sdk-py's the decision log, "CLI stays
# JS-only"), so this is now a small, self-contained local implementation
# instead of a shared-SDK dependency.

from __future__ import annotations

import base64
import gzip
from datetime import datetime, timezone
from typing import Any, Dict


def _base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _base64url_decode(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded)


def create_status_list(size: int = 131072) -> str:
    """New status list bitstring. Default size: 131072 bits (16KB uncompressed)."""
    buffer = bytearray((size + 7) // 8)
    return _base64url_encode(gzip.compress(bytes(buffer)))


def set_bit(encoded_list: str, index: int, value: int) -> str:
    """Flips a bit in the encoded status list. 0 = valid, 1 = revoked."""
    buffer = bytearray(gzip.decompress(_base64url_decode(encoded_list)))
    byte_index, bit_index = divmod(index, 8)
    if byte_index >= len(buffer):
        raise ValueError("Status list index out of bounds")
    if value == 1:
        buffer[byte_index] |= 1 << (7 - bit_index)
    else:
        buffer[byte_index] &= ~(1 << (7 - bit_index)) & 0xFF
    return _base64url_encode(gzip.compress(bytes(buffer)))


def get_bit(encoded_list: str, index: int) -> int:
    buffer = gzip.decompress(_base64url_decode(encoded_list))
    byte_index, bit_index = divmod(index, 8)
    if byte_index >= len(buffer):
        raise ValueError("Status list index out of bounds")
    return (buffer[byte_index] >> (7 - bit_index)) & 1

VC_CONTEXTS = [
    "https://www.w3.org/ns/credentials/v2",
    "https://www.w3.org/ns/credentials/status/v1",
]


def build_status_list_credential(
    list_id: str, encoded_list: str, issuer_did: str, api_base_url: str
) -> Dict[str, Any]:
    return {
        "@context": list(VC_CONTEXTS),
        "id": f"{api_base_url}/v1/status-list/{list_id}",
        "type": ["VerifiableCredential", "BitstringStatusListCredential"],
        "issuer": issuer_did,
        "validFrom": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "credentialSubject": {
            "id": f"{api_base_url}/v1/status-list/{list_id}#list",
            "type": "BitstringStatusList",
            "statusPurpose": "revocation",
            "encodedList": encoded_list,
        },
    }
