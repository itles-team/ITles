# ITles telemetry contract

`production.method` is a controlled category of provenance, not a calculation
formula or an OEM methodology identifier. Every production event therefore
requires `method_version`: a 1–80 character lowercase technical slug supplied
by the connected sender/configuration. The API accepts `unknown` when the
version cannot yet be established, but reports it in totals warnings and it
must not be used to make physical accuracy claims.

`calibration_ref` is optional because a sender may not expose a calibration
reference. It is a technical slug when present and is preserved in the ledger;
absence does not mean calibration passed or failed.

The bundled `synthetic-v1` version belongs only to the explicitly fictional
demo fixture. It is not a machine protocol, OEM method, or field validation.
