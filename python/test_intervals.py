"""Tests for interval-aware (15-minute / hourly / daily) price-production analysis.

These lock in the behaviour added when the Swedish market moved to 15-minute
resolution: production and prices may have different cadences, and "hours" metrics
must reflect real durations rather than row counts.
"""

import pandas as pd
import pytest

from core.price_analyzer import PriceAnalyzer
from core.intervals import (
    infer_step_hours,
    interval_hours_series,
    assess_resolution,
    granularity_from_hours,
    step_consistency_pct,
)


def test_infer_step_hours_hourly_and_quarterly():
    hourly = pd.date_range("2025-01-01", periods=10, freq="h")
    quarterly = pd.date_range("2025-01-01", periods=10, freq="15min")
    assert infer_step_hours(hourly) == pytest.approx(1.0)
    assert infer_step_hours(quarterly) == pytest.approx(0.25)
    assert infer_step_hours(hourly[:1]) == pytest.approx(1.0)  # single row -> default


def test_interval_hours_series_sums_to_span():
    idx = pd.date_range("2025-01-01", periods=4, freq="15min")
    hours = interval_hours_series(idx)
    assert hours.sum() == pytest.approx(1.0)  # 4 x 15 min == 1 hour


def test_hourly_x_hourly_matches_simple_multiplication():
    idx = pd.date_range("2025-01-01 00:00", periods=2, freq="h")
    prices = pd.DataFrame({"price_eur_per_mwh": [100.0, -50.0]}, index=idx)
    production = pd.DataFrame({"production_kwh": [2.0, 3.0]}, index=idx)

    merged = PriceAnalyzer.merge_data(prices, production, eur_sek_rate=10.0)
    a = PriceAnalyzer.analyze_data(merged)

    # sek/kwh = eur_mwh * 10 / 1000 -> [1.0, -0.5]
    assert a["total_hours"] == pytest.approx(2.0)
    assert a["production_total"] == pytest.approx(5.0)
    assert a["total_export_value_sek"] == pytest.approx(2 * 1.0 + 3 * -0.5)  # 0.5
    assert a["negative_price_hours"] == pytest.approx(1.0)
    assert a["hours_with_production"] == pytest.approx(2.0)
    assert a["negative_export_cost_abs_sek"] == pytest.approx(1.5)


def test_hourly_production_x_15min_prices_surfaces_negative_quarter():
    # Hourly production, but prices at 15-minute resolution with one negative quarter.
    prod_idx = pd.date_range("2025-11-03 00:00", periods=2, freq="h")
    production = pd.DataFrame({"production_kwh": [4.0, 8.0]}, index=prod_idx)

    price_idx = pd.date_range("2025-11-03 00:00", periods=8, freq="15min")
    # First hour has a negative third quarter; second hour all positive.
    eur = [100, 100, -200, 100, 100, 100, 100, 100]
    prices = pd.DataFrame({"price_eur_per_mwh": [float(x) for x in eur]}, index=price_idx)

    merged = PriceAnalyzer.merge_data(prices, production, eur_sek_rate=10.0)
    a = PriceAnalyzer.analyze_data(merged)

    # Production is split evenly across the 4 quarters of each hour: [1,1,1,1, 2,2,2,2].
    assert a["production_total"] == pytest.approx(12.0)
    assert a["total_hours"] == pytest.approx(2.0)
    # Revenue: 1*1 + 1*1 + 1*(-2) + 1*1 + 2*1*4 = 1 + 8 = 9
    assert a["total_export_value_sek"] == pytest.approx(9.0)
    # Exactly one negative 15-min quarter, carrying 1 kWh.
    assert a["negative_price_hours"] == pytest.approx(0.25)
    assert a["production_during_negative_prices"] == pytest.approx(1.0)
    assert a["negative_export_cost_abs_sek"] == pytest.approx(2.0)


def test_15min_production_x_hourly_prices_no_row_loss():
    # 15-minute production, hourly prices (older dates). No production interval dropped.
    prod_idx = pd.date_range("2024-06-01 00:00", periods=8, freq="15min")
    production = pd.DataFrame({"production_kwh": [1.0] * 8}, index=prod_idx)

    price_idx = pd.date_range("2024-06-01 00:00", periods=2, freq="h")
    prices = pd.DataFrame({"price_eur_per_mwh": [100.0, -100.0]}, index=price_idx)

    merged = PriceAnalyzer.merge_data(prices, production, eur_sek_rate=10.0)
    a = PriceAnalyzer.analyze_data(merged)

    assert len(merged) == 8  # all 15-min production rows kept
    assert a["total_hours"] == pytest.approx(2.0)
    assert a["production_total"] == pytest.approx(8.0)
    # First hour price +1 sek/kwh (4 kWh), second hour -1 sek/kwh (4 kWh) -> 0 net
    assert a["total_export_value_sek"] == pytest.approx(0.0)
    assert a["negative_price_hours"] == pytest.approx(1.0)  # second hour
    assert a["production_during_negative_prices"] == pytest.approx(4.0)


