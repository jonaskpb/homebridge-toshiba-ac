#!/usr/bin/env python3
"""Reference oracle for the differential test.

Reads JSON-line requests on stdin, answers using the original Python
toshiba_ac library (path passed as argv[1]), one JSON line per request.
Heavy dependencies (aiohttp, azure-iot-device) are stubbed out since only
the pure codec modules are exercised.
"""

import json
import sys
import types


def stub_module(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module


class _StubError(Exception):
    pass


stub_module(
    "aiohttp",
    ClientError=_StubError,
    ContentTypeError=_StubError,
    ClientSession=object,
    ClientTimeout=object,
)
stub_module("azure")
stub_module("azure.iot")
stub_module("azure.iot.device", Message=object, MethodRequest=object, MethodResponse=object)
stub_module("azure.iot.device.aio", IoTHubDeviceClient=object)
stub_module("azure.iot.device.custom_typing", JSONSerializable=object)

sys.path.insert(0, sys.argv[1])

from toshiba_ac.device.fcu_state import ToshibaAcFcuState  # noqa: E402
from toshiba_ac.device.features import ToshibaAcFeatures  # noqa: E402


def features_to_dict(features):
    return {
        "modes": sorted(m.name for m in features.ac_mode),
        "fanModes": sorted(m.name for m in features.ac_fan_mode),
        "swingModes": sorted(m.name for m in features.ac_swing_mode),
        "powerSelections": sorted(m.name for m in features.ac_power_selection),
        "meritA": sorted(m.name for m in features.ac_merit_a),
        "meritB": sorted(m.name for m in features.ac_merit_b),
        "pureIon": sorted(m.name for m in features.ac_air_pure_ion),
        "selfCleaning": sorted(m.name for m in features.ac_self_cleaning),
        "energyReport": features.ac_energy_report,
    }


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    op = request["op"]
    try:
        if op == "roundtrip":
            state = ToshibaAcFcuState.from_hex_state(request["hex"])
            result = {"encoded": state.encode()}
        elif op == "update":
            state = ToshibaAcFcuState.from_hex_state(request["base"])
            changed = state.update(request["update"])
            result = {"encoded": state.encode(), "changed": changed}
        elif op == "features":
            features = ToshibaAcFeatures.from_merit_string_and_model(request["merit"], request["model"])
            result = features_to_dict(features)
        elif op == "featuresForMode":
            features = ToshibaAcFeatures.from_merit_string_and_model(request["merit"], request["model"])
            from toshiba_ac.device.properties import ToshibaAcMode

            result = features_to_dict(features.for_ac_mode(ToshibaAcMode[request["mode"]]))
        else:
            result = {"error": f"unknown op {op}"}
    except Exception as e:  # noqa: BLE001 - report to the comparing side
        result = {"error": f"{type(e).__name__}: {e}"}
    print(json.dumps(result))
    sys.stdout.flush()
