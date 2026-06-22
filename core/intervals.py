"""Helpers for interval-aware (granularity-agnostic) analysis.

Electricity prices and production data can be hourly, 15-minute (the Swedish market
resolution from 2025-10-01), or daily. Code must therefore never assume "one row ==
one hour". These helpers infer the per-row interval length so energy/cost sums and
"hours" metrics stay correct at any resolution.
"""

import pandas as pd


def infer_step_hours(index: pd.DatetimeIndex, default: float = 1.0) -> float:
    """Return the dominant spacing of a datetime index, in hours.

    Uses the median of consecutive differences so occasional gaps (DST, missing
    rows) don't skew the result. Falls back to ``default`` for a single row.
    """
    if index is None or len(index) < 2:
        return default
    diffs = pd.Series(index).sort_values().diff().dropna()
    if diffs.empty:
        return default
    step = diffs.median().total_seconds() / 3600
    return step if step > 0 else default


def interval_hours_series(index: pd.DatetimeIndex) -> pd.Series:
    """Per-row interval length in hours.

    Each row's duration is the gap to the next timestamp; the final row reuses the
    median step. This makes ``(series * hours).sum()`` correct for mixed cadences.
    """
    if len(index) == 0:
        return pd.Series([], dtype=float)
    if len(index) == 1:
        return pd.Series([infer_step_hours(index)], index=index)

    ordered = pd.DatetimeIndex(index).sort_values()
    deltas = ordered[1:] - ordered[:-1]
    hours = [d.total_seconds() / 3600 for d in deltas]
    median = pd.Series(hours).median()
    hours.append(median)  # last row: assume one more median-length step
    return pd.Series(hours, index=ordered)
