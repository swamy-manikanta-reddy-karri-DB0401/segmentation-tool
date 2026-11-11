from .base import Destination
from .brevo import Brevo
from .csv_export import CsvExport
from .freewheel import FreeWheel
from .gam import GoogleAdManager
from .gam_kv import GamKeyValues
from .hubspot import HubSpot
from .meta import MetaCustomAudience
from .sailthru import Sailthru
from .webhook import Webhook

REGISTRY: dict[str, type[Destination]] = {
    cls.type: cls for cls in (Sailthru, Brevo, GoogleAdManager, GamKeyValues, FreeWheel, Webhook, CsvExport, HubSpot, MetaCustomAudience)
}


def get(type_: str) -> type[Destination]:
    try:
        return REGISTRY[type_]
    except KeyError:
        raise ValueError(f"Unknown destination type {type_!r}")
