# SPDX-License-Identifier: AGPL-3.0-only
"""Maintainer-only: make the pinned Noto CJK weight-400 static TrueType face.

Requires fonttools==4.60.1. All glyphs are retained; runtime subsets each PDF.
"""
import hashlib
import sys
from pathlib import Path
import fontTools
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

assert fontTools.version == "4.60.1"
source, output = map(Path, sys.argv[1:])
assert hashlib.sha256(source.read_bytes()).hexdigest() == "990c807e79c25662a5a9ecf7f971baeb2bf2eab9a559e5ecf15cdfdb8561d21f"
font = TTFont(source, recalcTimestamp=False)
instantiateVariableFont(font, {"wght": 400}, inplace=True, updateFontNames=True)
font.save(output)
print(hashlib.sha256(output.read_bytes()).hexdigest())
