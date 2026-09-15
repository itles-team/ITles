from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
import math
import re
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt, StrictStr, field_validator, model_validator


class StrictModel(BaseModel):
    # JSON necessarily represents UUIDs and timestamps as strings. Individual
    # numeric fields remain strict so telemetry values cannot be silently coerced.
    model_config = ConfigDict(extra="forbid")


METRICS: dict[str, tuple[str, str, float | None, float | None]] = {
    "fuel_level_pct": ("Уровень топлива", "%", 0, 100),
    "fuel_rate_lph": ("Текущий расход топлива", "L/h", 0, None),
    "fuel_consumed_total_l": ("Счётчик израсходованного топлива", "L", 0, None),
    "engine_oil_pressure_kpa": ("Давление масла двигателя", "kPa", 0, None),
    "engine_oil_temperature_c": ("Температура масла двигателя", "°C", None, None),
    "engine_oil_level_pct": ("Уровень масла двигателя", "%", 0, 100),
    "hydraulic_oil_temperature_c": ("Температура гидравлического масла", "°C", None, None),
    "hydraulic_oil_level_pct": ("Уровень гидравлического масла", "%", 0, 100),
    "chain_oil_level_pct": ("Уровень масла пильной цепи", "%", 0, 100),
    "coolant_temperature_c": ("Температура охлаждающей жидкости", "°C", None, None),
    "engine_rpm": ("Обороты двигателя", "rpm", 0, None),
    "engine_hours_total": ("Счётчик наработки двигателя", "h", 0, None),
}
SOURCES = {"onboard_measurement", "operator_export", "accounting_import"}
METHODS = {"harvester_onboard", "merchantable_log", "manual_ledger"}
TECHNICAL_SLUG = r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$"


def utc_timestamp(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("occurred_at must use UTC (Z or +00:00)")
    if value > datetime.now(UTC) + timedelta(minutes=5):
        raise ValueError("occurred_at cannot be in the future")
    return value.astimezone(UTC)


class Position(StrictModel):
    latitude: StrictFloat
    longitude: StrictFloat

    @model_validator(mode="after")
    def coordinates_in_range(self):
        if not -90 <= self.latitude <= 90 or not -180 <= self.longitude <= 180:
            raise ValueError("position is outside geographic bounds")
        return self


class Measurement(StrictModel):
    key: Literal[
        "fuel_level_pct", "engine_oil_pressure_kpa", "engine_oil_temperature_c",
        "hydraulic_oil_temperature_c", "coolant_temperature_c", "engine_rpm", "engine_hours_total",
        "fuel_rate_lph", "fuel_consumed_total_l", "engine_oil_level_pct",
        "hydraulic_oil_level_pct", "chain_oil_level_pct",
    ]
    value: StrictFloat | StrictInt
    unit: str = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def known_unit_and_range(self):
        _, expected_unit, low, high = METRICS[self.key]
        if self.unit != expected_unit:
            raise ValueError(f"{self.key} must use {expected_unit}")
        try:
            finite = math.isfinite(self.value)
        except OverflowError:
            finite = False
        if not finite or (low is not None and self.value < low) or (high is not None and self.value > high):
            raise ValueError(f"{self.key} is outside accepted range")
        return self


class EventBase(StrictModel):
    event_id: UUID
    machine_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    occurred_at: datetime
    kind: str

    @field_validator("occurred_at", mode="before")
    @classmethod
    def explicit_utc_string(cls, value):
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)", value):
            raise ValueError("occurred_at must be an explicit UTC timestamp with at most six fractional digits")
        return value

    @field_validator("occurred_at")
    @classmethod
    def valid_timestamp(cls, value: datetime) -> datetime:
        return utc_timestamp(value)


class TelemetryEvent(EventBase):
    kind: Literal["telemetry"]
    measurements: list[Measurement] = Field(default_factory=list, max_length=16)
    position: Position | None = None

    @model_validator(mode="after")
    def one_value_per_key(self):
        keys = [item.key for item in self.measurements]
        if len(keys) != len(set(keys)):
            raise ValueError("measurement keys must not repeat within one event")
        if not self.measurements and self.position is None:
            raise ValueError("telemetry must include measurements or a position")
        return self


class ProductionEvent(EventBase):
    kind: Literal["production"]
    volume_m3: Decimal
    basis: Literal["under_bark", "over_bark", "unknown"]
    source: Literal["onboard_measurement", "operator_export", "accounting_import"]
    method: Literal["harvester_onboard", "merchantable_log", "manual_ledger"]
    # This identifies the sender's calculation/configuration version, not a formula.
    method_version: StrictStr = Field(min_length=1, max_length=80, pattern=TECHNICAL_SLUG)
    calibration_ref: StrictStr | None = Field(default=None, min_length=1, max_length=80, pattern=TECHNICAL_SLUG)

    @field_validator("volume_m3", mode="before")
    @classmethod
    def decimal_string(cls, value):
        if not isinstance(value, str):
            raise ValueError("volume_m3 must be a decimal string")
        try:
            result = Decimal(value)
        except InvalidOperation as exc:
            raise ValueError("volume_m3 must be a decimal string") from exc
        if not result.is_finite() or result <= 0 or result > Decimal("10000"):
            raise ValueError("volume_m3 must be between 0 and 10000")
        if -result.as_tuple().exponent > 6:
            raise ValueError("volume_m3 allows at most six decimal places")
        return result


Event = Annotated[TelemetryEvent | ProductionEvent, Field(discriminator="kind")]


class IngestBatch(StrictModel):
    schema_version: Literal[1]
    batch_id: UUID
    events: list[Event] = Field(min_length=1, max_length=500)

    @field_validator("schema_version", mode="before")
    @classmethod
    def integer_schema_version(cls, value):
        if type(value) is not int or value != 1:
            raise ValueError("schema_version must be the integer 1")
        return value

    @model_validator(mode="after")
    def unique_event_ids(self):
        ids = [str(event.event_id) for event in self.events]
        if len(ids) != len(set(ids)):
            raise ValueError("event_id must be unique inside a batch")
        return self


class LoginRequest(StrictModel):
    account: str = Field(min_length=2, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    password: str = Field(min_length=12, max_length=256)