def test_fuse_flat_peak_analysis():
    # Hour 1: 12 kWh -> 12 kW (above 16 A limit ~11.1 kW). Hour 2: 5 kWh -> below.
    idx = pd.date_range("2025-07-01 12:00", periods=2, freq="h")
    prices = pd.DataFrame({"price_eur_per_mwh": [100.0, 100.0]}, index=idx)
    production = pd.DataFrame({"production_kwh": [12.0, 5.0]}, index=idx)

    merged = PriceAnalyzer.merge_data(prices, production, eur_sek_rate=10.0)
    a = PriceAnalyzer.analyze_data(merged, fuse_amps=16)

    gc = a["grid_connection"]
    assert gc["fuse_limit_kw"] == pytest.approx((3 ** 0.5) * 400 * 16 / 1000, abs=0.01)  # ~11.08
    assert gc["peak_power_kw"] == pytest.approx(12.0)
    assert gc["hours_at_max"] == pytest.approx(1.0)
    assert gc["peaks"] == 1
    assert gc["share_time_at_max_pct"] == pytest.approx(50.0)


def test_no_fuse_means_no_grid_connection_block():
    idx = pd.date_range("2025-07-01", periods=2, freq="h")
    prices = pd.DataFrame({"price_eur_per_mwh": [100.0, 100.0]}, index=idx)
    production = pd.DataFrame({"production_kwh": [1.0, 1.0]}, index=idx)
    merged = PriceAnalyzer.merge_data(prices, production)
    assert "grid_connection" not in PriceAnalyzer.analyze_data(merged)


def test_export_compensation_and_self_consumption():
    # spot [1.0, 2.0] SEK/kWh (eur_mwh [100,200] * 10/1000), production [2, 2] kWh.
    idx = pd.date_range("2025-01-01 00:00", periods=2, freq="h")
    prices = pd.DataFrame({"price_eur_per_mwh": [100.0, 200.0]}, index=idx)
    production = pd.DataFrame({"production_kwh": [2.0, 2.0]}, index=idx)
    merged = PriceAnalyzer.merge_data(prices, production, eur_sek_rate=10.0)

    # elnät: 5 öre fast + 10% rörlig ; elhandel: 10 öre fast + 0% rörlig
    a = PriceAnalyzer.analyze_data(
        merged,
        vat_rate=25,
        grid_fixed=0.05,
        grid_pct=10,
        trader_fixed=0.1,
        trader_pct=0,
        self_energy_tax=0.4,
        self_grid_fee=0.6,
    )

    # realized spot = (2*1 + 2*2)/4 = 1.5
    e = a["export_compensation"]
    assert e["spot_sek_per_kwh"] == pytest.approx(1.5)
    assert e["elnat_variable_sek_per_kwh"] == pytest.approx(0.15)  # 10% of 1.5
    assert e["elnat_total_sek_per_kwh"] == pytest.approx(0.20)  # 0.05 + 0.15
    assert e["elhandel_total_sek_per_kwh"] == pytest.approx(0.10)  # 0.10 fast
    assert e["price_before_vat_sek_per_kwh"] == pytest.approx(1.80)
    assert e["effective_price_sek_per_kwh"] == pytest.approx(2.25)  # * 1.25
    assert e["spot_total_sek"] == pytest.approx(6.0)
    assert e["effective_total_sek"] == pytest.approx(9.0)
    assert e["uplift_vs_spot_sek"] == pytest.approx(3.0)

    s = a["self_consumption"]
    assert s["value_self_sek_per_kwh"] == pytest.approx(3.125)  # (1.5+0.4+0.6)*1.25
    assert s["export_value_sek_per_kwh"] == pytest.approx(2.25)
    assert s["increment_vs_export_sek_per_kwh"] == pytest.approx(0.875)


def test_self_consumption_quarter_price_toggle():
    # More production in the cheap hour: realized=1.5, average=2.0 SEK/kWh.
    idx = pd.date_range("2025-11-03 00:00", periods=2, freq="h")
    prices = pd.DataFrame({"price_eur_per_mwh": [100.0, 300.0]}, index=idx)  # 1.0, 3.0 SEK/kWh
    production = pd.DataFrame({"production_kwh": [3.0, 1.0]}, index=idx)
    merged = PriceAnalyzer.merge_data(prices, production, eur_sek_rate=10.0)

    on = PriceAnalyzer.analyze_data(
        merged, vat_rate=25, self_energy_tax=0.4, self_grid_fee=0.6, self_quarter_price=True
    )["self_consumption"]
    assert on["quarter_price"] is True
    assert on["spot_sek_per_kwh"] == pytest.approx(1.5)  # realized
    assert on["value_self_sek_per_kwh"] == pytest.approx(3.125)

    off = PriceAnalyzer.analyze_data(
        merged, vat_rate=25, self_energy_tax=0.4, self_grid_fee=0.6, self_quarter_price=False
    )["self_consumption"]
    assert off["quarter_price"] is False
    assert off["spot_sek_per_kwh"] == pytest.approx(2.0)  # period average
    assert off["value_self_sek_per_kwh"] == pytest.approx(3.75)
    assert off["export_value_sek_per_kwh"] == pytest.approx(1.875)  # export realized at 1.5


