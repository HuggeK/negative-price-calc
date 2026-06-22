"""
Core analysis modules for the Price Production Analysis System.

This package contains the shared business logic and analysis components
that can be used by both API endpoints and web routes.

The pure analysis pieces (PriceAnalyzer, PriceDatabaseManager) have no heavy
third-party requirements and always import. The data-ingestion pieces
(PriceFetcher, ProductionLoader) pull optional dependencies (entsoe, openai,
chardet, ...); they are imported defensively so the core analyzer stays usable
in lightweight environments (and under test) even when those are absent.
"""

from .price_analyzer import PriceAnalyzer
from .db_manager import PriceDatabaseManager

__all__ = ['PriceAnalyzer', 'PriceDatabaseManager']

try:
    from .price_fetcher import PriceFetcher
    __all__.append('PriceFetcher')
except ImportError:  # pragma: no cover - optional data-source dependencies
    pass

try:
    from .production_loader import ProductionLoader
    __all__.append('ProductionLoader')
except ImportError:  # pragma: no cover - optional parsing/AI dependencies
    pass