def test_export_at_loss_quarters():
    # 15-min prices [1.0, -0.5, 0.05, 1.0] SEK/kWh (eur_mwh /100 * 10), 1 kWh each quarter.
    idx = pd.date_range("2025-11-03 00:00", periods=4, freq="15min")
    prices = pd.DataFrame({"price_eur_per_mwh": [100.0, -50.0, 5.0, 100.0]}, index=idx)
    production = pd.DataFrame({"production_kwh": [1.0, 1.0, 1.0, 1.0]}, index=idx)
    merged = PriceAnalyzer.merge_data(prices, production, eur_sek_rate=10.0)

    # 10 öre avdrag from the trader -> effective = spot - 0.10 ; break-even spot = 0.10.
    a = PriceAnalyzer.analyze_data(merged, trader_fixed=-0.1)
    f = a["export_at_loss"]
    assert f["count"] == 2  # q2 (-0.5) and q3 (0.05) fall below break-even
    assert f["break_even_spot_sek_per_kwh"] == pytest.approx(0.10)
    assert f["total_kwh"] == pytest.approx(2.0)
    assert f["total_loss_sek"] == pytest.approx(0.65)  # 0.60 + 0.05
    assert f["interval_minutes"] == pytest.approx(15.0)
    assert len(f["rows"]) == 2
    assert f["rows"][0]["loss_sek"] == pytest.approx(0.60)  # worst first


def test_monthly_forecast_full_months():
    # Continuous hourly data covering all of Nov + Dec 2025 (both full months).
    idx = pd.date_range("2025-11-01 00:00", "2025-12-31 23:00", freq="h")
    prices = pd.DataFrame({"price_eur_per_mwh": [100.0] * len(idx)}, index=idx)  # 1.0 SEK/kWh
    production = pd.DataFrame({"production_kwh": [1.0] * len(idx)}, index=idx)
    merged = PriceAnalyzer.merge_data(prices, production, eur_sek_rate=10.0)

    a = PriceAnalyzer.analyze_data(merged, vat_rate=25, grid_monthly_fee=100, trader_monthly_fee=20)
    f = a["monthly_forecast"]
    assert f["full_months"] == 2
    assert f["fixed_monthly_sek"] == pytest.approx(120.0)
    # Nov 720 kWh -> rev 720 -> eff 900 ; Dec 744 -> rev 744 -> eff 930
    assert f["avg_production_kwh"] == pytest.approx(732.0)
    assert f["avg_effective_sek"] == pytest.approx(915.0)
    assert f["avg_net_sek"] == pytest.approx(795.0)  # (780 + 810) / 2


def test_valuation_blocks_omitted_without_inputs():
    idx = pd.date_range("2025-01-01 00:00", periods=2, freq="h")
    prices = pd.DataFrame({"price_eur_per_mwh": [100.0, 200.0]}, index=idx)
    production = pd.DataFrame({"production_kwh": [2.0, 2.0]}, index=idx)
    merged = PriceAnalyzer.merge_data(prices, production, eur_sek_rate=10.0)
    a = PriceAnalyzer.analyze_data(merged)  # no valuation inputs
    assert "export_compensation" not in a
    assert "self_consumption" not in a


def test_granularity_from_hours():
    assert granularity_from_hours(0.25) == "15min"
    assert granularity_from_hours(1.0) == "hourly"
    assert granularity_from_hours(24.0) == "daily"
    assert granularity_from_hours(0) == "unknown"


def test_assess_resolution_accepts_quarter_hour():
    idx = pd.date_range("2026-05-01", periods=12, freq="15min")
    assert step_consistency_pct(idx) == pytest.approx(100.0)
    a = assess_resolution(idx)
    assert a.granularity == "15min"
    assert a.step_minutes == pytest.approx(15.0)
    assert a.is_quarter_hour is True
    assert a.level == "ok"


def test_assess_resolution_flags_hourly_data():
    idx = pd.date_range("2026-05-01", periods=6, freq="h")
    a = assess_resolution(idx)
    assert a.granularity == "hourly"
    assert a.is_quarter_hour is False
    assert a.level == "warning"
    assert "15-minute" in a.message


def test_db_has_data_for_period_is_resolution_aware(tmp_path):
    from core.db_manager import PriceDatabaseManager

    db = PriceDatabaseManager(str(tmp_path / "p.db"))
    idx = pd.date_range("2025-11-01 00:00", periods=96, freq="15min")  # one full day
    df = pd.DataFrame({"price_eur_per_mwh": [10.0] * 96}, index=idx)
    db.store_price_data(df, "SE3")

    start = pd.Timestamp("2025-11-01 00:00")
    end = pd.Timestamp("2025-11-01 23:45")
    # 96 quarter-hour points cover the day; the hourly-only heuristic would also pass,
    # but this confirms 15-min density is accepted as complete.
    assert db.has_data_for_period("SE3", start, end) is True
